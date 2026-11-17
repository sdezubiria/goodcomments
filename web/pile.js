// The pile at the bottom of the trunk: a tiny physics world. Each done comment
// is a monkey head (and dropped bananas join in). They fall, roll and bump into
// each other, and you can grab one, drag it around and throw it.

const G = 2200;              // gravity, px/s²
const RESTITUTION = 0.28;    // bounciness between bodies
const FLOOR_BOUNCE = 0.32;
const ROLL_FRICTION = 0.82;  // per contact with the floor, per step
const SUBSTEPS = 3;

const bodies = new Map();    // key → body
let heap = null;             // the element the world lives in
let W = 0;
let H = 0;
let raf = 0;
let lastT = 0;
let calm = 0;                // frames everything has been nearly still
let drag = null;
let touchedAt = 0;
let pokeHandler = () => {};
let bananaCount = 0;

export const onPoke = (fn) => { pokeHandler = fn; };
/** True right after a drag or poke, so the click that follows doesn't count as a click on the pile. */
export const recentlyTouched = () => performance.now() - touchedAt < 350;

const radiusOf = (el) => (el.classList.contains('banana') ? 10 : 13);
const baseAngle = (el) => (parseFloat(el.style.getPropertyValue('--r')) || 0) * (Math.PI / 180);

/**
 * Re-renders build a fresh pile; keep the live one (with its positions and any
 * drag in progress) and only add or remove the heads that changed.
 */
export function syncHeap(oldHeap, newHeap) {
  const want = new Map([...newHeap.children].map((el) => [el.dataset.key, el]));
  for (const el of [...oldHeap.children]) {
    const k = el.dataset.key;
    if (k?.startsWith('b')) continue;                        // bananas stay
    if (!want.has(k)) el.remove();
  }
  for (const [k, el] of want) {
    const cur = oldHeap.querySelector(`:scope > [data-key="${k}"]`);
    if (!cur) { oldHeap.appendChild(el); continue; }
    cur.classList.toggle('new', el.classList.contains('new'));
    cur.style.setProperty('--pc', el.style.getPropertyValue('--pc'));
    cur.title = el.title;
  }
  oldHeap.className = newHeap.className;
}

/** Bind the world to the pile element (call after every render). */
export function attach(el) {
  if (!el) { heap = null; stop(); return; }
  heap = el;
  wire(el);
  measure();
  const kids = [...el.children].filter((c) => c.dataset.key);
  const fresh = bodies.size === 0;
  const seen = new Set();
  const newcomers = kids.filter((c) => !bodies.has(c.dataset.key));
  if (fresh) stack(newcomers);
  for (const c of kids) {
    const k = c.dataset.key;
    seen.add(k);
    let b = bodies.get(k);
    if (!b) {
      b = spawn(c);
      bodies.set(k, b);
    }
    b.el = c;
    draw(b);
  }
  for (const k of [...bodies.keys()]) if (!seen.has(k)) bodies.delete(k);
  wake();
}

/** A freshly approved head waits (hidden) at the top until its card has landed. */
export function release(el) {
  const b = el && bodies.get(el.dataset.key);
  if (!b) return;
  b.frozen = false;
  b.vy = 120;
  wake();
}

/** Throw a head (or every head) up in the air. */
export function kick(el, strength = 1) {
  const list = el ? [bodies.get(el.dataset.key)].filter(Boolean) : [...bodies.values()];
  for (const b of list) {
    if (b.frozen) continue;
    b.vy -= (420 + Math.random() * 380) * strength;
    b.vx += (Math.random() * 2 - 1) * 260 * strength;
  }
  wake();
}

/** Clean-up: everything gets flung up and out of the pile. */
export function sweep() {
  if (!heap) return;
  heap.classList.add('sweeping');
  for (const b of bodies.values()) {
    b.frozen = false;
    b.escape = true;
    b.vy = -900 - Math.random() * 700;
    b.vx = (Math.random() - 0.5) * 1100;
  }
  wake();
}

/** The sweep didn't go through: let everything fall back in. */
export function unsweep() {
  if (!heap) return;
  heap.classList.remove('sweeping');
  for (const b of bodies.values()) { b.escape = false; b.y = Math.min(b.y, -20); }
  wake();
}

/** Bananas aren't comments; cleaning the pile throws them away too. */
export function clearBananas() {
  for (const [k, b] of [...bodies]) if (k.startsWith('b')) { b.el.remove(); bodies.delete(k); }
  // (the 'sweeping' class goes away on the next render, together with the archived heads)
}

/** A banana lands on the pile at this screen x. */
export function addBanana(clientX) {
  if (!heap) return;
  const el = document.createElement('span');
  el.className = 'banana';
  el.textContent = '🍌';
  el.dataset.key = `b${bananaCount++}`;
  el.style.setProperty('--r', `${Math.random() * 80 - 40}deg`);
  heap.appendChild(el);
  const r = heap.getBoundingClientRect();
  const b = { x: clamp(clientX - r.left, 10, W - 10), y: -10, vx: 0, vy: 260, r: 10, a: baseAngle(el), el, frozen: false };
  bodies.set(el.dataset.key, b);
  draw(b);
  wake();
}

// ---------- internals ----------

function measure() {
  W = heap.clientWidth;
  H = heap.clientHeight;
}

