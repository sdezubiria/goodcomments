// Storage layer. All queries live here and run through an executor from sql.js
// (local SQLite file, or a hosted Turso/libSQL database). Every function is async.
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { openDatabase } from './sql.js';

export const STATUSES = ['open', 'fixed', 'done'];
const PALETTE = ['#7c5cff', '#ff7a59', '#2bb3a3', '#3b82f6', '#e5487a', '#f2a93b', '#6c8a3a', '#9b6bd6'];
export const MAX_ATTACHMENT = 8 * 1024 * 1024;

const db = await openDatabase();
export const DB_KIND = db.kind;
export const DB_PATH = db.where;

await db.exec(`
  create table if not exists projects (
    id          text primary key,
    name        text not null,
    color       text not null,
    path        text,
    created_at  text not null
  );
  create table if not exists comments (
    id          integer primary key autoincrement,
    project_id  text references projects(id) on delete set null,
    body        text not null,
    source      text,
    author      text,
    location    text,
    status      text not null default 'open' check (status in ('open','fixed','done')),
    fix_note    text,
    fixed_by    text,
    fixed_at    text,
    done_at     text,
    created_at  text not null,
    updated_at  text not null
  );
  create index if not exists comments_status on comments(status, project_id);
  create table if not exists events (
    id          integer primary key autoincrement,
    comment_id  integer not null references comments(id) on delete cascade,
    at          text not null,
    actor       text,
    type        text not null,
    note        text
  );
  create table if not exists attachments (
    id          integer primary key autoincrement,
    comment_id  integer not null references comments(id) on delete cascade,
    name        text,
    type        text not null,
    size        integer not null,
    data        blob not null,
    created_at  text not null
  );
  create index if not exists attachments_comment on attachments(comment_id)
`);

const now = () => new Date().toISOString();
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

// ---------- projects ----------

export async function listProjects() {
  const rows = await db.all(`
    select p.*,
      sum(c.status = 'open')  as open,
      sum(c.status = 'fixed') as fixed,
      sum(c.status = 'done')  as done
    from projects p left join comments c on c.project_id = p.id
    group by p.id order by p.name collate nocase
  `);
  return rows.map((p) => ({ ...p, open: p.open || 0, fixed: p.fixed || 0, done: p.done || 0 }));
}

export const getProject = (id) => db.get('select * from projects where id = ?', [id]);

/** Find a project by id, by name, or by a filesystem path inside its folder. */
export async function resolveProject(ref) {
  if (!ref) return null;
  const byId = (await getProject(ref)) || (await getProject(slugify(ref)));
  if (byId) return byId;
  const byName = await db.get('select * from projects where lower(name) = lower(?)', [ref]);
  if (byName) return byName;
  if (ref.startsWith('/') || ref.startsWith('~')) {
    const target = resolve(ref.replace(/^~/, homedir()));
    const withPath = await db.all('select * from projects where path is not null');
    // longest matching path wins (nested repos)
    return withPath
      .filter((p) => target === p.path || target.startsWith(p.path + sep))
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
  }
  return null;
}

export async function createProject({ name, color, path, id }) {
  name = clean(name);
  if (!name) throw new HttpError(400, 'name is required');
  const pid = slugify(id || name);
  if (await getProject(pid)) throw new HttpError(409, `project "${pid}" already exists`);
  const { n } = await db.get('select count(*) n from projects');
  await db.run('insert into projects (id, name, color, path, created_at) values (?, ?, ?, ?, ?)',
    [pid, name, clean(color) || PALETTE[n % PALETTE.length], normPath(path), now()]);
  return getProject(pid);
}

export async function updateProject(id, { name, color, path }) {
  const p = await getProject(id);
  if (!p) throw new HttpError(404, `project "${id}" not found`);
  await db.run('update projects set name = ?, color = ?, path = ? where id = ?', [
    clean(name) ?? p.name, clean(color) ?? p.color, path === undefined ? p.path : normPath(path), id]);
  return getProject(id);
}

export async function deleteProject(id) {
  if (!(await getProject(id))) throw new HttpError(404, `project "${id}" not found`);
  await db.run('delete from projects where id = ?', [id]);
}

function normPath(p) {
  p = clean(p);
  return p ? resolve(p.replace(/^~/, homedir())).replace(/\/$/, '') : null;
}

// ---------- comments ----------

const SELECT = `
  select c.*, p.name as project_name, p.color as project_color,
    (select json_group_array(json_object('id', a.id, 'name', a.name, 'type', a.type, 'size', a.size, 'created_at', a.created_at))
       from attachments a where a.comment_id = c.id) as attachments,
    (select e.note from events e where e.comment_id = c.id and e.type = 'reopened' order by e.id desc limit 1) as reopen_note,
    (select e.at from events e where e.comment_id = c.id and e.type = 'reopened' order by e.id desc limit 1) as reopened_at,
    (select e.actor from events e where e.comment_id = c.id and e.type = 'reopened' order by e.id desc limit 1) as reopened_by
  from comments c left join projects p on p.id = c.project_id`;

const withAttachments = (c) => c && { ...c, attachments: JSON.parse(c.attachments || '[]') };

