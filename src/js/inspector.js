// Right pane, bottom (Edit mode only): settings for the selected cue,
// including a waveform with draggable start/end trim handles.

import { h, clamp, formatTime, formatDb, dbToGain } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';

class Waveform {
  constructor(engine, player, onTrim) {
    this.engine = engine;
    this.player = player;
    this.onTrim = onTrim;
    this.cue = null;
    this.canvas = h('canvas', { class: 'wave-canvas' });
    this.el = h('div', { class: 'wave' }, this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => this._down(e));
    this.canvas.addEventListener('pointermove', (e) => this._hover(e));
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  setCue(cue) { this.cue = cue; this.draw(); }

  get duration() { return this.cue ? this.engine.duration(this.cue.file) : null; }

  _x(t, w) { return (t / this.duration) * w; }

  _trim() {
    const d = this.duration;
    const s = clamp(Number(this.cue.trimStart) || 0, 0, d);
    const e = this.cue.trimEnd == null || this.cue.trimEnd === '' ? d : clamp(Number(this.cue.trimEnd), s, d);
    return [s, e];
  }

  draw() {
    const c = this.canvas;
    const w = this.el.clientWidth, hgt = this.el.clientHeight;
    if (!w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const css = getComputedStyle(this.el);
    const col = (n) => css.getPropertyValue(n).trim();
    const cue = this.cue;
    const d = this.duration;
    if (!cue || d == null) {
      g.fillStyle = col('--text-dim');
      g.font = '12px system-ui, sans-serif';
      const st = cue ? this.engine.status(cue.file) : '';
      g.fillText(st === 'error' ? 'Could not load this file' : 'Loading waveform…', 10, hgt / 2 + 4);
      return;
    }
    const peaks = this.engine.getPeaks(cue.file);
    const [s, e] = this._trim();
    const mid = hgt / 2;
    const cols = peaks.length / 2;
    // Waveform bars
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((x / w) * cols);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * cols));
      let mn = 0, mx = 0;
      for (let i = i0; i < i1 && i < cols; i++) { mn = Math.min(mn, peaks[i * 2]); mx = Math.max(mx, peaks[i * 2 + 1]); }
      const t = (x / w) * d;
      g.fillStyle = t >= s && t <= e ? col('--wave') : col('--wave-dim');
      g.fillRect(x, mid - mx * mid * 0.95, 1, Math.max(1, (mx - mn) * mid * 0.95));
    }
    // Dim trimmed-off areas
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, 0, this._x(s, w), hgt);
    g.fillRect(this._x(e, w), 0, w - this._x(e, w), hgt);
    // Gain envelope (fades + volume)
    const level = Math.min(1, Math.sqrt(dbToGain(Number(cue.volumeDb) || 0)) / Math.sqrt(dbToGain(10)));
    const top = hgt - 4 - level * (hgt - 8);
    const fi = Math.min(Number(cue.fadeIn) || 0, e - s);
    const fo = cue.loop ? 0 : Math.min(Number(cue.fadeOutEnd) || 0, e - s - fi);
    g.strokeStyle = col('--envelope');
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(this._x(s, w), fi > 0 ? hgt - 4 : top);
    g.lineTo(this._x(s + fi, w), top);
    g.lineTo(this._x(e - fo, w), top);
    g.lineTo(this._x(e, w), fo > 0 ? hgt - 4 : top);
    g.stroke();
    // Trim handles
    for (const [t, side] of [[s, 1], [e, -1]]) {
      const x = Math.round(this._x(t, w)) + (side > 0 ? 0.5 : -0.5);
      g.fillStyle = col('--trim');
      g.fillRect(x - 1, 0, 2, hgt);
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + side * 9, 0); g.lineTo(x, 10); g.closePath(); g.fill();
    }
    // Playheads
    for (const en of this.player.entriesForCue(cue.id)) {
      if (!en.voice) continue;
      const x = this._x(en.voice.position, w);
      g.fillStyle = col('--playing');
      g.fillRect(x - 1, 0, 2, hgt);
    }
  }

  _handleAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const [s, e] = this._trim();
    const xs = this._x(s, r.width) + r.left;
    const xe = this._x(e, r.width) + r.left;
    if (Math.abs(clientX - xs) <= 8) return 'start';
    if (Math.abs(clientX - xe) <= 8) return 'end';
    return null;
  }

  _hover(e) {
    if (this._dragging || this.duration == null) return;
    this.canvas.style.cursor = this._handleAt(e.clientX) ? 'ew-resize' : 'default';
  }

  _down(e) {
    if (this.duration == null || !store.editing) return;
    const which = this._handleAt(e.clientX);
    if (!which) return;
    e.preventDefault();
    this._dragging = true;
    this.canvas.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const d = this.duration;
      let t = clamp(((ev.clientX - r.left) / r.width) * d, 0, d);
      t = Math.round(t * 100) / 100;
      const [s, en] = this._trim();
      if (which === 'start') this.onTrim({ trimStart: Math.min(t, en - 0.05) });
      else this.onTrim({ trimEnd: t >= d - 0.01 ? null : Math.max(t, s + 0.05) });
    };
    const up = () => {
      this._dragging = false;
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      this.canvas.removeEventListener('pointercancel', up);
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }
}

