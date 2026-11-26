// GoodComments server: JSON API + live events + the web column.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import { agentRuns, chooseFolder, claudeApp, openInEditor, openSession, resolveFile } from './local.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.GOODCOMMENTS_PORT || 4477);
const HOST = '127.0.0.1';   // only this computer can reach it

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };

// ---------- live updates (Server-Sent Events) ----------
const listeners = new Set();   // open responses
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(msg);
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000).unref();

// ---------- helpers ----------
const HttpError = store.HttpError;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(status === 204 ? '' : JSON.stringify(body));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const contentType = (req) => (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

async function readJson(req, limit = 1e6) {
  // Requiring JSON means a web page on another site can't post here without a
  // CORS preflight, which this server never approves.
  if (contentType(req) !== 'application/json') throw new HttpError(415, 'send JSON with content-type: application/json');
  const raw = (await readBody(req, limit)).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'invalid JSON'); }
}

// The Host check stops DNS-rebinding tricks against the local server.
function hostAllowed(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });
const STATUS = Symbol('status');
const created = (body) => ({ [STATUS]: 201, body });
const NO_CONTENT = { [STATUS]: 204 };
const RAW = Symbol('raw');   // plain text answer
const actorOf = (req, body) => body?.actor || req.headers['x-actor'] || 'you';

route('GET', '/api/health', () => ({ ok: true, name: 'goodcomments', storage: store.DB_KIND, db: store.DB_PATH, local: true, claude: claudeApp() }));

route('GET', '/api/projects', () => store.listProjects());
route('GET', '/api/projects/resolve', async (req, url) => {
  const p = await store.resolveProject(url.searchParams.get('ref') || url.searchParams.get('path'));
  if (!p) throw new HttpError(404, 'no project matches');
  return p;
});
route('POST', '/api/projects', async (req) => { const p = await store.createProject(await readJson(req)); broadcast('change', { project: p.id }); return created(p); });
route('PATCH', '/api/projects/([\\w-]+)', async (req, url, [id]) => { const p = await store.updateProject(id, await readJson(req)); broadcast('change', { project: id }); return p; });
route('DELETE', '/api/projects/([\\w-]+)', async (req, url, [id]) => { await store.deleteProject(id); broadcast('change', { project: id }); return NO_CONTENT; });

route('GET', '/api/comments', async (req, url) => {
  const s = url.searchParams;
  let project = s.get('project');
  if (project) {
    const p = await store.resolveProject(project);
    if (!p) throw new HttpError(404, `project "${project}" not found`);
    project = p.id;
  }
  return store.listComments({ project, status: s.get('status'), q: s.get('q'), limit: s.get('limit'), archived: s.get('archived') });
});
route('POST', '/api/comments', async (req) => {
  const body = await readJson(req);
  const c = await store.createComment({ ...body, actor: actorOf(req, body) });
  broadcast('change', { id: c.id, status: c.status });
  return created(c);
});
route('GET', '/api/comments/(\\d+)', (req, url, [id]) => store.getComment(id));
route('PATCH', '/api/comments/(\\d+)', async (req, url, [id]) => {
  const body = await readJson(req);
  const c = await store.updateComment(id, { ...body, actor: actorOf(req, body) });
  broadcast('change', { id: c.id });
  return c;
});
route('POST', '/api/comments/(\\d+)/status', async (req, url, [id]) => {
  const body = await readJson(req);
  const c = await store.setStatus(id, { ...body, actor: actorOf(req, body) });
  broadcast('change', { id: c.id, status: c.status });
  return c;
});
route('POST', '/api/comments/(\\d+)/notes', async (req, url, [id]) => {
  const body = await readJson(req);
  const c = await store.addNote(id, { ...body, actor: actorOf(req, body) });
  broadcast('change', { id: c.id });
  return c;
});
route('DELETE', '/api/comments/(\\d+)', async (req, url, [id]) => { await store.deleteComment(id); broadcast('change', { id: Number(id) }); return NO_CONTENT; });

