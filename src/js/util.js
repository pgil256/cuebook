// Small shared helpers: DOM building, formatting, dB maths, cue numbering.

/**
 * Create an element. `props` may contain: class, text, html, style (object),
 * dataset (object), on* handlers, and any other attribute/property.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function uid(prefix = 'c') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function dbToGain(db) { return db <= -60 ? 0 : Math.pow(10, db / 20); }

export function formatDb(db) {
  if (db <= -60) return '−∞ dB';
  const s = (Math.round(db * 10) / 10).toFixed(1);
  return `${db > 0 ? '+' : ''}${s.replace('-', '−')} dB`;
}

/** 83.4 -> "1:23" ; with tenths -> "1:23.4" */
export function formatTime(sec, tenths = false) {
  if (!isFinite(sec)) return '∞';
  const neg = sec < 0;
  sec = Math.abs(sec);
  let m = Math.floor(sec / 60);
  let s = sec - m * 60;
  let out;
  if (tenths) {
    let t = Math.floor(s * 10) / 10;
    out = `${m}:${t < 10 ? '0' : ''}${t.toFixed(1)}`;
  } else {
    s = Math.floor(s);
    out = `${m}:${s < 10 ? '0' : ''}${s}`;
  }
  return (neg ? '−' : '') + out;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- cue numbering ----------

function num(n) {
  const v = parseFloat(n);
  return Number.isFinite(v) && /^\s*-?\d+(\.\d+)?\s*$/.test(String(n)) ? v : null;
}

function fmtNum(v) {
  return String(Math.round(v * 10000) / 10000);
}

/**
 * Pick a cue number that sorts between `prev` and `next` (either may be
 * missing), the way stage managers do it: 3 between 2 and 4, 2.5 between
 * 2 and 3, 2.3 between 2 and 2.5.
 */
export function numberBetween(prev, next, taken = new Set()) {
  const a = num(prev);
  const b = num(next);
  const ok = (v) => !taken.has(fmtNum(v));
  if (a === null && b === null) {
    for (let i = 1; ; i++) if (ok(i)) return fmtNum(i);
  }
  if (b === null) {
    for (let i = Math.floor(a) + 1; ; i++) if (ok(i)) return fmtNum(i);
  }
  const lo = a === null ? 0 : a;
  if (b - lo > 1 && Math.floor(lo) + 1 < b && ok(Math.floor(lo) + 1)) return fmtNum(Math.floor(lo) + 1);
  for (let d = 1; d <= 4; d++) {
    const f = Math.pow(10, d);
    const mid = Math.round(((lo + b) / 2) * f) / f;
    if (mid > lo && mid < b && ok(mid)) return fmtNum(mid);
  }
  return fmtNum(lo + (b - lo) / 2);
}

export function compareAnchors(a, b) {
  return (a.b - b.b) || (a.y - b.y);
}

export function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

export function extname(p) {
  const m = /\.[^.\\/]+$/.exec(String(p));
  return m ? m[0].toLowerCase() : '';
}

export const AUDIO_EXT = ['.mp3', '.wav', '.wave', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.aif', '.aiff', '.webm'];
export const SCRIPT_EXT = ['.pdf', '.docx', '.txt', '.text', '.md', '.fountain'];

export const isAudioPath = (p) => AUDIO_EXT.includes(extname(p));
export const isScriptPath = (p) => SCRIPT_EXT.includes(extname(p));
