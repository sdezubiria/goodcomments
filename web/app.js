import * as pile from './pile.js';
import { openEditor as openDrawEditor, isOpen as drawing, undo as drawUndo, grabScreen } from './draw.js';
const $ = (s, el = document) => el.querySelector(s);
const params = new URLSearchParams(location.search);
if (params.has('embed')) document.documentElement.classList.add('embed');
const QUICK = params.has('quick');   // the ⌃⌥N quick-capture window: only the composer
if (QUICK) document.documentElement.classList.add('quick');

const store = {
  get(k, d) { try { return localStorage.getItem('gc.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gc.' + k, v); } catch {} },
};

const state = {
  status: store.get('status', 'open'),
  project: store.get('project', ''),
  projects: [],
  comments: [],
  details: new Map(),   // id -> comment with events (when expanded)
  expanded: new Set(),
  asking: null,          // { id, kind: 'fix' | 'reopen' }
  pending: false,
  moved: null,           // { id, status } — the piece that just changed state, to animate its arrival
  allDone: false,        // show every done comment, not just the latest
  seen: new Set(),       // cards already on screen: they don't replay their entrance
  moving: false,         // a card is mid-fall: hold re-renders until it lands
  askFiles: [],          // screenshots waiting in the open fix / reopen box
  focusId: null,         // the card with the keyboard focus ring (j / k)
  q: '',                 // search text (filters cards, client-side)
  local: false,          // a server on this Mac: files can open in the editor, agents can run
  claude: false,         // Claude Code is installed
  runs: {},              // comment id → agent run { state, started, log }
};
document.documentElement.dataset.skin = 'trunk';   // the one look: monkeys on a trunk

// ---------- api ----------
// When the server runs with GOODCOMMENTS_TOKEN (cloud mode) we ask for it once and keep it.
let token = store.get('token', '');
const authHeaders = () => (token ? { authorization: `Bearer ${token}` } : {});
const withToken = (url) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

async function api(method, path, body, raw) {
  const res = await fetch(path, {
    method,
    headers: { ...authHeaders(), ...(raw ? raw.headers : body ? { 'content-type': 'application/json' } : {}) },
    body: raw ? raw.body : body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const t = prompt('This GoodComments server needs its access token:');
    if (t) { token = t.trim(); store.set('token', token); connect(); return api(method, path, body, raw); }
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function load() {
  if (QUICK) { state.projects = await api('GET', '/api/projects'); return renderProjects(); }
  const qs = new URLSearchParams({ status: 'all', limit: '3000' });
  if (state.project) qs.set('project', state.project);
  const [projects, comments] = await Promise.all([
    api('GET', '/api/projects'),
    api('GET', `/api/comments?${qs}`).catch((e) => {
      if (state.project) { state.project = ''; store.set('project', ''); return api('GET', '/api/comments?status=all&limit=3000'); }
      throw e;
    }),
  ]);
  state.projects = projects;
  state.comments = comments;
  if (state.local) state.runs = await api('GET', '/api/agent-runs').catch(() => state.runs);
  for (const id of state.expanded) await loadDetail(id);
  render();
}

async function uploadFiles(id, files) {
  for (const f of files) {
    await api('POST', `/api/comments/${id}/attachments`, null, {
      headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name || 'screenshot.png') },
      body: f,
    }).catch((e) => toast(`${f.name}: ${e.message}`));
  }
}

function clearAskFiles() {
  state.askFiles.forEach((f) => f.url && URL.revokeObjectURL(f.url));
  state.askFiles = [];
}

/** Add screenshots to the open fix / reopen box (paste, drop or paperclip). */
async function addAskFiles(list) {
  if (!state.asking) return 0;
  const files = (await Promise.all(imageFiles(list).map(prepareFile))).filter(Boolean);
  for (const f of files) state.askFiles.push(Object.assign(f, { url: isImage(f) ? URL.createObjectURL(f) : null }));
  if (files.length) {
    const input = $(`#ask-${state.asking.id} input:not([type=file])`);
    const text = input?.value;
    input?.blur();
    render();
    const again = $(`#ask-${state.asking.id} input:not([type=file])`);
    if (again) { again.value = text || ''; again.focus(); }
  }
  return files.length;
}

// any file can be attached except web pages, SVGs and scripts (the server refuses those too)
const BLOCKED = /^(text\/html|application\/xhtml|image\/svg|text\/javascript|application\/(x-)?javascript)/;
const imageFiles = (list) => [...(list || [])].filter((f) => f.size > 0 && !BLOCKED.test(f.type));
const isImage = (f) => (f.type || '').startsWith('image/');
const extOf = (name) => ((name || '').split('.').pop() || 'file').slice(0, 4).toUpperCase();
const SUPPORTED = /^(image\/(png|jpeg|gif|webp|heic)|application\/pdf)$/;

/** Images from a paste. Safari / the Mac panel often expose them only as clipboard items, not files. */
function clipboardFiles(cd) {
  if (!cd) return [];
  const files = [...(cd.files || [])];
  if (!files.length) {
    for (const it of cd.items || []) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
  }
  return imageFiles(files);
}

/** Give pasted images a name and turn formats the server doesn't take (TIFF, BMP…) into PNG. */
async function prepareFile(f) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  if (!isImage(f)) return f;                                // documents go as they are
  if (SUPPORTED.test(f.type)) {
    return !f.name || f.name === 'image.png' ? new File([f], `screenshot-${stamp}.${f.type.split('/')[1].replace('jpeg', 'jpg')}`, { type: f.type }) : f;
  }
  try {
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new File([blob], `screenshot-${stamp}.png`, { type: 'image/png' });
  } catch {
    toast(`Can't read ${f.type || 'that file'}`);
    return null;
  }
}

