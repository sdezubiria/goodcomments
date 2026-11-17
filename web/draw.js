// A small drawing editor for screenshots: pen, arrow, box, highlighter and text,
// a few colors, undo. Opens over the column; "Attach" hands back a PNG File.

const COLORS = ['#ff3b30', '#ffcc00', '#2f6fec', '#23a86b', '#111318', '#ffffff'];
const TOOLS = [
  { id: 'pen', key: 'p', label: 'Pen', icon: '<path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12 3 13z"/>' },
  { id: 'arrow', key: 'a', label: 'Arrow', icon: '<path d="M3 13L12.5 3.5M7 3.5h5.5V9"/>' },
  { id: 'box', key: 'b', label: 'Box', icon: '<rect x="2.5" y="3.5" width="11" height="9" rx="2"/>' },
  { id: 'mark', key: 'h', label: 'Highlighter', icon: '<path d="M2.5 13.5h6M5 11l6.5-6.5 2 2L7 13H5v-2z"/>' },
  { id: 'text', key: 't', label: 'Text', icon: '<path d="M3.5 4V3h9v1M8 3v10M6 13h4"/>' },
];

let current = null;
export const isOpen = () => !!current;
export const undo = () => current?.undo();

/**
 * @param {string|Blob} src  data URL or image Blob/File
 * @param {{ onDone?: (file: File) => void, onCancel?: () => void, title?: string }} opts
 */
