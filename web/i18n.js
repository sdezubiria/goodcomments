// Spanish for the board and the quick window.
//
// The pages are written in English. In Spanish, this translates the page as it's drawn: every text, title,
// placeholder and aria-label that matches an entry below (exactly, or one of the patterns) is swapped,
// including what the board renders later (a MutationObserver), so app.js keeps building its HTML in English.
// What people wrote (comment text, notes, places, sources) is never touched. Dialogs from confirm() and
// alert() go through t() in app.js.
//
// The language: Settings → Language (the board's setting, cached here per browser), or with "auto" the
// browser's / the Mac's preferred languages.

const KEY = 'gc.language';
const pref = (() => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } })();
const fromSystem = () => ((navigator.languages || [navigator.language || 'en']).find((l) => /^(es|en)\b/i.test(l)) || 'en').slice(0, 2).toLowerCase();
export const lang = pref === 'es' || pref === 'en' ? pref : fromSystem();
export const languagePref = pref;
document.documentElement.lang = lang;

/** Remember the board's setting in this browser; true when that changes the language (the page reloads). */
export function rememberLanguage(value) {
  const v = ['auto', 'en', 'es'].includes(value) ? value : 'auto';
  try { localStorage.setItem(KEY, v); } catch {}
  const next = v === 'auto' ? fromSystem() : v;
  return next !== lang;
}