async function loadDetail(id) {
  try { state.details.set(id, await api('GET', `/api/comments/${id}`)); }
  catch { state.expanded.delete(id); state.details.delete(id); }
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const isUrl = (s) => /^https?:\/\//i.test(s || '');
// "src/header.php:12", "./notes.md", "~/site/style.css": a file in the project's folder (not "/contact", a page)
const looksLikeFile = (s) => /^\S+$/.test(s || '') && (/\.\w{1,8}(:\d+){0,2}$/.test(s) || /^(\.{1,2}|~)\//.test(s));
const icons = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
  wrench: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5a3 3 0 0 0-3.4 4L2.5 11.1a1.3 1.3 0 0 0 1.9 1.9L9 8.4a3 3 0 0 0 4-3.4l-1.8 1.8-1.7-.3-.3-1.7z"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5L2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
  open: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>',
  spark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 1.8l1.5 4.1 4.2 1.6-4.2 1.6L8 13.2 6.5 9.1 2.3 7.5l4.2-1.6z"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2"/></svg>',
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- names: comments are called by their text, not their number ----------
function shortText(text, max = 38) {
  const line = String(text || '').split('\n')[0].trim().replace(/\s+/g, ' ');
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max).replace(/[\s,.;:–-]+$/, '') + '…';
}
const nameOf = (idOrComment) => {
  const c = typeof idOrComment === 'object' ? idOrComment : state.comments.find((x) => x.id === Number(idOrComment));
  return c ? `“${shortText(c.body)}”` : 'That comment';
};

// ---------- render ----------
function render() {
  if (state.moving) { state.pending = true; return; }
  // keep the line still while you're typing in it
  if ($('#line').contains(document.activeElement) && document.activeElement.matches('input')) { state.pending = true; return; }
  state.pending = false;

  const counts = { open: 0, fixed: 0, done: 0 };
  for (const c of state.comments) counts[c.status]++;
  for (const b of $('#states').children) {
    const s = b.dataset.status;
    b.setAttribute('aria-selected', String(s === state.status));
    const badge = b.querySelector('b');
    badge.textContent = counts[s];
    badge.classList.toggle('has', s === 'fixed' && counts.fixed > 0);
  }

  renderProjects();
  renderBoard();
  state.moved = null;
  for (const c of state.comments) state.seen.add(c.id);
  $('.rope').style.setProperty('--rope-h', $('#items').scrollHeight + 60 + 'px');
  applyFocus(false);

  if (state.asking) $(`#ask-${state.asking.id} input`)?.focus();
}

// ---------- the board: every state on one column, top to bottom ----------
const ZONES = {
  open: ['Hanging', 'Open comments hook onto the high sticks.'],
  fixed: ['To check', 'An agent pulled the stick — it dropped and swung down here.'],
  done: ['The pile', 'Pull the last stick and it falls here. The pile grows as the project gets done.'],
};
// resting tilt shrinks on wide panels, so the far edge never sags more than a few pixels
const tiltScale = () => Math.min(1, 380 / ($('#line')?.clientWidth || 380));
const tilt = (id, span = 18) => ((id * 47) % (span + 1)) - span / 2;

const matches = (c) => !state.q || [c.body, c.source, c.location, c.fix_note, c.reopen_note, c.project_name, c.author]
  .some((v) => v && String(v).toLowerCase().includes(state.q));

function renderBoard() {
  const by = (s) => state.comments.filter((c) => c.status === s && matches(c));
  const [open, fixed, done] = ['open', 'fixed', 'done'].map(by);
  const z = ZONES;
  const total = state.comments.length;
  const pct = total ? Math.round((state.comments.filter((c) => c.status === 'done').length / total) * 100) : 0;
  let i = 0;
  const zone = (key, items, inner = '', count = items.length) => `
    <li class="zone" data-zone="${key}">
      <div class="zone-head"><span class="dot ${key}"></span><h3>${z[key][0]}</h3><b>${count}</b><span class="zone-hint">${z[key][1]}</span></div>
      ${inner}
      <ol class="zone-items">${items.map((c) => renderItem(c, i++)).join('')}</ol>
      ${!items.length && key !== 'done' ? `<p class="zone-empty">${state.q ? 'No matches.' : key === 'open' ? 'Nothing hanging. Add one above.' : 'Nothing waiting for you.'}</p>` : ''}
    </li>`;

  const newest = state.moved?.status === 'done' ? state.moved.id : null;
  const heap = done.slice(0, 60).map((c) =>
    `<i data-key="c${c.id}" class="${c.id === newest ? 'new' : ''}" style="--pc:${esc(c.project_color || 'var(--ink-3)')};--r:${tilt(c.id)}deg" title="${esc(shortText(c.body, 60))}"></i>`).join('');
  const pileHtml = `<div class="pile" data-act="toggle-done" style="--fill:${pct}" title="Drag the monkeys around · click empty space to list what's done">
         <span class="heap physics">${heap}</span><span class="ground"></span>
         <span class="pile-label">${done.length} done · ${pct}%${done.length ? ' <button class="pile-clean" data-act="clean-pile" title="Clean the pile: archive the done comments (⌘Z to undo)">🧹 Clean up</button>' : ''}</span></div>`;
  const doneShown = state.allDone ? done : [];
  const doneZone = zone('done', doneShown, pileHtml, done.length).replace('</ol>', `</ol>${done.length ? `<button class="act show-done" data-act="toggle-done">${state.allDone ? 'Hide done' : `Show ${done.length} done`}</button>` : ''}`);

  patchItems(zone('open', open) + zone('fixed', fixed) + doneZone);
  pile.attach($('.pile .heap.physics'));
  $('#empty').hidden = true;
}

function renderProjects() {
  const total = (p) => p.open + p.fixed;
  const chips = [
    `<button class="chip" data-project="" aria-pressed="${!state.project}">All</button>`,
    ...state.projects.map((p) => `
      <button class="chip" data-project="${esc(p.id)}" aria-pressed="${state.project === p.id}" title="${esc(p.path || p.name)} · double-click to edit">
        <span class="swatch" style="background:${esc(p.color)}"></span>${esc(p.name)}${total(p) ? `<span class="n">${total(p)}</span>` : ''}
      </button>`),
    '<button class="chip add" data-new-project title="New project">+ Project</button>',
  ];
  $('#projects').innerHTML = chips.join('');

  const sel = $('#c-project');
  const keep = sel.value || state.project || store.get('lastProject', '');
  sel.innerHTML = '<option value="">No project</option>' + state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = state.projects.some((p) => p.id === keep) ? keep : '';
}

const hash = (str) => { let h = 5381; for (let k = 0; k < str.length; k++) h = ((h << 5) + h + str.charCodeAt(k)) | 0; return (h >>> 0).toString(36); };
const TRANSIENT = ['fresh', 'landed', 'leaving', 'pulling', 'arrived-open', 'arrived-fixed', 'arrived-done', 'to-open', 'to-fixed', 'to-done', 'dragging'];

/**
 * Update the list without rebuilding cards that didn't change: they keep their
 * DOM node, so images don't reload and nothing re-animates or flashes.
 */
function patchItems(html) {
  const box = $('#items');
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const old = new Map([...box.querySelectorAll('.item[data-id]')].map((el) => [el.dataset.id, el]));
  for (const el of tpl.content.querySelectorAll('.item[data-id]')) {
    const prev = old.get(el.dataset.id);
    if (!prev || prev.dataset.sig !== el.dataset.sig) continue;
    prev.classList.remove(...TRANSIENT);
    prev.style.visibility = '';
    prev.style.setProperty('--i', el.style.getPropertyValue('--i'));
    el.replaceWith(prev);
  }
  const liveHeap = box.querySelector('.heap.physics');
  const nextHeap = tpl.content.querySelector('.heap.physics');
  if (liveHeap && nextHeap) { pile.syncHeap(liveHeap, nextHeap); nextHeap.replaceWith(liveHeap); }
  box.replaceChildren(...tpl.content.childNodes);
}

const shotHtml = (a) => a.type.startsWith('image/')
  ? `<a class="shot" href="${withToken(`/api/attachments/${a.id}`)}" target="_blank" title="${esc(a.name)}"><img src="${withToken(`/api/attachments/${a.id}`)}" alt="${esc(a.name)}" loading="lazy"><button class="x" data-detach="${a.id}" title="Remove">✕</button></a>`
  : `<a class="shot pdf" href="${withToken(`/api/attachments/${a.id}`)}" target="_blank">${esc(a.name)}<button class="x" data-detach="${a.id}" title="Remove">✕</button></a>`;
const camera = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h2l1.2-1.8h4.6l1.2 1.8h2v7h-11z"/><circle cx="8" cy="8.8" r="2.3"/></svg>';
const paperclip = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10.5 4.5L5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2"/></svg>';

function renderItem(c, i) {
  const d = state.details.get(c.id);
  const expanded = state.expanded.has(c.id);
  const asking = state.asking?.id === c.id ? state.asking.kind : null;

  const run = state.runs[c.id];
  const project = state.projects.find((p) => p.id === c.project_id);
  const working = run?.state === 'running';
  const openBtn = !c.location ? ''
    : isUrl(c.location) ? `<a class="act" href="${esc(c.location)}" target="_blank" rel="noopener" title="Open ${esc(c.location)}">${icons.open}Open</a>`
    : state.local && project?.path && looksLikeFile(c.location) ? `<button class="act" data-act="open-file" title="Open ${esc(c.location)} in your editor">${icons.open}Open</button>` : '';
  const agentBtn = c.status !== 'open' || !state.local || !project?.path ? ''
    : working ? `<span class="agent-run"><span class="spin"></span>Claude is working… <a href="${withToken(`/api/comments/${c.id}/agent/log`)}" target="_blank">log</a></span>`
    : `<button class="act agent" data-act="agent" title="${state.claude ? `Run Claude Code in ${esc(project.path)} to fix this` : 'Claude Code isn’t installed: click to see how'}">${icons.spark}Ask Claude</button>`;
  const agentNote = c.status === 'open' && run && (run.state === 'stopped' || run.state === 'failed')
    ? `<div class="agent-note">${run.state === 'failed' ? esc(run.error || 'Claude couldn’t finish') : 'Claude stopped without a fix'} · <a href="${withToken(`/api/comments/${c.id}/agent/log`)}" target="_blank">log</a></div>` : '';

  const actions = {
    open: `${working ? '' : `<button class="act fixit" data-act="ask-fix">${icons.wrench}Mark fixed</button>`}${openBtn}${agentBtn}`,
    fixed: `<button class="act approve" data-act="done">${icons.check}Approve</button>
            <button class="act" data-act="ask-reopen">${icons.undo}Reopen</button>${openBtn}`,
    done: `<button class="act" data-act="ask-reopen">${icons.undo}Reopen</button>`,
  }[c.status];

  const atts = c.attachments || [];
  const reopenedNow = c.status === 'open' && c.reopened_at;
  const reopenShots = reopenedNow ? atts.filter((a) => a.created_at >= c.reopened_at) : [];
  const fixShots = c.fix_note && c.status !== 'open' && c.fixed_at ? atts.filter((a) => a.created_at >= c.fixed_at) : [];
  const otherShots = atts.filter((a) => !reopenShots.includes(a) && !fixShots.includes(a));
  const fix = c.fix_note ? `
    <div class="fix"><span class="who">Fixed${c.fixed_by ? ` by ${esc(c.fixed_by)}` : ''} · ${ago(c.fixed_at)}</span>${esc(c.fix_note)}
      ${fixShots.length ? `<div class="shots">${fixShots.map(shotHtml).join('')}</div>` : ''}</div>` : '';
  const reopened = reopenedNow && (c.reopen_note || reopenShots.length) ? `
    <div class="reopened"><span class="who">↩ Reopened${c.reopened_by ? ` by ${esc(c.reopened_by)}` : ''} · ${ago(c.reopened_at)}</span>${c.reopen_note ? `<span class="note">${esc(c.reopen_note)}</span>` : ''}
      ${reopenShots.length ? `<div class="shots">${reopenShots.map(shotHtml).join('')}</div>` : ''}</div>` : '';

  const ask = asking ? `
    <form class="ask ${asking}" id="ask-${c.id}" data-kind="${asking}" novalidate>
      <input placeholder="${asking === 'fix' ? 'What did you change?' : 'What’s still wrong?'}">
      <button type="button" class="act icon ask-clip" data-ask-shot title="Take a screenshot and draw on it">${camera}</button>
      <label class="act icon ask-clip" title="Attach screenshots (or paste ⌘V / drop them here)"><input type="file" multiple hidden data-ask-file>${paperclip}</label>
      <button class="act ${asking === 'fix' ? 'fixit' : 'reopen'}">${asking === 'fix' ? 'Fixed' : 'Reopen'}</button>
      <button type="button" class="act icon" data-act="cancel-ask" title="Cancel">✕</button>
      <div class="ask-files${state.askFiles.length ? ' has' : ''}">${state.askFiles.map((f, k) => `<span class="file" data-ask-edit="${k}" title="Click to draw on it" style="${f.url ? `background-image:url(${f.url})` : ''}">${f.url ? '' : extOf(f.name)}<button type="button" data-ask-rm="${k}" title="Remove">✕</button></span>`).join('')}
        <span class="ask-hint">${state.askFiles.length ? '' : 'Paste or drop screenshots here'}</span></div>
    </form>` : '';

  const history = expanded && d ? `
    <div class="detail">
      <ol class="history">${d.events.map((e) => `
        <li><span class="d ${esc(e.type)}"></span><span>${esc(e.type)}${e.actor ? ` by ${esc(e.actor)}` : ''}<time>${ago(e.at)}</time>${e.note ? `<span class="n">${esc(e.note)}</span>` : ''}</span></li>`).join('')}
      </ol>
      <form class="note-form" data-note="${c.id}"><input placeholder="Add a note…"><button class="act">Note</button></form>
    </div>` : '';

  const sig = hash(JSON.stringify([c, expanded, asking, run, project?.path, state.local, state.claude, d?.events?.length ?? -1, asking ? state.askFiles.map((f) => f.name + f.size) : 0]));
  return `
    <li data-sig="${sig}" class="item status-${c.status}${expanded ? ' expanded' : ''}${state.seen.has(c.id) ? '' : ' fresh'}${state.moved?.id === c.id ? ` arrived-${c.status}` : ''}" data-id="${c.id}" style="--i:${Math.min(i, 12)};--pc:${esc(c.project_color || 'var(--ink-3)')};--tw:${(tilt(c.id, 4) * tiltScale()).toFixed(2)}deg">
      <span class="pin" aria-hidden="true"></span>
      <span class="peg" aria-hidden="true"><i></i><i></i>
      <svg class="monkey" viewBox="0 0 64 54" role="img" aria-label="Monkey">
        <path class="arm" d="M21 33 C 15 25, 14 18, 17 11"/>
        <path class="arm a2" d="M43 33 C 49 25, 50 18, 47 11"/>
        <path class="arm a2-down" d="M43 33 C 50 38, 54 44, 56 50"/>
        <g class="wave-arm"><path class="arm" d="M43 33 C 50 28, 55 22, 57 15"/><circle class="hand" cx="57.5" cy="13.5" r="3.6"/></g>
        <circle class="hand" cx="17" cy="10" r="3.6"/><circle class="hand a2" cx="47" cy="10" r="3.6"/><circle class="hand a2-down" cx="56" cy="50" r="3.4"/>
        <circle class="fur" cx="19" cy="30" r="5.5"/><circle class="fur" cx="45" cy="30" r="5.5"/>
        <circle class="face" cx="19" cy="30" r="2.8"/><circle class="face" cx="45" cy="30" r="2.8"/>
        <circle class="fur" cx="32" cy="32" r="12"/>
        <circle class="face" cx="28.2" cy="29.5" r="4.6"/><circle class="face" cx="35.8" cy="29.5" r="4.6"/>
        <ellipse class="face" cx="32" cy="36" rx="8.2" ry="6.4"/>
        <circle class="eye" cx="28.6" cy="30" r="1.5"/><circle class="eye" cx="35.4" cy="30" r="1.5"/>
        <path class="mouth" d="M28.5 38.2 Q32 40.8 35.5 38.2"/>
        <ellipse class="mouth-o" cx="32" cy="38.6" rx="1.9" ry="2.3"/>
      </svg></span>
      <article class="sheet">
        <div class="meta">
          <span class="proj">${esc(c.project_name || 'No project')}</span>
          ${c.source ? `<span class="src">${esc(c.source)}</span>` : ''}
          <span>${ago(c.status === 'done' ? c.done_at : c.status === 'fixed' ? c.fixed_at : c.created_at)}</span>

        </div>
        <div class="body">${esc(c.body)}</div>
        ${c.location ? (isUrl(c.location) ? `<a class="where" href="${esc(c.location)}" target="_blank" rel="noopener">${esc(c.location)}</a>` : `<span class="where">${esc(c.location)}</span>`) : ''}
        ${otherShots.length ? `<div class="shots">${otherShots.map(shotHtml).join('')}</div>` : ''}
        ${reopened}
        ${c.status === 'open' ? '' : fix}
        ${agentNote}
        ${ask || `<div class="actions">${actions}<span class="tail">
          <button class="act icon" data-act="copy" title="Copy for an agent">${icons.copy}</button>
          <button class="act icon" data-act="delete" title="Delete">${icons.trash}</button></span></div>`}
        ${history}
      </article>
    </li>`;
}

// ---------- local actions: open in the editor, ask an agent ----------
// The x-goodcomments header tells the server this came from the page, not from another site.
const localApi = (path) => api('POST', path, null, { headers: { 'x-goodcomments': '1' } });

async function askAgent(c) {
  const project = state.projects.find((p) => p.id === c.project_id);
  if (!state.claude) return alert('Claude Code isn’t installed.\n\nInstall it in Terminal:\n  curl -fsSL https://claude.ai/install.sh | bash\n\nRun claude once to sign in, then reload GoodComments.');
  if (!confirm(`Ask Claude Code to fix ${nameOf(c)}?\n\nIt works in ${project.path} in the background (it can read and edit files there) and moves the card to To check when it’s done.`)) return;
  try {
    state.runs[c.id] = await localApi(`/api/comments/${c.id}/agent`);
    toast(`Claude is on ${nameOf(c)}`);
    render();
  } catch (e) { toast(e.message); }
}

// ---------- actions ----------
const SLOW = Math.max(1, Number(params.get('slowmo')) || 1);   // ?slowmo=5 to inspect the motion
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The card leaves from where it is and lands where it belongs.
 * 1. pull: the stick slides back into the trunk (or the clip opens)
 * 2. fall: a copy of the card drops under gravity to its new spot
 *    (done → it tumbles and shrinks into its monkey head / ticket on the pile)
 * 3. land: the real card appears and swings on its new stick; the pile bounces
 */
async function boardMove(li, id, status, note, { remote = false } = {}) {
  const line = $('#line');
  state.moving = true;            // live updates wait: the card must stay put while we measure it
  li.classList.add('pulling');
  // remote: someone else (an agent, the CLI) already made the change; we only show it
  const request = remote ? null : api('POST', `/api/comments/${id}/status`, { status, note: note || undefined });
  try { await Promise.all([request, sleep(220)]); }
  catch (e) { li.classList.remove('pulling'); settle(0); toast(e.message); return false; }

  // the falling copy, pinned where the card is now
  const from = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.add('faller');
  ghost.classList.remove('pulling', 'fresh', 'expanded');
  ghost.querySelector('.detail')?.remove();
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px` });
  document.body.appendChild(ghost);

  state.asking = null;
  state.moved = { id, status };
  state.seen.add(id);

  // remember where everything else is, so it can glide into place instead of jumping
  const before = snapshot();
  state.moving = false;
  state.pending = false;
  await load();
  state.moving = true;

  // where it lands
  const landing = status === 'done'
    ? ($('.heap i.new') || $('.pile'))
    : $(`.item[data-id="${id}"]`);
  if (!landing || !from.width) { ghost.remove(); settle(0); return true; }
  const realCard = status === 'done' ? null : landing;
  landing.style.visibility = 'hidden';

  // bring the landing spot into view (the falling copy is fixed, so it doesn't move)
  const lr = landing.getBoundingClientRect();
  const view = line.getBoundingClientRect();
  if (lr.top < view.top + 60 || lr.bottom > view.bottom - 20) {
    line.scrollTop += lr.top - (view.top + view.height * (status === 'done' ? 0.62 : 0.4));
  }
  const to = landing.getBoundingClientRect();
  glide(before, id);

  const anim = status === 'done' ? fallInto(ghost, from, to) : dropTo(ghost, from, to);
  await anim.finished.catch(() => {});
  ghost.remove();

  landing.style.visibility = '';
  if (realCard) {
    realCard.classList.add('landed');
  } else {
    pile.release(landing);
  }
  const n = nameOf(id);
  if (remote) toast({ fixed: `${n} was marked fixed`, done: `${n} was approved`, open: `${n} was reopened` }[status]);
  else if (!quietToast) toast({ fixed: `${n} moved to To check`, done: `${n} is done ✓`, open: `${n} reopened` }[status]);
  quietToast = false;
  settle(1200 * SLOW);
  return true;
}

// ---------- motion helpers ----------
/** Screen positions of the cards, zone headers and the pile, by key. */
function snapshot() {
  const map = new Map();
  for (const el of document.querySelectorAll('#items .item[data-id], #items .zone-head, #items .pile, #items .zone-empty, #items .show-done')) {
    map.set(flipKey(el), el.getBoundingClientRect().top);
  }
  return map;
}
const flipKey = (el) => el.dataset.id ? `i${el.dataset.id}` : `${el.className.split(' ')[0]}:${el.closest('.zone')?.dataset.zone || ''}`;

/** Everything that moved slides from its old spot to the new one. */
function glide(before, skipId) {
  for (const el of document.querySelectorAll('#items .item[data-id], #items .zone-head, #items .pile, #items .zone-empty, #items .show-done')) {
    if (el.dataset.id === String(skipId)) continue;
    const was = before.get(flipKey(el));
    if (was === undefined) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
      { duration: 420 * SLOW, easing: 'cubic-bezier(.25, .8, .25, 1)' });
  }
}

/** Sample a motion into keyframes (linear between samples), so the fall follows real gravity. */
function sampled(n, fn) {
  return Array.from({ length: n + 1 }, (_, k) => ({ ...fn(k / n), offset: k / n }));
}

/** Drop down a level (or climb back up): gravity, a slight tilt, lands exactly on the new stick. */
function dropTo(ghost, from, to) {
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  ghost.style.transformOrigin = '70px 0';
  if (dy <= 0) {   // going up (reopen / undo): a quick lift, then it eases onto the stick
    return ghost.animate(sampled(14, (t) => {
      const e = 1 - (1 - t) ** 3;
      return { transform: `translate(${dx * e}px, ${dy * e}px) rotate(${-Math.min(2, (7 / from.width) * 57.3) * Math.sin(Math.PI * t)}deg)` };
    }), { duration: Math.min(900, 380 + Math.abs(dy) * 0.35) * SLOW, fill: 'forwards' });
  }
  const tilt = Math.min(3, (10 / from.width) * 57.3);
  return ghost.animate(sampled(16, (t) => ({
    // y = ½gt²: slow start, speeding up; a little sideways drift and tilt as it lets go
    transform: `translate(${dx * t}px, ${dy * t * t}px) rotate(${tilt * Math.sin(Math.PI * t)}deg)`,
  })), { duration: Math.min(900, 260 + Math.sqrt(dy) * 26) * SLOW, fill: 'forwards' });
}

/** Approve: the card falls straight down onto the pile and only shrinks as it gets there. */
function fallInto(ghost, from, to) {
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const side = dx >= 0 ? 1 : -1;
  ghost.style.transformOrigin = '50% 50%';
  // end the size of a monkey head
  const endX = 26 / from.width;
  const endY = 26 / from.height;
  return ghost.animate(sampled(18, (t) => {
    const k = t < 0.55 ? 0 : (t - 0.55) / 0.45;          // shrink only in the last part of the fall
    const sx = 1 - k * (1 - endX);
    const sy = 1 - k * (1 - endY);
    return {
      transform: `translate(${dx * t * t}px, ${dy * t * t}px) rotate(${side * Math.min(10, (30 / from.width) * 57.3) * t}deg) scale(${sx}, ${sy})`,
      opacity: t < 0.9 ? 1 : 1 - (t - 0.9) / 0.1,
    };
  }), { duration: Math.min(1000, 320 + Math.sqrt(Math.abs(dy)) * 28) * SLOW, fill: 'forwards' });
}

// ---------- easter eggs: poke the monkeys ----------
const OOK = ['Ook!', 'Eek!', 'Ook ook?', '🍌?', 'Ship it!', 'Who wrote this?', 'Is it Friday?', 'Hang in there.', 'Fixed? Fixed.',
  'I only work for bananas.', 'Have you tried turning it off and on?', 'Works on my branch.', '*scratches head*', 'Mark me fixed!'];
const TRICKS = ['swing', 'wave', 'blink', 'loop', 'surprise'];
const pokes = new WeakMap();     // monkey → recent click times
let barrel = [];                 // recent pokes on different monkeys
let lastTrick = '';

/** A speech bubble next to whatever was poked, drawn above everything else. */
function say(anchor, text) {
  document.querySelector('.ook')?.remove();
  const r = anchor.getBoundingClientRect();
  const b = document.createElement('span');
  b.className = 'ook';
  b.textContent = text;
  document.body.appendChild(b);
  const room = innerWidth - 8 - b.offsetWidth;
  Object.assign(b.style, { left: `${Math.max(8, Math.min(r.right - 8, room))}px`, top: `${Math.max(8, r.top - b.offsetHeight + 6)}px` });
  setTimeout(() => b.remove(), 1700);
}

function trick(monkey, name) {
  monkey.classList.remove(...TRICKS.map((t) => `do-${t}`));
  void monkey.getBBox();                                   // restart the animation
  monkey.classList.add(`do-${name}`);
  clearTimeout(monkey._t);
  monkey._t = setTimeout(() => monkey.classList.remove(`do-${name}`), 1600);
}

function poke(monkey) {
  const now = Date.now();
  const times = (pokes.get(monkey) || []).filter((t) => now - t < 2500);
  times.push(now);
  pokes.set(monkey, times);

  // five quick pokes on the same monkey: it gives up its banana
  if (times.length >= 5) {
    pokes.set(monkey, []);
    trick(monkey, 'surprise');
    say(monkey, 'FINE. Take it.');
    return dropBanana(monkey);
  }
  if (times.length === 3) { trick(monkey, 'surprise'); return say(monkey, 'Hey!'); }
  if (times.length === 4) { trick(monkey, 'blink'); return say(monkey, 'Stop it…'); }

  // poke seven different monkeys quickly: barrel of monkeys
  barrel = barrel.filter((b) => now - b.t < 6000 && b.m !== monkey && b.m.isConnected);
  barrel.push({ m: monkey, t: now });
  if (barrel.length >= Math.min(7, document.querySelectorAll('#items .monkey').length) && barrel.length >= 3) {
    barrel = [];
    return barrelOfMonkeys();
  }

  let name;
  do { name = TRICKS[Math.floor(Math.random() * TRICKS.length)]; } while (name === lastTrick);
  lastTrick = name;
  trick(monkey, name);
  say(monkey, OOK[Math.floor(Math.random() * OOK.length)]);
}

/** Every monkey on the trunk does a loop around its stick, one after the other. */
function barrelOfMonkeys() {
  const all = [...document.querySelectorAll('#items .monkey')];
  all.forEach((m, k) => setTimeout(() => trick(m, k % 2 ? 'loop' : 'wave'), k * 110));
  toast('🐒 Barrel of monkeys!');
}

/** The banana falls off the stick and lands on the pile (and stays there for the session). */
function dropBanana(monkey) {
  const from = monkey.getBoundingClientRect();
  const pileEl = $('.pile .heap') || $('.pile');
  const b = document.createElement('span');
  b.className = 'banana falling';
  b.textContent = '🍌';
  Object.assign(b.style, { left: `${from.left + from.width / 2 - 10}px`, top: `${from.top + 10}px` });
  document.body.appendChild(b);
  if (!pileEl) { setTimeout(() => b.remove(), 900); return; }
  const to = pileEl.getBoundingClientRect();
  const dx = to.left + to.width / 2 + (Math.random() * 60 - 30) - (from.left + from.width / 2);
  const dy = Math.max(40, to.top + 4 - (from.top + 10));
  b.animate(sampled(16, (t) => ({ transform: `translate(${dx * t}px, ${dy * t * t}px) rotate(${540 * t}deg)` })),
    { duration: Math.min(1100, 300 + Math.sqrt(dy) * 30) * SLOW, fill: 'forwards' })
    .finished.then(() => {
      b.remove();
      state.bananas = (state.bananas || 0) + 1;
      pile.addBanana(from.left + from.width / 2 + dx);
      if (state.bananas === 3) toast('🍌🍌🍌 That’s a lot of bananas.');
    });
}

/** Poke a head on the pile: it jumps. Three quick pokes: the whole pile jumps. */
let headPokes = [];
pile.onPoke((head) => {
  const now = Date.now();
  headPokes = headPokes.filter((t) => now - t < 1500);
  headPokes.push(now);
  if (headPokes.length >= 3) {
    headPokes = [];
    pile.kick(null, 1.2);
    return say(head, '🎉 Ook ook ook!');
  }
  pile.kick(head);
  say(head, head.classList.contains('banana') ? '🍌' : ['ook', 'zzz', 'eek', '…', 'wheee'][Math.floor(Math.random() * 5)]);
});

// type "ook" anywhere (outside a text field): every monkey waves back
let typed = '';
document.addEventListener('keydown', (ev) => {
  if (isEditable(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey || ev.key.length !== 1) return;
  typed = (typed + ev.key.toLowerCase()).slice(-3);
  if (typed === 'ook') {
    document.querySelectorAll('#items .monkey').forEach((m, k) => setTimeout(() => trick(m, 'wave'), k * 80));
    const first = $('#items .monkey');
    if (first) say(first, 'Ook!');
  }
});

/** Let renders through again once the landing swing is over. */
function settle(after) {
  setTimeout(() => {
    state.moving = false;
    if (state.pending) render();
  }, after);
}

// ⌘Z / ⌘⇧Z: undo and redo moves (approve, mark fixed, reopen)
const undoStack = [];
const redoStack = [];
let quietToast = false;
const LABEL = { open: 'Open', fixed: 'To check', done: 'Done' };

async function changeStatus(id, status, note, { from = 'user' } = {}) {
  const before = state.comments.find((c) => c.id === id);
  const step = before && { id, from: before.status, to: status, fixNote: before.fix_note, note };
  const li = $(`.item[data-id="${id}"]`);
  let ok;
  if (li && !reduceMotion()) {
    quietToast = from !== 'user';
    ok = await boardMove(li, id, status, note);
  } else {
    li?.classList.add('leaving', `to-${status}`);
    try {
      await api('POST', `/api/comments/${id}/status`, { status, note: note || undefined });
      state.asking = null;
      state.moved = { id, status };
      await sleep(300);
      if (from === 'user') toast({ fixed: `${nameOf(id)} moved to To check`, done: `${nameOf(id)} is done ✓`, open: `${nameOf(id)} reopened` }[status]);
      await load();
      ok = true;
    } catch (e) { li?.classList.remove('leaving'); toast(e.message); ok = false; }
  }
  if (ok) panelBridge?.postMessage({ action: 'moved', id, status });
  if (ok && step) {
    if (from === 'user') { undoStack.push(step); redoStack.length = 0; }
    if (undoStack.length > 50) undoStack.shift();
  }
  return ok;
}

/** Clean the pile: the monkeys get swept off and the done comments are archived (⌘Z brings them back). */
async function cleanPile() {
  if (!document.querySelector('.heap.physics > *')) return toast('The pile is already clean');
  state.moving = true;
  pile.sweep();
  await sleep(700);
  try {
    const { archived } = await api('POST', '/api/pile/clean', { project: state.project || undefined });
    pile.clearBananas();
    state.bananas = 0;
    if (archived.length) { undoStack.push({ type: 'clean', ids: archived }); redoStack.length = 0; }
    state.moving = false;
    state.allDone = false;
    await load();
    toast(archived.length ? `Cleaned the pile: ${archived.length} archived · ⌘Z to undo` : 'The pile is already clean');
  } catch (e) {
    pile.unsweep();
    state.moving = false;
    toast(e.message);
  }
}

// Going back to "fixed" needs a note: reuse the one it had.
const noteFor = (status, step) => (status === 'fixed' ? step.fixNote || step.note || 'Restored with undo' : undefined);

async function undo() {
  const step = undoStack.pop();
  if (!step) return toast('Nothing to undo');
  if (step.type === 'clean') {
    try {
      const { restored } = await api('POST', '/api/pile/restore', { ids: step.ids });
      redoStack.push(step);
      await load();
      return toast(`Undo: ${restored.length} back on the pile`);
    } catch (e) { undoStack.push(step); return toast(e.message); }
  }
  if (await changeStatus(step.id, step.from, noteFor(step.from, step), { from: 'undo' })) {
    redoStack.push(step);
    toast(`Undo: ${nameOf(step.id)} back to ${LABEL[step.from]}`);
  } else undoStack.push(step);
}

async function redo() {
  const step = redoStack.pop();
  if (!step) return toast('Nothing to redo');
  if (step.type === 'clean') {
    try {
      await api('POST', '/api/pile/clean', { ids: step.ids });
      undoStack.push(step);
      await load();
      return toast(`Redo: cleaned ${step.ids.length} off the pile`);
    } catch (e) { redoStack.push(step); return toast(e.message); }
  }
  if (await changeStatus(step.id, step.to, noteFor(step.to, step), { from: 'redo' })) {
    undoStack.push(step);
    toast(`Redo: ${nameOf(step.id)} to ${LABEL[step.to]}`);
  } else redoStack.push(step);
}

const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
document.addEventListener('keydown', (ev) => {
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.key.toLowerCase() !== 'z') return;
  if (isEditable(document.activeElement)) return;   // normal text undo in fields
  ev.preventDefault();
  (ev.shiftKey ? redo : undo)();
});
/** Called by the Mac panel for ⌘Z / ⌘⇧Z. Returns 'native' when a text field should undo itself. */
window.gcUndo = (redoing) => {
  if (drawing()) { if (!redoing) drawUndo(); return 'handled'; }
  if (isEditable(document.activeElement)) return 'native';
  (redoing ? redo : undo)();
  return 'handled';
};

$('#items').addEventListener('mousedown', (ev) => {
  if (ev.target.closest('.monkey, .pile')) ev.preventDefault();   // no text selection or focus box on quick clicks
});

$('#items').addEventListener('click', async (ev) => {
  const monkey = ev.target.closest('.monkey');
  if (monkey) return poke(monkey);
  if (ev.target.closest('[data-act="clean-pile"]')) return cleanPile();
  if (ev.target.closest('.heap [data-key]') || pile.recentlyTouched()) return;
  if (ev.target.closest('[data-act="toggle-done"]')) { state.allDone = !state.allDone; return render(); }
  const li = ev.target.closest('.item');
  if (!li) return;
  const id = Number(li.dataset.id);
  const detach = ev.target.closest('[data-detach]')?.dataset.detach;
  if (detach) {
    ev.preventDefault();
    if (!confirm('Remove this attachment?')) return;
    await api('DELETE', `/api/attachments/${detach}`).catch((e) => toast(e.message));
    await loadDetail(id);
    return load();
  }
  const act = ev.target.closest('[data-act]')?.dataset.act;
  const c = state.comments.find((x) => x.id === id);

  // (blur first: Safari keeps focus in the text field when a button is clicked, which would hold the re-render)
  if (act === 'ask-fix' || act === 'ask-reopen') { document.activeElement?.blur(); clearAskFiles(); state.asking = { id, kind: act.slice(4) }; return render(); }
  if (act === 'cancel-ask') { document.activeElement?.blur(); clearAskFiles(); state.asking = null; return render(); }
  if (ev.target.closest('[data-ask-shot]')) { ev.preventDefault(); return takeScreenshot('ask'); }
  const askEdit = !ev.target.closest('[data-ask-rm]') && ev.target.closest('[data-ask-edit]')?.dataset.askEdit;
  if (askEdit !== undefined && askEdit !== false && state.askFiles[Number(askEdit)]?.type.startsWith('image/')) {
    ev.preventDefault();
    const k = Number(askEdit);
    const f = state.askFiles[k];
    return openEditor(f, { onDone: (edited) => {
      if (f.url) URL.revokeObjectURL(f.url);
      state.askFiles[k] = Object.assign(edited, { url: URL.createObjectURL(edited) });
      render();
    } });
  }
  const askRm = ev.target.closest('[data-ask-rm]')?.dataset.askRm;
  if (askRm !== undefined) {
    ev.preventDefault();
    const [f] = state.askFiles.splice(Number(askRm), 1);
    if (f?.url) URL.revokeObjectURL(f.url);
    const text = $(`#ask-${id} input:not([type=file])`)?.value || '';
    document.activeElement?.blur();
    render();
    const again = $(`#ask-${id} input:not([type=file])`);
    if (again) again.value = text;
    return $(`#ask-${id} input:not([type=file])`)?.focus();
  }
  if (act === 'done') return changeStatus(id, 'done');
  if (act === 'open-file') {
    return localApi(`/api/comments/${id}/open`)
      .then((r) => toast(`Opened ${r.opened.split('/').pop()}${r.line ? `:${r.line}` : ''}`), (e) => toast(e.message));
  }
  if (act === 'agent') return askAgent(c);
  if (act === 'copy') {
    const text = `GoodComments (${c.project_id || 'no project'}): ${c.body}${c.location ? `\nWhere: ${c.location}` : ''}\nWhen it's fixed, run: gc fix ${c.id} "what you changed"  (or MCP tool mark_fixed)`;
    await navigator.clipboard.writeText(text).then(() => toast('Copied for an agent'), () => toast('Copy failed'));
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Delete ${nameOf(id)}? This can't be undone.`)) return;
    li.classList.add('leaving');
    await api('DELETE', `/api/comments/${id}`).catch((e) => toast(e.message));
    return load();
  }
  if (act || ev.target.closest('a, input, form, button')) return;

  // click the sheet to see its history
  if (state.expanded.has(id)) state.expanded.delete(id);
  else { state.expanded.add(id); await loadDetail(id); }
  render();
});

