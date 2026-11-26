#!/usr/bin/env node
// Retakes the product page screenshots from the current board UI, with made-up demo data.
//
//   node docs/shots.mjs [--lang en|es] [--no-gif] [--keep]
//
// en writes to docs/img/, es to docs/img/es/. It starts its own throwaway server
// (temp HOME, temp database, a free port: never the real board on 4477 or ~/.goodcomments),
// seeds it through the HTTP API and drives headless Google Chrome over the DevTools
// Protocol (Node 22+: built-in fetch and WebSocket, no npm installs).
// Needs: /Applications/Google Chrome.app; ffmpeg (Homebrew or Playwright's) for falling.gif.
// --keep leaves the temp folder (server log, raw frames) for debugging.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const LANG = opt('--lang', 'en');
if (!['en', 'es'].includes(LANG)) { console.error('--lang must be en or es'); process.exit(1); }
const GIF = !args.includes('--no-gif');
const KEEP = args.includes('--keep');
const OUT = LANG === 'en' ? join(ROOT, 'docs/img') : join(ROOT, 'docs/img', LANG);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BG = { r: 251, g: 245, b: 234, a: 1 };   // the product page's paper behind the panel
const TMP = mkdtempSync(join(tmpdir(), 'gc-shots-'));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);
const children = [];
process.on('exit', () => { for (const c of children) try { c.kill('SIGKILL'); } catch {} if (!KEEP) rmSync(TMP, { recursive: true, force: true }); });
process.on('SIGINT', () => process.exit(130));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => (port === 4477 ? freePort().then(res, rej) : res(port))); });
    s.on('error', rej);
  });
}

