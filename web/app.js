import { t, ago, lang, languagePref, rememberLanguage } from './i18n.js';   // first: it translates the page as it's drawn
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
  ask: { agent: true, delete: true },   // Settings → Ask before: confirm Ask Claude and Delete (off = never ask)
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
  edit: null,            // the card being edited: { id, draft, files (new), remove (attachment ids), replace (id → drawn-on copy) }
  focusId: null,         // the card with the keyboard focus ring (j / k)
  q: '',                 // search text (filters cards, client-side)
  local: false,          // a server on this Mac: files can open in the editor, agents can run
  claude: false,        // Claude Code is installed
  runs: {},              // comment id → agent run { state, started, log }
};
document.documentElement.dataset.skin = 'trunk';   // the one look: monkeys on a trunk

// ---------- api ----------
async function api(method, path, body, raw) {
  const res = await fetch(path, {
    method,
    headers: raw ? raw.headers : body ? { 'content-type': 'application/json' } : {},
    body: raw ? raw.body : body ? JSON.stringify(body) : undefined,
  });
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

// Screenshots are stored as they're sent, so they're made small here: at most MAX_SIDE pixels on the long side,
// as WebP (JPEG where the browser can't write WebP, e.g. Safari), unless the original is already smaller.
const MAX_SIDE = 2000;
const QUALITY = 0.85;

/** A smaller copy of an image, or the original when shrinking doesn't help (or it's an animated GIF). */
async function shrinkImage(f, name) {
  if (!isImage(f) || f.type === 'image/gif') return f;
  let bmp;
  try { bmp = await createImageBitmap(f); } catch { return null; }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';   // JPEG has no transparency: transparent areas turn white, not black
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const encode = (type) => new Promise((r) => c.toBlob(r, type, QUALITY));
  let blob = await encode('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
  if (!blob) return null;
  const keep = scale === 1 && SUPPORTED.test(f.type) && f.size <= blob.size;
  if (keep) return name ? new File([f], `${name}.${f.type.split('/')[1].replace('jpeg', 'jpg')}`, { type: f.type }) : f;
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const base = name || (f.name || 'screenshot').replace(/\.[^.]+$/, '');
  return new File([blob], `${base}.${ext}`, { type: blob.type });
}

/** Name pasted images, shrink images, and turn formats the server doesn't take (TIFF, BMP…) into WebP/JPEG. */
async function prepareFile(f) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  if (!isImage(f) || f.gcReady) return f;                   // documents go as they are; shrunk ones aren't shrunk twice
  const unnamed = !f.name || f.name === 'image.png' || /^screenshot-[\d-]+\.png$/.test(f.name);
  const out = await shrinkImage(f, unnamed ? `screenshot-${stamp}` : null);
  if (!out) toast(`Can't read ${f.type || 'that file'}`);
  else out.gcReady = true;
  return out;
}

async function loadDetail(id) {
  try { state.details.set(id, await api('GET', `/api/comments/${id}`)); }
  catch { state.expanded.delete(id); state.details.delete(id); }
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Escaped text with its web addresses turned into links (they open outside the column). */
const linkify = (s) => esc(s).replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const isUrl = (s) => /^https?:\/\//i.test(s || '');
// "src/header.php:12", "./notes.md", "~/site/style.css": a file in the project's folder (not "/contact", a page)
const looksLikeFile = (s) => /^\S+$/.test(s || '') && (/\.\w{1,8}(:\d+){0,2}$/.test(s) || /^(\.{1,2}|~)\//.test(s));
const icons = {
  pencil: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.8 2.7l2.5 2.5L5.6 12.9l-3.1.6.6-3.1z"/></svg>',
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
  if ($('#line').contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) { state.pending = true; return; }
  // …and while you have text selected, so a live update doesn't drop the selection before you copy it
  if (selecting()) { state.pending = true; return; }
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

/** Text is selected somewhere on the board (re-rendering would move the nodes and lose it). */
function selecting() {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && $('#line').contains(sel.getRangeAt(0).commonAncestorContainer);
}
// once the selection is gone, catch up on what was held back
document.addEventListener('selectionchange', () => { if (state.pending && !selecting()) setTimeout(() => state.pending && render(), 0); });

// ---------- the board: every state on one column, top to bottom ----------
const ZONES = {
  open: ['On your mind', 'Write it down and a monkey holds it for you.'],
  fixed: ['To look at', 'An agent did it. Look it over, then let it go.'],
  done: ['Let go', 'Off your mind. The pile grows as the project gets done.'],
};
// resting tilt shrinks on wide panels, so the far edge never sags more than a few pixels
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
      <div class="zone-head"><span class="dot ${key}"></span><h3>${z[key][0]}</h3><b>${count}</b><span class="zone-hint">${simpleLook() && key === 'open' ? 'Write it down and it waits here for you.' : z[key][1]}</span></div>
      ${inner}
      <ol class="zone-items">${items.map((c) => renderItem(c, i++)).join('')}</ol>
      ${!items.length && key !== 'done' ? `<p class="zone-empty">${state.q ? 'No matches.' : key === 'open' ? 'Nothing on your mind.' : 'Nothing waiting for you.'}</p>` : ''}
    </li>`;

  // the monkey of a card that's falling right now waits at the top until the card lands (pile.release)
  const newest = state.falling ?? null;
  const heap = done.slice(0, 60).map((c) =>
    `<i data-key="c${c.id}" class="${c.id === newest ? 'new' : ''}" style="--pc:${esc(c.project_color || 'var(--ink-3)')};--r:${tilt(c.id)}deg" title="${esc(shortText(c.body, 60))}"><svg viewBox="16 14 32 32" aria-hidden="true"><use href="#gc-head" width="64" height="60"/></svg></i>`).join('');
  const pileHtml = `<div class="pile" data-act="toggle-done" style="--fill:${pct}" title="Drag the monkeys around · click empty space to list what's done">
         <span class="heap physics">${heap}</span><span class="ground"></span>
         <span class="pile-label">${done.length} let go · ${pct}%${done.length ? ' <button class="pile-clean" data-act="clean-pile" title="Clean the pile: archive the done comments (⌘Z to undo)">Sweep the pile</button>' : ''}</span></div>`;
  const doneShown = state.allDone ? done : [];
  const doneZone = zone('done', doneShown, pileHtml, done.length).replace('</ol>', `</ol>${done.length ? `<button class="act show-done" data-act="toggle-done">${state.allDone ? 'Hide them' : `Show all ${done.length}`}</button>` : ''}`);

  patchItems(zone('open', open) + zone('fixed', fixed) + doneZone);
  pile.attach($('.pile .heap.physics'));
  $('#empty').hidden = true;
}

function renderProjects() {
  const total = (p) => p.open + p.fixed;
  const chip = (p) => `
      <button class="chip" data-project="${esc(p.id)}" aria-pressed="${state.project === p.id}" title="${esc(p.path || p.name)} · double-click to edit">
        <span class="swatch" style="background:${esc(p.color)}"></span>${esc(p.name)}${total(p) ? `<span class="n">${total(p)}</span>` : ''}${state.project === p.id ? `<span class="edit" data-edit-project title="Edit name, folder and color">${icons.pencil}</span>` : ''}
      </button>`;
  const chips = [
    `<button class="chip" data-project="" aria-pressed="${!state.project}">All</button>`,
    ...state.projects.map(chip),
    '<button class="chip add" data-new-project title="New project">+ Project</button>',
  ];
  // same chips: keep the buttons, so a double-click (to edit) lands on the button it started on
  const chipsHtml = chips.join('');
  if (chipsHtml !== renderProjects.last) $('#projects').innerHTML = renderProjects.last = chipsHtml;

  // The composer files new comments under the project chip that's selected, so
  // what you write lands in the list you're looking at. (The quick window has no
  // chips: it remembers the last project used.)
  const sel = $('#c-project');
  const keep = QUICK ? (sel.value || store.get('lastProject', '')) : state.project;
  sel.innerHTML = '<option value="">No project</option>' + state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = state.projects.some((p) => p.id === keep) ? keep : '';
  renderTarget();
}

/** Say which project the comment being written will hang on. */
function renderTarget() {
  const p = state.projects.find((x) => x.id === $('#c-project').value);
  $('#c-target').innerHTML = p
    ? `New comment on <span class="swatch" style="background:${esc(p.color)}"></span><b>${esc(p.name)}</b>`
    : 'New comment, <b>no project</b>';
  $('#composer').style.setProperty('--target', p ? p.color : 'var(--hair-2)');
  $('#c-body').placeholder = p ? `What’s on your mind about ${p.name}?` : 'What’s on your mind?';
  $('#composer [type=submit]').title = `Hang it on ${p ? p.name : 'no project'} (⌘↵)`;
}

const hash = (str) => { let h = 5381; for (let k = 0; k < str.length; k++) h = ((h << 5) + h + str.charCodeAt(k)) | 0; return (h >>> 0).toString(36); };
const TRANSIENT = ['fresh', 'landed', 'caught', 'leaving', 'pulling', 'arrived-open', 'arrived-fixed', 'arrived-done', 'to-open', 'to-fixed', 'to-done', 'dragging'];

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
  ? `<a class="shot" href="/api/attachments/${a.id}" target="_blank" title="${esc(a.name)}"><img src="/api/attachments/${a.id}" alt="${esc(a.name)}" loading="lazy"><button class="x" data-detach="${a.id}" title="Remove">✕</button></a>`
  : `<a class="shot pdf" href="/api/attachments/${a.id}" target="_blank">${esc(a.name)}<button class="x" data-detach="${a.id}" title="Remove">✕</button></a>`;
const camera = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h2l1.2-1.8h4.6l1.2 1.8h2v7h-11z"/><circle cx="8" cy="8.8" r="2.3"/></svg>';
const paperclip = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10.5 4.5L5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2"/></svg>';

function renderItem(c, i) {
  const d = state.details.get(c.id);
  const expanded = state.expanded.has(c.id);
  const asking = state.asking?.id === c.id ? state.asking.kind : null;

  const run = state.runs[c.id];
  const project = state.projects.find((p) => p.id === c.project_id);
  const session = c.status === 'open' && run?.state === 'session';
  // where Claude would work: the project's folder, or the repo an absolute location points into
  const canAsk = state.local && (project?.path || /^(\/|~\/)/.test(c.location || ''));
  const openBtn = !c.location ? ''
    : isUrl(c.location) ? `<a class="act" href="${esc(c.location)}" target="_blank" rel="noopener" title="Open ${esc(c.location)}">${icons.open}Open</a>`
    : state.local && project?.path && looksLikeFile(c.location) ? `<button class="act" data-act="open-file" title="Open ${esc(c.location)} in your editor">${icons.open}Open</button>` : '';
  const agentBtn = c.status !== 'open' || !canAsk ? ''
    : `<button class="act agent" data-act="agent" title="${state.claude ? `Open a new Claude Code session in the Claude app, in ${esc(session ? run.folder : project?.path || 'the folder its location is in')}, to fix this` : 'The Claude app isn’t installed: click to see how'}">${icons.spark}${session ? 'New session' : 'Ask Claude'}</button>`;
  const sessionNote = session ? `<div class="agent-note session">Claude session opened in the Claude app · ${esc(run.folder.replace(/^\/Users\/[^/]+/, '~'))} · ${ago(run.started)}</div>` : '';

  const actions = {
    open: `<button class="act fixit" data-act="ask-fix">${icons.wrench}Mark fixed</button>${openBtn}${agentBtn}`,
    fixed: `<button class="act approve" data-act="done">${icons.check}Let it go</button>
            <button class="act" data-act="ask-reopen">${icons.undo}Not yet</button>${openBtn}`,
    done: `<button class="act" data-act="ask-reopen">${icons.undo}Bring back</button>`,
  }[c.status];

  const atts = c.attachments || [];
  const reopenedNow = c.status === 'open' && c.reopened_at;
  const reopenShots = reopenedNow ? atts.filter((a) => a.created_at >= c.reopened_at) : [];
  const fixShots = c.fix_note && c.status !== 'open' && c.fixed_at ? atts.filter((a) => a.created_at >= c.fixed_at) : [];
  // a comment that came back has a thread: every fix and every reopen, oldest first, each with its screenshots
  const steps = (c.thread || []).filter((e) => e.type === 'fixed' || e.type === 'reopened');
  const hasThread = steps.some((e) => e.type === 'reopened');
  const stepShots = hasThread ? steps.map((e, k) => atts.filter((a) => a.created_at >= e.at && (k === steps.length - 1 || a.created_at < steps[k + 1].at))) : [];
  const threadShots = stepShots.flat();
  const otherShots = atts.filter((a) => hasThread ? !threadShots.includes(a) : !reopenShots.includes(a) && !fixShots.includes(a));
  const thread = hasThread ? `
    <ol class="thread" title="Every fix and reopen, oldest first">${steps.map((e, k) => `
      <li class="${e.type === 'fixed' ? 't-fix' : 't-reopened'}${k === steps.length - 1 ? ' latest' : ''}">
        <span class="who">${e.type === 'fixed' ? 'Fixed' : '↩ Reopened'}${e.actor ? ` by ${esc(e.actor)}` : ''} · ${ago(e.at)}</span>${e.note ? `<span class="note">${linkify(e.note)}</span>` : ''}
        ${stepShots[k].length ? `<div class="shots">${stepShots[k].map(shotHtml).join('')}</div>` : ''}</li>`).join('')}
    </ol>` : '';
  const fix = c.fix_note ? `
    <div class="fix"><span class="who">Fixed${c.fixed_by ? ` by ${esc(c.fixed_by)}` : ''} · ${ago(c.fixed_at)}</span>${linkify(c.fix_note)}
      ${fixShots.length ? `<div class="shots">${fixShots.map(shotHtml).join('')}</div>` : ''}</div>` : '';
  const reopened = reopenedNow && (c.reopen_note || reopenShots.length) ? `
    <div class="reopened"><span class="who">↩ Reopened${c.reopened_by ? ` by ${esc(c.reopened_by)}` : ''} · ${ago(c.reopened_at)}</span>${c.reopen_note ? `<span class="note">${linkify(c.reopen_note)}</span>` : ''}
      ${reopenShots.length ? `<div class="shots">${reopenShots.map(shotHtml).join('')}</div>` : ''}</div>` : '';

  const ask = asking ? `
    <form class="ask ${asking}" id="ask-${c.id}" data-kind="${asking}" novalidate>
      <input placeholder="${asking === 'fix' ? 'What did you change?' : 'What’s still wrong?'}">
      <button type="button" class="act icon ask-clip" data-ask-shot title="Take a screenshot and draw on it">${camera}</button>
      <label class="act icon ask-clip" title="Attach screenshots (or paste ⌘V / drop them here)"><input type="file" multiple hidden data-ask-file>${paperclip}</label>
      <button class="act ${asking === 'fix' ? 'fixit' : 'reopen'}">${asking === 'fix' ? 'Fixed' : 'Send it back'}</button>
      <button type="button" class="act icon" data-act="cancel-ask" title="Cancel">✕</button>
      <div class="ask-files${state.askFiles.length ? ' has' : ''}">${state.askFiles.map((f, k) => `<span class="file" data-ask-edit="${k}" title="Click to draw on it" style="${f.url ? `background-image:url(${f.url})` : ''}">${f.url ? '' : extOf(f.name)}<button type="button" data-ask-rm="${k}" title="Remove">✕</button></span>`).join('')}
        <span class="ask-hint">${state.askFiles.length ? '' : 'Paste or drop screenshots here'}</span></div>
    </form>` : '';

  const history = expanded && d ? `
    <div class="detail">
      <ol class="history">${d.events.map((e) => `
        <li><span class="d ${esc(e.type)}"></span><span>${esc(e.type)}${e.actor ? ` by ${esc(e.actor)}` : ''}<time>${ago(e.at)}</time>${e.note ? `<span class="n">${linkify(e.note)}</span>` : ''}</span></li>`).join('')}
      </ol>
      <form class="note-form" data-note="${c.id}"><input placeholder="Add a note…"><button class="act">Note</button></form>
    </div>` : '';

  const editingThis = state.edit?.id === c.id;
  const sig = hash(JSON.stringify([c, expanded, asking, run, project?.path, state.local, state.claude, d?.events?.length ?? -1, asking ? state.askFiles.map((f) => f.name + f.size) : 0,
    editingThis ? [state.edit.files.map((f) => f.name + f.size), [...state.edit.remove], [...state.edit.replace.keys()], state.edit.draft.project] : 0]));
  return `
    <li data-sig="${sig}" class="item status-${c.status}${expanded ? ' expanded' : ''}${editingThis ? ' editing' : ''}${state.seen.has(c.id) ? '' : ' fresh'}${state.moved?.id === c.id ? ` arrived-${c.status}` : ''}" data-id="${c.id}" style="--i:${Math.min(i, 12)};--pc:${esc(c.project_color || 'var(--ink-3)')};--tw:0deg">
      <span class="pin" aria-hidden="true"></span>
      <span class="peg" aria-hidden="true"><i></i><i></i>
      <svg class="monkey" viewBox="0 0 64 54" role="img" aria-label="Monkey">
        <path class="arm" d="M26 31 C 20 25, 16 18, 17 9.5"/>
        <path class="arm a2" d="M38 31 C 44 25, 48 18, 47 9.5"/>
        <path class="arm a2-down" d="M40 37 C 47 40, 52 45, 54 50"/>
        <g class="wave-arm"><path class="arm" d="M39 32 C 47 27, 53 21, 56 14"/><path class="hand" d="M53.4 14 c.3-3.4 5.2-3.6 5.6-.3"/></g>
        <path class="hand" d="M14.3 10.6 c.4-3.4 5.2-3.6 5.6-.2"/><path class="hand a2" d="M44.3 10.6 c.4-3.4 5.2-3.6 5.6-.2"/><path class="hand a2-down" d="M52.4 50.4 c1.4 2.6 4.2 2.4 4.8.2"/>
        <g class="head" transform="translate(0 2)">
          <path class="face" d="M18.5 27 C13 25 10 29 12 33 C13.5 36 17 36 19 34.5"/>
          <path class="face" d="M45.5 27 C51 25 54 29 52 33 C50.5 36 47 36 45 34.5"/>
          <path class="face" d="M18 30 C17 20 25 14 32 14 C40 14 47 20 46 31 C45 41 39 46 32 46 C24 46 18 40 18 30 Z"/>
          <circle class="eye" cx="27" cy="29" r="1.8"/><circle class="eye" cx="37" cy="29" r="1.8"/>
          <path class="mouth" d="M28.5 36 Q32 40 35.5 36"/>
          <ellipse class="mouth-o" cx="32" cy="37" rx="2" ry="2.4"/>
        </g>
      </svg></span>
      <article class="sheet">
        <div class="meta">
          <span class="proj">${esc(c.project_name || 'No project')}</span>
          ${c.source ? `<span class="src">${esc(c.source)}</span>` : ''}
          <span>${ago(c.status === 'done' ? c.done_at : c.status === 'fixed' ? c.fixed_at : c.created_at)}</span>

        </div>
        ${editingThis ? editForm(c) : `<div class="body" title="Double-click to edit">${linkify(c.body)}</div>
        ${c.location ? (isUrl(c.location) ? `<a class="where" href="${esc(c.location)}" target="_blank" rel="noopener">${esc(c.location)}</a>` : `<span class="where">${esc(c.location)}</span>`) : ''}
        ${otherShots.length ? `<div class="shots">${otherShots.map(shotHtml).join('')}</div>` : ''}
        ${hasThread ? thread : `${reopened}
        ${c.status === 'open' ? '' : fix}`}
        ${sessionNote}
        ${ask || `<div class="actions">${actions}<span class="tail">
          <button class="act icon" data-act="edit" title="Edit: text, project, where, attachments (e)">${icons.pencil}</button>
          <button class="act icon" data-act="copy" title="Copy for an agent">${icons.copy}</button>
          <button class="act icon" data-act="delete" title="Delete">${icons.trash}</button></span></div>`}`}
        ${history}
      </article>
    </li>`;
}

// ---------- local actions: open in the editor, ask an agent ----------
// The x-goodcomments header tells the server this came from the page, not from another site.
const localApi = (path) => api('POST', path, null, { headers: { 'x-goodcomments': '1' } });

async function askAgent(c) {
  const project = state.projects.find((p) => p.id === c.project_id);
  if (!state.claude) return alert(t('The Claude app isn’t installed.\n\nGet it at https://claude.com/download, sign in, then reload GoodComments.'));
  const where = project?.path || 'the folder its location is in';
  if (state.ask.agent && !confirm(t('Open a new Claude Code session for {name}?\n\nIt opens in the Claude app, in {where}, with the comment as its task: send it, then watch and steer it. It moves the card to To look at when it’s done.', { name: t(nameOf(c)), where }))) return;
  try {
    state.runs[c.id] = await localApi(`/api/comments/${c.id}/agent`);
    toast(`Claude session opened for ${nameOf(c)}`);
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
 * 2. fall: a copy of the card drops under gravity, a little past its new stick
 *    (done → the card folds into its monkey, who jumps onto the pile as a head)
 * 3. land: the real card appears and is yanked back up onto its stick; the pile bounces
 */
async function boardMove(li, id, status, note, { elsewhere = false } = {}) {
  const line = $('#line');
  state.moving = true;            // live updates wait: the card must stay put while we measure it
  li.classList.add('pulling');
  // elsewhere: someone else (an agent, the CLI) already made the change; we only show it
  // The card moves right away; the server catches up in the background,
  // and a move it refuses puts the card back. Waiting for it first left the card hanging mid-move.
  const request = elsewhere ? Promise.resolve() : api('POST', `/api/comments/${id}/status`, { status, note: note || undefined });
  const answer = request.then(() => null, (e) => e);
  await sleep(160);   // the stick slides back first

  // the card that takes its place: the next one in the same section (or the one above if it was last)
  const sib = (el, dir) => { do el = el?.[dir]; while (el && !el.matches?.('.item[data-id]')); return el; };
  const nextId = Number((sib(li, 'nextElementSibling') || sib(li, 'previousElementSibling'))?.dataset.id) || null;
  const fromZone = li.closest('.zone')?.dataset.zone;
  const hadFocus = state.focusId === id;

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
  if (status === 'done') state.falling = id;

  // from here on, whatever goes wrong, the board must not stay frozen with a card in the air
  try {
    // remember where everything else is, so it can glide into place instead of jumping
    const before = snapshot();
    moveLocally(id, status, note);   // this board, right now, as the server will have it
    state.moving = false;
    state.pending = false;
    render();
    state.moving = true;

    // where it lands
    const landing = status === 'done'
      ? ($('.heap i.new') || $('.pile'))
      : $(`.item[data-id="${id}"]`);
    if (!landing || !from.width) { ghost.remove(); state.falling = null; settle(0); return !(await answer); }
    const realCard = status === 'done' ? null : landing;
    landing.style.visibility = 'hidden';

    // bring the landing spot into view (the falling copy is fixed, so it doesn't move).
    // Letting go never scrolls down to the pile: the card just drops out of sight where it is.
    const lr = landing.getBoundingClientRect();
    const view = line.getBoundingClientRect();
    const offView = lr.top < view.top + 60 || lr.bottom > view.bottom - 20;
    if (offView && status !== 'done') line.scrollTop += lr.top - (view.top + view.height * 0.4);
    const to = landing.getBoundingClientRect();
    glide(before, id);

    const anim = status !== 'done' ? dropTo(ghost, from, to)
      : offView ? fallAway(ghost, from) : fallInto(ghost, from, to);
    await anim.finished.catch(() => {});
    ghost.remove();

    landing.style.visibility = '';
    if (realCard) {
      realCard.classList.add('landed');
      if (ghost._caught) realCard.classList.add('caught');
    } else {
      pile.release(landing);
    }
    state.falling = null;
    const n = nameOf(id);
    if (elsewhere) toast({ fixed: `${n} was marked fixed`, done: `${n} was approved`, open: `${n} was reopened` }[status]);
    else if (!quietToast) toast({ fixed: `${n} is ready to look at`, done: `Let go of ${n}`, open: `${n} reopened` }[status]);
    quietToast = false;
    const refused = await answer;
    if (refused) { toast(refused.message); settle(0); load(); return false; }   // back where it was
    settle(1200 * SLOW);
    // let the landing register, then go back to where you were working
    setTimeout(() => frameAfterMove(nextId, fromZone, hadFocus), 380 * SLOW);
    return true;
  } catch (e) {
    ghost.remove();
    for (const el of document.querySelectorAll('.heap i.new')) pile.release(el);
    state.falling = null;
    settle(0);
    load();
    return !(await answer);
  }
}

/** Apply a move to this board's copy at once (the server's answer and the next load confirm it). */
function moveLocally(id, status, note) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) return;
  const t = new Date().toISOString();
  const p = state.projects.find((x) => x.id === c.project_id);
  if (p) { p[c.status] = Math.max(0, (p[c.status] || 0) - 1); p[status] = (p[status] || 0) + 1; }
  if (status === 'fixed') Object.assign(c, { fix_note: note || c.fix_note, fixed_by: 'you', fixed_at: t, done_at: null });
  else if (status === 'done') c.done_at = t;
  else Object.assign(c, { done_at: null, reopened_at: t, reopen_note: note || null });
  Object.assign(c, { status, archived_at: null, updated_at: t });
  // the server's order: To check, Open, Done; newest first
  const rank = { fixed: 0, open: 1, done: 2 };
  const when = (x) => x.done_at || x.fixed_at || x.created_at || '';
  state.comments.sort((a, b) => (rank[a.status] - rank[b.status]) || (when(b) > when(a) ? 1 : when(b) < when(a) ? -1 : 0));
}

/**
 * Scroll so the card that took the fallen one's place sits just under its section's
 * sticky header, monkey and all. No card left there: show the section it fell from.
 */
function frameAfterMove(nextId, fromZone, hadFocus) {
  const line = $('#line');
  const card = nextId && $(`#items .item[data-id="${nextId}"]`);
  const target = card || $(`#items .zone[data-zone="${fromZone}"]`);
  if (!target) return;
  if (card && hadFocus) { state.focusId = nextId; applyFocus(false); }
  const view = line.getBoundingClientRect();
  // the top of the card is its monkey or clip when they stick out above the sheet
  const top = Math.min(...[target, ...(card ? card.querySelectorAll('.peg, .monkey, .pin') : [])]
    .map((el) => el.getBoundingClientRect()).filter((r) => r.height).map((r) => r.top));
  const head = card?.closest('.zone')?.querySelector('.zone-head');
  // a stuck header sits at the line's top padding plus its own (negative) top, and covers that much
  const covered = head ? parseFloat(getComputedStyle(line).paddingTop) + parseFloat(getComputedStyle(head).top) + head.offsetHeight : 0;
  const goal = line.scrollTop + top - view.top - (card ? Math.max(0, covered) + 12 : 0);
  const max = line.scrollHeight - line.clientHeight;
  const y = Math.max(0, Math.min(max, Math.round(goal)));
  if (Math.abs(y - line.scrollTop) < 2) return;
  line.scrollTo({ top: y, behavior: reduceMotion() ? 'auto' : 'smooth' });
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
    return ghost.animate(sampled(40, (t) => {
      const e = 1 - (1 - t) ** 3;
      return { transform: `translate(${dx * e}px, ${dy * e}px)` };
    }), { duration: Math.min(900, 380 + Math.abs(dy) * 0.35) * SLOW, fill: 'forwards' });
  }
  // Catch the stick: it falls a little past its new stick, and the monkey's hand yanks it back up (.caught)
  const fall = dy + CATCH;
  ghost._caught = true;
  return ghost.animate(sampled(48, (t) => ({
    // y = ½gt²: slow start, speeding up; the card stays upright all the way down
    transform: `translate(${dx * t}px, ${fall * t * t}px)`,
  })), { duration: Math.min(900, 260 + Math.sqrt(fall) * 26) * SLOW, fill: 'forwards' });
}
const CATCH = 16;   // px past the stick; .caught in app.css starts from the same offset

/**
 * Approve: the monkey jumps in. The card folds up into its monkey, who lets go,
 * flips through the air and lands on the pile as one of the heads.
 */
function fallInto(ghost, from, to) {
  const sheet = ghost.querySelector('.sheet');
  const monkey = ghost.querySelector('.monkey');
  if (!monkey) return fallStraight(ghost, from, to);
  ghost.classList.add('jumping');
  const finished = (async () => {
    if (sheet) {
      sheet.style.transformOrigin = '50% 0';
      await sheet.animate([{ transform: 'none', opacity: 1 }, { transform: 'scaleY(.05)', opacity: 0 }],
        { duration: 160 * SLOW, easing: 'cubic-bezier(.5, 0, .9, .6)', fill: 'forwards' }).finished;
    }
    // the monkey's head is at (32, 32) in its 64×54 box; it ends a little bigger, the size of a head on the pile
    const m = monkey.getBoundingClientRect();
    const sx = m.width / 64, sy = m.height / 54;
    const dx = to.left + to.width / 2 - (m.left + 32 * sx);
    const dy = to.top + to.height / 2 - (m.top + 32 * sy);
    const end = to.width / (24 * sx);
    const H = Math.min(60, 30 + Math.abs(dy) * 0.12);   // how high the hop goes
    monkey.style.transition = 'none';
    monkey.style.transformOrigin = '32px 32px';
    await monkey.animate(sampled(48, (t) => ({
      transform: `translate(${dx * t}px, ${dy * t - 4 * H * t * (1 - t)}px) rotate(${360 * Math.min(1, t * 1.15)}deg) scale(${1 + (end - 1) * t})`,
    })), { duration: Math.min(560, 320 + Math.sqrt(Math.abs(dy)) * 7) * SLOW, fill: 'forwards' }).finished;
  })();
  return { finished };
}

/**
 * Approve with the pile out of sight: the card folds into its monkey, who lets go
 * and drops out of view right where it was. The pile gets the head without scrolling there.
 */
function fallAway(ghost, from) {
  const sheet = ghost.querySelector('.sheet');
  const monkey = ghost.querySelector('.monkey');
  const fall = 150;
  if (!monkey) {
    return ghost.animate(sampled(24, (t) => ({ transform: `translateY(${fall * t * t}px)`, opacity: 1 - t * t })),
      { duration: 380 * SLOW, fill: 'forwards' });
  }
  ghost.classList.add('jumping');
  const finished = (async () => {
    if (sheet) {
      sheet.style.transformOrigin = '50% 0';
      await sheet.animate([{ transform: 'none', opacity: 1 }, { transform: 'scaleY(.05)', opacity: 0 }],
        { duration: 160 * SLOW, easing: 'cubic-bezier(.5, 0, .9, .6)', fill: 'forwards' }).finished;
    }
    monkey.style.transition = 'none';
    monkey.style.transformOrigin = '32px 32px';
    await monkey.animate(sampled(24, (t) => ({
      transform: `translate(0, ${fall * t * t - 18 * t * (1 - t)}px) rotate(${200 * t}deg)`,
      opacity: t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4,
    })), { duration: 340 * SLOW, fill: 'forwards' }).finished;
  })();
  return { finished };
}

/** The old approve: the card falls straight down and only shrinks as it gets there (a card without a monkey). */
function fallStraight(ghost, from, to) {
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  ghost.style.transformOrigin = '50% 50%';
  const endX = 26 / from.width;
  const endY = 26 / from.height;
  return ghost.animate(sampled(54, (t) => {
    const k = t < 0.55 ? 0 : (t - 0.55) / 0.45;
    return {
      transform: `translate(${dx * t * t}px, ${dy * t * t}px) scale(${1 - k * (1 - endX)}, ${1 - k * (1 - endY)})`,
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

// ---------- editing a comment in place: text, project, where, source, attachments ----------
function editForm(c) {
  const e = state.edit;
  const d = e.draft;
  const projects = `<option value=""${d.project ? '' : ' selected'}>No project</option>`
    + state.projects.map((p) => `<option value="${esc(p.id)}"${p.id === d.project ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const kept = (c.attachments || []).filter((a) => !e.remove.has(a.id)).map((a) => {
    const drawn = e.replace.get(a.id);
    const img = drawn ? drawn.url : a.type.startsWith('image/') ? `/api/attachments/${a.id}` : null;
    return `<span class="file" data-edit-att="${a.id}" title="${img ? 'Click to draw on it' : esc(a.name)}" style="${img ? `background-image:url(${img})` : ''}">${img ? '' : extOf(a.name)}<button type="button" data-edit-rm="${a.id}" title="Remove">✕</button></span>`;
  }).join('');
  const added = e.files.map((f, k) => `<span class="file" data-edit-new="${k}" title="${f.url ? 'Click to draw on it' : esc(f.name)}" style="${f.url ? `background-image:url(${f.url})` : ''}">${f.url ? '' : extOf(f.name)}<button type="button" data-edit-new-rm="${k}" title="Remove">✕</button></span>`).join('');
  return `<form class="edit" data-edit-form="${c.id}" novalidate>
      <textarea name="body" rows="${Math.min(8, Math.max(2, Math.ceil(d.body.length / 46) + d.body.split('\n').length - 1))}" aria-label="Comment">${esc(d.body)}</textarea>
      <div class="edit-grid">
        <label>Project<select name="project">${projects}</select></label>
        <label>Where<input name="location" value="${esc(d.location)}" placeholder="URL or file:line"></label>
        <label>From<input name="source" value="${esc(d.source)}" placeholder="Email, Slack…"></label>
      </div>
      <div class="edit-files">${kept}${added}
        <button type="button" class="act icon" data-edit-shot title="Take a screenshot and draw on it">${camera}</button>
        <label class="act icon edit-clip" title="Attach files (or paste ⌘V / drop them on the card)"><input type="file" multiple hidden data-edit-file>${paperclip}</label>
      </div>
      <div class="edit-foot"><span>⌘↵ save · esc cancel</span><button type="button" class="act" data-act="cancel-edit">Cancel</button><button class="act fixit">Save</button></div>
    </form>`;
}

function openEdit(id) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) return;
  document.activeElement?.blur();
  clearAskFiles();
  state.asking = null;
  cancelEdit(false);
  state.edit = { id, draft: { body: c.body, project: c.project_id || '', location: c.location || '', source: c.source || '' }, files: [], remove: new Set(), replace: new Map() };
  render();
  const ta = $(`[data-edit-form="${id}"] textarea`);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
function cancelEdit(rerender = true) {
  if (!state.edit) return;
  for (const f of [...state.edit.files, ...state.edit.replace.values()]) if (f.url) URL.revokeObjectURL(f.url);
  state.edit = null;
  if (rerender) { document.activeElement?.blur(); render(); }
}
/** Files for the card being edited (paperclip, paste, drop, screenshot). */
async function addEditFiles(list) {
  if (!state.edit) return 0;
  const files = (await Promise.all(imageFiles(list).map(prepareFile))).filter(Boolean);
  for (const f of files) state.edit.files.push(Object.assign(f, { url: isImage(f) ? URL.createObjectURL(f) : null }));
  if (files.length) { document.activeElement?.blur(); render(); }
  return files.length;
}
async function saveEdit() {
  const e = state.edit;
  if (!e) return;
  const c = state.comments.find((x) => x.id === e.id);
  if (!c) return cancelEdit();
  const form = $(`[data-edit-form="${c.id}"]`);
  if (!e.draft.body.trim()) {
    const ta = form?.querySelector('textarea');
    ta?.classList.remove('invalid'); void ta?.offsetWidth; ta?.classList.add('invalid');
    return ta?.focus();
  }
  const before = { body: c.body, project: c.project_id || '', location: c.location || '', source: c.source || '' };
  const after = {};
  for (const k of Object.keys(before)) if (e.draft[k].trim() !== before[k].trim()) after[k] = e.draft[k].trim();
  const files = e.files.slice();
  const remove = [...e.remove];
  const replace = [...e.replace.entries()];
  state.edit = null;
  document.activeElement?.blur();
  const id = c.id;
  try {
    for (const aid of remove) await api('DELETE', `/api/attachments/${aid}`);
    for (const [aid, f] of replace) { await uploadFiles(id, [f]); await api('DELETE', `/api/attachments/${aid}`); }
    if (files.length) await uploadFiles(id, files);
    if (Object.keys(after).length) {
      await api('PATCH', `/api/comments/${id}`, after);
      const undoTo = Object.fromEntries(Object.keys(after).map((k) => [k, before[k]]));
      undoStack.push({ type: 'edit', id, before: undoTo, after });
      redoStack.length = 0;
    }
    const changed = Object.keys(after).length || files.length || remove.length || replace.length;
    toast(!changed ? 'Nothing changed' : `Saved${Object.keys(after).length ? ' · ⌘Z to undo' : ''}`);
  } catch (err) { toast(err.message); }
  for (const f of [...files, ...replace.map(([, f]) => f)]) if (f.url) URL.revokeObjectURL(f.url);
  if (state.expanded.has(id)) await loadDetail(id).catch(() => {});
  await load();
}
// typing in the form keeps a draft, so a live update can't lose it
$('#items').addEventListener('input', (ev) => {
  const form = ev.target.closest('[data-edit-form]');
  if (!form || !state.edit || !(ev.target.name in state.edit.draft)) return;
  state.edit.draft[ev.target.name] = ev.target.value;
  if (ev.target.name === 'body') { ev.target.style.height = 'auto'; ev.target.style.height = Math.min(ev.target.scrollHeight + 2, 260) + 'px'; }
});
$('#items').addEventListener('keydown', (ev) => {
  if (!ev.target.closest('[data-edit-form]')) return;
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return cancelEdit(); }
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); return saveEdit(); }
});
$('#items').addEventListener('dblclick', (ev) => {
  const text = ev.target.closest('.sheet .body');
  if (!text) return;
  window.getSelection()?.removeAllRanges();
  openEdit(Number(text.closest('.item').dataset.id));
});
/** The edit form's own buttons and tiles. → true when handled. */
async function editClick(ev, id) {
  if (!state.edit || state.edit.id !== id) return false;
  const e = state.edit;
  const t = ev.target;
  if (t.closest('[data-act="cancel-edit"]')) { cancelEdit(); return true; }
  if (t.closest('[data-edit-shot]')) { ev.preventDefault(); takeScreenshot('edit'); return true; }
  const rm = t.closest('[data-edit-rm]')?.dataset.editRm;
  if (rm !== undefined) { ev.preventDefault(); e.remove.add(Number(rm)); render(); return true; }
  const newRm = t.closest('[data-edit-new-rm]')?.dataset.editNewRm;
  if (newRm !== undefined) {
    ev.preventDefault();
    const [f] = e.files.splice(Number(newRm), 1);
    if (f?.url) URL.revokeObjectURL(f.url);
    render();
    return true;
  }
  const newK = t.closest('[data-edit-new]')?.dataset.editNew;
  if (newK !== undefined && e.files[Number(newK)]?.url) {
    ev.preventDefault();
    const k = Number(newK);
    const f = e.files[k];
    openEditor(f, { onDone: (drawn) => { URL.revokeObjectURL(f.url); e.files[k] = Object.assign(drawn, { url: URL.createObjectURL(drawn) }); render(); } });
    return true;
  }
  const att = t.closest('[data-edit-att]')?.dataset.editAtt;
  if (att !== undefined) {
    ev.preventDefault();
    const a = state.comments.find((x) => x.id === id)?.attachments?.find((x) => x.id === Number(att));
    if (!a?.type.startsWith('image/')) return true;
    const prev = e.replace.get(a.id);
    const src = prev || new File([await (await fetch(`/api/attachments/${a.id}`)).blob()], a.name, { type: a.type });
    // drawing on it saves a marked-up copy in its place
    openEditor(src, { onDone: (drawn) => { if (prev?.url) URL.revokeObjectURL(prev.url); e.replace.set(a.id, Object.assign(drawn, { url: URL.createObjectURL(drawn) })); render(); } });
    return true;
  }
  return !!t.closest('[data-edit-form]');   // clicks inside the form don't expand the card
}

// ⌘Z / ⌘⇧Z: undo and redo moves (approve, mark fixed, reopen) and edits
const undoStack = [];
const redoStack = [];
let quietToast = false;
const LABEL = { open: 'On your mind', fixed: 'To look at', done: 'Let go' };

async function changeStatus(id, status, note, { from = 'user' } = {}) {
  if (status === 'done' && lightbox.open) lightbox.close();   // letting a card go puts the screenshot away
  const before = state.comments.find((c) => c.id === id);
  const step = before && { id, from: before.status, to: status, fixNote: before.fix_note, note };
  const li = $(`.item[data-id="${id}"]`);
  // tell the Mac app first: the move reaches the server while the card is still falling,
  // and its "fixed by someone" notification shouldn't fire for your own move
  panelBridge?.postMessage({ action: 'moved', id, status });
  let ok;
  if (li && !reduceMotion() && !simpleLook()) {
    quietToast = from !== 'user';
    ok = await boardMove(li, id, status, note);
  } else {
    li?.classList.add('leaving', `to-${status}`);
    try {
      await api('POST', `/api/comments/${id}/status`, { status, note: note || undefined });
      state.asking = null;
      state.moved = { id, status };
      await sleep(300);
      if (from === 'user') toast({ fixed: `${nameOf(id)} is ready to look at`, done: `Let go of ${nameOf(id)}`, open: `${nameOf(id)} reopened` }[status]);
      await load();
      ok = true;
    } catch (e) { li?.classList.remove('leaving'); toast(e.message); ok = false; }
  }
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
  await sleep(pile.SWEEP_MS);
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
  if (step.type === 'edit') {
    try {
      const out = await api('PATCH', `/api/comments/${step.id}`, step.before);
      redoStack.push(step);
      await load();
      return toast(`Undo: edit of ${nameOf(out)}`);
    } catch (e) { undoStack.push(step); return toast(e.message); }
  }
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
  if (step.type === 'edit') {
    try {
      const out = await api('PATCH', `/api/comments/${step.id}`, step.after);
      undoStack.push(step);
      await load();
      return toast(`Redo: edit of ${nameOf(out)}`);
    } catch (e) { redoStack.push(step); return toast(e.message); }
  }
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
  if (await editClick(ev, id)) return;
  if (ev.target.closest('[data-act="edit"]')) return openEdit(id);
  const detach = ev.target.closest('[data-detach]')?.dataset.detach;
  if (detach) {
    ev.preventDefault();
    if (!confirm(t('Remove this attachment?'))) return;
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
    if (state.ask.delete && !confirm(t('Delete {name}? This can\'t be undone.', { name: t(nameOf(id)) }))) return;
    li.classList.add('leaving');
    await api('DELETE', `/api/comments/${id}`).catch((e) => toast(e.message));
    return load();
  }
  if (act || ev.target.closest('a, input, form, button')) return;
  // selecting text (drag, double- or triple-click) isn't a click to expand
  if (ev.detail > 1 || String(window.getSelection())) return;

  // click the sheet to see its history
  if (state.expanded.has(id)) state.expanded.delete(id);
  else { state.expanded.add(id); await loadDetail(id); }
  render();
});

$('#items').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  if (form.dataset.editForm) return saveEdit();
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
    const note = value || (files.length && status === 'open' ? t('See screenshot') : value);
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
  if (ev.target.matches('[data-edit-file]')) { addEditFiles(ev.target.files); ev.target.value = ''; return; }
  if (!ev.target.matches('[data-ask-file]')) return;
  addAskFiles(ev.target.files);
  ev.target.value = '';
});

$('#items').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.asking) { clearAskFiles(); state.asking = null; document.activeElement.blur(); render(); }
  // ⌘↩ / Ctrl↩ sends the fix / reopen box and the note box (WebKit doesn't submit a form on ⌘↩ by itself)
  const form = ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing && ev.target.closest('form.ask, form.note-form');
  if (form) { ev.preventDefault(); form.requestSubmit(); }
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

const lastChip = { id: null, at: 0 };
$('#projects').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-new-project')) return openProjectDialog();
  if (ev.target.closest('[data-edit-project]')) return openProjectDialog(state.projects.find((x) => x.id === b.dataset.project));
  // double-click to edit: counted by hand, because the first click redraws the chips
  // (the button you clicked is a new one by the second click, so 'dblclick' never fires)
  const id = b.dataset.project, now = Date.now();
  const twice = id && lastChip.id === id && now - lastChip.at < 450;
  lastChip.id = twice ? null : id; lastChip.at = now;
  if (twice) return openProjectDialog(state.projects.find((x) => x.id === id));
  if (id === state.project) return;
  showProject(id);
});
function showProject(id) {
  // Safari and the Mac panel keep focus in a card's field when a chip is clicked, which would hold the redraw
  if ($('#line').contains(document.activeElement)) document.activeElement.blur();
  state.project = id;
  store.set('project', id);
  $('#c-project').value = id;
  renderTarget();
  load();
}
// Picking a project in the composer switches the filter too, so they always match.
$('#c-project').addEventListener('change', (ev) => {
  if (QUICK) { store.set('lastProject', ev.target.value); return renderTarget(); }
  showProject(ev.target.value);
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
  if (state.edit && Number(li.dataset.id) === state.edit.id) return addEditFiles(ev.dataTransfer.files);
  const files = (await Promise.all(imageFiles(ev.dataTransfer.files).map(prepareFile))).filter(Boolean);
  if (!files.length) return toast('Nothing to attach there');
  await uploadFiles(li.dataset.id, files);
  toast(`Attached ${files.length} to ${nameOf(li.dataset.id)}`);
  load();
});

// ---------- composer ----------
const composer = $('#composer');
const body = $('#c-body');
const grow = () => { body.style.height = 'auto'; body.style.height = Math.min(body.scrollHeight + 2, QUICK ? 320 : 160) + 'px'; };
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
  if (state.edit && !composer.contains(document.activeElement)) {
    if (await addEditFiles(files)) toast('Added to the comment you’re editing');
    return;
  }
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

// one comment at a time: a comment with a screenshot takes a moment, and every click used to send it again
let hanging = false;
composer.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (hanging) return;
  const text = body.value.trim() || (pendingFiles.length ? t('Screenshot') : '');
  if (!text) return body.focus();
  hanging = true;
  composer.classList.add('busy');
  composer.querySelector('[type=submit]')?.setAttribute('disabled', '');
  const project = $('#c-project').value;
  const where = state.projects.find((p) => p.id === project)?.name || 'no project';
  store.set('lastProject', project);
  try {
    const c = await api('POST', '/api/comments', { body: text, project: project || undefined, source: $('#c-source').value, location: $('#c-location').value });
    if (pendingFiles.length) await uploadFiles(c.id, pendingFiles);
    pendingFiles.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    pendingFiles = []; renderFiles();
    body.value = ''; $('#c-location').value = ''; grow();
    state.status = 'open'; store.set('status', 'open');
    toast(`Hung ${nameOf(c)} on ${where}`);
    if (QUICK) return quickClose('quickDone', c.id);
    await load();
    $('#line').scrollTop = 0;
  } catch (e) { toast(e.message); }
  finally {
    hanging = false;
    composer.classList.remove('busy');
    composer.querySelector('[type=submit]')?.removeAttribute('disabled');
  }
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
  load().then(() => { if (state.projects.some((p) => p.id === last)) sel.value = last; renderTarget(); }).catch(() => {});
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
  // the window is as tall as what's in it: long text and attachments push it down instead of being cut off
  const quickBridge = window.webkit?.messageHandlers?.gc;
  const top = $('#column .top');
  if (quickBridge && top && 'ResizeObserver' in window) {
    let last = 0;
    new ResizeObserver(() => {
      const h = Math.ceil(top.getBoundingClientRect().height);
      if (Math.abs(h - last) > 2) { last = h; quickBridge.postMessage({ action: 'quickSize', height: h }); }
    }).observe(top);
  }
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
  // a folder picker on the Mac (the panel's own, or the server's for a browser on this Mac)
  $('#pd-choose').hidden = !window.webkit?.messageHandlers?.gc && !state.local;
  dlg.showModal();
}
$('#pd-choose').addEventListener('click', async () => {
  const bridge = window.webkit?.messageHandlers?.gc;
  if (bridge) return bridge.postMessage({ action: 'chooseFolder' });
  try {
    const { path } = await localApi('/api/choose-folder');
    if (path) window.gcFolderChosen(path);
  } catch (e) { toast(e.message); }
});
/** The chosen folder fills Repo folder, and names a new project after it if it has no name yet. */
window.gcFolderChosen = (path) => {
  const f = $('#project-form');
  f.path.value = path;
  if (!f.name.value.trim()) f.name.value = path.split('/').filter(Boolean).pop() || '';
  f.path.focus();
};
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
    const p = editing ? await api('PATCH', `/api/projects/${encodeURIComponent(editing.id)}`, data) : await api('POST', '/api/projects', data);
    if (!editing) { state.project = p.id; store.set('project', p.id); }
    load();
  } catch (e) { toast(e.message); }
});
$('#pd-delete').addEventListener('click', async () => {
  if (!editing || !confirm(t('Delete project “{name}”? Its comments stay, without a project.', { name: editing.name }))) return;
  await api('DELETE', `/api/projects/${encodeURIComponent(editing.id)}`).catch((e) => toast(e.message));
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
/** With monkeys, or simple: no monkeys, no branch, no pile of heads. Remembered locally so the page starts in it. */
function applyLook(look) {
  const simple = look === 'simple';
  if (simple) document.documentElement.dataset.look = 'simple';
  else delete document.documentElement.dataset.look;
  store.set('look', simple ? 'simple' : 'monkeys');
}
const simpleLook = () => document.documentElement.dataset.look === 'simple';
applyLook(store.get('look', 'monkeys'));
/**
 * The board's language (Settings → Language: auto, en or es), remembered in this browser so the next page
 * starts in it. The Mac app gets it for its menus. → true when the page reloads to change language.
 */
function applyLanguage(value) {
  window.webkit?.messageHandlers?.gc?.postMessage({ action: 'language', language: value || 'auto' });
  if (!rememberLanguage(value)) return false;
  location.reload();
  return true;
}
window.webkit?.messageHandlers?.gc?.postMessage({ action: 'language', language: languagePref });
/** Settings → Ask before: whether Ask Claude and Delete confirm first. */
function applyAsks(s) { state.ask = { agent: s.ask_before_agent !== false, delete: s.ask_before_delete !== false }; }
api('GET', '/api/settings').then((s) => { applyTheme(s.theme); applyLook(s.look); applyLanguage(s.language); applyAsks(s); }).catch(() => {});
$('#settings-btn').addEventListener('click', async () => {
  try {
    const s = await api('GET', '/api/settings');
    const sel = $('#settings-form').auto_clean_days;
    if (![...sel.options].some((o) => Number(o.value) === s.auto_clean_days)) sel.add(new Option(`${s.auto_clean_days} days after approving`, s.auto_clean_days));
    sel.value = String(s.auto_clean_days);
    showFilesRule(s);
    $('#settings-form').theme.value = s.theme;
    $('#settings-form').look.value = s.look || 'monkeys';
    $('#settings-form').language.value = s.language || 'auto';
    $('#settings-form').ask_before_agent.checked = s.ask_before_agent !== false;
    $('#settings-form').ask_before_delete.checked = s.ask_before_delete !== false;
    settingsDlg.showModal();
  } catch (e) { toast(e.message); }
});

// ---------- deleting screenshots automatically ----------
const UNITS = [[8760, 'year'], [720, 'month'], [168, 'week'], [24, 'day'], [1, 'hour']];
const FROM_TEXT = { archived: 'after the comment is cleaned up', done: 'after the comment is approved', attached: 'after they’re attached, on any comment' };
const UNITS_ES = { year: ['año', 'años'], month: ['mes', 'meses'], week: ['semana', 'semanas'], day: ['día', 'días'], hour: ['hora', 'horas'] };
const FROM_TEXT_ES = { archived: 'después de que se limpia el comentario', done: 'después de que se aprueba el comentario', attached: 'después de adjuntarlas, en cualquier comentario' };
function describeRule(r) {
  const [size, name] = UNITS.find(([h]) => r.files_delete_after_hours % h === 0);
  const n = r.files_delete_after_hours / size;
  if (lang === 'es') return `${n} ${UNITS_ES[name][n === 1 ? 0 : 1]} ${FROM_TEXT_ES[r.files_delete_from]}`;
  return `${n} ${name}${n === 1 ? '' : 's'} ${FROM_TEXT[r.files_delete_from]}`;
}
function filesRule() {
  const f = $('#settings-form');
  const amount = Math.max(1, Math.round(Number(f.files_delete_amount.value) || 1));
  return { files_auto_delete: f.files_auto_delete.checked, files_delete_after_hours: amount * Number(f.files_delete_unit.value), files_delete_from: f.files_delete_from.value };
}
function showFilesRule(s) {
  const f = $('#settings-form');
  const [size] = UNITS.find(([h]) => s.files_delete_after_hours % h === 0);
  f.files_auto_delete.checked = s.files_auto_delete;
  f.files_delete_amount.value = s.files_delete_after_hours / size;
  f.files_delete_unit.value = String(size);
  f.files_delete_from.value = s.files_delete_from;
  updateFilesHint();
}
function updateFilesHint() {
  const r = filesRule();
  $('.files-rule').classList.toggle('off', !r.files_auto_delete);
  const hint = $('#files-hint');
  hint.classList.toggle('warn', r.files_auto_delete && r.files_delete_from !== 'archived');
  const es = lang === 'es';
  hint.textContent = !r.files_auto_delete ? 'Screenshots stay until you remove them (✕ on a screenshot, or delete the comment).'
    : es ? `Se borran ${describeRule(r)}.${r.files_delete_from === 'attached' ? ' Incluye comentarios que siguen abiertos.' : r.files_delete_from === 'done' ? ' Los comentarios aprobados las pierden incluso antes de limpiarse.' : ''}`
    : `Deleted ${describeRule(r)}.${r.files_delete_from === 'attached' ? ' This includes comments still open.' : r.files_delete_from === 'done' ? ' Approved comments lose them even before they’re cleaned up.' : ''}`;
}
$('.files-rule').addEventListener('input', updateFilesHint);
$('.files-rule').addEventListener('change', updateFilesHint);

$('#settings-form').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  const days = Number($('#settings-form').auto_clean_days.value);
  const theme = $('#settings-form').theme.value;
  const look = $('#settings-form').look.value;
  const language = $('#settings-form').language.value;
  const asks = { ask_before_agent: $('#settings-form').ask_before_agent.checked, ask_before_delete: $('#settings-form').ask_before_delete.checked };
  const rule = filesRule();
  try {
    const before = await api('GET', '/api/settings');
    const changed = before.files_auto_delete !== rule.files_auto_delete || before.files_delete_after_hours !== rule.files_delete_after_hours || before.files_delete_from !== rule.files_delete_from;
    // a rule that deletes screenshots right away asks first
    if (changed && rule.files_auto_delete) {
      const { count } = await api('GET', `/api/files/expiring?hours=${rule.files_delete_after_hours}&from=${rule.files_delete_from}`);
      if (count && !confirm(t(count === 1 ? 'This deletes {n} screenshot right away, {rule}.\n\nThey can’t be brought back.' : 'This deletes {n} screenshots right away, {rule}.\n\nThey can’t be brought back.', { n: count, rule: describeRule(rule) }))) return settingsDlg.showModal();   // back to the settings, nothing saved
    }
    const s = await api('PATCH', '/api/settings', { auto_clean_days: days, theme, look, language, ...asks, ...rule });
    applyTheme(s.theme);
    applyAsks(s);
    if (simpleLook() !== (s.look === 'simple')) { applyLook(s.look); render(); }
    if (applyLanguage(s.language)) return;   // reloads in the new language
    if (changed) toast(s.files_auto_delete ? (lang === 'es' ? `Las capturas se borran ${describeRule(s)}` : `Screenshots are deleted ${describeRule(s)}`) : 'Screenshots are kept until you delete them');
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

// Search hides behind the magnifier next to Settings, so it isn't mistaken for the comment box.
// It stays out while it holds a query; empty, it tucks away again when you leave it.
const q = $('#q');
const searchBox = $('#search');
const searchBtn = $('#search-btn');
function showSearch(on) {
  searchBox.hidden = !on;
  searchBtn.setAttribute('aria-expanded', String(on));
  searchBtn.classList.toggle('on', on);
}
function openSearch() { showSearch(true); q.focus(); q.select(); }
function clearSearch() {
  q.value = '';
  if (document.activeElement !== q) showSearch(false);
  if (state.q) { state.q = ''; render(); }
}
function closeSearch() { q.blur(); clearSearch(); showSearch(false); }
searchBtn.addEventListener('mousedown', (ev) => ev.preventDefault());   // keep focus where it is, so blur doesn't race the click
searchBtn.addEventListener('click', () => (searchBox.hidden ? openSearch() : closeSearch()));
q.addEventListener('blur', () => { if (!q.value.trim()) showSearch(false); });
q.addEventListener('input', () => { state.q = q.value.trim().toLowerCase(); render(); });
q.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { ev.preventDefault(); closeSearch(); }
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
    else toast(c.status === 'open' ? 'Only cards to look at can be let go' : 'Already let go');
  } else if (ev.key === 'e') {
    ev.preventDefault();
    openEdit(c.id);
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
  es = new EventSource('/api/events');
  es.addEventListener('open', () => $('#live').classList.add('on'));
  es.addEventListener('error', () => $('#live').classList.remove('on'));
  es.addEventListener('agent', (ev) => {
    try { const r = JSON.parse(ev.data); state.runs[r.id] = r; } catch { return; }
    render();
  });
  es.addEventListener('change', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch {}
    if (data.settings) api('GET', '/api/settings').then((x) => { applyTheme(x.theme); if (simpleLook() !== (x.look === 'simple')) { applyLook(x.look); render(); } applyLanguage(x.language); applyAsks(x); }).catch(() => {});
    const c = data.id && state.comments.find((x) => x.id === data.id);
    const li = c && $(`#items .item[data-id="${data.id}"]`);
    // an agent pulled a stick: show the card falling instead of just jumping
    if (li && data.status && c.status !== data.status && !state.moving && !reduceMotion()) {
      clearTimeout(reloadTimer);
      boardMove(li, data.id, data.status, null, { elsewhere: true });
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

// ---------- screenshot lightbox ----------
// Clicking a screenshot opens it big inside the app; in the Mac panel the panel grows into a big window
// in the middle of the screen while it's open, like the drawing editor (Esc / click outside closes, ← → step through
// the card's screenshots). ⌘-click still opens it in the browser.
const lightbox = $('#lightbox');
let lbShots = [], lbAt = 0;
function lbShow(i) {
  lbAt = (i + lbShots.length) % lbShots.length;
  const a = lbShots[lbAt];
  $('#lb-img').src = a.href;
  $('#lb-img').alt = a.title || '';
  $('#lb-name').textContent = a.title || '';
  $('#lb-count').textContent = `${lbAt + 1} / ${lbShots.length}`;
  $('#lb-open').href = a.href;
  lightbox.classList.toggle('single', lbShots.length < 2);
}
document.addEventListener('click', (ev) => {
  const shot = ev.target.closest('a.shot:not(.pdf)');
  if (!shot || ev.target.closest('[data-detach]') || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  ev.preventDefault();
  const group = shot.closest('.item, dialog') || document;
  lbShots = [...group.querySelectorAll('a.shot:not(.pdf)')];
  lbShow(lbShots.indexOf(shot));
  if (lightbox.open) return;
  lightbox.showModal();
  panelBridge?.postMessage({ action: 'editorOpen' });   // Mac panel: grow into a big window in the middle of the screen
});
lightbox.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-lb]')?.dataset.lb;
  if (b === 'prev') return lbShow(lbAt - 1);
  if (b === 'next') return lbShow(lbAt + 1);
  if (b === 'close' || ev.target === lightbox) lightbox.close();
});
// Esc closes it, whatever has focus (in the Mac panel the dialog's own Esc doesn't always fire)
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !lightbox.open) return;
  ev.preventDefault(); ev.stopPropagation();
  lightbox.close();
}, true);
lightbox.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); lbShow(lbAt - 1); }
  if (ev.key === 'ArrowRight') { ev.preventDefault(); lbShow(lbAt + 1); }
});
lightbox.addEventListener('close', () => {
  $('#lb-img').removeAttribute('src');
  panelBridge?.postMessage({ action: 'editorClose' });   // back to the column at the edge
});

// ---------- screenshots: capture, draw, attach ----------
/**
 * Open the drawing editor. Inside the Mac panel the column is too narrow to draw in,
 * so the app grows the panel into a big window in the middle of the screen while it's open.
 */
function openEditor(src, opts = {}) {
  return openDrawEditor(src, {
    ...opts,
    // what you drew is shrunk like any other screenshot before it's attached
    onDone: async (drawn) => { const small = await prepareFile(drawn); if (small) opts.onDone?.(small); },
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
      else if (target === 'edit' && state.edit) await addEditFiles([file]);
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