$('#items').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const value = form.querySelector('input:not([type=file])').value.trim();
  if (form.classList.contains('ask')) {
    const id = Number(form.id.slice(4));
    const input = form.querySelector('input:not([type=file])');
    if (form.dataset.kind === 'fix' && !value) {
      // a fix needs a note, so whoever checks it knows what to look at
      input.classList.remove('invalid');
      void input.offsetWidth; // restart the shake
      input.classList.add('invalid');
      input.placeholder = 'Add a short note on what changed';
      input.focus();
      return;
    }
    input.blur();
    const files = state.askFiles.slice();
    const status = form.dataset.kind === 'fix' ? 'fixed' : 'open';
    const note = value || (files.length && status === 'open' ? 'See screenshot' : value);
    state.askFiles = [];
    const ok = await changeStatus(id, status, note);
    if (ok && files.length) {
      await uploadFiles(id, files);
      files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
      await load();
    } else if (!ok) state.askFiles = files;
    return;
  }
  if (form.dataset.note && value) {
    form.querySelector('input').blur();
    await api('POST', `/api/comments/${form.dataset.note}/notes`, { note: value }).catch((e) => toast(e.message));
    load();
  }
});

$('#items').addEventListener('change', (ev) => {
  if (!ev.target.matches('[data-ask-file]')) return;
  addAskFiles(ev.target.files);
  ev.target.value = '';
});