// ---------------------------------------------------------------- demo data
// Project names stay the same in both languages; everything people wrote is translated.
const T = {
  en: {
    pricing: { body: "Pricing: the annual toggle doesn't update the prices", where: 'acme.example/pricing', src: 'Email' },
    video: { body: 'Hero video stutters on Safari iOS, first 2 seconds', src: 'WhatsApp' },
    footer: {
      body: 'Footer still shows the old contact email', where: 'northwind.example/contact', src: 'Client',
      fix: 'Updated the email in partials/footer.html',
      reopen: 'The contact page still has the old address',
    },
    legend: {
      body: 'Map legend overlaps the zoom buttons on mobile', where: 'initech.example/stores', src: 'Figma',
      fix: 'Moved the legend to bottom-left in src/map.css:118; checked on iPhone 15 and iPad. https://initech.example/stores',
    },
    logos: { body: 'Add customer logos above the signup form', src: 'Slack', fix: 'Added the logo strip to signup.html (6 logos, grayscale)' },
    done: [
      ['Acme', 'Logo is blurry on retina screens', 'Email'], ['Globex', 'Typo in the About page: "recieve"', 'Client'],
      ['Initech', 'Cookie banner covers the chat button', 'Slack'], ['Northwind', 'Make the phone number clickable', 'WhatsApp'],
      ['Acme', 'Checkout button is grey on Safari', 'Meeting'], ['Globex', 'Add the Lisbon office to the footer', 'Email'],
      ['Initech', 'Search results ignore accents', 'Agent'], ['Northwind', 'Product photos load slowly on 3G', 'Call'],
      ['Acme', 'Newsletter form says "Sumbit"', 'Figma'], ['Globex', 'Dark mode: the table headers vanish', 'Me'],
      ['Initech', 'Favicon missing on the blog', 'Slack'], ['Northwind', 'Shipping page still lists 2024 prices', 'Client'],
      ['Acme', '404 page has no link home', 'Agent'], ['Globex', 'Team photos are in the wrong order', 'Meeting'],
    ],
    doneFix: 'Done, checked on desktop and mobile',
    shots: {
      plans: 'Simple pricing', monthly: 'Monthly', annual: 'Annual −20%', mo: '/mo', starter: 'Starter', team: 'Team', business: 'Business',
      small: 'For small teams', growing: 'For growing teams', large: 'For larger orgs', still: 'still monthly prices!', nav: ['Product', 'Pricing', 'Docs'],
      stores: 'Stores', open: 'Open now', closed: 'Closed', moved: 'legend moved to bottom-left ✓',
      contact: 'Contact us', answer: 'We usually answer within a day.', oldEmail: 'old email here too', navN: ['Shop', 'About', 'Contact'],
    },
  },
  es: {
    pricing: { body: 'Precios: el selector anual no actualiza los precios', where: 'acme.example/precios', src: 'Correo' },
    video: { body: 'El video de portada se traba en Safari iOS los primeros 2 segundos', src: 'WhatsApp' },
    footer: {
      body: 'El pie de página sigue mostrando el correo de contacto antiguo', where: 'northwind.example/contacto', src: 'Cliente',
      fix: 'Cambié el correo en partials/footer.html',
      reopen: 'La página de contacto todavía tiene la dirección antigua',
    },
    legend: {
      body: 'La leyenda del mapa tapa los botones de zoom en el móvil', where: 'initech.example/tiendas', src: 'Figma',
      fix: 'Moví la leyenda abajo a la izquierda en src/map.css:118; revisado en iPhone 15 y iPad. https://initech.example/tiendas',
    },
    logos: { body: 'Agregar logos de clientes sobre el formulario de registro', src: 'Slack', fix: 'Agregué la franja de logos a signup.html (6 logos, en gris)' },
    done: [
      ['Acme', 'El logo se ve borroso en pantallas retina', 'Correo'], ['Globex', 'Error en la página Nosotros: "recivir"', 'Cliente'],
      ['Initech', 'El aviso de cookies tapa el botón del chat', 'Slack'], ['Northwind', 'Que el teléfono se pueda tocar para llamar', 'WhatsApp'],
      ['Acme', 'El botón de pago se ve gris en Safari', 'Reunión'], ['Globex', 'Agregar la oficina de Lisboa al pie', 'Correo'],
      ['Initech', 'La búsqueda no reconoce las tildes', 'Agente'], ['Northwind', 'Las fotos de producto cargan lento en 3G', 'Llamada'],
      ['Acme', 'El formulario del boletín dice "Envíar"', 'Figma'], ['Globex', 'Modo oscuro: desaparecen los encabezados de la tabla', 'Yo'],
      ['Initech', 'Falta el favicon en el blog', 'Slack'], ['Northwind', 'La página de envíos tiene precios de 2024', 'Cliente'],
      ['Acme', 'La página 404 no tiene enlace al inicio', 'Agente'], ['Globex', 'Las fotos del equipo están en otro orden', 'Reunión'],
    ],
    doneFix: 'Listo, revisado en escritorio y móvil',
    shots: {
      plans: 'Precios simples', monthly: 'Mensual', annual: 'Anual −20%', mo: '/mes', starter: 'Inicial', team: 'Equipo', business: 'Empresa',
      small: 'Para equipos pequeños', growing: 'Para equipos en crecimiento', large: 'Para organizaciones', still: '¡siguen los precios mensuales!', nav: ['Producto', 'Precios', 'Docs'],
      stores: 'Tiendas', open: 'Abierta', closed: 'Cerrada', moved: 'leyenda abajo a la izquierda ✓',
      contact: 'Contacto', answer: 'Solemos responder en un día.', oldEmail: 'aquí también el correo antiguo', navN: ['Tienda', 'Nosotros', 'Contacto'],
    },
  },
}[LANG];
const PROJECTS = [['Acme', '#3b82f6'], ['Globex', '#22a06b'], ['Initech', '#c040c8'], ['Northwind', '#e8912d']];

// ---------------------------------------------------------------- fake web pages for the attached screenshots
const S = T.shots;
const page = (brand, color, nav, inner) => `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;font:14px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;color:#1d2433;background:#fff;width:900px;height:560px;overflow:hidden}
  header{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid #eceef3}
  header b{color:${color};font-size:17px} header nav{display:flex;gap:22px;color:#4a5265;font-size:13px}
  .ring{position:absolute;border:3px solid #e5383b;border-radius:50%} .tag{position:absolute;background:#e5383b;color:#fff;font:600 12px -apple-system,sans-serif;padding:3px 8px;border-radius:5px}
</style></head><body><header><b>${brand}</b><nav>${nav.map((n) => `<span>${n}</span>`).join('')}</nav></header>${inner}</body></html>`;