// ---------- the Spanish ----------
const ES = {
  // column
  'Live': 'En vivo', 'Search comments (/)': 'Buscar comentarios (/)', 'Settings': 'Ajustes', 'Keep open': 'Mantener abierto',
  'Minimize (⌃⌥C)': 'Minimizar (⌃⌥C)', 'Open': 'Abrir', 'To check': 'Por revisar', 'Done': 'Hechos',
  'Search comments': 'Buscar comentarios',
  '/ search · j / k move · a approve · f fixed · r reopen · ↵ open · esc close': '/ buscar · j / k moverse · a aprobar · f arreglado · r reabrir · ↵ abrir · esc cerrar',
  'Project': 'Proyecto', 'From…': 'De…', 'Source': 'Origen', 'Where (url, page…)': 'Dónde (url, página…)', 'Where': 'Dónde', 'From': 'De',
  'Take a screenshot and draw on it (⌃⌥S)': 'Tomar una captura y dibujar en ella (⌃⌥S)', 'Take a screenshot and draw on it': 'Tomar una captura y dibujar en ella',
  'Attach screenshots or documents': 'Adjuntar capturas o documentos', 'Hang': 'Colgar',
  '↵ hang it · ⇧↵ new line · camera: pick an area and draw on it · click a screenshot to draw on it · esc cancel':
    '↵ colgarlo · ⇧↵ nueva línea · cámara: elige un área y dibuja en ella · clic en una captura para dibujar en ella · esc cancelar',
  'Email': 'Correo', 'Meeting': 'Reunión', 'Call': 'Llamada', 'Client': 'Cliente', 'Me': 'Yo', 'Agent': 'Agente',
  // settings
  'Clean up the pile automatically': 'Limpiar la pila automáticamente', 'Never (use Sweep the pile)': 'Nunca (usa Barrer la pila)',
  '1 day after approving': '1 día después de aprobar', '3 days after approving': '3 días después de aprobar', '1 week after approving': '1 semana después de aprobar',
  '2 weeks after approving': '2 semanas después de aprobar', '1 month after approving': '1 mes después de aprobar',
  'Ask before': 'Preguntar antes de', 'Opening a Claude session (Ask Claude)': 'Abrir una sesión de Claude (Pedir a Claude)', 'Deleting a comment': 'Borrar un comentario',
  'Delete screenshots automatically': 'Borrar capturas automáticamente', 'after': 'después de', 'How long': 'Cuánto tiempo', 'Unit': 'Unidad',
  'hours': 'horas', 'days': 'días', 'weeks': 'semanas', 'months': 'meses', 'years': 'años', 'Counted from': 'Contado desde',
  'from the clean-up': 'desde la limpieza', 'from approving': 'desde que se aprueba', 'from attaching (any comment)': 'desde que se adjunta (cualquier comentario)',
  'Appearance': 'Apariencia', 'Look': 'Estilo', 'With monkeys': 'Con monos', 'Simple, no monkeys': 'Simple, sin monos', 'Same as macOS': 'Igual que macOS', 'Light': 'Claro', 'Dark': 'Oscuro', 'Language': 'Idioma',
  'Cancel': 'Cancelar', 'Save': 'Guardar',
  'Screenshots stay until you remove them (✕ on a screenshot, or delete the comment).': 'Las capturas se quedan hasta que las quites (✕ en una captura, o borrando el comentario).',
  // projects
  'New project': 'Nuevo proyecto', 'Edit project': 'Editar proyecto', 'Name': 'Nombre', 'Repo folder': 'Carpeta del repo',
  '/Users/you/Code/repo (optional)': '/Users/tu/Code/repo (opcional)', 'Choose…': 'Elegir…',
  'Agents working inside the repo folder pick the project automatically.': 'Los agentes que trabajan dentro de la carpeta del repo eligen el proyecto solos.',
  'Delete': 'Borrar',
  'Give the project a name': 'Ponle nombre al proyecto', 'All': 'Todos', '+ Project': '+ Proyecto', 'Edit name, folder and color': 'Editar nombre, carpeta y color',
  'No project': 'Sin proyecto', 'no project': 'sin proyecto', 'New comment on': 'Nuevo comentario en', 'New comment,': 'Nuevo comentario,',
  // the board
  'On your mind': 'En tu cabeza', 'Write it down and a monkey holds it for you.': 'Escríbelo y un mono lo sostiene por ti.', 'Write it down and it waits here for you.': 'Escríbelo y aquí te espera.',
  'To look at': 'Por mirar', 'Let go': 'Soltados',
  'An agent did it. Look it over, then let it go.': 'Un agente lo hizo. Míralo y suéltalo.',
  'Off your mind. The pile grows as the project gets done.': 'Fuera de tu cabeza. La pila crece a medida que avanza el proyecto.',
  'No matches.': 'Sin resultados.', 'Nothing on your mind.': 'Nada en la cabeza.', 'Nothing waiting for you.': 'Nada esperándote.',
  'Drag the monkeys around · click empty space to list what\'s done': 'Arrastra los monos · clic en un espacio vacío para ver lo hecho',
  'Clean the pile: archive the done comments (⌘Z to undo)': 'Limpiar la pila: archiva los comentarios hechos (⌘Z para deshacer)', 'Sweep the pile': 'Barrer la pila',
  'Hide them': 'Ocultarlos', 'Remove': 'Quitar', 'Monkey': 'Mono', 'Double-click to edit': 'Doble clic para editar',
  'The Claude app isn’t installed: click to see how': 'La app de Claude no está instalada: haz clic para ver cómo', 'New session': 'Nueva sesión', 'Ask Claude': 'Pedir a Claude',
  'Mark fixed': 'Marcar arreglado', 'Let it go': 'Soltar', 'Not yet': 'Todavía no', 'Bring back': 'Traer de vuelta', 'Send it back': 'Devolver', 'What’s on your mind?': '¿Qué tienes en la cabeza?', 'Fixed': 'Arreglado', 'Every fix and reopen, oldest first': 'Cada arreglo y reapertura, del más antiguo al más nuevo',
  'What did you change?': '¿Qué cambiaste?', 'What’s still wrong?': '¿Qué sigue mal?', 'Attach screenshots (or paste ⌘V / drop them here)': 'Adjuntar capturas (o pega con ⌘V / suéltalas aquí)',
  'Click to draw on it': 'Haz clic para dibujar en ella', 'Paste or drop screenshots here': 'Pega o suelta capturas aquí', 'Add a note…': 'Agrega una nota…', 'Note': 'Nota',
  'Edit: text, project, where, attachments (e)': 'Editar: texto, proyecto, dónde, adjuntos (e)', 'Copy for an agent': 'Copiar para un agente',
  'URL or file:line': 'URL o archivo:línea', 'Email, Slack…': 'Correo, Slack…', 'Attach files (or paste ⌘V / drop them on the card)': 'Adjuntar archivos (o pega con ⌘V / suéltalos en la tarjeta)',
  '⌘↵ save · esc cancel': '⌘↵ guardar · esc cancelar', 'Kept open: click so it slides away when you leave it': 'Se queda abierto: haz clic para que se esconda al salir',
  // toasts
  'Nothing changed': 'Nada cambió', 'Saved · ⌘Z to undo': 'Guardado · ⌘Z para deshacer', 'Saved': 'Guardado', 'The pile is already clean': 'La pila ya está limpia',
  'Nothing to undo': 'Nada que deshacer', 'Nothing to redo': 'Nada que rehacer', 'Copied for an agent': 'Copiado para un agente', 'Copy failed': 'No se pudo copiar',
  'Add a short note on what changed': 'Agrega una nota corta sobre lo que cambió', 'Nothing to attach there': 'Nada que adjuntar ahí',
  'Added to the comment you’re editing': 'Agregado al comentario que estás editando', 'Screenshot added': 'Captura agregada',
  'Screenshot added — write a note and Hang': 'Captura agregada: escribe una nota y Colgar', 'Screenshot attached': 'Captura adjuntada', 'No screenshot taken': 'No se tomó ninguna captura',
  'Screenshots are kept until you delete them': 'Las capturas se guardan hasta que las borres', 'Automatic clean-up is off': 'La limpieza automática está apagada',
  'Only cards to look at can be let go': 'Solo se pueden soltar las tarjetas por mirar', 'Already let go': 'Ya está soltado',
  'Only open cards can be marked fixed': 'Solo las tarjetas abiertas se pueden marcar arregladas', 'It’s already open': 'Ya está abierto',
  'That comment': 'Ese comentario',
  // the monkeys
  'Ship it!': '¡Publícalo!', 'Who wrote this?': '¿Quién escribió esto?', 'Is it Friday?': '¿Ya es viernes?', 'Hang in there.': 'Aguanta.', 'Fixed? Fixed.': '¿Arreglado? Arreglado.',
  'I only work for bananas.': 'Solo trabajo por bananos.', 'Have you tried turning it off and on?': '¿Probaste apagarlo y prenderlo?', 'Works on my branch.': 'En mi rama funciona.',
  '*scratches head*': '*se rasca la cabeza*', 'Mark me fixed!': '¡Márcame arreglado!', 'FINE. Take it.': 'BUENO. Tómalo.', 'Stop it…': 'Ya basta…',
  '🐒 Barrel of monkeys!': '🐒 ¡Barril de monos!', '🍌🍌🍌 That’s a lot of bananas.': '🍌🍌🍌 Son muchos bananos.',
  // drawing
  'Pen': 'Lápiz', 'Arrow': 'Flecha', 'Box': 'Recuadro', 'Highlighter': 'Resaltador', 'Text': 'Texto', 'Color': 'Color', 'Undo (⌘Z)': 'Deshacer (⌘Z)', 'Undo': 'Deshacer',
  'Attach': 'Adjuntar', 'Draw on it, then Attach · Esc cancels · ⌘Z undoes': 'Dibuja y luego Adjuntar · Esc cancela · ⌘Z deshace', 'Type, then Enter': 'Escribe y luego Enter',
  'Draw on the screenshot': 'Dibuja en la captura',
};