$('#items').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.asking) { clearAskFiles(); state.asking = null; document.activeElement.blur(); render(); }
});
$('#line').addEventListener('focusout', () => setTimeout(() => state.pending && render(), 0));

$('#states').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  state.status = b.dataset.status;
  state.asking = null;
  store.set('status', state.status);
  // every state is visible: jump to its zone instead of filtering
  if (state.status === 'done' && !state.allDone) state.allDone = true;
  render();
  const zone = $(`.zone[data-zone="${state.status}"]`);
  zone?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  zone?.classList.add('flash');
  setTimeout(() => zone?.classList.remove('flash'), 900);
});

$('#projects').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-new-project')) return openProjectDialog();
  state.project = b.dataset.project;
  store.set('project', state.project);
  load();
});
$('#projects').addEventListener('dblclick', (ev) => {
  const b = ev.target.closest('[data-project]');
  const p = b && state.projects.find((x) => x.id === b.dataset.project);
  if (p) openProjectDialog(p);
});

// drop screenshots straight onto a card
$('#items').addEventListener('dragover', (ev) => {
  const li = ev.target.closest('.item');
  if (!li || !ev.dataTransfer.types.includes('Files')) return;
  ev.preventDefault();
  document.querySelectorAll('.item.dragging').forEach((x) => x !== li && x.classList.remove('dragging'));
  li.classList.add('dragging');
});
$('#items').addEventListener('dragleave', (ev) => ev.target.closest('.item')?.classList.remove('dragging'));
$('#items').addEventListener('drop', async (ev) => {
  const li = ev.target.closest('.item');
  if (!li) return;
  ev.preventDefault();
  li.classList.remove('dragging');
  if (state.asking && Number(li.dataset.id) === state.asking.id) return addAskFiles(ev.dataTransfer.files);
  const files = (await Promise.all(imageFiles(ev.dataTransfer.files).map(prepareFile))).filter(Boolean);
  if (!files.length) return toast('Nothing to attach there');
  await uploadFiles(li.dataset.id, files);
  toast(`Attached ${files.length} to ${nameOf(li.dataset.id)}`);
  load();
});

