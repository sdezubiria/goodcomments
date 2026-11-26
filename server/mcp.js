// MCP server over stdio (newline-delimited JSON-RPC), no dependencies.
// Register with:  claude mcp add goodcomments -- node /path/to/GoodComments/bin/gc.js mcp
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { api, projectForDir, formatComment, fetchAttachment, uploadFile } from './client.js';

const ID = { type: 'integer', description: 'The comment number, as shown: 12.' };

const ACTOR = process.env.GOODCOMMENTS_ACTOR || 'agent';

const INSTRUCTIONS = `GoodComments tracks feedback on projects. Each comment moves open → fixed → done.
- Work from list_comments (defaults to open comments in the project for the current folder).
- After you change code or content for a comment, call mark_fixed with a short note: what you changed and where.
- Never mark comments done: the owner verifies fixed comments and closes them.
- If a comment is unclear or blocked, use add_note instead of guessing.
- When you notice a problem you won't fix now, record it with add_comment.
- Comments may have screenshots: get_comment returns them as images.
- A comment that was reopened says why (REOPENED: …) and may include new screenshots: fix what the note and screenshots describe.
- attach_files adds screenshots of what you changed; remove_attachment takes one off. edit_comment fixes a comment's text, project, source or location.
- Owner-only tools (mark_done, reopen, delete_comment, clean_pile, restore_comments, delete_project): use them only when the owner asks you to in this conversation, never on your own initiative.`;

const OWNER = 'OWNER ONLY: call this only when the owner explicitly asks you to in this conversation, never on your own initiative.';

const projectProp = { type: 'string', description: 'Project id or name. Omit to use the project whose folder contains the current directory.' };

