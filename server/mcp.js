// MCP server over stdio (newline-delimited JSON-RPC), no dependencies.
// Register with:  claude mcp add goodcomments -- node /path/to/GoodComments/bin/gc.js mcp
import { createInterface } from 'node:readline';
import { api, projectForDir, formatComment, fetchAttachment } from './client.js';

const ACTOR = process.env.GOODCOMMENTS_ACTOR || 'agent';

const INSTRUCTIONS = `GoodComments tracks feedback on projects. Each comment moves open → fixed → done.
- Work from list_comments (defaults to open comments in the project for the current folder).
- After you change code or content for a comment, call mark_fixed with a short note: what you changed and where.
- Never mark comments done: the owner verifies fixed comments and closes them.
- If a comment is unclear or blocked, use add_note instead of guessing.
- When you notice a problem you won't fix now, record it with add_comment.
- Comments may have screenshots: get_comment returns them as images.`;

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
      },
    },
    run: async ({ project, status = 'open', query }) => {
      const p = await pickProject(project);
      const qs = new URLSearchParams({ status });
      if (p) qs.set('project', p.id);
      if (query) qs.set('q', query);
      const list = await api('GET', `/api/comments?${qs}`);
      const scope = p ? `project ${p.id}` : 'all projects';
      if (!list.length) return `No ${status === 'all' ? '' : status + ' '}comments in ${scope}.`;
      return `${list.length} ${status === 'all' ? '' : status + ' '}comment(s) in ${scope}:\n\n` + list.map((c) => formatComment(c)).join('\n\n');
    },
  },
  {
    name: 'get_comment',
    description: 'Get one comment with its full history. Screenshots attached to it are returned as images.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: async ({ id }) => {
      const c = await api('GET', `/api/comments/${id}`);
      const content = [{ type: 'text', text: formatComment(c, { full: true }) }];
      for (const a of c.attachments.filter((x) => /^image\/(png|jpeg|gif|webp)$/.test(x.type)).slice(0, 4)) {
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
        id: { type: 'integer' },
        note: { type: 'string', description: 'What you changed and where (files, pages), so the owner can check it quickly.' },
      },
      required: ['id', 'note'],
    },
    run: async ({ id, note }) => `Marked fixed:\n${formatComment(await api('POST', `/api/comments/${id}/status`, { status: 'fixed', note, actor: ACTOR }))}`,
  },
  {
    name: 'add_note',
    description: 'Add a note to a comment (a question, progress, or why it is blocked) without changing its state.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, note: { type: 'string' } }, required: ['id', 'note'] },
    run: async ({ id, note }) => `Noted:\n${formatComment(await api('POST', `/api/comments/${id}/notes`, { note, actor: ACTOR }), { full: true })}`,
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
        serverInfo: { name: 'goodcomments', version: '0.1.0' },
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