// ---------- composer ----------
const composer = $('#composer');
const body = $('#c-body');
const grow = () => { body.style.height = 'auto'; body.style.height = Math.min(body.scrollHeight + 2, 160) + 'px'; };
body.addEventListener('input', grow);
body.addEventListener('focus', () => composer.classList.add('open'));
composer.addEventListener('focusout', () => setTimeout(() => {
  if (!composer.contains(document.activeElement) && !body.value.trim() && !pendingFiles.length) composer.classList.remove('open');
}, 120));
body.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); composer.requestSubmit(); }
  if (ev.key === 'Escape') { body.value = ''; grow(); body.blur(); }
});
let pendingFiles = [];
function renderFiles() {
  const box = $('#c-files');
  box.classList.toggle('has', pendingFiles.length > 0);
  box.innerHTML = pendingFiles.map((f, i) => `<span class="file" data-edit="${i}" title="Click to draw on it" style="${f.url ? `background-image:url(${f.url})` : ''}">${f.url ? '' : extOf(f.name)}<button type="button" data-rm="${i}">✕</button></span>`).join('');
}
async function addFiles(list) {
  const files = (await Promise.all(imageFiles(list).map(prepareFile))).filter(Boolean);
  for (const f of files) pendingFiles.push(Object.assign(f, { url: isImage(f) ? URL.createObjectURL(f) : null }));
  if (files.length) { composer.classList.add('open'); renderFiles(); body.focus(); }
  return files.length;
}
$('#c-files').addEventListener('click', (ev) => {
  const i = ev.target.dataset.rm;
  if (i !== undefined) { pendingFiles.splice(Number(i), 1); return renderFiles(); }
  const e = ev.target.closest('[data-edit]')?.dataset.edit;
  const f = e !== undefined && pendingFiles[Number(e)];
  if (!f || !f.type.startsWith('image/')) return;
  openEditor(f, { onDone: (edited) => {
    if (f.url) URL.revokeObjectURL(f.url);
    pendingFiles[Number(e)] = Object.assign(edited, { url: URL.createObjectURL(edited) });
    renderFiles();
  } });
});
$('#c-shot').addEventListener('click', () => takeScreenshot('composer'));
$('#c-file').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; body.focus(); });
// Paste a screenshot anywhere in the column: it goes to the open card if one is
// expanded (and you're not typing in the composer), otherwise to a new comment.
document.addEventListener('paste', async (ev) => {
  if (drawing()) return;
  const files = clipboardFiles(ev.clipboardData);
  if (!files.length) return;
  ev.preventDefault();
  if (state.asking && !composer.contains(document.activeElement)) {
    if (await addAskFiles(files)) toast('Screenshot added');
    return;
  }
  const expanded = [...state.expanded];
  if (expanded.length === 1 && !composer.contains(document.activeElement)) {
    const ready = (await Promise.all(files.map(prepareFile))).filter(Boolean);
    await uploadFiles(expanded[0], ready);
    toast(`Attached ${ready.length} to ${nameOf(expanded[0])}`);
    await loadDetail(expanded[0]);
    return load();
  }
  if (await addFiles(files)) toast('Screenshot added — write a note and Hang');
});
composer.addEventListener('dragover', (ev) => { if (ev.dataTransfer.types.includes('Files')) { ev.preventDefault(); composer.classList.add('dragging'); } });
composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
composer.addEventListener('drop', (ev) => { ev.preventDefault(); composer.classList.remove('dragging'); addFiles(ev.dataTransfer.files); body.focus(); });

