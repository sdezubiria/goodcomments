// GoodComments server: JSON API + live events + the web column.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import { normalize as normalizeInbox } from './inbox.js';
import { agentRuns, claudePath, openInEditor, resolveFile, startAgent } from './local.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || process.env.GOODCOMMENTS_PORT || 4477);
const HOST = process.env.GOODCOMMENTS_HOST || '127.0.0.1';
const LOCAL = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const TOKEN = process.env.GOODCOMMENTS_TOKEN || null;        // required on /api when set
const INBOX_KEY = process.env.GOODCOMMENTS_INBOX_KEY || null; // enables POST /api/inbox?key=…

if (!LOCAL && !TOKEN) {
  console.error('GoodComments: refusing to listen on a public address without GOODCOMMENTS_TOKEN.');
  process.exit(1);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };

// ---------- live updates (Server-Sent Events) ----------
const listeners = new Set();
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

const safeEqual = (a, b) => !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The Host check stops DNS-rebinding tricks against the local server.
function hostAllowed(req) {
  if (!LOCAL) return true;
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function authorized(req, url) {
  if (!TOKEN) return true;
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return safeEqual(header, TOKEN) || safeEqual(url.searchParams.get('token') || '', TOKEN);
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });
const STATUS = Symbol('status');
const created = (body) => ({ [STATUS]: 201, body });
const NO_CONTENT = { [STATUS]: 204 };
const RAW = Symbol('raw');   // plain text answer
const actorOf = (req, body) => body?.actor || req.headers['x-actor'] || 'you';

route('GET', '/api/health', () => ({ ok: true, name: 'goodcomments', storage: store.DB_KIND, db: store.DB_PATH, inbox: !!INBOX_KEY, local: LOCAL, claude: LOCAL && !!claudePath() }));

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
  if (!LOCAL || !/^(127\.|::1$|::ffff:127\.)/.test(from)) throw new HttpError(403, 'only on a local GoodComments server');
  if (req.headers['x-goodcomments'] === undefined) throw new HttpError(400, 'send an x-goodcomments header');
}
// logs live next to the database (~/.goodcomments by default)
const LOG_DIR = store.DB_KIND === 'sqlite' ? dirname(store.DB_PATH) : join(homedir(), '.goodcomments');

route('POST', '/api/comments/(\\d+)/open', async (req, url, [id]) => {
  localOnly(req);
  const c = await store.getComment(id);
  if (!c.location) throw new HttpError(400, 'this comment has no location');
  if (/^https?:\/\//i.test(c.location)) throw new HttpError(400, 'that’s a web address: open it in the browser');
  return openInEditor(resolveFile(await store.getProject(c.project_id), c.location));
});

route('GET', '/api/agent-runs', () => (LOCAL ? agentRuns() : {}));
route('POST', '/api/comments/(\\d+)/agent', async (req, url, [id]) => {
  localOnly(req);
  const c = await store.getComment(id);
  const run = startAgent(c, await store.getProject(c.project_id), {
    port: PORT,
    logDir: LOG_DIR,
    onEnd: async (cid, r) => {
      const now = await store.getComment(cid).catch(() => null);
      if (now?.status === 'fixed') r.state = 'fixed';
      else if (now && r.state === 'finished') {
        r.state = 'stopped';
        await store.addNote(cid, { actor: 'claude', note: `The agent stopped without marking it fixed. Log: ${r.log}` }).catch(() => {});
      } else if (now) {
        const tail = await readFile(r.log, 'utf8').then((t) => t.slice(-2000), () => '');
        if (/not logged in|\/login/i.test(tail)) r.error = 'Claude Code isn’t signed in: run claude once in Terminal and sign in';
        await store.addNote(cid, { actor: 'claude', note: `The agent run failed${r.error ? `: ${r.error}` : r.code != null ? ` (exit ${r.code})` : ''}. Log: ${r.log}` }).catch(() => {});
      }
      broadcast('agent', { id: cid, ...r });
      broadcast('change', { id: cid });
    },
  });
  broadcast('agent', { id: c.id, ...run });
  return created(run);
});
route('GET', '/api/comments/(\\d+)/agent/log', async (req, url, [id]) => {
  const run = LOCAL && agentRuns()[id];
  const path = run?.log || join(LOG_DIR, `agent-${Number(id)}.log`);
  const text = await readFile(path, 'utf8').catch(() => { throw new HttpError(404, 'no agent log for this comment'); });
  return { [RAW]: text.slice(-200000) };
});

// Clean the pile: archive done comments (all, { project }, or { ids }); restore with { ids }.
route('POST', '/api/pile/clean', async (req) => {
  const body = await readJson(req);
  const ids = await store.cleanPile({ ...body, actor: actorOf(req, body) });
  broadcast('change', { pile: 'cleaned' });
  return { archived: ids };
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

// Inbox: one URL for email services, Slack slash commands, Shortcuts and scripts.
// Webhooks can't always set headers, so it's protected by ?key= instead of the token.
async function inbox(req, res, url) {
  if (!INBOX_KEY) throw new HttpError(404, 'inbox is off — start the server with GOODCOMMENTS_INBOX_KEY=<secret>');
  if (!safeEqual(url.searchParams.get('key') || '', INBOX_KEY)) throw new HttpError(401, 'wrong inbox key');
  const type = contentType(req);
  const raw = await readBody(req, 25e6);
  let fields;
  if (type === 'application/json') {
    try { fields = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
  } else if (type === 'application/x-www-form-urlencoded') {
    fields = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  } else if (type === 'text/plain' || type === '') {
    fields = { text: raw.toString('utf8') };
  } else {
    throw new HttpError(415, 'inbox accepts JSON, form-encoded or plain text');
  }

  const { comment, attachments, reply, original } = normalizeInbox(fields, url.searchParams);
  const actor = comment.author || comment.source;
  let c;
  try {
    try {
      c = await store.createComment({ ...comment, actor });
    } catch (err) {
      // never lose a message over a mistyped project tag: keep it, unassigned
      if (err.status !== 404 || !comment.project) throw err;
      c = await store.createComment({ ...comment, body: original, project: null, actor });
    }
  } catch (err) {
    if (reply === 'slack') return send(res, 200, { response_type: 'ephemeral', text: `GoodComments: ${err.message}` });
    throw err;
  }
  for (const a of attachments) await store.addAttachment(c.id, a).catch(() => {});
  broadcast('change', { id: c.id, status: c.status });
  if (reply === 'slack') return send(res, 200, { response_type: 'ephemeral', text: `Hung #${c.id} on ${c.project_name || 'no project'}` });
  return send(res, 201, { id: c.id, project: c.project_id });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!hostAllowed(req)) throw new HttpError(403, 'host not allowed');

    if (req.method === 'POST' && url.pathname === '/api/inbox') return await inbox(req, res, url);

    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) throw new HttpError(401, 'missing or wrong token');
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') { console.error(`GoodComments: port ${PORT} is already in use (probably already running).`); process.exit(1); }
  throw err;
});
server.listen(PORT, HOST, () => {
  console.log(`GoodComments running at http://${HOST}:${PORT}  (${store.DB_KIND}: ${store.DB_PATH})${TOKEN ? '  [token required]' : ''}${INBOX_KEY ? '  [inbox on]' : ''}`);
});
