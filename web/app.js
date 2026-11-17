const $ = (s, el = document) => el.querySelector(s);
const params = new URLSearchParams(location.search);
if (params.has('embed')) document.documentElement.classList.add('embed');
const SKINS = ['line', 'trunk', 'rail'];

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
  skin: 'trunk',         // trunk | rail | line (set below)
  moved: null,           // { id, status } — the piece that just changed state, to animate its arrival
  allDone: false,        // show every done comment, not just the latest
  seen: new Set(),       // cards already on screen: they don't replay their entrance
  moving: false,         // a card is mid-fall: hold re-renders until it lands
};
state.skin = SKINS.includes(params.get('skin')) ? params.get('skin') : SKINS.includes(store.get('skin')) ? store.get('skin') : 'trunk';
document.documentElement.dataset.skin = state.skin;
const board = () => state.skin !== 'line';

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

const imageFiles = (list) => [...(list || [])].filter((f) => /^image\/|application\/pdf/.test(f.type));
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
const icons = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
  wrench: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5a3 3 0 0 0-3.4 4L2.5 11.1a1.3 1.3 0 0 0 1.9 1.9L9 8.4a3 3 0 0 0 4-3.4l-1.8 1.8-1.7-.3-.3-1.7z"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5L2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2"/></svg>',
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

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
  for (const b of $('#skins').children) b.setAttribute('aria-checked', String(b.dataset.skin === state.skin));

  if (board()) {
    renderBoard();
  } else {
  const list = state.comments.filter((c) => c.status === state.status);
  patchItems(list.map((c, i) => renderItem(c, i)).join(''));
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = {
      open: '<strong>Nothing on the line</strong>Hang a comment above, or let an agent add one.',
      fixed: '<strong>Nothing to check</strong>Fixed comments wait here for your OK.',
      done: '<strong>Nothing dried yet</strong>Approved comments end up here.',
    }[state.status];
  }
  }
  state.moved = null;
  for (const c of state.comments) state.seen.add(c.id);
  $('.rope').style.setProperty('--rope-h', $('#items').scrollHeight + 60 + 'px');

  if (state.asking) $(`#ask-${state.asking.id} input`)?.focus();
}

// ---------- board skins: every state on one column, top to bottom ----------
const ZONES = {
  trunk: {
    open: ['Hanging', 'Open comments hook onto the high sticks.'],
    fixed: ['To check', 'An agent pulled the stick — it dropped and swung down here.'],
    done: ['The pile', 'Pull the last stick and it falls here. The pile grows as the project gets done.'],
  },
  rail: {
    open: ['On the rail', 'Tickets waiting to be worked on.'],
    fixed: ['The pass', 'Fixed and waiting for your OK.'],
    done: ['The spike', 'Approved tickets get spiked.'],
  },
};
// resting tilt shrinks on wide panels, so the far edge never sags more than a few pixels
const tiltScale = () => Math.min(1, 380 / ($('#line')?.clientWidth || 380));
const tilt = (id, span = 18) => ((id * 47) % (span + 1)) - span / 2;

function renderBoard() {
  const by = (s) => state.comments.filter((c) => c.status === s);
  const [open, fixed, done] = ['open', 'fixed', 'done'].map(by);
  const z = ZONES[state.skin];
  const total = state.comments.length;
  const pct = total ? Math.round((done.length / total) * 100) : 0;
  let i = 0;
  const zone = (key, items, inner = '', count = items.length) => `
    <li class="zone" data-zone="${key}">
      <div class="zone-head"><span class="dot ${key}"></span><h3>${z[key][0]}</h3><b>${count}</b><span class="zone-hint">${z[key][1]}</span></div>
      ${inner}
      <ol class="zone-items">${items.map((c) => renderItem(c, i++)).join('')}</ol>
      ${!items.length && key !== 'done' ? `<p class="zone-empty">${key === 'open' ? 'Nothing hanging. Add one above.' : 'Nothing waiting for you.'}</p>` : ''}
    </li>`;

  const newest = state.moved?.status === 'done' ? state.moved.id : null;
  const heap = done.slice(0, 60).map((c) =>
    `<i class="${c.id === newest ? 'new' : ''}" style="--pc:${esc(c.project_color || 'var(--ink-3)')};--r:${tilt(c.id)}deg;--n:${tilt(c.id)}" title="#${c.id} ${esc(c.body.slice(0, 60))}"></i>`).join('');
  const pile = state.skin === 'trunk'
    ? `<button class="pile" data-act="toggle-done" style="--fill:${pct};--heap-w:${Math.max(3, Math.ceil(Math.sqrt(done.length) * 1.3)) * 24}px" title="${pct}% of this view is done">
         <span class="heap">${heap}</span><span class="ground"></span>
         <span class="pile-label">${done.length} done · ${pct}%</span></button>`
    : `<button class="spike" data-act="toggle-done" title="${done.length} tickets spiked">
         <span class="needle"></span><span class="stack">${heap}</span>
         <span class="pile-label">${done.length} spiked · ${pct}%</span></button>`;
  const doneShown = state.allDone ? done : [];
  const doneZone = zone('done', doneShown, pile, done.length).replace('</ol>', `</ol>${done.length ? `<button class="act show-done" data-act="toggle-done">${state.allDone ? 'Hide done' : `Show ${done.length} done`}</button>` : ''}`);

  patchItems(zone('open', open) + zone('fixed', fixed) + doneZone);
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
const TRANSIENT = ['fresh', 'landed', 'landed-rail', 'leaving', 'pulling', 'arrived-open', 'arrived-fixed', 'arrived-done', 'to-open', 'to-fixed', 'to-done', 'dragging'];

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
  box.replaceChildren(...tpl.content.childNodes);
}