composer.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = body.value.trim() || (pendingFiles.length ? 'Screenshot' : '');
  if (!text) return body.focus();
  const project = $('#c-project').value;
  store.set('lastProject', project);
  try {
    const c = await api('POST', '/api/comments', { body: text, project: project || undefined, source: $('#c-source').value, location: $('#c-location').value });
    if (pendingFiles.length) await uploadFiles(c.id, pendingFiles);
    pendingFiles.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    pendingFiles = []; renderFiles();
    body.value = ''; $('#c-location').value = ''; grow();
    state.status = 'open'; store.set('status', 'open');
    toast(`Hung ${nameOf(c)}`);
    if (QUICK) return quickClose('quickDone', c.id);
    await load();
    $('#line').scrollTop = 0;
  } catch (e) { toast(e.message); }
});

// ---------- quick capture (?quick=1): the ⌃⌥N window and "Send to GoodComments" ----------
// ↵ hangs it, ⇧↵ is a new line, esc closes. The Mac app shows and hides the window.
function quickClose(action, id) {
  const bridge = window.webkit?.messageHandlers?.gc;
  body.value = ''; $('#c-location').value = ''; $('#c-source').value = ''; grow();
  pendingFiles.forEach((f) => f.url && URL.revokeObjectURL(f.url));
  pendingFiles = []; renderFiles();
  bridge?.postMessage({ action, id });
}
/** The Mac app calls this each time the window opens, with selected text when it came from the Services menu. */
window.gcQuick = ({ text = '' } = {}) => {
  body.value = text; grow();
  const sel = $('#c-project');
  const last = store.get('lastProject', '');
  load().then(() => { if (state.projects.some((p) => p.id === last)) sel.value = last; }).catch(() => {});
  body.focus();
  body.setSelectionRange(body.value.length, body.value.length);
};
if (QUICK) {
  composer.classList.add('open');
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return quickClose('quickCancel'); }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.target.matches('textarea, input')) {
      ev.preventDefault(); ev.stopPropagation(); composer.requestSubmit();
    }
  }, true);
  window.gcQuick({ text: params.get('text') || '' });
}