const PAGES = {
  pricing: page('◆ Acme', '#2f6fec', S.nav, `
    <style>.plans{display:flex;gap:18px;padding:0 60px}.plan{flex:1;border:1px solid #e3e6ee;border-radius:12px;padding:22px;height:200px}
    .plan.hl{border:2px solid #2f6fec;box-shadow:0 8px 24px #2f6fec22}.plan h3{margin:0 0 14px;font-size:15px}.price{font-size:34px;font-weight:700}.price small{font-size:14px;color:#6b7385;font-weight:500}
    .plan p{color:#6b7385;font-size:13px}.btn{margin-top:18px;background:#f1f3f8;border-radius:8px;padding:9px;text-align:center;font-weight:600;font-size:13px}.hl .btn{background:#2f6fec;color:#fff}</style>
    <h1 style="text-align:center;font-size:30px;margin:38px 0 16px">${S.plans}</h1>
    <div style="display:flex;justify-content:center;margin-bottom:30px"><div style="display:flex;background:#eef1f7;border-radius:99px;padding:4px;font-size:13px">
      <span style="padding:6px 16px;color:#4a5265">${S.monthly}</span><span style="padding:6px 16px;background:#2f6fec;color:#fff;border-radius:99px">${S.annual}</span></div></div>
    <div class="plans"><div class="plan"><h3>${S.starter}</h3><div class="price">$12<small>${S.mo}</small></div><p>${S.small}</p><div class="btn">Start</div></div>
    <div class="plan hl"><h3>${S.team}</h3><div class="price">$29<small>${S.mo}</small></div><p>${S.growing}</p><div class="btn">Start</div></div>
    <div class="plan"><h3>${S.business}</h3><div class="price">$79<small>${S.mo}</small></div><p>${S.large}</p><div class="btn">Contact</div></div></div>
    <div class="ring" style="left:330px;top:258px;width:190px;height:70px;transform:rotate(-6deg)"></div><div class="tag" style="left:560px;top:214px">${S.still}</div>`),
  map: page('Initech', '#b13ab8', [S.stores], `
    <div style="position:relative;margin:18px 28px;height:470px;border-radius:12px;overflow:hidden;background:linear-gradient(135deg,#dfeadb,#d7e6ee 60%,#cfe0ec)">
      <svg width="844" height="470" style="position:absolute;inset:0"><path d="M0 330 L844 250" stroke="#fff" stroke-width="10"/><path d="M180 0 L420 470" stroke="#fff" stroke-width="7"/>
        <path d="M520 0 C 560 160, 700 200, 844 210" stroke="#fff" stroke-width="6" fill="none"/><path d="M0 120 C 200 140, 260 90, 520 110" stroke="#f3f1e6" stroke-width="14" fill="none"/>
        ${[[300, 200], [560, 150], [640, 330], [210, 380]].map(([x, y]) => `<g transform="translate(${x} ${y})"><path d="M0 0 C -10 -14 -12 -22 0 -30 C 12 -22 10 -14 0 0Z" fill="#e5383b"/><circle cy="-21" r="4" fill="#fff"/></g>`).join('')}</svg>
      <div style="position:absolute;right:16px;top:16px;display:grid;background:#fff;border-radius:8px;box-shadow:0 2px 8px #0002;font:600 18px sans-serif"><span style="padding:6px 12px;border-bottom:1px solid #eee">+</span><span style="padding:6px 12px">−</span></div>
      <div style="position:absolute;left:16px;bottom:16px;background:#fff;border-radius:8px;padding:9px 14px;box-shadow:0 2px 8px #0002;font-size:13px;display:flex;gap:16px">
        <span><b style="color:#e5383b">●</b> ${S.open}</span><span><b style="color:#9aa1b1">●</b> ${S.closed}</span></div>
      <div style="position:absolute;left:220px;bottom:20px;background:#22a06b;color:#fff;border-radius:6px;padding:4px 10px;font:600 12px sans-serif">${S.moved}</div>
    </div>`),
  contact: page('Northwind', '#d9822b', S.navN, `
    <div style="padding:34px 60px"><h1 style="margin:0 0 8px;font-size:28px">${S.contact}</h1><p style="color:#6b7385;margin:0 0 26px">${S.answer}</p>
      <div style="background:#f5f6f9;border-radius:12px;padding:20px 24px;width:430px;line-height:2;font-size:15px">📍 12 Harbor Street<br>☎ +1 555 0100<br>✉ hello@northwind-old.example</div></div>
    <div class="ring" style="left:52px;top:250px;width:300px;height:48px;transform:rotate(-2deg)"></div><div class="tag" style="left:380px;top:262px">${S.oldEmail}</div>`),
};