function renderItem(c, i) {
  const d = state.details.get(c.id);
  const expanded = state.expanded.has(c.id);
  const asking = state.asking?.id === c.id ? state.asking.kind : null;

  const actions = {
    open: `<button class="act fixit" data-act="ask-fix">${icons.wrench}Mark fixed</button>`,
    fixed: `<button class="act approve" data-act="done">${icons.check}Approve</button>
            <button class="act" data-act="ask-reopen">${icons.undo}Reopen</button>`,
    done: `<button class="act" data-act="ask-reopen">${icons.undo}Reopen</button>`,
  }[c.status];

  const fix = c.fix_note ? `
    <div class="fix"><span class="who">Fixed${c.fixed_by ? ` by ${esc(c.fixed_by)}` : ''} · ${ago(c.fixed_at)}</span>${esc(c.fix_note)}</div>` : '';

  const ask = asking ? `
    <form class="ask" id="ask-${c.id}" data-kind="${asking}" novalidate>
      <input placeholder="${asking === 'fix' ? 'What did you change?' : 'What’s still wrong? (optional)'}">
      <button class="act ${asking === 'fix' ? 'fixit' : ''}">${asking === 'fix' ? 'Fixed' : 'Reopen'}</button>
      <button type="button" class="act icon" data-act="cancel-ask" title="Cancel">✕</button>
    </form>` : '';

  const history = expanded && d ? `
    <div class="detail">
      <ol class="history">${d.events.map((e) => `
        <li><span class="d ${esc(e.type)}"></span><span>${esc(e.type)}${e.actor ? ` by ${esc(e.actor)}` : ''}<time>${ago(e.at)}</time>${e.note ? `<span class="n">${esc(e.note)}</span>` : ''}</span></li>`).join('')}
      </ol>
      <form class="note-form" data-note="${c.id}"><input placeholder="Add a note…"><button class="act">Note</button></form>
    </div>` : '';

  const sig = hash(JSON.stringify([c, expanded, asking, d?.events?.length ?? -1, state.skin]));
  return `
    <li data-sig="${sig}" class="item status-${c.status}${expanded ? ' expanded' : ''}${state.seen.has(c.id) ? '' : ' fresh'}${state.moved?.id === c.id ? ` arrived-${c.status}` : ''}" data-id="${c.id}" style="--i:${Math.min(i, 12)};--pc:${esc(c.project_color || 'var(--ink-3)')};--tw:${(tilt(c.id, 4) * tiltScale()).toFixed(2)}deg">
      <span class="pin" aria-hidden="true"></span>
      <span class="peg" aria-hidden="true"><i></i><i></i>
      <svg class="monkey" viewBox="0 0 64 54" aria-hidden="true">
        <path class="arm" d="M21 33 C 15 25, 14 18, 17 11"/>
        <path class="arm a2" d="M43 33 C 49 25, 50 18, 47 11"/>
        <path class="arm a2-down" d="M43 33 C 50 38, 54 44, 56 50"/>
        <circle class="hand" cx="17" cy="10" r="3.6"/><circle class="hand a2" cx="47" cy="10" r="3.6"/><circle class="hand a2-down" cx="56" cy="50" r="3.4"/>
        <circle class="fur" cx="19" cy="30" r="5.5"/><circle class="fur" cx="45" cy="30" r="5.5"/>
        <circle class="face" cx="19" cy="30" r="2.8"/><circle class="face" cx="45" cy="30" r="2.8"/>
        <circle class="fur" cx="32" cy="32" r="12"/>
        <circle class="face" cx="28.2" cy="29.5" r="4.6"/><circle class="face" cx="35.8" cy="29.5" r="4.6"/>
        <ellipse class="face" cx="32" cy="36" rx="8.2" ry="6.4"/>
        <circle class="eye" cx="28.6" cy="30" r="1.5"/><circle class="eye" cx="35.4" cy="30" r="1.5"/>
        <path class="mouth" d="M28.5 38.2 Q32 40.8 35.5 38.2"/>
      </svg></span>
      <article class="sheet">
        <div class="meta">
          <span class="proj">${esc(c.project_name || 'No project')}</span>
          ${c.source ? `<span class="src">${esc(c.source)}</span>` : ''}
          <span>${ago(c.status === 'done' ? c.done_at : c.status === 'fixed' ? c.fixed_at : c.created_at)}</span>
          <span class="id">#${c.id}</span>
        </div>
        <div class="body">${esc(c.body)}</div>
        ${c.location ? (isUrl(c.location) ? `<a class="where" href="${esc(c.location)}" target="_blank" rel="noopener">${esc(c.location)}</a>` : `<span class="where">${esc(c.location)}</span>`) : ''}
        ${c.attachments?.length ? `<div class="shots">${c.attachments.map((a) => a.type.startsWith('image/')
          ? `<a class="shot" href="${withToken(`/api/attachments/${a.id}`)}" target="_blank" title="${esc(a.name)}"><img src="${withToken(`/api/attachments/${a.id}`)}" alt="${esc(a.name)}" loading="lazy"><button class="x" data-detach="${a.id}" title="Remove">✕</button></a>`
          : `<a class="shot pdf" href="${withToken(`/api/attachments/${a.id}`)}" target="_blank">${esc(a.name)}<button class="x" data-detach="${a.id}" title="Remove">✕</button></a>`).join('')}</div>` : ''}
        ${fix}
        ${ask || `<div class="actions">${actions}<span class="spacer"></span>
          <button class="act icon" data-act="copy" title="Copy for an agent">${icons.copy}</button>
          <button class="act icon" data-act="delete" title="Delete">${icons.trash}</button></div>`}
        ${history}
      </article>
    </li>`;
}

