// Tiny HTTP client shared by the CLI and the MCP server. Both talk to the API,
// never to the database directly, so pointing GOODCOMMENTS_URL at a hosted
// server later is the only change agents need.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = (process.env.GOODCOMMENTS_URL || `http://127.0.0.1:${process.env.GOODCOMMENTS_PORT || 4477}`).replace(/\/$/, '');
const TOKEN = process.env.GOODCOMMENTS_TOKEN;
export const ACTOR = process.env.GOODCOMMENTS_ACTOR || null;

const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE);
let ensured = false;

async function ping() {
  // any HTTP answer means a server is there (a 401 is a token problem, reported by the real call)
  try { await fetch(`${BASE}/api/health`, { headers: headers(), signal: AbortSignal.timeout(isLocal ? 800 : 5000) }); return true; } catch { return false; }
}

/** Start the local server in the background if it isn't running yet. */
export async function ensureServer() {
  if (ensured || !isLocal) return;
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
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`;
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

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf' };

/** Attach a file (screenshot, image, PDF) to a comment. */
export async function uploadFile(id, file, actor) {
  await ensureServer();
  const type = MIME[extname(file).toLowerCase()];
  if (!type) throw new Error(`${basename(file)}: only PNG, JPEG, GIF, WebP, HEIC or PDF`);
  const res = await fetch(`${BASE}/api/comments/${id}/attachments`, {
    method: 'POST',
    headers: headers({ 'content-type': type, 'x-filename': encodeURIComponent(basename(file)) }, actor),
    body: await readFile(file),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
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
  const head = [`#${c.id}`, `[${c.status}]`, c.project_id || 'no project', c.source && `from ${c.source}`, ago(c.created_at)]
    .filter(Boolean).join(' · ');
  const lines = [head, ...c.body.split('\n').map((l) => `  ${l}`)];
  if (c.location) lines.push(`  where: ${c.location}`);
  if (c.attachments?.length) lines.push(`  attachments: ${c.attachments.map((a) => `${a.name} (${attachmentUrl(a)})`).join(', ')}`);
  if (c.fix_note) lines.push(`  fix (${c.fixed_by || 'someone'}, ${ago(c.fixed_at)}): ${c.fix_note}`);
  if (full && c.events?.length) {
    lines.push('  history:');
    for (const e of c.events) lines.push(`    ${ago(e.at)} ${e.type}${e.actor ? ` by ${e.actor}` : ''}${e.note ? `: ${e.note}` : ''}`);
  }
  return lines.join('\n');
}
