// Tiny HTTP client shared by the CLI and the MCP server. Both talk to the
// server on this Mac through its API, never to the database directly.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = `http://127.0.0.1:${process.env.GOODCOMMENTS_PORT || 4477}`;

export const ACTOR = process.env.GOODCOMMENTS_ACTOR || null;

let ensured = false;

async function ping() {
  // any HTTP answer means a server is there
  try { await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) }); return true; } catch { return false; }
}

/** Start the local server in the background if it isn't running yet. */
export async function ensureServer() {
  if (ensured) return;
  if (await ping()) { ensured = true; return; }
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
  spawn(process.execPath, ['--no-warnings', entry], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await ping()) { ensured = true; return; }
  }
  throw new Error(`could not start the GoodComments server at ${BASE}`);
}

function headers(extra = {}, actor) {
  const h = { ...extra };
  if (actor || ACTOR) h['x-actor'] = actor || ACTOR;
  return h;
}

export async function api(method, path, body, actor) {
  await ensureServer();
  const res = await fetch(BASE + path, {
    method,
    headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }, actor),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const MIME = {
  '.png': 'image/png', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.key': 'application/vnd.apple.keynote', '.pages': 'application/vnd.apple.pages', '.numbers': 'application/vnd.apple.numbers',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4',
};

// Screenshots are stored as they're sent: on a Mac, big PNG / JPEG / HEIC / TIFF images are made smaller first
// (at most 2000 px on the long side, JPEG at 85%), like the board does with the ones you paste.
const MAX_SIDE = 2000;
const sips = (args) => new Promise((done) => execFile('/usr/bin/sips', args, { timeout: 20000 }, (err, out) => done(err ? null : out)));

async function smaller(file, type, data) {
  if (process.platform !== 'darwin' || !/^image\/(png|jpeg|heic|tiff)$/.test(type) || data.length < 200 * 1024) return null;
  const info = await sips(['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const side = Math.max(...[...String(info || '').matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])));
  if (!Number.isFinite(side) || side <= 0) return null;
  const dir = await mkdtemp(join(tmpdir(), 'gc-shot-'));
  const out = join(dir, `${basename(file, extname(file))}.jpg`);
  try {
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', ...(side > MAX_SIDE ? ['-Z', String(MAX_SIDE)] : []), file, '--out', out];
    if (!(await sips(args))) return null;
    const small = await readFile(out);
    return small.length < data.length ? { name: basename(out), type: 'image/jpeg', data: small } : null;
  } catch { return null; } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Attach a file (screenshot, image, PDF) to a comment. */
export async function uploadFile(id, file, actor) {
  await ensureServer();
  let type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  let name = basename(file);
  let data = await readFile(file);
  const small = await smaller(file, type, data);
  if (small) ({ name, type, data } = small);
  const res = await fetch(`${BASE}/api/comments/${id}/attachments`, {
    method: 'POST',
    headers: headers({ 'content-type': type, 'x-filename': encodeURIComponent(name) }, actor),
    body: data,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `${res.status} ${res.statusText}`);
  return out;
}

/** Download an attachment's bytes (for agents that want to look at a screenshot). */
export async function fetchAttachment(id) {
  await ensureServer();
  const res = await fetch(`${BASE}/api/attachments/${id}`, { headers: headers() });
  if (!res.ok) throw new Error(`attachment ${id}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export const attachmentUrl = (a) => `${BASE}/api/attachments/${a.id}`;

/** The project whose folder contains `dir` (agents run inside repos). */
export async function projectForDir(dir = process.cwd()) {
  try { return await api('GET', `/api/projects/resolve?path=${encodeURIComponent(dir)}`); } catch { return null; }
}

// ---------- plain-text formatting (what agents read) ----------
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatComment(c, { full = false } = {}) {
  const where = c.project_id || 'no project';
  const head = [`#${c.id}`, `[${c.status}]`, where, c.source && `from ${c.source}`, ago(c.created_at)]
    .filter(Boolean).join(' · ');
  const lines = [head, ...c.body.split('\n').map((l) => `  ${l}`)];
  if (c.location) lines.push(`  where: ${c.location}`);
  if (c.attachments?.length) lines.push(`  attachments: ${c.attachments.map((a) => `${a.name} [${a.id}] (${attachmentUrl(a)})`).join(', ')}`);
  if (c.fix_note) lines.push(`  fix (${c.fixed_by || 'someone'}, ${ago(c.fixed_at)}): ${c.fix_note}`);
  if (c.status === 'open' && c.reopened_at) {
    const shots = (c.attachments || []).filter((a) => a.created_at >= c.reopened_at);
    lines.push(`  REOPENED (${c.reopened_by || 'someone'}, ${ago(c.reopened_at)}): ${c.reopen_note || 'no note'}${shots.length ? ` — see ${shots.map((a) => a.name).join(', ')}` : ''}`);
  }
  if (full && c.events?.length) {
    lines.push('  history:');
    for (const e of c.events) lines.push(`    ${ago(e.at)} ${e.type}${e.actor ? ` by ${e.actor}` : ''}${e.note ? `: ${e.note}` : ''}`);
  }
  return lines.join('\n');
}