// ---------------------------------------------------------------- the throwaway server
async function startServer(name) {
  const port = await freePort();
  const home = join(TMP, name);
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, PORT: String(port), GOODCOMMENTS_DB: join(home, 'gc.db'), GOODCOMMENTS_HOST: '127.0.0.1' };
  for (const k of Object.keys(env)) if (/^(GOODCOMMENTS_(TOKEN|URL|INBOX_KEY|LIBSQL_URL|LIBSQL_TOKEN|EDITOR|PORT)|SUPABASE_)/.test(k)) delete env[k];
  const proc = spawn(process.execPath, [join(ROOT, 'server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let out = '';
  proc.stdout.on('data', (d) => (out += d)); proc.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    if (proc.exitCode !== null) throw new Error('server exited:\n' + out);
    await sleep(100);
  }
  const api = async (method, path, body, { actor = 'you', type, name: fname } = {}) => {
    const headers = { 'x-actor': actor };
    if (type) Object.assign(headers, { 'content-type': type, 'x-filename': encodeURIComponent(fname) });
    else if (body) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: type ? body : body ? JSON.stringify(body) : undefined });
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(`${method} ${path}: ${r.status} ${data?.error || ''}`); e.status = r.status; throw e; }
    return data;
  };
  log(`${name} server on ${base} (data in ${home})`);
  return { base, api, proc };
}

async function seedSettings(api) {
  await api('PATCH', '/api/settings', { theme: 'light' }).catch((e) => log('theme:', e.message));
  await api('PATCH', '/api/settings', { language: LANG }).catch((e) => {
    if (e.status === 400) log(`language setting not supported by this server yet (${e.message}); shooting in its default language`);
    else throw e;
  });
}
const projectsBy = async (api) => Object.fromEntries((await Promise.all(PROJECTS.map(([name, color]) => api('POST', '/api/projects', { name, color })))).map((p) => [p.name, p.id]));
const tick = () => sleep(15);   // keep event and attachment timestamps strictly ordered
async function add(api, project, { body, where, src }) { const c = await api('POST', '/api/comments', { body, project, source: src, location: where }); await tick(); return c; }
async function attach(api, id, png, name, actor) { await api('POST', `/api/comments/${id}/attachments`, png, { type: 'image/png', name, actor }); await tick(); }
async function status(api, id, s, note, actor) { await api('POST', `/api/comments/${id}/status`, { status: s, note }, { actor }); await tick(); }

async function seedDone(api, P, rows) {
  for (const [proj, body, src] of rows) {
    const c = await add(api, P[proj], { body, src });
    await status(api, c.id, 'fixed', T.doneFix, 'claude');
    await status(api, c.id, 'done', undefined, 'you');
  }
}

// ---------------------------------------------------------------- Chrome over CDP
async function startChrome() {
  const port = await freePort();
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(TMP, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'],
  { stdio: 'ignore' });
  children.push(proc);
  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {}
    await sleep(100);
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const once = (method) => new Promise((r) => { const l = (m) => { if (m.method === method) { listeners.splice(listeners.indexOf(l), 1); r(m.params); } }; listeners.push(l); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: BG });

  const c = {
    send,
    listen: (fn) => listeners.push(fn),
    async size(width, height, scale = 2) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }); },
    async goto(url) { const loaded = once('Page.loadEventFired'); await send('Page.navigate', { url }); await loaded; },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async shot(file, clip, { format = 'jpeg', quality = 85 } = {}) {
      const p = { format, captureBeyondViewport: false };
      if (format === 'jpeg') p.quality = quality;
      if (clip) p.clip = { ...clip, scale: 1 };
      const { data } = await send('Page.captureScreenshot', p);
      const buf = Buffer.from(data, 'base64');
      if (file) writeFileSync(file, buf);
      return buf;
    },
  };
  return c;
}