export class Inspector {
  constructor(root, { player, engine, actions, scriptView }) {
    this.root = root;
    this.player = player;
    this.engine = engine;
    this.actions = actions;
    this.scriptView = scriptView;
    this.cueId = null;
    this._selfEdit = false;
    this.waveform = new Waveform(engine, player, (patch) => this._set(patch, `trim-${this.cueId}`));
  }

  get cue() { return store.cue(this.cueId); }

  /** Full rebuild (selection changed, undo, or an edit made elsewhere). */
  render() {
    this.cueId = store.selectedId;
    const cue = this.cue;
    this.root.innerHTML = '';
    if (!cue) {
      this.root.append(h('div', { class: 'insp-empty' }, h('p', { text: store.cues.length ? 'Select a cue to edit it.' : 'Add a cue to edit its settings here.' })));
      return;
    }
    this.previewBtn = cue.type === 'audio'
      ? h('button', { class: 'btn small', title: 'Play just this cue (does not affect the show)', onclick: () => this._togglePreview() }, icon('play'), h('span', { text: 'Preview' }))
      : null;
    const head = h('div', { class: 'insp-head' },
      this.headTitle = h('div', { class: 'insp-title' }),
      h('div', { class: 'spacer' }),
      this.previewBtn,
      h('button', { class: 'btn small', title: 'Make this the next cue to GO (or double-click it in the list)', onclick: () => this.player.setStandby(cue.id) }, h('span', { text: 'Set as next' })),
      h('button', { class: 'btn small danger-ghost icon-only', title: 'Delete this cue (Del)', onclick: () => this.actions.deleteCue(cue.id) }, icon('trash')));
    this._updateTitle();

    const body = h('div', { class: 'insp-body' });
    body.append(this._section('Cue',
      h('div', { class: 'grid-2-wide' },
        this._field('Number', this._text(cue.number, (v) => ({ number: v.trim() }), { class: 'num-input' })),
        this._field('Name', this._text(cue.name, (v) => ({ name: v })))),
      this._field('Notes (shown with the standby cue)', this._textarea(cue.notes, (v) => ({ notes: v }), 'e.g. “GO on the door slam” or “wait for blackout”'))));

    if (cue.type === 'audio') this._audioSections(body, cue);
    else this._fadeSections(body, cue);

    body.append(this._followSection(cue), this._pinSection(cue));
    this.root.append(head, body);
    // The canvas element is reused between cues, so redraw now that it's back in the page.
    if (cue.type === 'audio') this.waveform.draw();
    this._renderedStatus = this.player.fileState(cue);
    this.updateLive();
  }