/** First time we see the pile: lay the heads out as a settled heap (no raining down on page load). */
function stack(list) {
  const d = 24;
  const perRow = Math.max(3, Math.min(Math.floor((W - 20) / d), Math.ceil(Math.sqrt(list.length) * 1.7)));
  let i = 0;
  for (let row = 0; i < list.length; row++) {
    const n = Math.min(Math.max(1, perRow - row), list.length - i);
    const x0 = W / 2 - ((n - 1) * d) / 2 + (row % 2 ? d / 4 : 0);
    for (let k = 0; k < n; k++, i++) {
      const el = list[i];
      bodies.set(el.dataset.key, {
        x: x0 + k * d + (Math.random() - 0.5) * 2,
        y: H - 13 - row * 21,
        vx: 0, vy: 0, r: radiusOf(el), a: baseAngle(el), el, frozen: false,
      });
    }
  }
}

function spawn(el) {
  const r = radiusOf(el);
  const isNew = el.classList.contains('new');
  return {
    x: clamp(W / 2 + (Math.random() - 0.5) * 60, r, W - r),
    y: isNew ? r : -r * 2,
    vx: 0, vy: 0, r, a: baseAngle(el), el,
    frozen: isNew,           // waits for its card to finish falling (see release)
  };
}

function draw(b) {
  b.el.style.transform = `translate(${b.x - b.r}px, ${b.y - b.r}px) rotate(${b.a}rad)`;
}

function wake() {
  calm = 0;
  if (!raf && heap) { lastT = performance.now(); raf = requestAnimationFrame(tick); }
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function tick(t) {
  raf = 0;
  if (!heap || !heap.isConnected) return;
  const dt = Math.min(0.033, (t - lastT) / 1000);
  lastT = t;
  measure();
  for (let s = 0; s < SUBSTEPS; s++) step(dt / SUBSTEPS);
  let fastest = 0;
  for (const b of bodies.values()) {
    draw(b);
    if (!b.frozen) fastest = Math.max(fastest, Math.abs(b.vx), Math.abs(b.vy));
  }
  const flying = [...bodies.values()].some((b) => b.escape && b.y < H + 200);
  calm = fastest < 12 && !drag && !flying ? calm + 1 : 0;
  if (calm > 40) {                       // everything has settled: stop until poked
    for (const b of bodies.values()) { b.vx = 0; b.vy = 0; }
    return;
  }
  raf = requestAnimationFrame(tick);
}

function step(dt) {
  const list = [...bodies.values()];
  for (const b of list) {
    if (b.frozen) continue;
    if (b === drag?.b) {
      // follow the pointer, remembering how fast it moves (for the throw)
      b.vx = (drag.x - b.x) / dt * 0.5;
      b.vy = (drag.y - b.y) / dt * 0.5;
      b.x += (drag.x - b.x) * 0.5;
      b.y += (drag.y - b.y) * 0.5;
      continue;
    }
    b.vy += G * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }

  // bodies push each other apart and trade momentum
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const c = list[j];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const min = a.r + c.r - 1;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const ia = a.frozen || a === drag?.b ? 0 : 1;
      const ic = c.frozen || c === drag?.b ? 0 : 1;
      const total = ia + ic;
      if (!total) continue;
      const overlap = min - d;
      a.x -= nx * overlap * (ia / total);
      a.y -= ny * overlap * (ia / total);
      c.x += nx * overlap * (ic / total);
      c.y += ny * overlap * (ic / total);
      const rv = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
      if (rv < 0) {
        const jn = (-(1 + RESTITUTION) * rv) / total;
        a.vx -= jn * nx * ia; a.vy -= jn * ny * ia;
        c.vx += jn * nx * ic; c.vy += jn * ny * ic;
        // a little friction along the contact so stacks don't slide forever
        const tx = -ny;
        const ty = nx;
        const rt = (c.vx - a.vx) * tx + (c.vy - a.vy) * ty;
        const jt = (rt * 0.32) / total;
        a.vx += jt * tx * ia; a.vy += jt * ty * ia;
        c.vx -= jt * tx * ic; c.vy -= jt * ty * ic;
      }
    }
  }

  // floor and walls; rolling turns the heads
  for (const b of list) {
    if (b.frozen || b === drag?.b) continue;
    if (b.escape) { b.a += (b.vx * dt) / b.r; continue; }   // being swept away: nothing holds it in
    if (b.y + b.r > H) {
      b.y = H - b.r;
      b.vy = Math.abs(b.vy) > 80 ? -b.vy * FLOOR_BOUNCE : 0;
      b.vx *= ROLL_FRICTION;
    }
    if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.5; }
    if (b.x + b.r > W) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * 0.5; }
    b.a += (b.vx * dt) / b.r;
  }
}

/** Grab, drag and throw. A press without moving is a poke. */
function wire(el) {
  if (el._wired) return;
  el._wired = true;
  el.addEventListener('pointerdown', (ev) => {
    const target = ev.target.closest('[data-key]');
    const b = target && bodies.get(target.dataset.key);
    if (!b || b.frozen || ev.button !== 0) return;
    ev.preventDefault();
    el.setPointerCapture(ev.pointerId);
    const p = local(ev);
    drag = { b, x: p.x, y: p.y, sx: ev.clientX, sy: ev.clientY, moved: false, id: ev.pointerId };
    el.classList.add('dragging');
    touchedAt = performance.now();
    wake();
  });
  el.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const p = local(ev);
    drag.x = clamp(p.x, drag.b.r, W - drag.b.r);
    drag.y = Math.min(p.y, H - drag.b.r);
    if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) > 4) drag.moved = true;
    touchedAt = performance.now();
    wake();
  });
  const end = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const { b, moved } = drag;
    drag = null;
    el.classList.remove('dragging');
    touchedAt = performance.now();
    // throw speed comes from the last pointer movement; keep it sane
    b.vx = clamp(b.vx, -2600, 2600);
    b.vy = clamp(b.vy, -2600, 2600);
    if (!moved) pokeHandler(b.el);
    wake();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function local(ev) {
  const r = heap.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