// ---------- local-only actions: open a file in your editor, ask Claude Code to fix a comment ----------
// Only on a localhost server, from this machine, with an x-goodcomments header that other sites can't send.
function localOnly(req) {
  const from = req.socket.remoteAddress || '';
  if (!/^(127\.|::1$|::ffff:127\.)/.test(from)) throw new HttpError(403, 'only on a local GoodComments server');
  if (req.headers['x-goodcomments'] === undefined) throw new HttpError(400, 'send an x-goodcomments header');
}
route('POST', '/api/comments/(\\d+)/open', async (req, url, [id]) => {
  localOnly(req);
  const c = await store.getComment(id);
  if (!c.location) throw new HttpError(400, 'this comment has no location');
  if (/^https?:\/\//i.test(c.location)) throw new HttpError(400, 'that’s a web address: open it in the browser');
  return openInEditor(resolveFile(c.project_id && await store.getProject(c.project_id), c.location));
});

// The project dialog's Choose… button, from a browser on this Mac (the Mac panel uses its own picker).
route('POST', '/api/choose-folder', async (req) => { localOnly(req); return { path: await chooseFolder() }; });

route('GET', '/api/agent-runs', () => agentRuns());
route('POST', '/api/comments/(\\d+)/agent', async (req, url, [id]) => {
  localOnly(req);
  const c = await store.getComment(id);
  const run = await openSession(c, c.project_id && await store.getProject(c.project_id));
  broadcast('agent', { id: c.id, ...run });
  return created(run);
});

// Clean the pile: archive done comments (all, { project }, or { ids }); restore with { ids }.
route('POST', '/api/pile/clean', async (req) => {
  const body = await readJson(req);
  const ids = await store.cleanPile({ ...body, actor: actorOf(req, body) });
  broadcast('change', { pile: 'cleaned' });
  return { archived: ids };
});

// Settings (for now: auto clean-up of the pile).
route('GET', '/api/settings', async () => store.getSettings());
route('PATCH', '/api/settings', async (req) => {
  const settings = await store.updateSettings(await readJson(req));
  broadcast('change', { settings: true });
  autoClean().then(forgetOldFiles);
  return settings;
});
// Before saving a rule for deleting screenshots: how many it would delete right away.
route('GET', '/api/files/expiring', async (req, url) => {
  const hours = Number(url.searchParams.get('hours'));
  if (!Number.isInteger(hours) || hours < 1) throw new HttpError(400, 'hours must be a whole number from 1');
  return { count: await store.countOldFiles({ olderThan: new Date(Date.now() - hours * 3600000).toISOString(), from: url.searchParams.get('from') || 'archived' }) };
});
route('POST', '/api/pile/restore', async (req) => {
  const body = await readJson(req);
  const ids = await store.restorePile({ ...body, actor: actorOf(req, body) });
  broadcast('change', { pile: 'restored' });
  return { restored: ids };
});

// Attachments: send the raw file as the body with its own content-type
// (image/png, image/jpeg, …, application/pdf) and an optional x-filename header.
route('POST', '/api/comments/(\\d+)/attachments', async (req, url, [id]) => {
  const type = contentType(req);
  // the x-filename header can't be sent by a plain cross-site form, so other sites can't post files here
  if (req.headers['x-filename'] === undefined) throw new HttpError(400, 'send the file name in an x-filename header');
  const data = await readBody(req, store.MAX_ATTACHMENT + 1);
  const name = decodeURIComponent(req.headers['x-filename'] || '') || null;
  const a = await store.addAttachment(id, { name, type, data, actor: actorOf(req) });
  broadcast('change', { id: Number(id) });
  return created(a);
});
route('DELETE', '/api/attachments/(\\d+)', async (req, url, [id]) => { await store.deleteAttachment(id); broadcast('change', {}); return NO_CONTENT; });

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!hostAllowed(req)) throw new HttpError(403, 'host not allowed');

    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    // Agent docs and static web UI
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (file.toLowerCase() === '/agents.md') file = join(ROOT, 'AGENTS.md');
    else file = join(WEB, normalize(file));
    if (!file.startsWith(WEB) && !file.endsWith('AGENTS.md')) throw new HttpError(404, 'not found');
    const data = await readFile(file).catch(() => { throw new HttpError(404, 'not found'); });
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message });
    else res.end();
  }
});

/** One API request. */
async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }
  const att = req.method === 'GET' && url.pathname.match(/^\/api\/attachments\/(\d+)$/);
  if (att) {
    const a = await store.getAttachment(att[1]);
    // images and PDFs open in place; any other document downloads, sandboxed
    const inline = /^(image\/(png|jpeg|gif|webp|heic)|application\/pdf)$/.test(a.type);
    res.writeHead(200, {
      'content-type': a.type,
      'content-length': a.data.length,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    });
    return res.end(a.data);
  }
  for (const r of routes) {
    const m = r.method === req.method && url.pathname.match(r.re);
    if (!m) continue;
    const out = await r.fn(req, url, m.slice(1));
    if (out?.[RAW] !== undefined) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(out[RAW]);
    }
    return out?.[STATUS] ? send(res, out[STATUS], out.body) : send(res, 200, out);
  }
  throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') { console.error(`GoodComments: port ${PORT} is already in use (probably already running).`); process.exit(1); }
  throw err;
});
// Auto clean-up: archive done comments once they've sat on the pile longer than the chosen window (checked hourly).
async function autoClean() {
  try {
    const { auto_clean_days: days } = await store.getSettings();
    if (!days) return;
    const ids = await store.cleanPile({ olderThan: new Date(Date.now() - days * 86400000).toISOString(), actor: 'auto clean-up' });
    if (ids.length) broadcast('change', { pile: 'cleaned' });
  } catch (err) { console.error('auto clean-up failed:', err.message); }
}
// Screenshots are deleted once their clock (from the clean-up, the approval or the upload) passes what Settings keeps.
async function forgetOldFiles() {
  try {
    const { files_auto_delete: on, files_delete_after_hours: hours, files_delete_from: from } = await store.getSettings();
    if (!on) return;
    const total = await store.forgetOldFiles({ olderThan: new Date(Date.now() - hours * 3600000).toISOString(), from, actor: 'auto clean-up' });
    if (total) {
      broadcast('change', {});
      await store.compact();
      console.log(`GoodComments: deleted ${total} old attachment(s) of cleaned-up comments`);
    }
  } catch (err) { console.error('deleting old attachments failed:', err.message); }
}
setInterval(() => autoClean(), 60 * 60 * 1000).unref();
setInterval(() => forgetOldFiles(), 10 * 60 * 1000).unref();   // every 10 minutes: the shortest setting is an hour

server.listen(PORT, HOST, () => {
  autoClean().then(forgetOldFiles);
  console.log(`GoodComments running at http://${HOST}:${PORT}  (${store.DB_PATH})`);
});
