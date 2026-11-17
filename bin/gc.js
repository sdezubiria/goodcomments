#!/usr/bin/env -S node --no-warnings
// gc — GoodComments from the terminal. Humans and agents use the same commands.
import { spawn } from 'node:child_process';
import { api, BASE, projectForDir, formatComment, uploadFile } from '../server/client.js';

const HELP = `gc — track feedback: open → fixed → done

  gc                              open + fixed comments for this folder's project
  gc list [-p project|--all] [-s open|fixed|done|all] [-q text] [--json]
  gc add "text" [-p project] [-s source] [-l where] [-f shot.png …]
  gc attach <id> <file…>             add screenshots / images / PDFs
  gc show <id>
  gc fix <id> "what you changed"     open → fixed  (agents do this)
  gc done <id> [note]                fixed → done (you, after checking)
  gc reopen <id> "what's still wrong"
  gc note <id> "text"
  gc edit <id> [-b body] [-p project] [-s source] [-l where]
  gc rm <id>

  gc projects
  gc project add "Name" [--path dir] [--color #hex]   (--path . = this folder)
  gc project set <id> [--name ..] [--path ..] [--color ..]

  gc open        open the board in the browser
  gc serve       run the server in the foreground
  gc mcp         run as an MCP server (stdio) for agents

Env: GOODCOMMENTS_URL (default ${BASE}), GOODCOMMENTS_ACTOR (name shown on changes), GOODCOMMENTS_TOKEN`;

const FLAGS = { p: 'project', s: 'status', q: 'query', l: 'location', b: 'body', f: 'file' };

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opt[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    } else if (a === '-f' || a === '--file') {
      (opt.files ||= []).push(argv[++i]);
    } else if (/^-[a-z]$/.test(a)) {
      opt[FLAGS[a[1]] || a[1]] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    } else pos.push(a);
  }
  return { pos, opt };
}

async function scope(opt) {
  if (opt.all) return null;
  if (opt.project) return api('GET', `/api/projects/resolve?ref=${encodeURIComponent(opt.project)}`);
  return projectForDir();
}

const print = (x, opt) => console.log(opt.json ? JSON.stringify(x, null, 2) : x);

