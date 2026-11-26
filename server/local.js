// Things only the local server does, on your own Mac: open a comment's file in
// your editor, and ask Claude Code to fix a comment. index.js only lets these run
// on a localhost server, from localhost, with an x-goodcomments header (a page on
// another site can't send that without a CORS preflight, which is never approved).
import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { HttpError } from './db.js';

// ---------- open where it is ----------

/** "src/app.js:42:7" → { file, line, col }, resolved inside the project's folder (symlinks and .. can't escape it). */
/** A folder picker on this Mac (for a project's Repo folder from a browser): its path, or null if cancelled. */
export function chooseFolder() {
  return new Promise((done, fail) => {
    execFile('osascript', ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "Choose the project’s folder")'],
      { timeout: 10 * 60e3 }, (err, out) => {
        if (err) return /-128|cancel/i.test(String(err.message)) ? done(null) : fail(new HttpError(500, 'couldn’t open the folder picker'));
        done(out.trim().replace(/\/$/, '') || null);
      });
  });
}

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

const runs = new Map();   // comment id → { state: 'session', started, folder }: the last session opened for it
export const agentRuns = () => Object.fromEntries(runs);

/** Whether the Claude app (which opens claude:// links) is installed on this Mac. */
export const claudeApp = () => ['/Applications/Claude.app', join(homedir(), 'Applications/Claude.app')].some((p) => existsSync(p));

function taskFor(c, { dir, from } = {}) {
  const shots = (c.attachments || []).length;
  const { id } = c;
  return [
    `Fix this piece of feedback, tracked in GoodComments as comment #${id}${c.project_name ? ` (project ${c.project_name})` : ''}.`,
    '',
    `Comment: ${c.body}`,
    c.location ? `Where: ${c.location}` : '',
    c.source ? `From: ${c.source}` : '',
    c.status === 'open' && c.reopen_note ? `It was reopened before. What's still wrong: ${c.reopen_note}` : '',
    shots ? `It has ${shots} attachment(s).` : '',
    '',
    dir ? `You're in ${dir} (${from}). Work out the rest of the environment from the comment before changing anything:` : '',
    dir ? '- the files or pages its "Where" names, and how this project is built, run and deployed here (README, AGENTS.md / CLAUDE.md, package.json and the like);' : '',
    dir ? '- whether it is about the local app or a live site, and check the result there.' : '',
    '',
    'Make the change in this folder, keeping it focused on this comment.',
    `When it's done, call the GoodComments mark_fixed tool with id ${id} and a note: what you changed and where (files, pages, URLs), so the owner can check it in seconds.`,
    'Give it links to check the change at (links: the page, a preview URL) and, if you have screenshots or files that show the result, their paths (files): they show with the fix.',
    `If the comment is unclear or you're blocked, don't guess: call add_note with id ${id} saying what you need, and stop.`,
    `(get_comment ${id} shows its history and screenshots.)`,
    'Never mark a comment done and never delete comments.',
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
}

/**
 * Where the session works, derived from the comment: its project's folder, or else — for a comment whose
 * location is an absolute path on this Mac — the git repo (or folder) that path is in.
 */
export function folderFor(c, project) {
  if (project?.path) {
    try { return { dir: realpathSync(project.path), from: `${project.name}'s folder` }; }
    catch { throw new HttpError(404, `${project.name}'s folder doesn't exist: ${project.path}`); }
  }
  const loc = String(c.location || '').trim().replace(/:\d+(?::\d+)?$/, '').replace(/^~(?=\/|$)/, homedir());
  if (isAbsolute(loc)) {
    let dir = loc;
    while (dir !== dirname(dir)) {
      try { if (statSync(dir).isDirectory()) break; } catch { /* not there: try its parent */ }
      dir = dirname(dir);
    }
    for (let d = dir; d !== dirname(d); d = dirname(d)) if (existsSync(join(d, '.git'))) return { dir: realpathSync(d), from: 'the repo its location is in' };
    if (dir !== dirname(dir)) return { dir: realpathSync(dir), from: 'the folder its location is in' };
  }
  throw new HttpError(400, 'give the project a folder first (double-click its chip), so Claude knows where to work');
}

/**
 * Open a new Claude Code session in the Claude app for this comment: in the folder the comment points to, with the
 * task filled in (claude://code/new?folder=…&q=…). You read it, send it, watch and steer it; it moves the card to
 * To check itself (mark_fixed, through your GoodComments MCP server or `gc`).
 */
export async function openSession(c, project) {
  if (c.status !== 'open') throw new HttpError(409, `it's already ${c.status === 'fixed' ? 'waiting to be checked' : 'done'}`);
  const { dir, from } = folderFor(c, project);
  const q = new URLSearchParams({ folder: dir, q: taskFor(c, { dir, from }), source: 'goodcomments' });
  const link = `claude://code/new?${q.toString().replace(/\+/g, '%20')}`;
  await new Promise((ok, fail) => execFile('open', [link], (err) =>
    err ? fail(new HttpError(424, 'couldn’t open the Claude app: install it from https://claude.com/download and sign in')) : ok()));
  const run = { state: 'session', started: new Date().toISOString(), folder: dir };
  runs.set(c.id, run);
  return run;
}
