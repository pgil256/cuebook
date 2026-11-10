// Small shared helpers.

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
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const uid = (prefix = 't') => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 83.4 -> "1:23", 3725 -> "1:02:05" */
export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

export const basename = (p) => String(p).split(/[\\/]/).pop();

export function extname(p) {
  const m = /\.[^.\\/]+$/.exec(String(p));
  return m ? m[0].toLowerCase() : '';
}

const AUDIO_EXT = ['.mp3', '.wav', '.wave', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm'];
const SCRIPT_EXT = ['.pdf', '.docx', '.txt', '.text', '.md', '.fountain'];

export const isAudioPath = (p) => AUDIO_EXT.includes(extname(p));
export const isScriptPath = (p) => SCRIPT_EXT.includes(extname(p));