// ---------- actions ----------
const SLOW = Math.max(1, Number(params.get('slowmo')) || 1);   // ?slowmo=5 to inspect the motion
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Trunk / rail: the card leaves from where it is and lands where it belongs.
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
    ? ($('.heap i.new, .stack i.new') || $('.pile, .spike'))
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

  const rail = state.skin === 'rail';
  const anim = status === 'done'
    ? fallInto(ghost, from, to, rail)
    : dropTo(ghost, from, to, rail);
  await anim.finished.catch(() => {});
  ghost.remove();

  landing.style.visibility = '';
  if (realCard) {
    realCard.classList.add(rail ? 'landed-rail' : 'landed');
  } else {
    landing.classList.add('landed');
    $('.pile, .spike')?.classList.add('thud');
    setTimeout(() => $('.pile, .spike')?.classList.remove('thud'), 450);
  }
  if (remote) toast({ fixed: `#${id} was marked fixed`, done: `#${id} was approved`, open: `#${id} was reopened` }[status]);
  else if (!quietToast) toast({ fixed: `#${id} moved to “To check”`, done: `#${id} done ✓`, open: `#${id} reopened` }[status]);
  quietToast = false;
  settle(1200 * SLOW);
  return true;
}

// ---------- motion helpers (board skins) ----------
/** Screen positions of the cards, zone headers and the pile, by key. */
function snapshot() {
  const map = new Map();
  for (const el of document.querySelectorAll('#items .item[data-id], #items .zone-head, #items .pile, #items .spike, #items .zone-empty, #items .show-done')) {
    map.set(flipKey(el), el.getBoundingClientRect().top);
  }
  return map;
}
const flipKey = (el) => el.dataset.id ? `i${el.dataset.id}` : `${el.className.split(' ')[0]}:${el.closest('.zone')?.dataset.zone || ''}`;

