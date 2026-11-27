// Starts `gc mcp` with an empty home folder and checks it answers MCP requests:
// initialize, tools/list, and a tool call that starts the local board server.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const home = mkdtempSync(join(tmpdir(), 'gc-smoke-'));
const port = String(4600 + Math.floor(Math.random() * 300));
const env = { ...process.env, HOME: home, GOODCOMMENTS_PORT: port, GOODCOMMENTS_ACTOR: 'ci' };
const mcp = spawn(process.execPath, ['--no-warnings', 'bin/gc.js', 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let buf = '';
mcp.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  }
});
let nextId = 1;
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

try {
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'goodcomments');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await call('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['list_comments', 'get_comment', 'add_comment', 'mark_fixed', 'add_note']) assert.ok(names.includes(n), `missing tool ${n}`);

  const added = await call('tools/call', { name: 'add_comment', arguments: { body: 'CI smoke test' } });
  assert.ok(!added.result.isError, added.result.content?.[0]?.text);
  const listed = await call('tools/call', { name: 'list_comments', arguments: { project: 'all' } });
  assert.match(listed.result.content[0].text, /CI smoke test/);

  console.log(`ok: ${names.length} tools, add_comment and list_comments work`);
} finally {
  mcp.kill();
  // the board server was started detached: stop the process listening on its port
  spawn('sh', ['-c', `kill $(lsof -tiTCP:${port} -sTCP:LISTEN) 2>/dev/null`]).on('exit', () => rmSync(home, { recursive: true, force: true }));
}
