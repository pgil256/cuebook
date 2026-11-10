// Left pane: shows the script (PDF, Word or text) for reading along.

import { h, debounce } from './util.js';
import { icon } from './icons.js';

const api = window.cuebook;
const PDF_BASE = '/node_modules/pdfjs-dist/';

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ||= import(PDF_BASE + 'build/pdf.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDF_BASE + 'build/pdf.worker.mjs';
    return m;
  });
  return pdfjsPromise;
}

const ALLOWED_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUP', 'SUB', 'BR',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'BLOCKQUOTE', 'PRE', 'CODE', 'IMG']);

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
        const keep = attr.name === 'colspan' || attr.name === 'rowspan'
          || (child.tagName === 'IMG' && ((attr.name === 'src' && attr.value.startsWith('data:image/')) || attr.name === 'alt'));
        if (!keep) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

export class ScriptView {
  constructor(root, { onPick, mediaUrl }) {
    this.root = root;
    this.onPick = onPick;
    this.mediaUrl = mediaUrl;
    this.kind = null; // 'pdf' | 'text' | null
    this.pages = [];
    this.loadToken = 0;

    this.nameEl = h('span', { class: 'pane-sub' });
    this.pickLabel = h('span', { text: 'Add script…' });
    this.content = h('div', { class: 'script-content' });
    this.scroll = h('div', { class: 'script-scroll hidden' }, this.content);
    this.empty = h('div', { class: 'pane-empty' },
      h('div', { class: 'dropzone' },
        icon('file', 'big'),
        h('h3', { text: 'Drop your script here' }),
        h('p', { text: 'PDF, Word (.docx) or a text file.' }),
        h('button', { class: 'btn primary', onclick: () => this.onPick() }, icon('file'), h('span', { text: 'Choose a file…' }))));
    this.status = h('div', { class: 'pane-status hidden' });
    root.append(
      h('div', { class: 'pane-toolbar' },
        h('span', { class: 'pane-label', text: 'Script' }), this.nameEl, h('div', { class: 'spacer' }),
        h('button', { class: 'tb-btn', title: 'Choose a script file', onclick: () => this.onPick() }, icon('file'), this.pickLabel)),
      h('div', { class: 'pane-body', dataset: { drop: 'Drop a script here: PDF, Word or text' } }, this.scroll, this.empty, this.status));

    this._relayout = debounce(() => this.layout(), 100);
    new ResizeObserver(() => this._relayout()).observe(this.root);
  }

  /** Show `script` ({ file, type, name }) or nothing. */
  async load(script) {
    const token = ++this.loadToken;
    this._clear();
    this.nameEl.textContent = script ? script.name || script.file.split('/').pop() : '';
    this.pickLabel.textContent = script ? 'Change script…' : 'Add script…';
    this.empty.classList.toggle('hidden', !!script);
    if (!script) return;
    this._status('Loading script…');
    try {
      if (script.type === 'pdf') await this._loadPdf(script, token);
      else await this._loadText(script, token);
      if (token !== this.loadToken) return;
      this.scroll.classList.remove('hidden');
      this.scroll.scrollTop = 0;
      this.layout();
      this._status(null);
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error(err);
      this._clear();
      this._status(`The script couldn't be shown: ${err.message || err}`, true);
    }
  }

  _status(text, isError = false) {
    this.status.textContent = text || '';
    this.status.classList.toggle('hidden', !text);
    this.status.classList.toggle('error', isError);
  }

  _clear() {
    if (this.io) { this.io.disconnect(); this.io = null; }
    for (const p of this.pages) { try { if (p.task) p.task.cancel(); } catch { /* ignore */ } }
    if (this.pdfTask) { this.pdfTask.destroy().catch(() => {}); this.pdfTask = null; }
    this.pages = [];
    this.kind = null;
    this.content.innerHTML = '';
    this.scroll.classList.add('hidden');
    this._status(null);
  }

  async _loadPdf(script, token) {
    const pdfjs = await loadPdfjs();
    const res = await fetch(this.mediaUrl(script.file));
    if (!res.ok) throw new Error('the file is missing from the show folder');
    const task = pdfjs.getDocument({
      data: new Uint8Array(await res.arrayBuffer()),
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
    this.kind = 'pdf';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      if (token !== this.loadToken) return;
      const vp = page.getViewport({ scale: 1 });
      const el = h('div', { class: 'pdf-page', dataset: { i: String(i - 1) } });
      this.pages.push({ page, w: vp.width, h: vp.height, el, canvas: null, renderedWidth: 0, task: null, visible: false });
      this.content.append(el);
    }
    // Only draw pages near the screen, so long scripts stay light.
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const p = this.pages[Number(en.target.dataset.i)];
        if (!p) continue;
        p.visible = en.isIntersecting;
        if (p.visible) this._renderPage(p); else this._releasePage(p);
      }
    }, { root: this.scroll, rootMargin: '1500px 0px' });
    for (const p of this.pages) this.io.observe(p.el);
  }

  async _loadText(script, token) {
    const paper = h('div', { class: `text-paper ${script.type}` });
    if (script.type === 'docx') paper.innerHTML = sanitize(await api.docxToHtml(script.file));
    else paper.textContent = (await api.readScriptText(script.file)).replace(/\r\n?/g, '\n');
    if (token !== this.loadToken) return;
    if (!paper.textContent.trim() && !paper.querySelector('img')) throw new Error('it appears to be empty');
    this.kind = 'text';
    this.content.append(paper);
  }

  /** Fit PDF pages to the pane width. */
  layout() {
    if (this.kind !== 'pdf') return;
    const width = Math.max(240, this.scroll.clientWidth - 48);
    for (const p of this.pages) {
      p.cssW = width;
      p.el.style.width = `${width}px`;
      p.el.style.height = `${Math.round(width * (p.h / p.w))}px`;
      if (p.visible) this._renderPage(p);
    }
  }

  async _renderPage(p) {
    const cssW = p.cssW;
    if (!cssW || p.renderedWidth === cssW || p.rendering === cssW) return;
    p.rendering = cssW;
    if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = p.page.getViewport({ scale: (cssW * dpr) / p.w });
    const canvas = h('canvas', { class: 'pdf-canvas' });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = p.page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
    p.task = task;
    try {
      await task.promise;
      if (p.rendering !== cssW || !p.visible) return;
      if (p.canvas) p.canvas.replaceWith(canvas); else p.el.append(canvas);
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
}