  /** A sound finished loading (or failed): refresh if it's the one on screen. */
  onFileLoaded() {
    const cue = this.cue;
    if (!cue || cue.type !== 'audio') return;
    const st = this.player.fileState(cue);
    if (st === this._renderedStatus) return;
    const a = document.activeElement;
    if (a && this.root.contains(a) && a.matches('input, textarea, select')) {
      // Don't yank the field someone is typing in; just update the waveform.
      this.waveform.draw();
      return;
    }
    this.render();
  }

  /** After an edit made from the inspector itself: refresh dependent bits only. */
  refreshSoft() {
    this._updateTitle();
    this.waveform.draw();
    if (this.pinDesc && this.cue) this.pinDesc.textContent = this.scriptView.describeAnchor(this.cue.anchor);
    if (this.trimStartIn && this.cue) {
      if (document.activeElement !== this.trimStartIn) this.trimStartIn.value = String(Number(this.cue.trimStart) || 0);
      if (document.activeElement !== this.trimEndIn) this.trimEndIn.value = this.cue.trimEnd == null ? '' : String(this.cue.trimEnd);
    }
  }

  _updateTitle() {
    const cue = this.cue;
    if (!cue || !this.headTitle) return;
    this.headTitle.innerHTML = '';
    this.headTitle.append(h('span', { class: 'insp-num', text: `Q${cue.number || '–'}` }), h('span', { class: 'insp-name', text: cue.name || 'Untitled' }));
  }