// ---------- project dialog ----------
const dlg = $('#project-dialog');
let editing = null;
function openProjectDialog(p = null) {
  editing = p;
  const f = $('#project-form');
  $('#pd-title').textContent = p ? 'Edit project' : 'New project';
  f.name.value = p?.name || '';
  f.path.value = p?.path || '';
  f.color.value = p?.color || ['#7c5cff', '#ff7a59', '#2bb3a3', '#3b82f6', '#e5487a', '#f2a93b'][state.projects.length % 6];
  $('#pd-delete').hidden = !p;
  dlg.showModal();
}
$('#project-form').addEventListener('submit', (ev) => {
  const name = ev.target.name;
  if (ev.submitter?.value === 'ok' && !name.value.trim()) {
    ev.preventDefault();
    name.classList.remove('invalid'); void name.offsetWidth; name.classList.add('invalid');
    name.placeholder = 'Give the project a name';
    name.focus();
  }
});
dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'ok') return;
  const f = $('#project-form');
  const data = { name: f.name.value, path: f.path.value, color: f.color.value };
  try {
    const p = editing ? await api('PATCH', `/api/projects/${editing.id}`, data) : await api('POST', '/api/projects', data);
    if (!editing) { state.project = p.id; store.set('project', p.id); }
    load();
  } catch (e) { toast(e.message); }
});
$('#pd-delete').addEventListener('click', async () => {
  if (!editing || !confirm(`Delete project “${editing.name}”? Its comments stay, without a project.`)) return;
  await api('DELETE', `/api/projects/${editing.id}`).catch((e) => toast(e.message));
  dlg.close();
  if (state.project === editing.id) { state.project = ''; store.set('project', ''); }
  load();
});

// ---------- settings ----------
const settingsDlg = $('#settings-dialog');
/** Light / dark / follow the system. Remembered locally too, so the page doesn't flash the wrong colours while it loads. */
function setTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  store.set('theme', theme || 'system');
}
function applyTheme(theme) {
  setTheme(theme);
  // the Mac app matches its glass (and the other window) to it
  window.webkit?.messageHandlers?.gc?.postMessage({ action: 'theme', theme: theme || 'system' });
}
window.gcTheme = setTheme;
applyTheme(store.get('theme', 'system'));
api('GET', '/api/settings').then((s) => applyTheme(s.theme)).catch(() => {});
$('#settings-btn').addEventListener('click', async () => {
  try {
    const s = await api('GET', '/api/settings');
    const sel = $('#settings-form').auto_clean_days;
    if (![...sel.options].some((o) => Number(o.value) === s.auto_clean_days)) sel.add(new Option(`${s.auto_clean_days} days after approving`, s.auto_clean_days));
    sel.value = String(s.auto_clean_days);
    $('#settings-form').theme.value = s.theme;
    settingsDlg.showModal();
  } catch (e) { toast(e.message); }
});
$('#settings-form').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  const days = Number($('#settings-form').auto_clean_days.value);
  const theme = $('#settings-form').theme.value;
  try {
    const before = await api('GET', '/api/settings');
    const s = await api('PATCH', '/api/settings', { auto_clean_days: days, theme });
    applyTheme(s.theme);
    if (before.auto_clean_days === days) return;
    toast(days ? `Done comments now leave the pile ${days === 1 ? '1 day' : `${days} days`} after approving` : 'Automatic clean-up is off');
  } catch (e) { toast(e.message); }
});

