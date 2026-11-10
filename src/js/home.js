// Start screen: make a new show, open one, or pick a recent show.

import { h } from './util.js';
import { icon } from './icons.js';

const api = window.cuebook;

export class Home {
  constructor(root, { onOpen, toast }) {
    this.root = root;
    this.onOpen = onOpen;
    this.toast = toast;
    this.parentDir = '';
    // Dropping a show folder (or its show.cuebook file) here opens it.
    root.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      const p = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).find(Boolean);
      if (p) this._open(() => api.openShow(p));
    });
  }

  async render() {
    if (!this.parentDir) {
      try { this.parentDir = await api.defaultShowParent(); } catch { this.parentDir = ''; }
    }
    let recent = [];
    try { recent = await api.recentShows(); } catch { /* none */ }

    const nameIn = h('input', { type: 'text', placeholder: 'e.g. Our Town', class: 'big-input', spellcheck: false });
    const locEl = h('span', { class: 'loc-path', text: this.parentDir, title: this.parentDir });
    const create = async () => {
      const name = nameIn.value.trim();
      if (!name) { nameIn.focus(); this.toast('Type a name for the show first.', 'warn'); return; }
      await this._open(() => api.createShow(name, this.parentDir));
    };
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    const changeLoc = async () => {
      const d = await api.pickFolder(this.parentDir).catch(() => null);
      if (d) { this.parentDir = d; locEl.textContent = d; locEl.title = d; }
    };

    const recentList = recent.length
      ? h('div', { class: 'recent-list' }, recent.map((r) => h('div', { class: `recent-item ${r.missing ? 'missing' : ''}` },
        h('button', { class: 'recent-open', disabled: r.missing, title: r.dir, onclick: () => this._open(() => api.openShow(r.dir)) },
          icon('folder'),
          h('span', { class: 'recent-text' }, h('span', { class: 'recent-name', text: r.name }),
            h('span', { class: 'recent-dir', text: r.missing ? `Not found: ${r.dir}` : r.dir }))),
        h('button', { class: 'tb-btn icon-only', title: 'Remove from this list (the show itself is not deleted)', onclick: async () => { await api.forgetRecent(r.dir); this.render(); } }, icon('close')))))
      : h('p', { class: 'muted', text: 'Shows you open will appear here.' });

    this.root.innerHTML = '';
    this.root.append(h('div', { class: 'home-wrap' },
      h('div', { class: 'home-brand' }, h('span', { class: 'brand-mark big' }), h('h1', { text: 'Cuebook' })),
      h('p', { class: 'home-tag', text: 'Your script on the left, your music on the right.' }),
      h('div', { class: 'home-grid' },
        h('section', { class: 'home-card' },
          h('h2', { text: 'New show' }),
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Show name' }), nameIn),
          h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Saved in' }),
            h('div', { class: 'loc-row' }, icon('folder'), locEl, h('button', { class: 'btn small', onclick: changeLoc }, 'Change…'))),
          h('button', { class: 'btn primary big', onclick: create }, icon('plus'), h('span', { text: 'Create show' }))),
        h('section', { class: 'home-card' },
          h('div', { class: 'card-head' }, h('h2', { text: 'Open a show' }),
            h('button', { class: 'btn', onclick: () => this._open(() => api.openShowDialog()) }, icon('folder'), h('span', { text: 'Browse…' }))),
          recentList))));
    requestAnimationFrame(() => nameIn.focus());
  }

  async _open(fn) {
    try {
      const res = await fn();
      if (res) await this.onOpen(res);
    } catch (err) {
      this.toast(err.message, 'error');
    }
  }
}
