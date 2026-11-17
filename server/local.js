// Things only the local server does, on your own Mac: open a comment's file in
// your editor, and ask Claude Code to fix a comment. index.js only lets these run
// on a localhost server, from localhost, with an x-goodcomments header (a page on
// another site can't send that without a CORS preflight, which is never approved).
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, mkdirSync, openSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- open where it is ----------

/** "src/app.js:42:7" → { file, line, col }, resolved inside the project's folder (symlinks and .. can't escape it). */
export function resolveFile(project, location) {
  if (!project?.path) throw new HttpError(400, 'give the project a folder first (double-click its chip)');
  const m = String(location || '').trim().match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
  if (!m) throw new HttpError(400, 'no location');
  const p = m[1].replace(/^~(?=\/|$)/, homedir());
  let root;
  try { root = realpathSync(project.path); } catch { throw new HttpError(404, `${project.name}'s folder doesn't exist: ${project.path}`); }
  // an absolute path must already be inside the folder; "/contact" style paths are tried inside it too
  for (const candidate of isAbsolute(p) ? [p, join(root, p)] : [join(root, p)]) {
    let real;
    try { real = realpathSync(resolve(candidate)); } catch { continue; }
    if (real === root || real.startsWith(root + sep)) return { file: real, line: m[2] ? Number(m[2]) : null, col: m[3] ? Number(m[3]) : null };
  }
  throw new HttpError(404, `no file “${m[1]}” in ${project.name}'s folder`);
}

/** Open in $GOODCOMMENTS_EDITOR when set (VS Code-style editors jump to the line), else with macOS `open`. */
export async function openInEditor({ file, line, col }) {
  const editor = (process.env.GOODCOMMENTS_EDITOR || '').trim();
  const at = line ? `${file}:${line}${col ? `:${col}` : ''}` : file;
  let cmd = 'open';
  let args = [file];
  if (editor) {
    [cmd, ...args] = editor.split(/\s+/);
    const name = basename(cmd);
    if (/^(code|code-insiders|cursor|windsurf|codium)$/.test(name)) args.push('-g', at);
    else if (/^(subl|zed|mate)$/.test(name)) args.push(at);
    else args.push(file);
  }
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail); })
    .catch((err) => { throw new HttpError(400, `couldn't run ${cmd}: ${err.code || err.message}`); });
  child.unref();
  return { opened: file, line, with: cmd };
}

// ---------- ask an agent to fix this ----------

const runs = new Map();   // comment id → { state: running | fixed | stopped | failed, started, ended, code, log }

const isExecutable = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/** Where the `claude` CLI is: $GOODCOMMENTS_CLAUDE, PATH, or the usual install folders. */
export function claudePath() {
  if (process.env.GOODCOMMENTS_CLAUDE) return isExecutable(process.env.GOODCOMMENTS_CLAUDE) ? process.env.GOODCOMMENTS_CLAUDE : null;
  const dirs = [...(process.env.PATH || '').split(delimiter), join(homedir(), '.local/bin'), join(homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) if (d && isExecutable(join(d, 'claude'))) return join(d, 'claude');
  return null;
}

export const INSTALL_HINT = 'Claude Code isn’t installed. Install it with: curl -fsSL https://claude.ai/install.sh | bash — then sign in once by running claude in a terminal, and try again.';

export const agentRuns = () => Object.fromEntries(runs);

const TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep',
  'mcp__goodcomments__get_comment', 'mcp__goodcomments__mark_fixed', 'mcp__goodcomments__add_note',
  'Bash(gc show:*)', 'Bash(gc fix:*)', 'Bash(gc note:*)', 'Bash(git status:*)', 'Bash(git diff:*)'].join(' ');

/**
 * The server may have been started from inside a Claude Code session (an agent's `gc` starts it when it isn't
 * running): don't hand that session's variables to the new agent, or it tries to be part of that session.
 */
function cleanEnv() {
  // inside a session, ANTHROPIC_BASE_URL points at that session's own proxy too
  const session = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$)/;
  const fromSession = 'CLAUDECODE' in process.env;
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !session.test(k) && !(fromSession && k === 'ANTHROPIC_BASE_URL')));
}

