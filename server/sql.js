// The SQL executor db.js speaks to: a SQLite file through Node's built-in node:sqlite,
// behind an async interface: all(sql, args), get(sql, args), run(sql, args), exec(sql).
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function openDatabase() {
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