// the tabs say what's in them; the same word on a card is an action
const CONTEXT = [['#states', { 'On your mind': 'En tu cabeza', 'To look at': 'Por mirar', 'Let go': 'Soltados' }]];

const EVENTS = { created: 'creado', fixed: 'arreglado', reopened: 'reabierto', done: 'aprobado', note: 'nota', attached: 'adjunto', edited: 'editado', archived: 'archivado', restored: 'restaurado' };
const LABELS = { 'On your mind': 'En tu cabeza', 'To look at': 'Por mirar', 'Let go': 'Soltados' };
const who = (s) => (s === 'you' ? 'ti' : s);
const thing = (s) => ES[s] || s;   // "That comment", "no project"
const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;

const PATTERNS = [
  [/^Fixed(?: by (.+?))? · (.+)$/, (m, by, at) => `Arreglado${by ? ` por ${who(by)}` : ''} · ${at}`],
  [/^↩ Reopened(?: by (.+?))? · (.+)$/, (m, by, at) => `↩ Reabierto${by ? ` por ${who(by)}` : ''} · ${at}`],
  [/^(created|fixed|reopened|done|note|attached|edited|archived|restored)(?: by (.+))?$/, (m, e, by) => `${EVENTS[e]}${by ? ` por ${who(by)}` : ''}`],
  [/^(\d+) let go · (\d+)%$/, (m, n, p) => `${n} ${n === '1' ? 'soltado' : 'soltados'} · ${p} %`],
  [/^Show all (\d+)$/, (m, n) => `Ver los ${n}`],
  [/^(.*?) · double-click to edit$/, (m, p) => `${p} · doble clic para editar`],
  [/^What’s on your mind about (.+)\?$/, (m, p) => `¿Qué tienes en la cabeza sobre ${p}?`],
  [/^Hang a new comment… \(paste or drop screenshots\)$/, () => 'Cuelga un comentario nuevo… (pega o suelta capturas)'],
  [/^Hang it on (.+) \(⌘↵\)$/, (m, p) => `Colgarlo ${p === 'no project' ? 'sin proyecto' : `en ${p}`} (⌘↵)`],
  [/^Hang it \(⌘↵\)$/, () => 'Colgarlo (⌘↵)'],
  [/^Open (.+) in your editor$/, (m, f) => `Abrir ${f} en tu editor`],
  [/^Open a new Claude Code session in the Claude app, in (.+), to fix this$/, (m, f) => `Abrir una sesión nueva de Claude Code en la app de Claude, en ${f === 'the folder its location is in' ? 'la carpeta donde está su ubicación' : f}, para arreglar esto`],
  [/^Open (https?:\/\/.+)$/, (m, u) => `Abrir ${u}`],
  [/^Claude session opened in the Claude app · (.+) · (.+)$/, (m, f, at) => `Sesión de Claude abierta en la app de Claude · ${f} · ${at}`],
  [/^Claude session opened for (.+)$/, (m, n) => `Sesión de Claude abierta para ${thing(n)}`],
  [/^(.+) was marked fixed$/, (m, n) => `${thing(n)} se marcó como arreglado`],
  [/^(.+) was approved$/, (m, n) => `${thing(n)} se aprobó`],
  [/^(.+) was reopened$/, (m, n) => `${thing(n)} se reabrió`],
  [/^(.+) is ready to look at$/, (m, n) => `${thing(n)} está listo para mirar`],
  [/^Let go of (.+)$/, (m, n) => `Soltaste ${thing(n)}`],
  [/^(“.+”|That comment) reopened$/, (m, n) => `${thing(n)} se reabrió`],
  [/^Cleaned the pile: (\d+) archived · ⌘Z to undo$/, (m, n) => `Pila limpia: ${plural(n, 'archivado', 'archivados')} · ⌘Z para deshacer`],
  [/^Undo: edit of (.+)$/, (m, n) => `Deshecho: edición de ${thing(n)}`],
  [/^Undo: (\d+) back on the pile$/, (m, n) => `Deshecho: ${n} de vuelta en la pila`],
  [/^Undo: (.+) back to (On your mind|To look at|Let go)$/, (m, n, l) => `Deshecho: ${thing(n)} de vuelta a ${LABELS[l]}`],
  [/^Redo: edit of (.+)$/, (m, n) => `Rehecho: edición de ${thing(n)}`],
  [/^Redo: cleaned (\d+) off the pile$/, (m, n) => `Rehecho: ${n} fuera de la pila`],
  [/^Redo: (.+) to (On your mind|To look at|Let go)$/, (m, n, l) => `Rehecho: ${thing(n)} a ${LABELS[l]}`],
  [/^Opened (.+)$/, (m, f) => `Abierto ${f}`],
  [/^Attached (\d+) to (.+)$/, (m, k, n) => `${plural(k, 'adjunto', 'adjuntos')} a ${thing(n)}`],
  [/^Hung (.+) on (.+)$/, (m, n, p) => `Colgado ${thing(n)} ${p === 'no project' ? 'sin proyecto' : `en ${p}`}`],
  [/^Done comments now leave the pile (\d+) days? after approving$/, (m, n) => `Los comentarios hechos ahora salen de la pila ${plural(n, 'día', 'días')} después de aprobarlos`],
  [/^Couldn't take a screenshot: (.+)$/, (m, e) => `No se pudo tomar la captura: ${e}`],
  [/^(\d+) files? added to a new comment$/, (m, n) => `${plural(n, 'archivo agregado', 'archivos agregados')} a un comentario nuevo`],
  [/^Can't read (.+)$/, (m, f) => `No se puede leer ${f === 'that file' ? 'ese archivo' : f}`],
  [/^(Pen|Arrow|Box|Highlighter|Text) \((\w)\)$/, (m, n, k) => `${ES[n]} (${k})`],
  [/^Color (#\w+)$/, (m, c) => `Color ${c}`],
];

/** The Spanish for an English text, or null when there's none. */
function spanish(text, el) {
  for (const [sel, map] of CONTEXT) if (map[text] && el?.closest?.(sel)) return map[text];
  if (Object.hasOwn(ES, text)) return ES[text];
  for (const [re, fn] of PATTERNS) { const m = text.match(re); if (m) return fn(...m); }
  return null;
}

/** For code: confirm(), alert(), and text that's stored. `{name}` takes vars.name. */
export function t(text, vars = {}) {
  const out = lang === 'es' ? (DIALOGS[text] ?? spanish(text) ?? text) : text;
  return out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const DIALOGS = {
  'The Claude app isn’t installed.\n\nGet it at https://claude.com/download, sign in, then reload GoodComments.':
    'La app de Claude no está instalada.\n\nDescárgala en https://claude.com/download, inicia sesión y vuelve a cargar GoodComments.',
  'Open a new Claude Code session for {name}?\n\nIt opens in the Claude app, in {where}, with the comment as its task: send it, then watch and steer it. It moves the card to To look at when it’s done.':
    '¿Abrir una sesión nueva de Claude Code para {name}?\n\nSe abre en la app de Claude, en {where}, con el comentario como tarea: envíala y luego síguela y guíala. Pasa la tarjeta a Por mirar cuando termine.',
  'Remove this attachment?': '¿Quitar este adjunto?',
  'Delete {name}? This can\'t be undone.': '¿Borrar {name}? No se puede deshacer.',
  'Delete project “{name}”? Its comments stay, without a project.': '¿Borrar el proyecto “{name}”? Sus comentarios se quedan, sin proyecto.',
  'This deletes {n} screenshots right away, {rule}.\n\nThey can’t be brought back.': 'Esto borra {n} capturas ahora mismo, {rule}.\n\nNo se pueden recuperar.',
  'This deletes {n} screenshot right away, {rule}.\n\nThey can’t be brought back.': 'Esto borra {n} captura ahora mismo, {rule}.\n\nNo se puede recuperar.',
  'See screenshot': 'Ver captura', 'Screenshot': 'Captura',
};

// ---------- relative times ----------
/** "now", "5m", "3h", "2d" (or "ahora", "5 min"…) */
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  const es = lang === 'es';
  if (s < 45) return es ? 'ahora' : 'now';
  if (s < 3600) return `${Math.round(s / 60)}${es ? ' min' : 'm'}`;
  if (s < 86400) return `${Math.round(s / 3600)}${es ? ' h' : 'h'}`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}${es ? ' d' : 'd'}`;
  return new Date(iso).toLocaleDateString(lang, { month: 'short', day: 'numeric' });
}

// ---------- translating the page ----------
// what people wrote: never translated
const THEIRS = '.body, .note, .n, .where, .src, .fix-text, .name, code, pre, textarea, [translate="no"]';
const ATTRS = ['title', 'placeholder', 'aria-label'];

function swapText(node) {
  const raw = node.nodeValue;
  const text = raw.trim();
  if (!text || !/[A-Za-z]/.test(text)) return;
  const el = node.parentElement;
  if (!el || el.closest(THEIRS) || el.closest('script, style')) return;
  if (el.closest('div.fix') && !el.closest('.who')) return;   // a fix note sits right inside .fix
  const es = spanish(text, el);
  if (es != null && es !== text) node.nodeValue = raw.replace(text, es);
}

function swapAttrs(el) {
  if (el.closest(THEIRS) && !el.matches('textarea')) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || !/[A-Za-z]/.test(v)) continue;
    const es = spanish(v.trim(), el);
    if (es != null && es !== v) el.setAttribute(a, es);
  }
}

function translate(root) {
  if (root.nodeType === Node.TEXT_NODE) return swapText(root);
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) swapAttrs(root);
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeType === Node.TEXT_NODE ? swapText(n) : swapAttrs(n);
}

if (lang === 'es') {
  const start = () => {
    document.title = spanish(document.title) || document.title;
    translate(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'childList') m.addedNodes.forEach(translate);
        else if (m.type === 'characterData') swapText(m.target);
        else if (m.type === 'attributes') swapAttrs(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
}