function taskFor(c) {
  const shots = (c.attachments || []).length;
  return [
    `Fix this piece of feedback, tracked in GoodComments as comment #${c.id}${c.project_name ? ` (project ${c.project_name})` : ''}.`,
    '',
    `Comment: ${c.body}`,
    c.location ? `Where: ${c.location}` : '',
    c.source ? `From: ${c.source}` : '',
    c.status === 'open' && c.reopen_note ? `It was reopened before. What's still wrong: ${c.reopen_note}` : '',
    shots ? `It has ${shots} attachment(s).` : '',
    '',
    'Make the change in this folder, keeping it focused on this comment.',
    `When it's done, call the GoodComments mark_fixed tool with id ${c.id} and a note: what you changed and where (files, pages, URLs), so the owner can check it in seconds.`,
    `If the comment is unclear or you're blocked, don't guess: call add_note with id ${c.id} saying what you need, and stop.`,
    `(get_comment ${c.id} shows its history and screenshots.)`,
    'Never mark a comment done and never delete comments.',
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
}

/**
 * Run `claude -p` in the project's folder, in the background. One run per comment.
 * onEnd(id, run) is called when it exits (the card then falls to To check on its own, via the fix).
 */
export function startAgent(c, project, { port, logDir, onEnd }) {
  if (!project?.path) throw new HttpError(400, 'give the project a folder first, so the agent knows where to work');
  if (runs.get(c.id)?.state === 'running') throw new HttpError(409, 'an agent is already working on this one');
  if (c.status !== 'open') throw new HttpError(409, `it's already ${c.status === 'fixed' ? 'waiting to be checked' : 'done'}`);
  const claude = claudePath();
  if (!claude) throw new HttpError(424, INSTALL_HINT);

  mkdirSync(logDir, { recursive: true });
  // a `gc` the agent can call, pointing at this server
  const binDir = join(logDir, 'agent-bin');
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, 'gc');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${join(ROOT, 'bin/gc.js')}" "$@"\n`);
  chmodSync(shim, 0o755);

  const log = join(logDir, `agent-${c.id}.log`);
  const fd = openSync(log, 'a');
  const task = taskFor(c);
  const tools = process.env.GOODCOMMENTS_AGENT_TOOLS || TOOLS;
  writeSync(fd, `\n=== ${new Date().toISOString()} · claude -p in ${project.path}\n--- task\n${task}\n--- output\n`);

  // its own GoodComments MCP server, pointed at this board (never the one in your user settings)
  const url = `http://127.0.0.1:${port}`;
  const mcp = JSON.stringify({ mcpServers: { goodcomments: {
    command: process.execPath, args: ['--no-warnings', join(ROOT, 'bin/gc.js'), 'mcp'],
    env: { GOODCOMMENTS_URL: url, GOODCOMMENTS_ACTOR: 'claude', ...(process.env.GOODCOMMENTS_TOKEN ? { GOODCOMMENTS_TOKEN: process.env.GOODCOMMENTS_TOKEN } : {}) },
  } } });
  const child = spawn(claude, ['-p', task, '--allowedTools', tools, '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', mcp], {
    cwd: project.path,
    stdio: ['ignore', fd, fd],
    env: {
      ...cleanEnv(),
      PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
      GOODCOMMENTS_URL: url,
      GOODCOMMENTS_ACTOR: 'claude',
    },
  });
  closeSync(fd);
  const run = { state: 'running', started: new Date().toISOString(), log };
  runs.set(c.id, run);
  const kill = setTimeout(() => child.kill('SIGTERM'), 30 * 60 * 1000);   // never longer than half an hour
  kill.unref();
  let done = false;
  const finish = (code, err) => {
    if (done) return;
    done = true;
    clearTimeout(kill);
    Object.assign(run, { state: err || code ? 'failed' : 'finished', code: code ?? null, ended: new Date().toISOString(), error: err?.message });
    onEnd?.(c.id, run);
  };
  child.on('error', (err) => finish(null, err));
  child.on('exit', (code) => finish(code));
  return run;
}