export async function listComments({ project, status, q, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (project) { where.push('c.project_id = ?'); args.push(project); }
  if (status && status !== 'all') {
    const list = String(status).split(',').filter((s) => STATUSES.includes(s));
    if (list.length) { where.push(`c.status in (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (q) {
    where.push('(c.body like ? or c.source like ? or c.location like ? or c.fix_note like ?)');
    args.push(...Array(4).fill(`%${q}%`));
  }
  const rows = await db.all(`${SELECT}
    ${where.length ? 'where ' + where.join(' and ') : ''}
    order by case c.status when 'fixed' then 0 when 'open' then 1 else 2 end,
             coalesce(c.done_at, c.fixed_at, c.created_at) desc
    limit ?`, [...args, Number(limit) || 500]);
  return rows.map(withAttachments);
}

export async function getComment(id) {
  const c = withAttachments(await db.get(`${SELECT} where c.id = ?`, [Number(id)]));
  if (!c) throw new HttpError(404, `comment #${id} not found`);
  c.events = await db.all('select at, actor, type, note from events where comment_id = ? order by id', [c.id]);
  return c;
}

const logEvent = (commentId, type, actor, note) =>
  db.run('insert into events (comment_id, at, actor, type, note) values (?, ?, ?, ?, ?)',
    [commentId, now(), clean(actor), type, clean(note)]);

async function projectIdFrom(ref) {
  if (!ref) return null;
  const p = await resolveProject(ref);
  if (!p) throw new HttpError(404, `project "${ref}" not found — create it first`);
  return p.id;
}

export async function createComment({ body, project, source, author, location, actor }) {
  body = clean(body);
  if (!body) throw new HttpError(400, 'body is required');
  const t = now();
  const { lastInsertRowid } = await db.run(`
    insert into comments (project_id, body, source, author, location, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)`,
    [await projectIdFrom(project), body, clean(source), clean(author), clean(location), t, t]);
  await logEvent(lastInsertRowid, 'created', actor || author, null);
  return getComment(lastInsertRowid);
}

export async function updateComment(id, fields) {
  const c = await getComment(id);
  const next = {
    body: fields.body !== undefined ? clean(fields.body) : c.body,
    source: fields.source !== undefined ? clean(fields.source) : c.source,
    author: fields.author !== undefined ? clean(fields.author) : c.author,
    location: fields.location !== undefined ? clean(fields.location) : c.location,
    project_id: fields.project !== undefined ? await projectIdFrom(fields.project) : c.project_id,
  };
  if (!next.body) throw new HttpError(400, 'body cannot be empty');
  await db.run('update comments set body=?, source=?, author=?, location=?, project_id=?, updated_at=? where id=?',
    [next.body, next.source, next.author, next.location, next.project_id, now(), c.id]);
  await logEvent(c.id, 'edited', fields.actor, null);
  return getComment(c.id);
}

/**
 * open  → fixed : someone (usually an agent) says it's handled. A note is required.
 * fixed → done  : you checked it. Only humans should do this.
 * any   → open  : reopen, with a note saying what's still wrong.
 */
export async function setStatus(id, { status, note, actor }) {
  if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
  const c = await getComment(id);
  if (c.status === status) throw new HttpError(409, `comment #${c.id} is already ${status}`);
  if (status === 'fixed' && !clean(note)) throw new HttpError(400, 'a note describing the fix is required');
  const t = now();
  if (status === 'fixed') {
    await db.run('update comments set status=?, fix_note=?, fixed_by=?, fixed_at=?, done_at=null, updated_at=? where id=?',
      ['fixed', clean(note), clean(actor), t, t, c.id]);
  } else if (status === 'done') {
    await db.run('update comments set status=?, done_at=?, updated_at=? where id=?', ['done', t, t, c.id]);
  } else {
    await db.run('update comments set status=?, done_at=null, updated_at=? where id=?', ['open', t, c.id]);
  }
  await logEvent(c.id, status === 'open' ? 'reopened' : status, actor, note);
  return getComment(c.id);
}

export async function addNote(id, { note, actor }) {
  const c = await getComment(id);
  if (!clean(note)) throw new HttpError(400, 'note is required');
  await logEvent(c.id, 'note', actor, note);
  await db.run('update comments set updated_at=? where id=?', [now(), c.id]);
  return getComment(c.id);
}

export async function deleteComment(id) {
  const c = await getComment(id);
  await db.run('delete from comments where id = ?', [c.id]);
}

// ---------- attachments (screenshots, images, PDFs) ----------

export async function addAttachment(commentId, { name, type, data, actor }) {
  const c = await getComment(commentId);
  if (!/^(image\/(png|jpeg|gif|webp|heic)|application\/pdf)$/.test(type || '')) {
    throw new HttpError(415, 'attachments must be PNG, JPEG, GIF, WebP, HEIC or PDF');
  }
  if (!data?.length) throw new HttpError(400, 'empty file');
  if (data.length > MAX_ATTACHMENT) throw new HttpError(413, 'file is larger than 8 MB');
  const { lastInsertRowid } = await db.run(
    'insert into attachments (comment_id, name, type, size, data, created_at) values (?, ?, ?, ?, ?, ?)',
    [c.id, clean(name) || 'screenshot', type, data.length, data, now()]);
  await logEvent(c.id, 'attached', actor, clean(name) || 'screenshot');
  return { id: lastInsertRowid, comment_id: c.id, name: clean(name) || 'screenshot', type, size: data.length };
}

export async function getAttachment(id) {
  const a = await db.get('select * from attachments where id = ?', [Number(id)]);
  if (!a) throw new HttpError(404, `attachment ${id} not found`);
  return { ...a, data: Buffer.from(a.data) };
}

export async function deleteAttachment(id) {
  const a = await db.get('select comment_id, name from attachments where id = ?', [Number(id)]);
  if (!a) throw new HttpError(404, `attachment ${id} not found`);
  await db.run('delete from attachments where id = ?', [Number(id)]);
  await logEvent(a.comment_id, 'detached', null, a.name);
}
