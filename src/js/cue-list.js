// Right pane, top: the ordered cue list. Double-click jumps the standby,
// drag to reorder or onto the script to pin, drop sound files to add cues.

import { h, formatTime, isAudioPath, compareAnchors } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';

const api = window.cuebook;

export class CueList {
  constructor(root, { player, engine, actions, scriptView, toast }) {
    this.root = root;
    this.player = player;
    this.engine = engine;
    this.actions = actions;
    this.scriptView = scriptView;
    this.toast = toast;
    this.rows = new Map(); // id -> { row, progress, time }
    this._build();
  }

  _build() {
    this.countEl = h('span', { class: 'pane-count' });
    this.sortBtn = h('button', { class: 'tb-btn edit-only', title: 'Reorder pinned cues to match their order in the script', onclick: () => this.actions.sortByScript() }, icon('sort'), h('span', { text: 'Sort by script' }));
    this.toolbar = h('div', { class: 'pane-toolbar' },
      h('div', { class: 'pane-title' }, h('span', { class: 'pane-label', text: 'Cue list' }), this.countEl),
      h('div', { class: 'spacer' }),
      h('button', { class: 'tb-btn edit-only', title: 'Add sound files as new cues', onclick: () => this.actions.addAudioDialog() }, icon('plus'), h('span', { text: 'Sound' })),
      h('button', { class: 'tb-btn edit-only', title: 'Add a cue that fades or stops sounds that are playing', onclick: () => this.actions.addFadeCue() }, icon('fade'), h('span', { text: 'Fade/Stop' })),
      h('div', { class: 'tb-sep edit-only' }),
      this.sortBtn,
      h('button', { class: 'tb-btn edit-only', title: 'Renumber every cue 1, 2, 3…', onclick: () => this.actions.renumber() }, icon('hash'), h('span', { text: 'Renumber' })),
    );
    this.header = h('div', { class: 'cue-header' },
      h('span', { class: 'c-grip' }), h('span', { class: 'c-num', text: 'Cue' }), h('span', { class: 'c-type' }),
      h('span', { class: 'c-main', text: 'Name' }), h('span', { class: 'c-flags' }), h('span', { class: 'c-dur', text: 'Length' }));
    this.list = h('div', { class: 'cue-rows' });
    this.indicator = h('div', { class: 'drop-indicator hidden' });
    this.empty = h('div', { class: 'cue-empty hidden' });
    this.scroll = h('div', { class: 'cue-scroll' }, this.list, this.indicator, this.empty);
    this.root.append(this.toolbar, this.header, this.scroll);

    this.list.addEventListener('click', (e) => {
      const row = e.target.closest('.cue-row');
      if (!row) return;
      if (store.editing) {
        store.select(row.dataset.id);
        this.scriptView.scrollToCue(row.dataset.id, true, true);
      }
    });
    this.list.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.cue-row');
      if (row) this.player.setStandby(row.dataset.id);
    });
    this.list.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.cue-row');
      if (!row || !store.editing) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-cuebook-cue', row.dataset.id);
      e.dataTransfer.effectAllowed = 'copyMove';
      this._dragId = row.dataset.id;
      row.classList.add('dragging');
    });
    this.list.addEventListener('dragend', () => {
      this._dragId = null;
      this.list.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
      this._hideIndicator();
    });
    this.scroll.addEventListener('dragover', (e) => this._onDragOver(e));
    this.scroll.addEventListener('dragleave', (e) => { if (!this.scroll.contains(e.relatedTarget)) this._hideIndicator(); });
    this.scroll.addEventListener('drop', (e) => this._onDrop(e));
  }

  // ---------- rendering ----------

  render() {
    const cues = store.cues;
    this.countEl.textContent = cues.length ? `${cues.length} cue${cues.length === 1 ? '' : 's'}` : '';
    this.list.innerHTML = '';
    this.rows.clear();

    // Flag cues whose pins are out of order relative to the script, and duplicate numbers.
    const outOfOrder = new Set();
    let lastAnchor = null;
    for (const c of cues) {
      if (!c.anchor || !this.scriptView.isPlaceable(c.anchor)) continue;
      if (lastAnchor && compareAnchors(c.anchor, lastAnchor) < 0) outOfOrder.add(c.id);
      lastAnchor = c.anchor;
    }
    this.sortBtn.classList.toggle('attention', outOfOrder.size > 0);
    const counts = new Map();
    for (const c of cues) counts.set(c.number, (counts.get(c.number) || 0) + 1);

    for (const c of cues) {
      const progress = h('div', { class: 'row-progress' });
      const time = h('span', { class: 'c-dur' });
      const flags = h('span', { class: 'c-flags' });
      const sub = h('div', { class: 'c-sub' });
      const row = h('div', { class: 'cue-row', draggable: store.editing ? 'true' : 'false', dataset: { id: c.id } },
        progress,
        h('span', { class: 'c-grip' }, icon('grip')),
        h('span', { class: 'c-num', text: c.number || '–' }),
        h('span', { class: 'c-type' }, icon(c.type === 'fade' ? 'fade' : 'music')),
        h('div', { class: 'c-main' }, h('div', { class: 'c-name', text: c.name || (c.type === 'fade' ? 'Fade' : 'Untitled') }), sub),
        flags,
        time);

      if (c.type === 'audio') {
        if (c.fadeIn > 0) flags.append(icon('fadeIn', 'flag'));
        if (c.fadeOutEnd > 0) flags.append(icon('fade', 'flag'));
        if (c.loop) flags.append(icon('loop', 'flag'));
        if (c.onStart === 'keep') flags.append(h('span', { class: 'flag-text', title: 'Keeps other sounds playing', text: '+' }));
      }
      if (c.follow !== 'none') flags.append(icon('chain', 'flag follow'));
      flags.append(icon(c.anchor ? 'pin' : 'pinOff', c.anchor ? 'flag pinned' : 'flag unpinned'));
      if (outOfOrder.has(c.id)) { row.classList.add('out-of-order'); row.title = 'This cue is pinned earlier in the script than the cue before it.'; }
      if (counts.get(c.number) > 1) row.classList.add('dup-number');

      this.list.append(row);
      this.rows.set(c.id, { row, progress, time, sub, cue: c });

      if (c.follow !== 'none') {
        const text = c.follow === 'end' ? 'then auto-GO when it ends' : `then auto-GO after ${Number(c.followDelay) || 0}s`;
        this.list.append(h('div', { class: 'chain-link' }, icon('chain'), h('span', { text })));
      }
    }

    this.empty.classList.toggle('hidden', cues.length > 0);
    if (!cues.length) {
      this.empty.innerHTML = '';
      this.empty.append(store.editing
        ? h('div', { class: 'empty-card dropzone small' }, icon('music', 'big'), h('h3', { text: 'Drop sound files here' }),
          h('p', { text: 'Or drop them onto the script to pin each cue to its line. Files are copied into the show folder.' }),
          h('div', { class: 'empty-actions' }, h('button', { class: 'btn primary', onclick: () => this.actions.addAudioDialog() }, icon('plus'), h('span', { text: 'Add sounds…' }))))
        : h('div', { class: 'empty-card small' }, h('h3', { text: 'No cues yet' }), h('p', { text: 'Switch to Edit mode to add some.' })));
    }
    this.updateStates();
    this.updateLoadStates();
  }

  /** Standby / selection / playing classes (cheap). */
  updateStates() {
    for (const [id, r] of this.rows) {
      r.row.classList.toggle('standby', id === this.player.standbyId);
      r.row.classList.toggle('selected', store.editing && id === store.selectedId);
    }
  }

  updateLoadStates() {
    for (const [, r] of this.rows) {
      const c = r.cue;
      const st = this.player.fileState(c);
      r.row.classList.toggle('missing', st === 'missing' || st === 'error' || st === 'nofile');
      r.row.classList.toggle('loading', st === 'loading');
      let sub = c.notes || '';
      let subClass = 'note';
      if (st === 'missing') { sub = `Missing file: ${c.file}`; subClass = 'bad'; }
      else if (st === 'error') { sub = this.engine.error(c.file) || 'Could not load'; subClass = 'bad'; }
      else if (st === 'nofile') { sub = 'No sound file'; subClass = 'bad'; }
      else if (c.type === 'fade') sub = c.notes || this._fadeSummary(c);
      r.sub.textContent = sub;
      r.sub.className = `c-sub ${subClass}`;
      r.time.textContent = this._lengthText(c);
    }
  }

  _fadeSummary(c) {
    const target = c.target === 'all' ? 'all sound' : `Q${store.cue(c.target)?.number ?? '?'}`;
    return c.action === 'level' ? `Fade ${target} to ${c.levelDb} dB over ${c.duration}s` : `Fade out ${target} over ${c.duration}s`;
  }

  _lengthText(c) {
    if (c.type === 'fade') return `${Number(c.duration) || 0}s`;
    const d = this.engine.duration(c.file);
    if (d == null) return '';
    const start = Math.max(0, Number(c.trimStart) || 0);
    const end = c.trimEnd == null || c.trimEnd === '' ? d : Math.min(d, Number(c.trimEnd));
    const len = Math.max(0, end - start);
    return c.loop ? `↻ ${formatTime(len)}` : formatTime(len);
  }

  /** Called every animation frame: progress bars for playing cues. */
  updateLive() {
    const byCue = new Map();
    for (const e of this.player.active.values()) {
      if (e.stopping) continue;
      let p = 0;
      if (e.voice) p = e.voice.progress;
      else if (e.kind === 'fade' && e.duration > 0) p = Math.min(1, (performance.now() - e.startedAt) / (e.duration * 1000));
      byCue.set(e.cue.id, Math.max(byCue.get(e.cue.id) || 0, p));
    }
    for (const [id, r] of this.rows) {
      const p = byCue.get(id);
      const playing = p !== undefined;
      if (r._playing !== playing) { r.row.classList.toggle('playing', playing); r._playing = playing; }
      const w = playing ? `${(p * 100).toFixed(2)}%` : '0%';
      if (r._w !== w) { r.progress.style.width = w; r._w = w; }
    }
  }

  scrollToStandby() {
    const r = this.rows.get(this.player.standbyId);
    if (r) r.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- drag & drop ----------

  _indexAt(clientY) {
    const rows = [...this.list.querySelectorAll('.cue-row')];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return { index: i, y: r.top };
    }
    const last = rows[rows.length - 1];
    return { index: rows.length, y: last ? last.getBoundingClientRect().bottom : this.list.getBoundingClientRect().top };
  }

  _onDragOver(e) {
    const types = [...e.dataTransfer.types];
    const isCue = types.includes('application/x-cuebook-cue');
    if (!isCue && !types.includes('Files')) return;
    e.preventDefault();
    if (!store.editing) { e.dataTransfer.dropEffect = 'none'; return; }
    e.dataTransfer.dropEffect = isCue ? 'move' : 'copy';
    const { y } = this._indexAt(e.clientY);
    const top = y - this.scroll.getBoundingClientRect().top + this.scroll.scrollTop;
    this.indicator.style.top = `${top - 1}px`;
    this.indicator.classList.remove('hidden');
  }

  _hideIndicator() { this.indicator.classList.add('hidden'); }

  async _onDrop(e) {
    const types = [...e.dataTransfer.types];
    const isCue = types.includes('application/x-cuebook-cue');
    if (!isCue && !types.includes('Files')) return;
    e.preventDefault();
    this._hideIndicator();
    if (!store.editing) { this.toast('Switch to Edit mode to change the cue list.', 'warn'); return; }
    const { index } = this._indexAt(e.clientY);
    if (isCue) {
      this.actions.moveCue(e.dataTransfer.getData('application/x-cuebook-cue'), index);
      return;
    }
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    const audio = paths.filter(isAudioPath);
    if (!audio.length) { this.toast('Only sound files can be dropped on the cue list (mp3, wav, m4a, ogg, flac…).', 'warn'); return; }
    await this.actions.addAudio(audio, { index });
  }
}