  _audioSections(body, cue) {
    const d = this.engine.duration(cue.file);
    const status = this.player.fileState(cue);
    const fileLine = h('div', { class: 'file-line' },
      icon('music'),
      h('span', { class: 'file-name', title: cue.file, text: cue.file ? cue.file.replace(/^audio\//, '') : 'No file' }),
      h('span', { class: 'file-dur', text: d != null ? formatTime(d, true) : '' }),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', title: 'Use a different sound file for this cue', onclick: () => this.actions.replaceFile(cue.id) }, h('span', { text: 'Replace…' })),
      cue.file ? h('button', { class: 'btn small icon-only', title: 'Show the file in Explorer', onclick: () => window.cuebook.reveal(cue.file) }, icon('reveal')) : null);
    const warn = status === 'missing' ? h('div', { class: 'insp-warn' }, icon('warn'), h('span', { text: 'This file is missing from the show folder. Use Replace… to point the cue at the sound again.' }))
      : status === 'error' ? h('div', { class: 'insp-warn' }, icon('warn'), h('span', { text: this.engine.error(cue.file) || 'This file could not be loaded.' }))
        : null;

    const volLabel = h('span', { class: 'vol-val', text: formatDb(cue.volumeDb) });
    const vol = h('input', { type: 'range', min: '-40', max: '10', step: '0.5', value: String(cue.volumeDb), class: 'vol-range' });
    vol.addEventListener('input', () => {
      const v = Number(vol.value);
      volLabel.textContent = formatDb(v);
      this._set({ volumeDb: v }, `vol-${cue.id}`);
      this.player.applyLiveLevel(this.cue);
    });
    vol.addEventListener('dblclick', () => { vol.value = '0'; vol.dispatchEvent(new Event('input')); });
    vol.addEventListener('change', () => vol.blur());

    this.trimStartIn = this._num(cue.trimStart, (v) => ({ trimStart: Math.max(0, v || 0) }), { step: 0.1, min: 0 });
    this.trimEndIn = this._num(cue.trimEnd, (v) => ({ trimEnd: v === null || v <= 0 ? null : v }), { step: 0.1, min: 0, placeholder: 'end of file' });

    body.append(this._section('Sound',
      fileLine, warn,
      this.waveform.el,
      h('div', { class: 'hint', text: 'Drag the yellow handles on the waveform to trim where the sound starts and ends.' }),
      h('div', { class: 'grid-3' },
        this._field('Start at (s)', this.trimStartIn),
        this._field('End at (s)', this.trimEndIn),
        this._field('Loop', this._check(cue.loop, (v) => ({ loop: v }), 'Repeat between start and end'))),
      this._field('Volume', h('div', { class: 'vol-row' }, vol, volLabel), 'Double-click the slider to reset to 0 dB. Changes are heard live.')));
    this.waveform.setCue(cue);

    body.append(this._section('Fades',
      h('div', { class: 'grid-3' },
        this._field('Fade in (s)', this._num(cue.fadeIn, (v) => ({ fadeIn: Math.max(0, v || 0) }), { step: 0.5, min: 0 })),
        this._field('Fade out at end (s)', this._num(cue.fadeOutEnd, (v) => ({ fadeOutEnd: Math.max(0, v || 0) }), { step: 0.5, min: 0 })),
        this._field('Fade when stopped (s)', this._num(cue.stopFade, (v) => ({ stopFade: Math.max(0, v || 0) }), { step: 0.5, min: 0 }))),
      h('div', { class: 'hint', text: '“Fade when stopped” is used when a later cue, a Fade/Stop cue, or STOP ALL ends this sound.' })));

    body.append(this._section('When this cue starts',
      this._radio(`onstart-${cue.id}`, cue.onStart, [
        ['fadeOthers', 'Fade out other sounds that are playing'],
        ['keep', 'Keep other sounds playing underneath'],
      ], (v) => ({ onStart: v }))));
  }

  _fadeSections(body, cue) {
    const targetSel = h('select', {});
    targetSel.append(h('option', { value: 'all', text: 'Every sound that is playing' }));
    for (const c of store.cues) {
      if (c.type !== 'audio') continue;
      targetSel.append(h('option', { value: c.id, text: `Q${c.number || '–'}  ${c.name}` }));
    }
    targetSel.value = store.cue(cue.target) || cue.target === 'all' ? cue.target : 'all';
    targetSel.addEventListener('change', () => { this._set({ target: targetSel.value }); targetSel.blur(); });

    const levelIn = this._num(cue.levelDb, (v) => ({ levelDb: clamp(v ?? -12, -60, 10) }), { step: 1, min: -60, max: 10 });
    body.append(this._section('Fade',
      this._field('Fade which sounds', targetSel),
      this._radio(`fadeaction-${cue.id}`, cue.action, [
        ['stop', 'Fade out and stop'],
        ['level', 'Fade to a new volume and keep playing'],
      ], (v) => ({ action: v })),
      h('div', { class: 'grid-3' },
        this._field('Over (s)', this._num(cue.duration, (v) => ({ duration: Math.max(0, v || 0) }), { step: 0.5, min: 0 })),
        cue.action === 'level' ? this._field('To volume (dB)', levelIn) : h('div'),
        h('div'))));
  }

  _followSection(cue) {
    const sel = h('select', {},
      h('option', { value: 'none', text: 'Wait for the next GO' }),
      h('option', { value: 'end', text: cue.type === 'fade' ? 'GO the next cue when the fade finishes' : 'GO the next cue when this one ends' }),
      h('option', { value: 'delay', text: 'GO the next cue after a delay' }));
    sel.value = cue.follow;
    sel.addEventListener('change', () => { this._set({ follow: sel.value }); sel.blur(); this.render(); });
    const items = [this._field('Then', sel)];
    if (cue.follow === 'delay') items.push(this._field('Delay after this cue starts (s)', this._num(cue.followDelay, (v) => ({ followDelay: Math.max(0, v || 0) }), { step: 0.5, min: 0 })));
    if (cue.follow === 'end' && cue.loop) items.push(h('div', { class: 'insp-warn' }, icon('warn'), h('span', { text: 'A looping sound never ends by itself, so the next cue would never fire. Use a delay instead.' })));
    return this._section('Auto-follow', h('div', { class: 'grid-2' }, ...items));
  }

  _pinSection(cue) {
    this.pinDesc = h('div', { class: 'pin-desc', text: this.scriptView.describeAnchor(cue.anchor) });
    return this._section('Script position',
      this.pinDesc,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', title: 'Then click the spot in the script (or Alt+click the script any time)', onclick: () => this.scriptView.startPinMode(cue.id) }, icon('pin'), h('span', { text: cue.anchor ? 'Move pin…' : 'Pin to script…' })),
        cue.anchor ? h('button', { class: 'btn small', onclick: () => this.scriptView.scrollToCue(cue.id) }, h('span', { text: 'Show in script' })) : null,
        cue.anchor ? h('button', { class: 'btn small', onclick: () => this.actions.unpinCue(cue.id) }, h('span', { text: 'Unpin' })) : null),
      h('div', { class: 'hint', text: 'Tip: drag a cue from the list onto the script, or drag its marker in the script to move it.' }));
  }

  // ---------- live ----------

  updateLive() {
    const cue = this.cue;
    if (!cue) return;
    if (this.previewBtn) {
      const previewing = this.player.entriesForCue(cue.id).some((e) => e.preview);
      if (this._previewing !== previewing) {
        this._previewing = previewing;
        this.previewBtn.innerHTML = '';
        this.previewBtn.append(icon(previewing ? 'stop' : 'play'), h('span', { text: previewing ? 'Stop' : 'Preview' }));
        this.previewBtn.classList.toggle('active', previewing);
      }
    }
    if (cue.type === 'audio' && this.player.entriesForCue(cue.id).length) this.waveform.draw();
    else if (this._hadPlayhead) this.waveform.draw();
    this._hadPlayhead = cue.type === 'audio' && this.player.entriesForCue(cue.id).length > 0;
  }

  _togglePreview() {
    const cue = this.cue;
    if (this.player.entriesForCue(cue.id).some((e) => e.preview)) this.player.stopPreview();
    else this.player.preview(cue);
  }

  // ---------- field helpers ----------

  _set(patch, coalesce = null) {
    const id = this.cueId;
    this._selfEdit = true;
    try {
      store.edit((show) => {
        const c = show.cues.find((x) => x.id === id);
        if (c) Object.assign(c, patch);
      }, { coalesce });
    } finally {
      this._selfEdit = false;
    }
  }

  _section(title, ...children) {
    return h('section', { class: 'insp-section' }, h('h4', { text: title }), ...children);
  }

  _field(label, control, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control, hint ? h('span', { class: 'hint', text: hint }) : null);
  }

  _text(value, toPatch, props = {}) {
    const input = h('input', { type: 'text', value: value ?? '', spellcheck: false, ...props });
    input.addEventListener('change', () => this._set(toPatch(input.value)));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return input;
  }

  _textarea(value, toPatch, placeholder) {
    const ta = h('textarea', { rows: 2, placeholder, spellcheck: true });
    ta.value = value ?? '';
    ta.addEventListener('change', () => this._set(toPatch(ta.value)));
    return ta;
  }

  _num(value, toPatch, { step = 1, min, max, placeholder } = {}) {
    const input = h('input', { type: 'number', step: String(step), value: value == null ? '' : String(value), placeholder, class: 'num' });
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      const v = raw === '' ? null : Number(raw);
      if (raw !== '' && !Number.isFinite(v)) return;
      this._set(toPatch(v));
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return input;
  }

  _check(value, toPatch, text) {
    const input = h('input', { type: 'checkbox', checked: !!value });
    input.addEventListener('change', () => { this._set(toPatch(input.checked)); input.blur(); });
    return h('span', { class: 'check' }, input, h('span', { text }));
  }

  _radio(name, value, options, toPatch) {
    return h('div', { class: 'radios' }, ...options.map(([v, label]) => {
      const input = h('input', { type: 'radio', name, value: v, checked: v === value });
      input.addEventListener('change', () => {
        if (input.checked) { this._set(toPatch(v)); input.blur(); if (name.startsWith('fadeaction')) this.render(); }
      });
      return h('label', { class: 'radio' }, input, h('span', { text: label }));
    }));
  }
}