// Wait until the board is still: no finite CSS animations running, no card mid-move, pile heads at rest.
const SETTLE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const heads = () => [...document.querySelectorAll('.heap > *')].map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y); }).join(' ');
  let calm = 0, last = heads();
  for (let i = 0; i < 200 && calm < 8; i++) {
    await sleep(100);
    const busy = document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)
      || document.querySelector('.faller, .pulling, .leaving');
    const now = heads();
    calm = busy || now !== last ? 0 : calm + 1;
    last = now;
  }
  await document.fonts.ready;
  return calm >= 8;
})()`;
// The idle monkeys fidget now and then (wave, blink, swing): wait for a quiet moment right before a shot.
const QUIET = `(async () => { for (let i = 0; i < 100; i++) { if (!document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) return true; await new Promise((r) => setTimeout(r, 50)); } return false; })()`;

async function renderPages(chrome) {
  const png = {};
  await chrome.size(900, 560, 1);
  for (const [k, html] of Object.entries(PAGES)) {
    await chrome.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await sleep(150);
    png[k] = await chrome.shot(null, null, { format: 'png' });
  }
  return png;
}

const rectOf = (chrome, sel) => chrome.eval(`(() => {
  const el = ${sel};
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);
const cardOf = (bodyText) => `[...document.querySelectorAll('#items .item[data-id]')].find((li) => li.querySelector('.body')?.textContent.includes(${JSON.stringify(bodyText)}))`;

/** A card with its monkey and stick, full panel width so the trunk shows on the left. Fixed output size. */
async function shootCard(chrome, bodyText, file, w, h) {
  const r = await rectOf(chrome, cardOf(bodyText));
  if (!r) throw new Error('card not found: ' + bodyText);
  await sleep(500);
  await chrome.eval(SETTLE);
  const r2 = await rectOf(chrome, cardOf(bodyText));
  const cw = w / 2;
  // the monkey and stick stick out ~24px above the item's box; keep the card's bottom shadow in view.
  // A card taller than the usual frame gets a taller image (the page scales it with height: auto).
  const ch = Math.max(h / 2, Math.ceil(r2.height) + 14 + 8);
  if (ch > h / 2) log(`note: ${file} is ${ch * 2}px tall instead of ${h}px (the card is taller)`);
  const top = Math.max(0, Math.round(r2.y + r2.height + 14 - ch));
  await chrome.eval(QUIET);
  await chrome.shot(join(OUT, file), { x: 0, y: top, width: cw, height: ch });
  log('wrote', join(OUT, file));
}

// ---------------------------------------------------------------- stills
async function stills(chrome, png) {
  const { base, api } = await startServer('stills');
  await seedSettings(api);
  const P = await projectsBy(api);
  await seedDone(api, P, [...T.done, ...T.done, ...T.done]);   // enough heads to make a heap
  // open (oldest first: the board lists newest first)
  const footer = await add(api, P.Northwind, T.footer);
  await status(api, footer.id, 'fixed', T.footer.fix, 'claude');
  await status(api, footer.id, 'open', T.footer.reopen, 'you');
  await attach(api, footer.id, png.contact, 'contact.png', 'you');
  await add(api, P.Globex, T.video);
  const pricing = await add(api, P.Acme, T.pricing);
  await attach(api, pricing.id, png.pricing, 'pricing.png', 'you');
  // to check
  const logos = await add(api, P.Acme, T.logos);
  await status(api, logos.id, 'fixed', T.logos.fix, 'codex');
  const legend = await add(api, P.Initech, T.legend);
  await status(api, legend.id, 'fixed', T.legend.fix, 'claude');
  await attach(api, legend.id, png.map, 'after.png', 'claude');

  // the cards and the pile, in a 520px panel (1040px images)
  await chrome.size(520, 1200);
  await chrome.goto(`${base}/?embed`);
  await chrome.eval(`new Promise((r) => { const t = setInterval(() => { if (document.querySelector('#items .item[data-id]')) { clearInterval(t); r(); } }, 50); })`);
  if (!(await chrome.eval(SETTLE))) log('warning: the board never fully settled');
  await shootCard(chrome, T.pricing.body, 'card-screenshot.jpg', 1040, 516);
  await shootCard(chrome, T.legend.body, 'to-check.jpg', 1040, 664);
  await shootCard(chrome, T.footer.body, 'reopened.jpg', 1040, 668);

  // the pile: its label on top, heads on the ground
  await rectOf(chrome, `document.querySelector('#items .pile')`);
  await sleep(400);
  await chrome.eval(SETTLE);
  const pr = await rectOf(chrome, `document.querySelector('#items .pile')`);
  const ph = Math.round(pr.height) + 8;   // the whole pile: its label on top, the heap on the ground
  await chrome.eval(QUIET);
  await chrome.shot(join(OUT, 'pile.jpg'), { x: 0, y: Math.round(pr.y) - 8, width: 520, height: ph });
  log('wrote', join(OUT, 'pile.jpg'));

  // the whole column, 400px wide, as tall as its content
  await chrome.size(400, 1200);
  await chrome.goto(`${base}/?embed`);
  await chrome.eval(`new Promise((r) => { const t = setInterval(() => { if (document.querySelector('#items .item[data-id]')) { clearInterval(t); r(); } }, 50); })`);
  await chrome.eval(SETTLE);
  const full = await chrome.eval(`(() => { const line = document.querySelector('#line'); return Math.ceil(line.getBoundingClientRect().top + line.scrollHeight); })()`);
  await chrome.size(400, full);
  await sleep(600);
  await chrome.eval(SETTLE);
  await chrome.eval(`document.querySelector('#line').scrollTop = 0`);
  await chrome.eval(QUIET);
  await chrome.shot(join(OUT, 'board.jpg'), { x: 0, y: 0, width: 400, height: full });
  log('wrote', join(OUT, 'board.jpg'), `(800x${full * 2})`);
}

// ---------------------------------------------------------------- falling.gif
function findFfmpeg() {
  const pw = join(homedir(), 'Library/Caches/ms-playwright');
  const cands = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  if (existsSync(pw)) for (const d of readdirSync(pw).filter((d) => d.startsWith('ffmpeg'))) cands.push(join(pw, d, 'ffmpeg-mac'), join(pw, d, 'ffmpeg'));
  return cands.find((p) => existsSync(p)) || null;
}

async function gif(chrome) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) { log('no ffmpeg found: skipping falling.gif'); return; }
  const { base, api } = await startServer('gif');
  await seedSettings(api);
  const P = await projectsBy(api);
  await seedDone(api, P, T.done.slice(0, 9));
  const logos = await add(api, P.Acme, T.logos);
  await status(api, logos.id, 'fixed', T.logos.fix, 'codex');
  await add(api, P.Globex, T.video);
  const legend = await add(api, P.Initech, { body: T.legend.body, where: T.legend.where, src: T.legend.src });

  const W = 400, H = 1009;
  await chrome.size(W, H);
  await chrome.goto(`${base}/?embed`);
  await chrome.eval(`new Promise((r) => { const t = setInterval(() => { if (document.querySelector('#items .item[data-id]')) { clearInterval(t); r(); } }, 50); })`);
  await chrome.eval(SETTLE);
  await chrome.eval(QUIET);

  // record with a screencast (frames come with timestamps); the API calls happen meanwhile
  const dir = join(TMP, 'frames');
  mkdirSync(dir, { recursive: true });
  const frames = [];
  let recording = true;
  const onFrame = async (m) => {
    if (m.method !== 'Page.screencastFrame') return;
    const { data, metadata, sessionId } = m.params;
    chrome.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!recording) return;
    const f = join(dir, `f${String(frames.length).padStart(4, '0')}.jpg`);
    writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push({ f, t: metadata.timestamp });
  };
  chrome.listen(onFrame);
  await chrome.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 1 });
  // a still board does not paint: nudge it so the first second has frames
  const t0 = Date.now();
  const keepAlive = setInterval(() => chrome.eval(`document.body.style.outlineColor = 'rgba(0,0,0,${Math.random() / 1000})'`).catch(() => {}), 40);
  await sleep(1300);
  await status(api, legend.id, 'fixed', T.legend.fix, 'claude');      // an agent marks it fixed: it drops to To check
  await sleep(3200);
  await status(api, legend.id, 'done', undefined, 'you');             // you approve it: it falls onto the pile
  await sleep(3400);
  await status(api, logos.id, 'done', undefined, 'you');              // and the other one
  await sleep(3600);
  recording = false;
  clearInterval(keepAlive);
  await chrome.send('Page.stopScreencast');
  log(`recorded ${frames.length} frames over ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (frames.length < 30) { log('too few frames: skipping falling.gif'); return; }

  // concat list with each frame's real duration, then a 2-pass palette GIF at 20 fps, 400px wide
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 0.5;
    lines.push(`file '${frames[i].f}'`, `duration ${Math.max(0.01, d).toFixed(3)}`);
  }
  lines.push(`file '${frames.at(-1).f}'`);
  const list = join(dir, 'list.txt');
  writeFileSync(list, lines.join('\n'));
  const out = join(OUT, 'falling.gif');
  const vf = `fps=20,scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-loop', '0', out]);
  log('wrote', out);
}

// ---------------------------------------------------------------- main
const chrome = await startChrome();
try {
  log(`language: ${LANG} → ${OUT}`);
  const png = await renderPages(chrome);
  await stills(chrome, png);
  if (GIF) await gif(chrome);
  log('done');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  process.exit();
}