/** Everything that moved slides from its old spot to the new one. */
function glide(before, skipId) {
  for (const el of document.querySelectorAll('#items .item[data-id], #items .zone-head, #items .pile, #items .spike, #items .zone-empty, #items .show-done')) {
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
function dropTo(ghost, from, to, rail) {
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  ghost.style.transformOrigin = rail ? '0 0' : '70px 0';
  if (dy <= 0) {   // going up (reopen / undo): a quick lift, then it eases onto the stick
    return ghost.animate(sampled(14, (t) => {
      const e = 1 - (1 - t) ** 3;
      return { transform: `translate(${dx * e}px, ${dy * e}px) rotate(${rail ? 0 : -Math.min(2, (7 / from.width) * 57.3) * Math.sin(Math.PI * t)}deg)` };
    }), { duration: Math.min(900, 380 + Math.abs(dy) * 0.35) * SLOW, fill: 'forwards' });
  }
  const tilt = rail ? 0 : Math.min(3, (10 / from.width) * 57.3);
  return ghost.animate(sampled(16, (t) => ({
    // y = ½gt²: slow start, speeding up; a little sideways drift and tilt as it lets go
    transform: `translate(${dx * t}px, ${dy * t * t}px) rotate(${tilt * Math.sin(Math.PI * t)}deg)`,
  })), { duration: Math.min(900, 260 + Math.sqrt(dy) * 26) * SLOW, fill: 'forwards' });
}

/** Approve: the card falls straight down onto the pile and only shrinks as it gets there. */
function fallInto(ghost, from, to, rail) {
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const side = dx >= 0 ? 1 : -1;
  ghost.style.transformOrigin = '50% 50%';
  // end the size of a monkey head (or a ticket sliver on the spike)
  const endX = rail ? 120 / from.width : 26 / from.width;
  const endY = rail ? 6 / from.height : 26 / from.height;
  return ghost.animate(sampled(18, (t) => {
    const k = t < 0.55 ? 0 : (t - 0.55) / 0.45;          // shrink only in the last part of the fall
    const sx = 1 - k * (1 - endX);
    const sy = 1 - k * (1 - endY);
    return {
      transform: `translate(${dx * t * t}px, ${dy * t * t}px) rotate(${rail ? 0 : side * Math.min(10, (30 / from.width) * 57.3) * t}deg) scale(${sx}, ${sy})`,
      opacity: t < 0.9 ? 1 : 1 - (t - 0.9) / 0.1,
    };
  }), { duration: Math.min(1000, 320 + Math.sqrt(Math.abs(dy)) * 28) * SLOW, fill: 'forwards' });
}

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
  if (li && board() && !reduceMotion()) {
    quietToast = from !== 'user';
    ok = await boardMove(li, id, status, note);
  } else {
    li?.classList.add('leaving', `to-${status}`);
    try {
      await api('POST', `/api/comments/${id}/status`, { status, note: note || undefined });
      state.asking = null;
      state.moved = { id, status };
      await sleep(board() ? 420 : 300);
      if (from === 'user') toast({ fixed: `#${id} moved to “To check”`, done: `#${id} done ✓`, open: `#${id} reopened` }[status]);
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

// Going back to "fixed" needs a note: reuse the one it had.
const noteFor = (status, step) => (status === 'fixed' ? step.fixNote || step.note || 'Restored with undo' : undefined);

async function undo() {
  const step = undoStack.pop();
  if (!step) return toast('Nothing to undo');
  if (await changeStatus(step.id, step.from, noteFor(step.from, step), { from: 'undo' })) {
    redoStack.push(step);
    toast(`Undo: #${step.id} back to ${LABEL[step.from]}`);
  } else undoStack.push(step);
}

async function redo() {
  const step = redoStack.pop();
  if (!step) return toast('Nothing to redo');
  if (await changeStatus(step.id, step.to, noteFor(step.to, step), { from: 'redo' })) {
    undoStack.push(step);
    toast(`Redo: #${step.id} to ${LABEL[step.to]}`);
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
  if (isEditable(document.activeElement)) return 'native';
  (redoing ? redo : undo)();
  return 'handled';
};

$('#items').addEventListener('click', async (ev) => {
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

  if (act === 'ask-fix' || act === 'ask-reopen') { state.asking = { id, kind: act.slice(4) }; return render(); }
  if (act === 'cancel-ask') { state.asking = null; return render(); }
  if (act === 'done') return changeStatus(id, 'done');
  if (act === 'copy') {
    const text = `GoodComments #${c.id} (${c.project_id || 'no project'}): ${c.body}${c.location ? `\nWhere: ${c.location}` : ''}\nWhen it's fixed, run: gc fix ${c.id} "what you changed"  (or MCP tool mark_fixed)`;
    await navigator.clipboard.writeText(text).then(() => toast('Copied for an agent'), () => toast('Copy failed'));
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Delete #${id}? This can't be undone.`)) return;
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
  const value = form.querySelector('input').value.trim();
  if (form.classList.contains('ask')) {
    const id = Number(form.id.slice(4));
    const input = form.querySelector('input');
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
    return changeStatus(id, form.dataset.kind === 'fix' ? 'fixed' : 'open', value);
  }
  if (form.dataset.note && value) {
    form.querySelector('input').blur();
    await api('POST', `/api/comments/${form.dataset.note}/notes`, { note: value }).catch((e) => toast(e.message));
    load();
  }
});

$('#items').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.asking) { state.asking = null; document.activeElement.blur(); render(); }
});
$('#line').addEventListener('focusout', () => setTimeout(() => state.pending && render(), 0));

$('#states').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  state.status = b.dataset.status;
  state.asking = null;
  store.set('status', state.status);
  if (board()) {
    // every state is visible: jump to its zone instead of filtering
    if (state.status === 'done' && !state.allDone) { state.allDone = true; }
    render();
    const zone = $(`.zone[data-zone="${state.status}"]`);
    zone?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    zone?.classList.add('flash');
    setTimeout(() => zone?.classList.remove('flash'), 900);
    return;
  }
  render();
  $('#line').scrollTop = 0;
});

$('#skins').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-skin]');
  if (!b) return;
  state.skin = b.dataset.skin;
  store.set('skin', state.skin);
  document.documentElement.dataset.skin = state.skin;
  render();
  $('#line').scrollTop = 0;
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
  const files = (await Promise.all(imageFiles(ev.dataTransfer.files).map(prepareFile))).filter(Boolean);
  if (!files.length) return toast('Only images and PDFs');
  await uploadFiles(li.dataset.id, files);
  toast(`Attached ${files.length} to #${li.dataset.id}`);
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
  box.innerHTML = pendingFiles.map((f, i) => `<span class="file" style="${f.url ? `background-image:url(${f.url})` : ''}">${f.url ? '' : 'PDF'}<button type="button" data-rm="${i}">✕</button></span>`).join('');
}
async function addFiles(list) {
  const files = (await Promise.all(imageFiles(list).map(prepareFile))).filter(Boolean);
  for (const f of files) pendingFiles.push(Object.assign(f, { url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null }));
  if (files.length) { composer.classList.add('open'); renderFiles(); body.focus(); }
  return files.length;
}
$('#c-files').addEventListener('click', (ev) => {
  const i = ev.target.dataset.rm;
  if (i === undefined) return;
  pendingFiles.splice(Number(i), 1);
  renderFiles();
});
$('#c-file').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; body.focus(); });
// Paste a screenshot anywhere in the column: it goes to the open card if one is
// expanded (and you're not typing in the composer), otherwise to a new comment.
document.addEventListener('paste', async (ev) => {
  const files = clipboardFiles(ev.clipboardData);
  if (!files.length) return;
  ev.preventDefault();
  const expanded = [...state.expanded];
  if (expanded.length === 1 && !composer.contains(document.activeElement)) {
    const ready = (await Promise.all(files.map(prepareFile))).filter(Boolean);
    await uploadFiles(expanded[0], ready);
    toast(`Attached ${ready.length} to #${expanded[0]}`);
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
    toast(`Hung #${c.id}`);
    await load();
    $('#line').scrollTop = 0;
  } catch (e) { toast(e.message); }
});

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

// ---------- keyboard ----------
document.addEventListener('keydown', (ev) => {
  if (isEditable(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'n' || ev.key === 'c') { ev.preventDefault(); body.focus(); }
  const tab = { 1: 'open', 2: 'fixed', 3: 'done' }[ev.key];
  if (tab) $(`#states [data-status="${tab}"]`).click();
});

// ---------- live ----------
let reloadTimer;
let es;
function connect() {
  es?.close();
  es = new EventSource(withToken('/api/events'));
  es.addEventListener('open', () => $('#live').classList.add('on'));
  es.addEventListener('error', () => $('#live').classList.remove('on'));
  es.addEventListener('change', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch {}
    const c = data.id && state.comments.find((x) => x.id === data.id);
    const li = c && $(`#items .item[data-id="${data.id}"]`);
    // an agent pulled a stick: show the card falling instead of just jumping
    if (li && data.status && c.status !== data.status && board() && !state.moving && !reduceMotion()) {
      clearTimeout(reloadTimer);
      boardMove(li, data.id, data.status, null, { remote: true });
      return;
    }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 120);
  });
}

setInterval(() => !state.asking && render(), 60000); // refresh "5m" labels
load().catch((e) => toast(e.message));
connect();
