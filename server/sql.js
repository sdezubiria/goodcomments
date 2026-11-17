// SQL executors. db.js speaks plain SQLite SQL to one of these:
//   local  — a SQLite file through Node's built-in node:sqlite (default)
//   libsql — a hosted Turso / libSQL database over its HTTP API (set GOODCOMMENTS_LIBSQL_URL)
// Both expose the same async interface: all(sql, args), get(sql, args), run(sql, args), exec(sql).
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function openDatabase() {
  const url = process.env.GOODCOMMENTS_LIBSQL_URL;
  if (url) return libsql(url, process.env.GOODCOMMENTS_LIBSQL_TOKEN);
  return local(process.env.GOODCOMMENTS_DB || join(homedir(), '.goodcomments', 'goodcomments.db'));
}

async function local(path) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
  const fix = (args) => args.map((a) => (a instanceof Buffer ? new Uint8Array(a) : a));
  return {
    kind: 'sqlite',
    where: path,
    all: async (sql, args = []) => db.prepare(sql).all(...fix(args)),
    get: async (sql, args = []) => db.prepare(sql).get(...fix(args)) ?? null,
    run: async (sql, args = []) => {
      const r = db.prepare(sql).run(...fix(args));
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    exec: async (sql) => db.exec(sql),
  };
}

// Turso / libSQL "Hrana over HTTP" (v2 pipeline). https://docs.turso.tech/sdk/http/reference
async function libsql(url, token) {
  const endpoint = url.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
  const encode = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
    if (v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
    return { type: 'text', value: String(v) };
  };
  const decode = (v) => {
    switch (v.type) {
      case 'null': return null;
      case 'integer': return Number(v.value);
      case 'float': return Number(v.value);
      case 'blob': return Buffer.from(v.base64, 'base64');
      default: return v.value;
    }
  };
  async function execute(stmts) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ requests: [...stmts.map((s) => ({ type: 'execute', stmt: s })), { type: 'close' }] }),
    });
    if (!res.ok) throw new Error(`libsql ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.results.slice(0, stmts.length).map((r) => {
      if (r.type === 'error') throw new Error(`libsql: ${r.error.message}`);
      return r.response.result;
    });
  }
  const rows = (result) => result.rows.map((row) =>
    Object.fromEntries(result.cols.map((c, i) => [c.name, decode(row[i])])));
  const one = async (sql, args) => (await execute([{ sql, args: args.map(encode) }]))[0];

  // Foreign keys are on per connection; every pipeline is a fresh one, so turn them on each time we write.
  const fk = { sql: 'pragma foreign_keys = on' };
  return {
    kind: 'libsql',
    where: url.replace(/\?.*$/, ''),
    all: async (sql, args = []) => rows(await one(sql, args)),
    get: async (sql, args = []) => rows(await one(sql, args))[0] ?? null,
    run: async (sql, args = []) => {
      const [, r] = await execute([fk, { sql, args: args.map(encode) }]);
      return { lastInsertRowid: Number(r.last_insert_rowid), changes: r.affected_row_count };
    },
    exec: async (sql) => {
      const parts = sql.split(';').map((s) => s.trim()).filter((s) => s && !/^pragma\s+journal_mode/i.test(s));
      if (parts.length) await execute(parts.map((s) => ({ sql: s })));
    },
  };
}
