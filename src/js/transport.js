// Top bar (show name, mode lock, output device, master, clocks) and the
// transport strip (GO, standby cue, what's playing, STOP ALL).

import { h, formatTime, formatClock, formatDb } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';

export class Transport {
  constructor({ topbar, transport }, { player, engine, actions, toast }) {
    this.player = player;
    this.engine = engine;
    this.actions = actions;
    this.toast = toast;
    this.activeRows = new Map();
    this._buildTopbar(topbar);
    this._buildTransport(transport);
    navigator.mediaDevices.addEventListener('devicechange', () => this.refreshDevices(true));
  }

  // ---------- top bar ----------

  _buildTopbar(root) {
    this.showNameEl = h('div', { class: 'show-name' });
    this.saveEl = h('div', { class: 'save-status' });
    this.editBtn = h('button', { class: 'seg', onclick: () => this.actions.setMode('edit') }, icon('unlock'), h('span', { text: 'Edit' }));
    this.showBtn = h('button', { class: 'seg', onclick: () => this.actions.setMode('show') }, icon('lock'), h('span', { text: 'Show' }));
    this.deviceSel = h('select', { class: 'device-select', title: 'Where the sound goes' });
    this.deviceSel.addEventListener('change', () => { this.deviceSel.blur(); this.actions.setOutput(this.deviceSel.value); });
    this.masterIn = h('input', { type: 'range', min: '-40', max: '10', step: '0.5', class: 'master-range', title: 'Master volume (double-click for 0 dB)' });
    this.masterVal = h('span', { class: 'master-val' });
    this.masterIn.addEventListener('input', () => {
      const v = Number(this.masterIn.value);
      this.masterVal.textContent = formatDb(v);
      this.engine.setMasterDb(v);
      store.pref((s) => { s.masterDb = v; }, { master: true });
    });
    this.masterIn.addEventListener('change', () => this.masterIn.blur());
    this.masterIn.addEventListener('dblclick', () => { this.masterIn.value = '0'; this.masterIn.dispatchEvent(new Event('input')); });
    this.showClock = h('div', { class: 'clock-big', title: 'Show running time. Starts on the first GO. Click to reset.' });
    this.showClock.addEventListener('click', () => this.actions.resetClock());
    this.todEl = h('div', { class: 'clock-small', title: 'Time of day' });

    root.append(
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), h('span', { text: 'Cuebook' })),
      h('div', { class: 'show-title' }, this.showNameEl, this.saveEl),
      h('div', { class: 'mode-badge', text: 'SHOW MODE — editing locked' }),
      h('div', { class: 'spacer' }),
      h('div', { class: 'seg-group', title: 'Show mode locks the cue list against accidental edits' }, this.editBtn, this.showBtn),
      h('div', { class: 'tb-group' }, icon('speaker'), this.deviceSel,
        h('button', { class: 'tb-btn', title: 'Play a short test beep through this output', onclick: () => { this.engine.resume(); this.engine.testTone(); } }, h('span', { text: 'Test' }))),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label', text: 'Master' }), this.masterIn, this.masterVal),
      h('div', { class: 'clocks' }, this.showClock, this.todEl),
      h('button', { class: 'tb-btn icon-only', title: 'Keyboard shortcuts', onclick: () => this.actions.showShortcuts() }, icon('keyboard')),
      h('button', { class: 'tb-btn icon-only edit-only', title: 'Show settings', onclick: () => this.actions.openSettings() }, icon('gear')),
      h('button', { class: 'tb-btn icon-only', title: 'Close this show', onclick: () => this.actions.closeShow() }, icon('close')),
    );
  }

  renderTopbar() {
    const show = store.show;
    if (!show) return;
    this.showNameEl.textContent = show.name;
    this.editBtn.classList.toggle('on', store.editing);
    this.showBtn.classList.toggle('on', !store.editing);
    this.masterIn.value = String(show.settings.masterDb);
    this.masterVal.textContent = formatDb(show.settings.masterDb);
    this.renderSave();
  }

  renderSave() {
    const st = store.saveState;
    this.saveEl.className = `save-status ${st}`;
    this.saveEl.textContent = st === 'error' ? 'Not saved: retrying…' : st === 'saved' ? 'All changes saved' : 'Saving…';
    this.saveEl.title = st === 'error' ? store.saveError : 'Changes save automatically to the show folder';
  }

  async refreshDevices(fromEvent = false) {
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    } catch { /* leave empty */ }
    this.devices = devices;
    const s = store.show?.settings;
    this.deviceSel.innerHTML = '';
    this.deviceSel.append(h('option', { value: '', text: 'System default output' }));
    for (const d of devices) this.deviceSel.append(h('option', { value: d.deviceId, text: d.label || 'Audio output' }));
    if (!s) return;
    // Prefer the saved device id, then a device with the same name (ids can change between computers).
    let want = '';
    if (s.outputDeviceId) {
      const byId = devices.find((d) => d.deviceId === s.outputDeviceId);
      const byLabel = !byId && s.outputDeviceLabel ? devices.find((d) => d.label === s.outputDeviceLabel) : null;
      want = (byId || byLabel)?.deviceId || '';
      if (!want && (!fromEvent || this.engine.sinkId)) {
        this.toast(`The saved output “${s.outputDeviceLabel || 'device'}” isn't connected. Using the system default until it's plugged in.`, 'warn');
      }
    }
    this.deviceSel.value = want;
    if (this.engine.sinkId !== want) {
      try { await this.engine.setOutput(want); } catch (err) { this.toast(`Couldn't switch output: ${err.message}`, 'error'); }
      if (want && fromEvent) this.toast(`Output “${s.outputDeviceLabel}” is back.`, 'info');
    }
  }

  // ---------- transport ----------

  _buildTransport(root) {
    this.goBtn = h('button', { class: 'go-btn', title: 'GO: fire the standby cue (Space)' }, h('span', { class: 'go-text', text: 'GO' }), h('span', { class: 'go-key', text: 'Space' }));
    this.goBtn.addEventListener('click', () => this.actions.go());
    this.standbyEl = h('div', { class: 'standby-box' });
    this.activeEl = h('div', { class: 'active-list' });
    this.stopAllBtn = h('button', { class: 'stopall-btn', title: 'Fade out everything (Esc). Press again to cut instantly.' }, h('span', { class: 'go-text', text: 'STOP ALL' }), h('span', { class: 'go-key', text: 'Esc' }));
    this.stopAllBtn.addEventListener('click', () => this.player.stopAll());
    this.typingHint = h('div', { class: 'typing-hint hidden', text: 'Typing in a field: click outside it (or press Esc) to use Space for GO' });
    root.append(h('div', { class: 'go-wrap' }, this.goBtn, this.typingHint), this.standbyEl, this.activeEl, this.stopAllBtn);
  }

  renderStandby() {
    const cue = this.player.standby;
    const el = this.standbyEl;
    el.innerHTML = '';
    this.goBtn.classList.toggle('disabled', !cue);
    if (!cue) {
      el.append(h('div', { class: 'sb-label', text: 'Standby' }), h('div', { class: 'sb-end', text: store.cues.length ? 'End of the cue list' : 'No cues yet' }));
      if (store.cues.length) el.append(h('div', { class: 'sb-hint', text: 'Double-click a cue or use ↑ ↓ to choose the next one' }));
      return;
    }
    const st = this.player.fileState(cue);
    const problem = st === 'missing' ? 'Sound file missing!' : st === 'error' ? 'Sound file can\'t be played!' : st === 'nofile' ? 'No sound file!' : null;
    const chain = [];
    let i = store.cueIndex(cue.id);
    while (i >= 0 && store.cues[i].follow !== 'none' && store.cues[i + 1]) { chain.push(store.cues[i + 1]); i++; }
    // (Element.append would print null as text, so build the optional parts in a list.)
    const parts = [
      h('div', { class: 'sb-label', text: 'Standby' }),
      h('div', { class: 'sb-main' }, h('span', { class: 'sb-num', text: `Q${cue.number || '–'}` }), h('span', { class: 'sb-name', text: cue.name || 'Untitled' })),
    ];
    if (problem) parts.push(h('div', { class: 'sb-problem' }, icon('warn'), h('span', { text: problem })));
    if (cue.notes) parts.push(h('div', { class: 'sb-notes', text: cue.notes }));
    if (chain.length) parts.push(h('div', { class: 'sb-chain' }, icon('chain'), h('span', { text: `Also fires ${chain.map((c) => 'Q' + c.number).join(', ')} automatically` })));
    el.append(...parts);
  }

  renderActive() {
    const entries = [...this.player.active.values()];
    const keep = new Set(entries.map((e) => e.key));
    for (const [k, r] of this.activeRows) if (!keep.has(k)) { r.row.remove(); this.activeRows.delete(k); }
    for (const e of entries) {
      if (this.activeRows.has(e.key)) continue;
      const bar = h('div', { class: 'ar-bar' });
      const elapsed = h('span', { class: 'ar-elapsed' });
      const remain = h('span', { class: 'ar-remain' });
      const tag = e.preview ? h('span', { class: 'ar-tag', text: 'PREVIEW' }) : e.kind === 'fade' ? h('span', { class: 'ar-tag fade', text: 'FADE' }) : null;
      const row = h('div', { class: `active-row ${e.kind}` },
        h('div', { class: 'ar-top' },
          h('span', { class: 'ar-num', text: `Q${e.cue.number || '–'}` }),
          h('span', { class: 'ar-name', text: e.cue.name || 'Untitled' }), tag,
          h('div', { class: 'spacer' }), elapsed, remain,
          e.kind === 'audio' ? h('button', { class: 'ar-stop', title: 'Fade out this sound', onclick: () => this.player.stop(e.key) }, icon('stop')) : null),
        h('div', { class: 'ar-track' }, bar));
      this.activeEl.append(row);
      this.activeRows.set(e.key, { row, bar, elapsed, remain, e });
    }
    this.activeEl.classList.toggle('empty', entries.length === 0);
    if (!entries.length) this.activeEl.dataset.empty = 'Nothing playing';
  }

  /** Per animation frame. */
  updateLive() {
    for (const [, r] of this.activeRows) {
      const e = r.e;
      let p = 0, el = '', rem = '';
      if (e.loading) { el = 'loading…'; }
      else if (e.voice) {
        const v = e.voice;
        p = v.progress;
        el = formatTime(v.elapsed, true);
        rem = v.loop ? '↻ loop' : '−' + formatTime(v.remaining, true);
      } else if (e.kind === 'fade') {
        const t = (performance.now() - e.startedAt) / 1000;
        p = e.duration > 0 ? Math.min(1, t / e.duration) : 1;
        el = formatTime(t, true);
        rem = '−' + formatTime(Math.max(0, e.duration - t), true);
      }
      const w = `${(p * 100).toFixed(2)}%`;
      if (r._w !== w) { r.bar.style.width = w; r._w = w; }
      if (r._el !== el) { r.elapsed.textContent = el; r._el = el; }
      if (r._rem !== rem) {
        r.remain.textContent = rem;
        r._rem = rem;
        const warn = e.voice && !e.voice.loop && e.voice.remaining < 5;
        r.row.classList.toggle('ending', !!warn);
      }
      r.row.classList.toggle('stopping', !!e.stopping);
    }
    const clock = this.player.showClockStart === null ? '00:00:00' : formatClock(Date.now() - this.player.showClockStart);
    if (this._clock !== clock) { this.showClock.textContent = clock; this._clock = clock; }
    const tod = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (this._tod !== tod) { this.todEl.textContent = tod; this._tod = tod; }
  }

  flashGuard() {
    this.goBtn.classList.remove('guarded');
    void this.goBtn.offsetWidth;
    this.goBtn.classList.add('guarded');
  }

  flashGo() {
    this.goBtn.classList.remove('fired');
    void this.goBtn.offsetWidth;
    this.goBtn.classList.add('fired');
  }

  setTyping(on) {
    this.typingHint.classList.toggle('hidden', !on);
  }
}
