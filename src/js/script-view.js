// Left pane: the script, rendered from PDF / Word / text, with cue markers
// pinned to positions in it like pencil marks in a prompt book.
//
// A position ("anchor") is { b, y }: block index + fraction down that block.
// Blocks are PDF pages, or paragraphs / lines / table rows for text scripts,
// so markers stay attached to the right words when the pane is resized.

import { h, clamp, debounce, isAudioPath, isScriptPath } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { mediaUrl } from './audio.js';

const api = window.cuebook;
const PDF_BASE = '/node_modules/pdfjs-dist/';
const GUTTER = 76;     // left margin that holds the cue tags
const PAD_RIGHT = 20;
const MAX_TEXT_WIDTH = 820;

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ||= import(PDF_BASE + 'build/pdf.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDF_BASE + 'build/pdf.worker.mjs';
    return m;
  });
  return pdfjsPromise;
}

const ALLOWED_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUP', 'SUB', 'BR',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'BLOCKQUOTE', 'PRE', 'CODE', 'IMG', 'A']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'DIV', 'BLOCKQUOTE', 'PRE']);
const CONTAINER_TAGS = new Set(['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'DIV', 'BLOCKQUOTE']);

/** Keep only harmless formatting from converted Word documents. */
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  const walk = (el) => {
    for (const child of [...el.children]) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META'].includes(child.tagName)) child.remove();
        else { walk(child); child.replaceWith(...child.childNodes); }
        continue;
      }
      for (const attr of [...child.attributes]) {
        const keep = (attr.name === 'colspan' || attr.name === 'rowspan')
          || (child.tagName === 'IMG' && ((attr.name === 'src' && attr.value.startsWith('data:image/')) || attr.name === 'alt'));
        if (!keep) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

function collectBlocks(root) {
  const out = [];
  const walk = (el) => {
    for (const child of el.children) {
      const hasBlockKids = [...child.children].some((k) => BLOCK_TAGS.has(k.tagName));
      if (CONTAINER_TAGS.has(child.tagName) && hasBlockKids) walk(child);
      else out.push(child);
    }
  };
  walk(root);
  return out;
}

export class ScriptView {
  constructor(root, { player, actions, toast }) {
    this.root = root;
    this.player = player;
    this.actions = actions;
    this.toast = toast;
    this.kind = null;      // 'pdf' | 'html' | null
    this.blocks = [];      // block elements
    this.geo = [];         // { top, height } per block, relative to the doc
    this.pages = [];       // pdf: { page, w, h, el, canvas, renderedWidth, task, visible }
    this.pdf = null;
    this.loadToken = 0;
    this.pinCueId = null;
    this.loadedFile = null;
    this._markerEls = new Map();
    this._build();
    this._relayout = debounce(() => this.layout(), 120);
    this._remeasure = debounce(() => this.measure(), 60);
    new ResizeObserver(() => this._relayout()).observe(this.scroll);
    // Content height can change on its own (fonts, images in Word docs).
    new ResizeObserver(() => { if (this.kind) this._remeasure(); }).observe(this.pagesEl);
  }

  // ---------- DOM ----------

  _build() {
    const zoomLabel = h('span', { class: 'zoom-label', text: '100%' });
    this.zoomLabel = zoomLabel;
    this.titleEl = h('div', { class: 'pane-title-name' });
    this.toolbar = h('div', { class: 'pane-toolbar' },
      h('div', { class: 'pane-title' }, h('span', { class: 'pane-label', text: 'Script' }), this.titleEl),
      h('div', { class: 'spacer' }),
      h('button', { class: 'tb-btn edit-only', title: 'Import a script (PDF, Word or text)', onclick: () => this.actions.importScriptDialog() }, icon('file'), h('span', { text: 'Import' })),
      h('button', { class: 'tb-btn edit-only', title: 'Paste the script as text', onclick: () => this.actions.pasteScript() }, icon('paste'), h('span', { text: 'Paste' })),
      h('div', { class: 'tb-sep edit-only' }),
      h('button', { class: 'tb-btn icon-only', title: 'Zoom out', onclick: () => this.zoomBy(-0.1) }, icon('zoomOut')),
      h('button', { class: 'tb-btn zoom-btn', title: 'Fit to width', onclick: () => this.setZoom(1) }, zoomLabel),
      h('button', { class: 'tb-btn icon-only', title: 'Zoom in', onclick: () => this.zoomBy(0.1) }, icon('zoomIn')),
      h('div', { class: 'tb-sep' }),
      this.darkBtn = h('button', { class: 'tb-btn icon-only toggle', title: 'Dim the script pages for a dark booth', onclick: () => store.pref((s) => { s.darkScript = !s.darkScript; }, { view: true }) }, icon('moon')),
      this.followBtn = h('button', { class: 'tb-btn toggle', title: 'Scroll the script to the next cue automatically', onclick: () => store.pref((s) => { s.followScript = !s.followScript; }, { view: true }) }, icon('follow'), h('span', { text: 'Follow' })),
    );

    this.pagesEl = h('div', { class: 'script-pages' });
    this.markerLayer = h('div', { class: 'marker-layer' });
    this.guide = h('div', { class: 'pin-guide hidden' }, h('span', { class: 'pin-guide-tag' }));
    this.doc = h('div', { class: 'script-doc' }, this.pagesEl, this.markerLayer, this.guide);
    this.scroll = h('div', { class: 'script-scroll' }, this.doc);
    this.banner = h('div', { class: 'pin-banner hidden' });
    this.dropHint = h('div', { class: 'drop-hint hidden' });
    this.empty = h('div', { class: 'script-empty' });
    this.root.append(this.toolbar, h('div', { class: 'script-body' }, this.scroll, this.empty, this.banner, this.dropHint));

    this.scroll.addEventListener('click', (e) => this._onClick(e));
    this.scroll.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.scroll.addEventListener('pointerleave', () => { if (!this._dragMarker) this._hideGuide(); });
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey) { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 0.1 : -0.1); }
    }, { passive: false });
    this.markerLayer.addEventListener('pointerdown', (e) => this._onMarkerDown(e));
    this.markerLayer.addEventListener('dblclick', (e) => {
      const pin = e.target.closest('.pin');
      if (pin) this.player.setStandby(pin.dataset.id);
    });

    const body = this.root.querySelector('.script-body');
    body.addEventListener('dragover', (e) => this._onDragOver(e));
    body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) this._endDragUi(); });
    body.addEventListener('drop', (e) => this._onDrop(e));
    this.renderEmpty();
  }

  renderEmpty(message) {
    this.empty.innerHTML = '';
    if (message) {
      this.empty.append(h('div', { class: 'empty-card error' }, icon('warn', 'big'), h('h3', { text: 'The script could not be shown' }), h('p', { text: message })));
      return;
    }
    if (store.editing) {
      this.empty.append(h('div', { class: 'empty-card dropzone' },
        icon('file', 'big'),
        h('h3', { text: 'Drop the script here' }),
        h('p', { text: 'PDF, Word (.docx) or plain text. It gets copied into the show folder.' }),
        h('div', { class: 'empty-actions' },
          h('button', { class: 'btn primary', onclick: () => this.actions.importScriptDialog() }, icon('file'), h('span', { text: 'Choose a file…' })),
          h('button', { class: 'btn', onclick: () => this.actions.pasteScript() }, icon('paste'), h('span', { text: 'Paste text…' })))));
    } else {
      this.empty.append(h('div', { class: 'empty-card' }, icon('file', 'big'), h('h3', { text: 'No script loaded' }), h('p', { text: 'Switch to Edit mode to add one.' })));
    }
  }

  // ---------- loading ----------

  /** Load (or clear) the script. Asking for the file already being shown/loaded is a no-op. */
  load(script, { force = false } = {}) {
    const file = script ? script.file : null;
    if (!force && this._loadPromise && this._loadingFile === file) return this._loadPromise;
    this._loadingFile = file;
    this._loadPromise = this._load(script).finally(() => {
      if (this.onLoaded) this.onLoaded();
    });
    return this._loadPromise;
  }

  async _load(script) {
    const token = ++this.loadToken;
    this._teardown();
    this.loadedFile = script ? script.file : null;
    this.titleEl.textContent = script ? script.name || script.file.split('/').pop() : '';
    this.root.classList.toggle('has-script', !!script);
    if (!script) { this.renderEmpty(); return; }
    this.empty.innerHTML = '';
    this.root.classList.add('loading');
    try {
      if (script.type === 'pdf') await this._loadPdf(script, token);
      else await this._loadHtml(script, token);
      if (token !== this.loadToken) return;
      this.layout();
      this.applyView();
      requestAnimationFrame(() => this.scrollToCue(this.player.standbyId, false));
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error(err);
      this._teardown();
      this.root.classList.remove('has-script');
      this.renderEmpty(err.message || String(err));
      this._loadPromise = null; // allow a retry of the same file
    } finally {
      if (token === this.loadToken) this.root.classList.remove('loading');
    }
  }

  _teardown() {
    if (this.io) { this.io.disconnect(); this.io = null; }
    for (const p of this.pages) { try { p.task && p.task.cancel(); } catch { /* ignore */ } }
    if (this.pdfTask) { this.pdfTask.destroy().catch(() => {}); this.pdfTask = null; }
    this.pdf = null;
    this.pages = [];
    this.blocks = [];
    this.geo = [];
    this.kind = null;
    this.paper = null;
    this._lastZoom = null;
    this.pagesEl.innerHTML = '';
    this.pagesEl.className = 'script-pages';
    this.markerLayer.innerHTML = '';
    this._markerEls.clear();
  }

  async _loadPdf(script, token) {
    const pdfjs = await loadPdfjs();
    const res = await fetch(mediaUrl(script.file));
    if (!res.ok) throw new Error(`The script file ${script.file} is missing from the show folder.`);
    const data = new Uint8Array(await res.arrayBuffer());
    const task = pdfjs.getDocument({
      data,
      cMapUrl: PDF_BASE + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDF_BASE + 'standard_fonts/',
      wasmUrl: PDF_BASE + 'wasm/',
      iccUrl: PDF_BASE + 'iccs/',
      isEvalSupported: false,
      enableXfa: false,
    });
    const pdf = await task.promise;
    if (token !== this.loadToken) { task.destroy().catch(() => {}); return; }
    this.pdfTask = task;
    this.pdf = pdf;
    this.kind = 'pdf';
    this.pagesEl.classList.add('pdf');
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      if (token !== this.loadToken) return;
      const vp = page.getViewport({ scale: 1 });
      const el = h('div', { class: 'pdf-page', dataset: { b: String(i - 1) } }, h('div', { class: 'page-num', text: String(i) }));
      this.pages.push({ page, w: vp.width, h: vp.height, el, canvas: null, renderedWidth: 0, task: null, visible: false });
      this.pagesEl.append(el);
    }
    this.blocks = this.pages.map((p) => p.el);
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const p = this.pages[Number(en.target.dataset.b)];
        if (!p) continue;
        p.visible = en.isIntersecting;
        if (p.visible) this._renderPage(p);
        else this._releasePage(p);
      }
    }, { root: this.scroll, rootMargin: '1500px 0px' });
    for (const p of this.pages) this.io.observe(p.el);
  }

  async _loadHtml(script, token) {
    let html;
    if (script.type === 'docx') {
      html = sanitize(await api.docxToHtml(script.file));
    } else {
      const text = await api.readScriptText(script.file);
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const frag = document.createElement('div');
      for (const line of lines) frag.append(h('div', { class: 'line', text: line || ' ' }));
      html = frag.innerHTML;
    }
    if (token !== this.loadToken) return;
    this.kind = 'html';
    const paper = h('div', { class: `text-paper ${script.type}` });
    paper.innerHTML = html;
    if (!paper.textContent.trim()) throw new Error('The script appears to be empty.');
    this.pagesEl.append(paper);
    this.paper = paper;
    this.blocks = collectBlocks(paper);
    this.blocks.forEach((el, i) => { el.dataset.b = String(i); });
  }

  // ---------- layout & rendering ----------

  get zoom() { return clamp(Number(store.show?.settings.scriptZoom) || 1, 0.4, 3); }

  zoomBy(d) { this.setZoom(Math.round((this.zoom + d) * 10) / 10); }

  setZoom(z) {
    store.pref((s) => { s.scriptZoom = clamp(z, 0.4, 3); }, { view: true });
  }

  /** Apply view prefs (zoom, dark pages, follow) and re-layout if needed. */
  applyView() {
    const s = store.show?.settings || {};
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.darkBtn.classList.toggle('on', !!s.darkScript);
    this.followBtn.classList.toggle('on', !!s.followScript);
    this.doc.classList.toggle('dark-page', !!s.darkScript);
    if (this._lastZoom !== this.zoom) { this._lastZoom = this.zoom; this.layout(); }
  }

  layout() {
    if (!this.kind) return;
    const avail = Math.max(240, this.scroll.clientWidth - GUTTER - PAD_RIGHT - 8);
    if (this.kind === 'pdf') {
      const width = Math.round(avail * this.zoom);
      this.doc.style.width = `${width + GUTTER + PAD_RIGHT}px`;
      for (const p of this.pages) {
        p.cssW = width;
        p.cssH = Math.round(width * (p.h / p.w));
        p.el.style.width = `${p.cssW}px`;
        p.el.style.height = `${p.cssH}px`;
        if (p.visible) this._renderPage(p);
      }
    } else {
      const width = Math.min(avail, Math.round(MAX_TEXT_WIDTH * Math.max(1, this.zoom)));
      this.doc.style.width = `${width + GUTTER + PAD_RIGHT}px`;
      this.paper.style.width = `${width}px`;
      this.paper.style.fontSize = `${(16 * this.zoom).toFixed(1)}px`;
    }
    this.measure();
  }

  measure() {
    const docTop = this.doc.getBoundingClientRect().top;
    this.geo = this.blocks.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top - docTop, height: Math.max(1, r.height) };
    });
    this.renderMarkers();
  }

  async _renderPage(p) {
    const cssW = p.cssW;
    if (!cssW || p.renderedWidth === cssW || p.rendering === cssW) return;
    p.rendering = cssW;
    if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = (cssW * dpr) / p.w;
    const viewport = p.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = 'pdf-canvas';
    const task = p.page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
    p.task = task;
    try {
      await task.promise;
      if (p.rendering !== cssW || !p.visible) return;
      if (p.canvas) p.canvas.replaceWith(canvas); else p.el.prepend(canvas);
      p.canvas = canvas;
      p.renderedWidth = cssW;
    } catch (err) {
      if (err && err.name !== 'RenderingCancelledException') console.warn('PDF page render failed', err);
    } finally {
      if (p.rendering === cssW) p.rendering = 0;
      if (p.task === task) p.task = null;
    }
  }

  _releasePage(p) {
    if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } p.task = null; }
    p.rendering = 0;
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
    p.renderedWidth = 0;
  }

  // ---------- anchors & markers ----------

  anchorAt(clientY) {
    if (!this.geo.length) return null;
    const y = clientY - this.doc.getBoundingClientRect().top;
    let lo = 0, hi = this.geo.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.geo[mid].top <= y) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const g = this.geo[idx];
    if (y > g.top + g.height && this.geo[idx + 1]) {
      // In the gap between two blocks: snap to whichever edge is closer.
      const next = this.geo[idx + 1];
      if (next.top - y < y - (g.top + g.height)) return { b: idx + 1, y: 0 };
      return { b: idx, y: 1 };
    }
    return { b: idx, y: Math.round(clamp((y - g.top) / g.height, 0, 1) * 10000) / 10000 };
  }

  anchorTop(anchor) {
    if (!anchor) return null;
    const g = this.geo[anchor.b];
    return g ? g.top + clamp(anchor.y, 0, 1) * g.height : null;
  }

  /** Human description of where a cue is pinned, for the inspector. */
  describeAnchor(anchor) {
    if (!anchor) return 'Not pinned to the script';
    if (!this.kind) return 'Pinned (no script loaded)';
    if (!this.geo[anchor.b]) return 'Pinned outside this script';
    if (this.kind === 'pdf') return `Pinned on page ${anchor.b + 1}, ${Math.round(anchor.y * 100)}% down`;
    const text = (this.blocks[anchor.b].textContent || '').trim();
    return `Pinned at “${text.length > 48 ? text.slice(0, 48) + '…' : text || '(blank line)'}”`;
  }

  isPlaceable(anchor) { return !!(anchor && this.geo[anchor.b]); }

  renderMarkers() {
    const layer = this.markerLayer;
    if (!this.kind) { layer.innerHTML = ''; this._markerEls.clear(); return; }
    const pinned = store.cues
      .map((c, i) => ({ c, i, top: this.anchorTop(c.anchor) }))
      .filter((m) => m.top !== null)
      .sort((a, b) => a.top - b.top || a.i - b.i);
    const keep = new Set();
    let lastTop = -1e9, stack = 0;
    for (const m of pinned) {
      keep.add(m.c.id);
      let el = this._markerEls.get(m.c.id);
      if (!el) {
        el = h('div', { class: 'pin', dataset: { id: m.c.id } },
          h('div', { class: 'pin-line' }),
          h('div', { class: 'pin-tag' }, h('span', { class: 'pin-num' }), h('span', { class: 'pin-name' })));
        this._markerEls.set(m.c.id, el);
        layer.append(el);
      }
      stack = m.top - lastTop < 22 ? stack + 1 : 0;
      lastTop = m.top;
      el.style.top = `${m.top}px`;
      el.style.setProperty('--stack', stack);
      el.querySelector('.pin-num').textContent = `Q${m.c.number || '?'}`;
      el.querySelector('.pin-name').textContent = m.c.name || '';
      el.title = `Cue ${m.c.number}: ${m.c.name}${m.c.notes ? '\n' + m.c.notes : ''}\nDouble-click to make it the next cue`;
    }
    for (const [id, el] of this._markerEls) {
      if (!keep.has(id)) { el.remove(); this._markerEls.delete(id); }
    }
    this.updateMarkerStates();
  }

  /** Cheap per-frame-safe update of standby/playing/selected classes. */
  updateMarkerStates() {
    const playing = new Set();
    for (const e of this.player.active.values()) if (!e.stopping && !e.preview) playing.add(e.cue.id);
    for (const [id, el] of this._markerEls) {
      el.classList.toggle('standby', id === this.player.standbyId);
      el.classList.toggle('playing', playing.has(id));
      el.classList.toggle('selected', store.editing && id === store.selectedId);
      el.classList.toggle('pinning', id === this.pinCueId);
    }
  }

  scrollToCue(id, smooth = true, onlyIfHidden = false) {
    const cue = id && store.cue(id);
    if (!cue || !cue.anchor) return;
    const top = this.anchorTop(cue.anchor);
    if (top === null) return;
    const docOffset = this.doc.offsetTop;
    const y = top + docOffset;
    if (onlyIfHidden) {
      const vis = y > this.scroll.scrollTop + 40 && y < this.scroll.scrollTop + this.scroll.clientHeight - 40;
      if (vis) return;
    }
    this.scroll.scrollTo({ top: Math.max(0, y - this.scroll.clientHeight * 0.3), behavior: smooth ? 'smooth' : 'auto' });
  }

  // ---------- pin mode ----------

  startPinMode(cueId) {
    const cue = store.cue(cueId);
    if (!cue || !store.editing) return;
    if (!this.kind) { this.toast('Load a script first, then pin cues to it.', 'warn'); return; }
    this.pinCueId = cueId;
    this.root.classList.add('pin-mode');
    this.banner.textContent = `Click in the script where cue ${cue.number || ''} “${cue.name}” happens. Esc cancels.`;
    this.banner.classList.remove('hidden');
    this.updateMarkerStates();
  }

  cancelPinMode() {
    if (!this.pinCueId) return false;
    this.pinCueId = null;
    this.root.classList.remove('pin-mode');
    this.banner.classList.add('hidden');
    this._hideGuide();
    this.updateMarkerStates();
    return true;
  }

  _onClick(e) {
    if (!store.editing || !this.kind) return;
    if (e.target.closest('.pin')) return;
    const id = this.pinCueId || (e.altKey ? store.selectedId : null);
    if (!id) return;
    const anchor = this.anchorAt(e.clientY);
    if (!anchor) return;
    this.actions.pinCue(id, anchor);
    this.cancelPinMode();
  }

  _showGuide(clientY, label) {
    const anchor = this.anchorAt(clientY);
    const top = this.anchorTop(anchor);
    if (top === null) return this._hideGuide();
    this.guide.style.top = `${top}px`;
    this.guide.querySelector('.pin-guide-tag').textContent = label || '';
    this.guide.classList.remove('hidden');
  }

  _hideGuide() { this.guide.classList.add('hidden'); }

  _onPointerMove(e) {
    if (this._dragMarker) return;
    if (this.pinCueId || (e.altKey && store.editing && store.selectedId && this.kind)) {
      const cue = store.cue(this.pinCueId || store.selectedId);
      this._showGuide(e.clientY, cue ? `Q${cue.number}` : '');
    } else {
      this._hideGuide();
    }
  }

  _onMarkerDown(e) {
    const pin = e.target.closest('.pin');
    if (!pin || e.button !== 0) return;
    const id = pin.dataset.id;
    if (!store.editing) return;
    e.preventDefault();
    const startY = e.clientY;
    let moved = false;
    const tag = pin.querySelector('.pin-tag');
    tag.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientY - startY) < 4) return;
      moved = true;
      this._dragMarker = true;
      pin.classList.add('dragging');
      const top = this.anchorTop(this.anchorAt(ev.clientY));
      if (top !== null) pin.style.top = `${top}px`;
    };
    const onUp = (ev) => {
      tag.removeEventListener('pointermove', onMove);
      tag.removeEventListener('pointerup', onUp);
      tag.removeEventListener('pointercancel', onUp);
      pin.classList.remove('dragging');
      this._dragMarker = false;
      if (moved) {
        const anchor = this.anchorAt(ev.clientY);
        if (anchor) this.actions.pinCue(id, anchor);
      } else {
        store.select(id);
      }
    };
    tag.addEventListener('pointermove', onMove);
    tag.addEventListener('pointerup', onUp);
    tag.addEventListener('pointercancel', onUp);
  }

  // ---------- drag & drop ----------

  _dragKind(dt) {
    if (!dt) return null;
    const types = [...dt.types];
    if (types.includes('application/x-cuebook-cue')) return 'cue';
    if (!types.includes('Files')) return null;
    const items = [...dt.items].filter((i) => i.kind === 'file');
    if (items.some((i) => i.type.startsWith('audio/') || i.type === 'video/ogg' || i.type === 'video/webm')) return 'audio';
    if (items.some((i) => /pdf|word|officedocument|text\//.test(i.type))) return 'script';
    return 'files';
  }

  _onDragOver(e) {
    const kind = this._dragKind(e.dataTransfer);
    if (!kind) return;
    e.preventDefault();
    if (!store.editing) {
      e.dataTransfer.dropEffect = 'none';
      this._setDropHint('Switch to Edit mode to change the show');
      return;
    }
    e.dataTransfer.dropEffect = kind === 'cue' ? 'move' : 'copy';
    if ((kind === 'cue' || kind === 'audio' || kind === 'files') && this.kind) {
      this._setDropHint(null);
      this._showGuide(e.clientY, kind === 'cue' ? 'Pin here' : 'New cue here');
      if (kind === 'files') this._setDropHint('Sound files become cues pinned here. A script file replaces the script.', true);
    } else if (kind === 'script' || kind === 'files') {
      this._hideGuide();
      this._setDropHint(this.kind ? 'Drop to replace the script' : 'Drop to import this script');
    } else {
      this._hideGuide();
      this._setDropHint('Load a script first, then drop sounds onto it');
    }
  }

  _setDropHint(text, subtle = false) {
    if (!text) { this.dropHint.classList.add('hidden'); return; }
    this.dropHint.textContent = text;
    this.dropHint.classList.toggle('subtle', subtle);
    this.dropHint.classList.remove('hidden');
  }

  _endDragUi() {
    this._hideGuide();
    this._setDropHint(null);
  }

  async _onDrop(e) {
    const kind = this._dragKind(e.dataTransfer);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    this._endDragUi();
    if (!store.editing) { this.toast('Switch to Edit mode to change the show.', 'warn'); return; }
    const anchor = this.kind ? this.anchorAt(e.clientY) : null;
    if (kind === 'cue') {
      const id = e.dataTransfer.getData('application/x-cuebook-cue');
      if (id && anchor) this.actions.pinCue(id, anchor);
      return;
    }
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    const scripts = paths.filter(isScriptPath);
    const audio = paths.filter(isAudioPath);
    if (scripts.length) await this.actions.importScript(scripts[0]);
    if (audio.length) {
      if (!this.kind && !scripts.length) this.toast('Sounds were added to the end of the cue list. Load a script to pin them.', 'info');
      await this.actions.addAudio(audio, { anchor: scripts.length ? null : anchor });
    }
    if (!scripts.length && !audio.length) this.toast('Drop sound files (mp3, wav, m4a…) or a script (PDF, Word, text).', 'warn');
  }
}