export async function openEditor(src, { onDone, onCancel, onOpen, onClose, title = 'Draw on the screenshot' } = {}) {
  if (current) current.close();
  const img = await loadImage(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const stroke = Math.max(3, Math.round(Math.max(W, H) / 320));

  const root = document.createElement('div');
  root.className = 'draw';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', title);
  root.innerHTML = `
    <div class="draw-bar">
      <div class="draw-group tools">${TOOLS.map((t) => `<button data-tool="${t.id}" title="${t.label} (${t.key.toUpperCase()})" aria-label="${t.label}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></button>`).join('')}</div>
      <div class="draw-group colors">${COLORS.map((c) => `<button data-color="${c}" style="--c:${c}" title="Color" aria-label="Color ${c}"></button>`).join('')}</div>
      <button class="draw-undo" title="Undo (⌘Z)" aria-label="Undo"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5L2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/></svg></button>
      <span class="draw-spacer"></span>
      <button class="draw-cancel">Cancel</button>
      <button class="draw-done">Attach</button>
    </div>
    <div class="draw-stage"><canvas width="${W}" height="${H}"></canvas></div>
    <div class="draw-hint">Draw on it, then Attach · Esc cancels · ⌘Z undoes</div>`;
  document.body.appendChild(root);

  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const stage = root.querySelector('.draw-stage');
  const shapes = [];
  let tool = 'arrow';
  let color = COLORS[0];
  let live = null;
  let textInput = null;

  const pick = () => {
    root.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    root.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
    stage.dataset.tool = tool;
  };

  function redraw() {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0);
    for (const s of shapes) paint(s);
    if (live) paint(live);
  }

  function paint(s) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = stroke;
    if (s.type === 'pen' || s.type === 'mark') {
      if (s.type === 'mark') { ctx.globalAlpha = 0.38; ctx.lineWidth = stroke * 5; ctx.lineCap = 'square'; }
      ctx.beginPath();
      s.pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
      ctx.stroke();
    } else if (s.type === 'box') {
      const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
      const w = Math.abs(s.x2 - s.x1), h = Math.abs(s.y2 - s.y1);
      const r = Math.min(stroke * 3, w / 2, h / 2);
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
      ctx.stroke();
    } else if (s.type === 'arrow') {
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = stroke * 4.5;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2 - Math.cos(ang) * head * 0.6, s.y2 - Math.sin(ang) * head * 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(ang - 0.45), s.y2 - head * Math.sin(ang - 0.45));
      ctx.lineTo(s.x2 - head * Math.cos(ang + 0.45), s.y2 - head * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    } else if (s.type === 'text') {
      const size = stroke * 7;
      ctx.font = `700 ${size}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, size / 7);
      ctx.strokeStyle = s.color === '#ffffff' ? '#111318' : '#ffffff';   // halo so it reads on anything
      ctx.strokeText(s.text, s.x, s.y);
      ctx.fillText(s.text, s.x, s.y);
    }
    ctx.restore();
  }

  // screen ↔ image coordinates
  const at = (ev) => {
    const r = canvas.getBoundingClientRect();
    return [(ev.clientX - r.left) * (W / r.width), (ev.clientY - r.top) * (H / r.height)];
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    if (textInput) commitText();
    const [x, y] = at(ev);
    if (tool === 'text') return startText(ev, x, y);
    canvas.setPointerCapture(ev.pointerId);
    live = tool === 'pen' || tool === 'mark'
      ? { type: tool, color: tool === 'mark' && color === '#111318' ? '#ffcc00' : color, pts: [[x, y]] }
      : { type: tool, color, x1: x, y1: y, x2: x, y2: y };
    redraw();
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!live) return;
    const [x, y] = at(ev);
    if (live.pts) live.pts.push([x, y]);
    else { live.x2 = x; live.y2 = y; }
    redraw();
  });
  const finish = () => {
    if (!live) return;
    const tiny = live.pts ? false : Math.hypot(live.x2 - live.x1, live.y2 - live.y1) < stroke * 2;
    if (!tiny) shapes.push(live);
    live = null;
    redraw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  function startText(ev, x, y) {
    const r = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    textInput = document.createElement('input');
    textInput.className = 'draw-text';
    textInput.placeholder = 'Type, then Enter';
    textInput.style.left = `${ev.clientX - sr.left}px`;
    textInput.style.top = `${ev.clientY - sr.top}px`;
    textInput.style.color = color;
    textInput.style.fontSize = `${Math.max(13, (stroke * 7 * r.width) / W)}px`;
    textInput._pos = [x, y];
    stage.appendChild(textInput);
    setTimeout(() => textInput?.focus(), 0);
    textInput.addEventListener('blur', () => setTimeout(commitText, 0));
  }
  function commitText() {
    if (!textInput) return;
    const t = textInput.value.trim();
    const [x, y] = textInput._pos;
    textInput.remove();
    textInput = null;
    if (t) { shapes.push({ type: 'text', color, x, y, text: t }); redraw(); }
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    if (current === api) current = null;
    onClose?.();
  }
  function cancel() { close(); onCancel?.(); }
  function done() {
    commitText();
    redraw();
    close();   // close right away; the PNG is encoded from the (now detached) canvas in the background
    canvas.toBlob((blob) => {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      onDone?.(new File([blob], `screenshot-${stamp}.png`, { type: 'image/png' }));
    }, 'image/png');
  }

  function onKey(ev) {
    if (textInput && document.activeElement === textInput) {
      if (ev.key === 'Enter') { ev.preventDefault(); commitText(); }
      if (ev.key === 'Escape') { ev.preventDefault(); textInput.value = ''; commitText(); }
      ev.stopPropagation();
      return;
    }
    const k = ev.key.toLowerCase();
    if ((ev.metaKey || ev.ctrlKey) && k === 'z') { ev.preventDefault(); ev.stopPropagation(); return api.undo(); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return cancel(); }
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); return done(); }
    const t = TOOLS.find((x) => x.key === k);
    if (t && !ev.metaKey && !ev.ctrlKey) { ev.stopPropagation(); tool = t.id; pick(); }
  }
  document.addEventListener('keydown', onKey, true);

  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) { tool = b.dataset.tool; pick(); }
    else if (b.dataset.color) { color = b.dataset.color; pick(); }
    else if (b.classList.contains('draw-undo')) api.undo();
    else if (b.classList.contains('draw-cancel')) cancel();
    else if (b.classList.contains('draw-done')) done();
  });

  const api = {
    close,
    undo() { if (textInput) { textInput.value = ''; commitText(); return; } shapes.pop(); redraw(); },
  };
  current = api;
  pick();
  redraw();
  onOpen?.();
  return api;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not open that image'));
    img.src = url;
  });
}

/** Browser fallback (no Mac app): ask for a screen, window or tab and grab one frame. */
export async function grabScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return c.toDataURL('image/png');
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