// ---------- keyboard ----------
// n / c new comment · 1 2 3 zones · j / k move between cards · a approve · f mark fixed · r reopen
// ↵ expand · / search · esc clear. Never while typing in a field.
function applyFocus(scroll) {
  for (const el of document.querySelectorAll('#items .item.kfocus')) if (Number(el.dataset.id) !== state.focusId) el.classList.remove('kfocus');
  const el = state.focusId && $(`#items .item[data-id="${state.focusId}"]`);
  if (!el) return;
  el.classList.add('kfocus');
  if (scroll) el.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}
function setFocus(id) { state.focusId = id; applyFocus(true); }

const q = $('#q');
function openSearch() { q.focus(); q.select(); }
function clearSearch() {
  q.value = '';
  if (state.q) { state.q = ''; render(); }
}
q.addEventListener('input', () => { state.q = q.value.trim().toLowerCase(); render(); });
q.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { ev.preventDefault(); clearSearch(); q.blur(); }
  if (ev.key === 'Enter' || ev.key === 'ArrowDown') {   // jump into the results
    ev.preventDefault();
    q.blur();
    const first = $('#items .item[data-id]');
    if (first) setFocus(Number(first.dataset.id));
  }
});

document.addEventListener('keydown', (ev) => {
  if (isEditable(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey || drawing() || dlg.open || settingsDlg.open) return;
  if (ev.key === 'n' || ev.key === 'c') { ev.preventDefault(); body.focus(); return; }
  const tab = { 1: 'open', 2: 'fixed', 3: 'done' }[ev.key];
  if (tab) return $(`#states [data-status="${tab}"]`).click();
  if (ev.key === '/') { ev.preventDefault(); return openSearch(); }
  if (ev.key === 'Escape') {
    if (state.focusId) { state.focusId = null; applyFocus(false); }
    return clearSearch();
  }
  if (ev.key === 'j' || ev.key === 'k') {
    const cards = [...document.querySelectorAll('#items .item[data-id]')];
    if (!cards.length) return;
    const at = cards.findIndex((el) => Number(el.dataset.id) === state.focusId);
    const next = at < 0 ? (ev.key === 'j' ? 0 : cards.length - 1) : Math.max(0, Math.min(cards.length - 1, at + (ev.key === 'j' ? 1 : -1)));
    ev.preventDefault();
    return setFocus(Number(cards[next].dataset.id));
  }
  const c = state.focusId && state.comments.find((x) => x.id === state.focusId);
  if (!c || !$(`#items .item[data-id="${c.id}"]`)) return;
  if (ev.key === 'a') {
    if (c.status === 'fixed') changeStatus(c.id, 'done');
    else toast(c.status === 'open' ? 'Only cards in To check can be approved' : 'Already done');
  } else if (ev.key === 'f' || ev.key === 'r') {
    const kind = ev.key === 'f' ? 'fix' : 'reopen';
    if (kind === 'fix' && c.status !== 'open') return toast('Only open cards can be marked fixed');
    if (kind === 'reopen' && c.status === 'open') return toast('It’s already open');
    ev.preventDefault();   // don't type the letter into the box that opens
    clearAskFiles();
    state.asking = { id: c.id, kind };
    render();
    applyFocus(true);
  } else if (ev.key === 'Enter') {
    if (ev.target.closest?.('button, a, summary')) return;   // Enter on a focused button clicks it
    ev.preventDefault();
    if (state.expanded.has(c.id)) { state.expanded.delete(c.id); render(); }
    else loadDetail(c.id).then(() => { state.expanded.add(c.id); render(); });
  }
});

// ---------- live ----------
let reloadTimer;
let es;
function connect() {
  es?.close();
  es = new EventSource(withToken('/api/events'));
  es.addEventListener('open', () => $('#live').classList.add('on'));
  es.addEventListener('error', () => $('#live').classList.remove('on'));
  es.addEventListener('agent', (ev) => {
    try { const r = JSON.parse(ev.data); state.runs[r.id] = r; } catch { return; }
    render();
  });
  es.addEventListener('change', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch {}
    if (data.settings) api('GET', '/api/settings').then((x) => applyTheme(x.theme)).catch(() => {});
    const c = data.id && state.comments.find((x) => x.id === data.id);
    const li = c && $(`#items .item[data-id="${data.id}"]`);
    // an agent pulled a stick: show the card falling instead of just jumping
    if (li && data.status && c.status !== data.status && !state.moving && !reduceMotion()) {
      clearTimeout(reloadTimer);
      boardMove(li, data.id, data.status, null, { remote: true });
      return;
    }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 120);
  });
}

if (!QUICK) {
  setInterval(() => !state.asking && render(), 60000); // refresh "5m" labels
  api('GET', '/api/health').then((h) => { state.local = !!h.local; state.claude = !!h.claude; }).catch(() => {})
    .then(load).catch((e) => toast(e.message));
  connect();
}

// ---------- Mac edge panel: keep open / minimize ----------
// Only inside the Mac app, which exposes a message handler named "gc".
const panelBridge = window.webkit?.messageHandlers?.gc;
if (panelBridge) {
  $('#panel-ctl').hidden = false;
  $('#pin').addEventListener('click', () => panelBridge.postMessage({ action: 'togglePin' }));
  $('#minimize').addEventListener('click', () => panelBridge.postMessage({ action: 'minimize' }));
}
/** The Mac app calls this when you click a notification: put the focus ring on that card. */
window.gcFocus = async (id) => {
  if (state.q) clearSearch();
  await load();
  const c = state.comments.find((x) => x.id === Number(id));
  if (c?.status === 'done' && !state.allDone) { state.allDone = true; render(); }
  setFocus(Number(id));
};
/** The app tells the page whether the panel is kept open. */
window.gcPanel = ({ pinned }) => {
  const b = $('#pin');
  b.setAttribute('aria-pressed', String(!!pinned));
  b.title = pinned ? 'Kept open: click so it slides away when you leave it' : 'Keep open';
};

// ---------- screenshots: capture, draw, attach ----------
/**
 * Open the drawing editor. Inside the Mac panel the column is too narrow to draw in,
 * so the app grows the panel into a big window in the middle of the screen while it's open.
 */
function openEditor(src, opts = {}) {
  return openDrawEditor(src, {
    ...opts,
    onOpen: () => panelBridge?.postMessage({ action: 'editorOpen' }),
    onClose: () => panelBridge?.postMessage({ action: 'editorClose' }),
  });
}

/** target: 'composer' (a new comment) or 'ask' (the open fix / reopen box). */
async function takeScreenshot(target) {
  if (panelBridge) return panelBridge.postMessage({ action: 'capture', target });   // Mac app: pick an area of the screen
  try {
    drawThenAttach(await grabScreen(), target);                                      // browser: pick a screen, window or tab
  } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast(`Couldn't take a screenshot: ${e.message}`);
  }
}

function drawThenAttach(src, target) {
  openEditor(src, {
    onDone: async (file) => {
      if (target === 'ask' && state.asking) await addAskFiles([file]);
      else { await addFiles([file]); body.focus(); }
      toast('Screenshot attached');
    },
  });
}

/** The Mac app calls this with the area you picked (or null if you cancelled). */
window.gcScreenshot = (dataUrl, target) => {
  if (!dataUrl) return toast('No screenshot taken');
  drawThenAttach(dataUrl, target);
};

// ---------- drops anywhere in the column ----------
// A file dropped outside a card or the composer goes to a new comment (and never makes the page load the file).
document.addEventListener('dragover', (ev) => {
  if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault();
});
document.addEventListener('drop', (ev) => {
  if (!ev.dataTransfer?.types?.includes('Files')) return;
  ev.preventDefault();
  if (ev.target.closest?.('#items .item, #composer, .draw')) return;   // handled there
  addFiles(ev.dataTransfer.files).then((n) => n && toast(`${n} file${n > 1 ? 's' : ''} added to a new comment`));
});