const tools = [
  {
    name: 'list_projects',
    description: 'List projects with counts of open, fixed and done comments.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const ps = await api('GET', '/api/projects');
      if (!ps.length) return 'No projects yet.';
      return ps.map((p) => `${p.id} — ${p.name}: ${p.open} open, ${p.fixed} fixed, ${p.done} done${p.path ? ` (${p.path})` : ''}`).join('\n');
    },
  },
  {
    name: 'list_comments',
    description: 'List comments. Defaults to open comments for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { ...projectProp, description: projectProp.description + ' Use "all" for every project.' },
        status: { type: 'string', enum: ['open', 'fixed', 'done', 'all'], default: 'open' },
        query: { type: 'string', description: 'Text search in comment, source, location and fix note.' },
        archived: { type: 'string', enum: ['only', 'all'], description: 'Include comments cleaned off the pile: "only" for just those, "all" for both. Omit to hide them.' },
      },
    },
    run: async ({ project, status = 'open', query, archived }) => {
      const p = await pickProject(project);
      const qs = new URLSearchParams({ status });
      if (p) qs.set('project', p.id);
      if (query) qs.set('q', query);
      if (archived) qs.set('archived', archived);
      const list = await api('GET', `/api/comments?${qs}`);
      const scope = p ? `project ${p.id}` : 'all projects';
      if (!list.length) return `No ${status === 'all' ? '' : status + ' '}comments in ${scope}.`;
      return `${list.length} ${status === 'all' ? '' : status + ' '}comment(s) in ${scope}:\n\n` + list.map((c) => formatComment(c)).join('\n\n');
    },
  },
  {
    name: 'get_comment',
    description: 'Get one comment with its full history. Screenshots attached to it are returned as images.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    run: async ({ id }) => {
      const c = await api('GET', `/api/comments/${id}`);
      const content = [{ type: 'text', text: formatComment(c, { full: true }) }];
      // newest first: after a reopen, the screenshots of what's still wrong come first
      for (const a of c.attachments.filter((x) => /^image\/(png|jpeg|gif|webp)$/.test(x.type)).sort((x, y) => Math.abs(y.id) - Math.abs(x.id)).slice(0, 4)) {
        const data = await fetchAttachment(a.id).catch(() => null);
        if (data && data.length < 5e6) content.push({ type: 'image', data: data.toString('base64'), mimeType: a.type });
      }
      return content;
    },
  },
  {
    name: 'add_comment',
    description: 'Record a new piece of feedback or an issue you noticed.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The feedback itself, in plain words.' },
        project: projectProp,
        source: { type: 'string', description: 'Where it came from (e.g. Email, Slack, Meeting, Figma, Agent).' },
        location: { type: 'string', description: 'URL, page, file path or screen it refers to.' },
      },
      required: ['body'],
    },
    run: async ({ body, project, source, location }) => {
      const p = await pickProject(project);
      const c = await api('POST', '/api/comments', { body, project: p?.id, source: source || 'Agent', location, actor: ACTOR });
      return `Added:\n${formatComment(c)}`;
    },
  },
  {
    name: 'mark_fixed',
    description: 'Mark a comment as fixed once your change is in place. The owner will verify it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        note: { type: 'string', description: 'What you changed and where (files, pages), so the owner can check it quickly. Web addresses in it show as links.' },
        links: { type: 'array', items: { type: 'string' }, description: 'Optional: web addresses to check the change at (the page, a preview, a PR). Added to the note as links.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional: screenshots or files showing the result (absolute paths). They show with the fix.' },
      },
      required: ['id', 'note'],
    },
    run: async ({ id, note, links = [], files = [] }) => {
      const urls = links.filter((u) => /^https?:\/\//.test(u) && !note.includes(u));
      const full = urls.length ? `${note}\n${urls.join('\n')}` : note;
      const c = await api('POST', `/api/comments/${id}/status`, { status: 'fixed', note: full, actor: ACTOR });
      const done = [];
      for (const f of files) done.push((await uploadFile(c.id, resolve(f), ACTOR)).name);
      return `Marked fixed${done.length ? ` with ${done.length} file(s): ${done.join(', ')}` : ''}:\n${formatComment(c)}`;
    },
  },
  {
    name: 'add_note',
    description: 'Add a note to a comment (a question, progress, or why it is blocked) without changing its state.',
    inputSchema: { type: 'object', properties: { id: ID, note: { type: 'string' } }, required: ['id', 'note'] },
    run: async ({ id, note }) => `Noted:\n${formatComment(await api('POST', `/api/comments/${id}/notes`, { note, actor: ACTOR }), { full: true })}`,
  },
  {
    name: 'remove_attachment',
    description: 'Remove a screenshot or file from a comment. Its number is the one in brackets after its name in list_comments / get_comment.',
    inputSchema: { type: 'object', properties: { attachment: { type: 'integer', description: 'The attachment number, e.g. 13.' } }, required: ['attachment'] },
    run: async ({ attachment }) => { await api('DELETE', `/api/attachments/${attachment}`); return `Removed attachment ${attachment}`; },
  },
  {
    name: 'attach_files',
    description: 'Attach screenshots, images or PDFs (local file paths) to a comment, e.g. before/after shots of what you changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        files: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Paths to local files (absolute, or relative to the current folder).' },
      },
      required: ['id', 'files'],
    },
    run: async ({ id, files }) => {
      const done = [];
      for (const f of files) done.push(await uploadFile(id, resolve(f), ACTOR));
      return `Attached ${done.length} file(s) to #${id}: ${done.map((a) => a.name).join(', ')}`;
    },
  },
  {
    name: 'edit_comment',
    description: "Edit a comment's text, project, source or location (only the fields you pass change). Doesn't change its state: use mark_fixed for that.",
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        body: { type: 'string' },
        project: { type: 'string', description: 'Move it to this project (id or name).' },
        source: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['id'],
    },
    run: async ({ id, body, project, source, location }) => {
      const fields = { actor: ACTOR };
      if (body !== undefined) fields.body = body;
      if (project !== undefined) fields.project = (await pickProject(project)).id;
      if (source !== undefined) fields.source = source;
      if (location !== undefined) fields.location = location;
      if (Object.keys(fields).length === 1) throw new Error('pass at least one of body, project, source, location');
      return `Edited:\n${formatComment(await api('PATCH', `/api/comments/${id}`, fields))}`;
    },
  },
  {
    name: 'mark_done',
    description: `Mark a fixed comment done (fixed → done): the owner checked it and approves. ${OWNER}`,
    inputSchema: { type: 'object', properties: { id: ID, note: { type: 'string', description: 'Optional note.' } }, required: ['id'] },
    run: async ({ id, note }) => `Marked done:\n${formatComment(await api('POST', `/api/comments/${id}/status`, { status: 'done', note, actor: ACTOR }))}`,
  },
  {
    name: 'reopen',
    description: `Reopen a fixed or done comment (→ open) with what's still wrong. ${OWNER}`,
    inputSchema: { type: 'object', properties: { id: ID, reason: { type: 'string', description: "What's still wrong." } }, required: ['id', 'reason'] },
    run: async ({ id, reason }) => `Reopened:\n${formatComment(await api('POST', `/api/comments/${id}/status`, { status: 'open', note: reason, actor: ACTOR }))}`,
  },
  {
    name: 'delete_comment',
    description: `Permanently delete a comment and its attachments. Cannot be undone; prefer clean_pile for done comments. ${OWNER}`,
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    run: async ({ id }) => { await api('DELETE', `/api/comments/${id}`); return `Deleted #${id}`; },
  },
  {
    name: 'clean_pile',
    description: `Archive done comments (clean them off the pile). Pass ids, or a project, or "all"; omit both for the current folder's project. Undo with restore_comments. ${OWNER}`,
    inputSchema: {
      type: 'object',
      properties: {
        project: { ...projectProp, description: projectProp.description + ' Use "all" for every project.' },
        ids: { type: 'array', items: ID, description: 'Archive just these done comments.' },
      },
    },
    run: async ({ project, ids }) => {
      const body = { actor: ACTOR };
      if (ids?.length) body.ids = ids;
      else {
        const p = await pickProject(project);
        if (!p && project !== 'all') throw new Error('no project for this folder: pass project (or "all") or ids');
        if (p) body.project = p.id;
      }
      const { archived } = await api('POST', '/api/pile/clean', body);
      return archived.length ? `Archived ${archived.length} done comment(s): ${archived.map((x) => '#' + x).join(' ')}` : 'Nothing to archive: no done comments on the pile.';
    },
  },
  {
    name: 'restore_comments',
    description: `Put archived comments back on the pile (find them with list_comments archived: "only"). ${OWNER}`,
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: ID, minItems: 1 } }, required: ['ids'] },
    run: async ({ ids }) => {
      const { restored } = await api('POST', '/api/pile/restore', { ids, actor: ACTOR });
      return restored.length ? `Restored ${restored.map((x) => '#' + x).join(' ')}` : 'Nothing restored (were they archived?).';
    },
  },
  {
    name: 'create_project',
    description: 'Create a project. Give it the repo folder as path so comments are picked automatically from that folder.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        path: { type: 'string', description: 'Folder of the project (absolute; "." for the current folder).' },
        color: { type: 'string', description: 'Hex color, e.g. #3b82f6.' },
      },
      required: ['name'],
    },
    run: async ({ name, path, color }) => {
      const p = await api('POST', '/api/projects', { name, path: path ? resolve(path) : undefined, color });
      return `Created project ${p.id}${p.path ? ` → ${p.path}` : ''}`;
    },
  },
  {
    name: 'update_project',
    description: "Rename a project or change its folder or color (only the fields you pass change).",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id or name.' },
        name: { type: 'string' },
        path: { type: 'string', description: 'New folder (absolute; "." for the current folder).' },
        color: { type: 'string' },
      },
      required: ['project'],
    },
    run: async ({ project, name, path, color }) => {
      const p = await pickProject(project);
      const u = await api('PATCH', `/api/projects/${p.id}`, { name, path: path ? resolve(path) : undefined, color });
      return `Updated project ${u.id}: ${u.name}${u.path ? ` (${u.path})` : ''}`;
    },
  },
  {
    name: 'delete_project',
    description: `Delete a project. Its comments keep existing, without a project. ${OWNER}`,
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project id or name.' } }, required: ['project'] },
    run: async ({ project }) => {
      const p = await pickProject(project);
      await api('DELETE', `/api/projects/${p.id}`);
      return `Deleted project ${p.id} (its comments keep existing, without a project)`;
    },
  },
];

async function pickProject(ref) {
  if (ref === 'all') return null;
  if (ref) {
    const p = await api('GET', `/api/projects/resolve?ref=${encodeURIComponent(ref)}`).catch(() => null);
    if (!p) throw new Error(`Project "${ref}" not found. Use list_projects to see ids.`);
    return p;
  }
  return projectForDir(process.cwd());
}

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notifications
  switch (method) {
    case 'initialize':
      return write({ jsonrpc: '2.0', id, result: {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'goodcomments', version: '0.2.0' },
        instructions: INSTRUCTIONS,
      } });
    case 'ping':
      return write({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return write({ jsonrpc: '2.0', id, result: { tools: tools.map(({ run, ...t }) => t) } });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } });
      try {
        const out = await tool.run(params.arguments || {});
        const content = Array.isArray(out) ? out : [{ type: 'text', text: out }];
        return write({ jsonrpc: '2.0', id, result: { content } });
      } catch (err) {
        return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } });
      }
    }
    default:
      return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

export function runMcp() {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    handle(msg).catch((err) => write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: err.message } }));
  });
}