async function main() {
  let argv = process.argv.slice(2);
  if (!argv.length || (argv[0].startsWith('-') && !['-h', '--help'].includes(argv[0]))) argv = ['list', ...argv];
  const [cmd, ...rest] = argv;
  const { pos, opt } = parse(rest);
  const id = pos[0];
  const text = pos.slice(1).join(' ');

  switch (cmd) {
    case 'help': case '-h': case '--help':
      return console.log(HELP);

    case 'mcp': {
      const { runMcp } = await import('../server/mcp.js');
      return runMcp();
    }
    case 'serve':
      return import('../server/index.js');

    case 'open': {
      await api('GET', '/api/health');
      spawn('open', [BASE], { stdio: 'ignore', detached: true }).unref();
      return console.log(BASE);
    }

    case 'list': case 'ls': {
      // the "list" alias lets `gc -p x` work too
      const p = await scope(opt);
      const status = opt.status || 'open,fixed';
      const qs = new URLSearchParams({ status });
      if (p) qs.set('project', p.id);
      if (opt.query) qs.set('q', opt.query);
      const list = await api('GET', `/api/comments?${qs}`);
      if (opt.json) return print(list, opt);
      const where = p ? p.name : 'all projects';
      if (!list.length) return console.log(`Nothing ${status.replace(',', ' or ')} in ${where}.`);
      console.log(`${where} — ${list.length} comment(s)\n`);
      return console.log(list.map((c) => formatComment(c)).join('\n\n'));
    }

    case 'add': {
      const body = pos.join(' ');
      if (!body) throw new Error('usage: gc add "text" [-p project]');
      const p = opt.project ? await scope(opt) : await projectForDir();
      const c = await api('POST', '/api/comments', { body, project: p?.id, source: typeof opt.status === 'string' ? opt.status : opt.source, location: opt.location });
      for (const f of opt.files || []) await uploadFile(c.id, f);
      const n = opt.files?.length ? ` with ${opt.files.length} attachment(s)` : '';
      return print(opt.json ? c : `Hung #${c.id} on ${c.project_name || 'no project'}${n}`, opt);
    }

    case 'show': {
      const c = await api('GET', `/api/comments/${need(id)}`);
      return print(opt.json ? c : formatComment(c, { full: true }), opt);
    }

    case 'fix': {
      if (!text) throw new Error('usage: gc fix <id> "what you changed"');
      const c = await api('POST', `/api/comments/${need(id)}/status`, { status: 'fixed', note: text });
      return print(opt.json ? c : `#${c.id} → fixed`, opt);
    }
    case 'done': {
      const c = await api('POST', `/api/comments/${need(id)}/status`, { status: 'done', note: text || undefined });
      return print(opt.json ? c : `#${c.id} → done`, opt);
    }
    case 'reopen': {
      const c = await api('POST', `/api/comments/${need(id)}/status`, { status: 'open', note: text || undefined });
      return print(opt.json ? c : `#${c.id} → open`, opt);
    }
    case 'note': {
      if (!text) throw new Error('usage: gc note <id> "text"');
      await api('POST', `/api/comments/${need(id)}/notes`, { note: text });
      return console.log(`Noted on #${id}`);
    }
    case 'edit': {
      const fields = {};
      for (const k of ['body', 'project', 'location']) if (typeof opt[k] === 'string') fields[k] = opt[k];
      if (typeof opt.status === 'string') fields.source = opt.status; // -s = source here
      if (typeof opt.source === 'string') fields.source = opt.source;
      const c = await api('PATCH', `/api/comments/${need(id)}`, fields);
      return print(opt.json ? c : formatComment(c), opt);
    }
    case 'attach': {
      const files = pos.slice(1);
      if (!files.length) throw new Error('usage: gc attach <id> <file…>');
      for (const f of files) await uploadFile(need(id), f);
      return console.log(`Attached ${files.length} file(s) to #${id}`);
    }
    case 'rm': {
      await api('DELETE', `/api/comments/${need(id)}`);
      return console.log(`Removed #${id}`);
    }

    case 'projects': {
      const ps = await api('GET', '/api/projects');
      if (opt.json) return print(ps, opt);
      if (!ps.length) return console.log('No projects yet. gc project add "Name" --path .');
      return console.log(ps.map((p) => `${p.id.padEnd(22)} ${String(p.open).padStart(3)} open ${String(p.fixed).padStart(3)} fixed ${String(p.done).padStart(4)} done   ${p.path || ''}`).join('\n'));
    }
    case 'project': {
      const [sub, ...args] = pos;
      if (sub === 'add') {
        const path = opt.path === '.' || opt.path === true ? process.cwd() : opt.path;
        const p = await api('POST', '/api/projects', { name: args.join(' '), path, color: opt.color });
        return console.log(`Created project ${p.id}${p.path ? ` → ${p.path}` : ''}`);
      }
      if (sub === 'set') {
        const path = opt.path === '.' ? process.cwd() : opt.path;
        const p = await api('PATCH', `/api/projects/${need(args[0])}`, { name: opt.name, path, color: opt.color });
        return console.log(`Updated ${p.id}`);
      }
      if (sub === 'rm') {
        await api('DELETE', `/api/projects/${need(args[0])}`);
        return console.log(`Removed project ${args[0]} (its comments keep existing, without a project)`);
      }
      throw new Error('usage: gc project add|set|rm …');
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

function need(v) {
  if (!v) throw new Error('missing id');
  return String(v).replace(/^#/, '');
}

main().catch((err) => {
  console.error(`gc: ${err.message}`);
  process.exit(1);
});
