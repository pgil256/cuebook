// Show playback logic: the standby cue, GO, auto-follow chains, fade cues,
// stop-all (panic), preview, and preloading around the standby position.

import { store } from './store.js';

const api = window.cuebook;

let entrySeq = 0;

export class Player {
  constructor(engine) {
    this.engine = engine;
    this.standbyId = null;
    /** key -> { key, cue, kind: 'audio'|'fade', voice, startedAt, duration, followTimer, preview } */
    this.active = new Map();
    this.showClockStart = null;
    this.lastGoAt = 0;
    this.panicUntil = 0;
    this.listeners = new Set();
    this.missing = new Set(); // files known to be missing on disk
    this._preloadToken = 0;
    engine.onLoadStateChange = () => this.emit({ load: true });
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of [...this.listeners]) { try { fn(what); } catch (err) { console.error(err); } } }

  get standby() { return store.cue(this.standbyId); }

  // ---------- standby / navigation ----------

  setStandby(id, { scroll = true } = {}) {
    if (id && !store.cue(id)) id = null;
    this.standbyId = id;
    api.setStandby(id).catch(() => {});
    this.emit({ standby: true, scroll });
    this.preloadAround();
  }

  moveStandby(delta) {
    const cues = store.cues;
    if (!cues.length) return;
    let i = this.standbyId ? store.cueIndex(this.standbyId) : (delta > 0 ? -1 : cues.length);
    i = Math.max(0, Math.min(cues.length - 1, i + delta));
    this.setStandby(cues[i].id);
  }

  /** The cue after `cue` plus everything it auto-follows into. */
  _afterChain(cue) {
    const cues = store.cues;
    let i = store.cueIndex(cue.id);
    while (i >= 0 && i < cues.length - 1 && cues[i].follow !== 'none') i++;
    return cues[i + 1] || null;
  }

  // ---------- GO ----------

  /** Returns 'fired' | 'guarded' | 'empty'. */
  go() {
    const now = performance.now();
    const guard = Number(store.show?.settings.goGuardMs) || 0;
    if (guard > 0 && now - this.lastGoAt < guard) {
      this.emit({ guarded: true });
      return 'guarded';
    }
    const cue = this.standby;
    if (!cue) return 'empty';
    this.lastGoAt = now;
    if (this.showClockStart === null) this.showClockStart = Date.now();
    const next = this._afterChain(cue);
    this.fire(cue);
    this.setStandby(next ? next.id : null);
    this.emit({ go: true });
    return 'fired';
  }

  fire(cue) {
    this.engine.resume();
    if (cue.type === 'fade') this._fireFade(cue);
    else this._fireAudio(cue);
  }

  _fireAudio(cue) {
    if (!cue.file) { this.emit({ error: `Cue ${cue.number || ''} has no sound file.` }); return; }

    // Fade out what's playing first, so the new cue doesn't wait on a slow load.
    if (cue.onStart !== 'keep') this._fadeOthers();

    const key = `e${++entrySeq}`;
    const entry = { key, cue, kind: 'audio', voice: null, startedAt: performance.now(), followTimer: null, preview: false, loading: true };
    this.active.set(key, entry);
    this.emit({ active: true });

    const start = (buffer) => {
      if (!this.active.has(key)) return; // stopped while loading
      const voice = this.engine.createVoice(cue, buffer);
      entry.voice = voice;
      entry.loading = false;
      voice.onEnded = (natural) => {
        this.active.delete(key);
        if (natural && cue.follow === 'end') this._followFrom(entry);
        else if (entry.followTimer) clearTimeout(entry.followTimer);
        this.emit({ active: true });
      };
      voice.start();
      if (cue.follow === 'delay') {
        entry.followTimer = setTimeout(() => { entry.followTimer = null; this._followFrom(entry); }, Math.max(0, Number(cue.followDelay) || 0) * 1000);
      }
      this.emit({ active: true });
    };

    const buffer = this.engine.peek(cue.file);
    if (buffer) start(buffer);
    else {
      this.engine.load(cue.file).then(start, (err) => {
        this.active.delete(key);
        this.emit({ active: true, error: `Cue ${cue.number || ''} “${cue.name}” couldn't play: ${err.message}` });
      });
    }
  }

  _fireFade(cue) {
    const duration = Math.max(0, Number(cue.duration) || 0);
    for (const e of this.active.values()) {
      if (e.kind !== 'audio' || e.preview) continue;
      if (cue.target !== 'all' && e.cue.id !== cue.target) continue;
      if (cue.action === 'level') {
        if (e.voice) e.voice.setLevelDb(Number(cue.levelDb) || 0, duration);
      } else {
        this._stopEntry(e, duration);
      }
    }
    const key = `e${++entrySeq}`;
    const entry = { key, cue, kind: 'fade', voice: null, startedAt: performance.now(), duration, followTimer: null, preview: false };
    this.active.set(key, entry);
    entry.doneTimer = setTimeout(() => {
      this.active.delete(key);
      if (cue.follow === 'end') this._followFrom(entry);
      this.emit({ active: true });
    }, duration * 1000);
    if (cue.follow === 'delay') {
      entry.followTimer = setTimeout(() => { entry.followTimer = null; this._followFrom(entry); }, Math.max(0, Number(cue.followDelay) || 0) * 1000);
    }
    this.emit({ active: true });
  }

  _followFrom(entry) {
    const cues = store.cues;
    const i = store.cueIndex(entry.cue.id);
    const next = i >= 0 ? cues[i + 1] : null;
    if (!next) return;
    this.fire(next);
    // If the operator parked standby on the cue the chain just fired, move past it.
    if (this.standbyId === next.id) {
      const after = this._afterChain(next);
      this.setStandby(after ? after.id : null);
    }
    this.emit({ go: true });
  }

  _fadeOthers() {
    const def = Number(store.show?.settings.defaultStopFade) || 0;
    for (const e of this.active.values()) {
      if (e.kind !== 'audio' || e.preview) continue;
      const f = e.cue.stopFade ?? def;
      this._stopEntry(e, Number(f) || 0);
    }
  }

  _stopEntry(e, fadeSeconds) {
    if (e.followTimer) { clearTimeout(e.followTimer); e.followTimer = null; }
    if (e.kind === 'fade') {
      clearTimeout(e.doneTimer);
      this.active.delete(e.key);
      return;
    }
    if (!e.voice) { this.active.delete(e.key); return; } // still loading: never start it
    e.stopping = true;
    if (fadeSeconds > 0) e.voice.fadeOutAndStop(fadeSeconds);
    else e.voice.stopNow();
  }

  /** Stop one running entry (from the transport's stop buttons). */
  stop(key, fade = null) {
    const e = this.active.get(key);
    if (!e) return;
    const f = fade ?? (e.cue.stopFade ?? store.show?.settings.defaultStopFade ?? 0);
    this._stopEntry(e, Number(f) || 0);
    this.emit({ active: true });
  }

  /** Esc / STOP ALL: fade everything out. Pressing again during the fade cuts it immediately. */
  stopAll() {
    const now = performance.now();
    const hard = now < this.panicUntil;
    const fade = hard ? 0 : Math.max(0, Number(store.show?.settings.panicFade) || 0);
    for (const e of [...this.active.values()]) this._stopEntry(e, fade);
    this.panicUntil = hard ? 0 : now + fade * 1000 + 100;
    this.emit({ active: true, panic: hard ? 'hard' : 'fade' });
  }

  /** Immediately silence everything without fades (used when closing the show). */
  silence() {
    for (const e of [...this.active.values()]) {
      if (e.followTimer) clearTimeout(e.followTimer);
      if (e.doneTimer) clearTimeout(e.doneTimer);
      if (e.voice) e.voice.stopNow();
    }
    this.active.clear();
    this.emit({ active: true });
  }

  get playing() {
    for (const e of this.active.values()) if (!e.stopping) return true;
    return false;
  }

  // ---------- preview (rehearsal) ----------

  preview(cue) {
    this.stopPreview();
    if (!cue || cue.type !== 'audio' || !cue.file) return;
    this.engine.resume();
    const key = `p${++entrySeq}`;
    const entry = { key, cue, kind: 'audio', voice: null, startedAt: performance.now(), followTimer: null, preview: true, loading: true };
    this.active.set(key, entry);
    this.emit({ active: true });
    this.engine.load(cue.file).then((buffer) => {
      if (!this.active.has(key)) return;
      const voice = this.engine.createVoice(cue, buffer, { preview: true });
      entry.voice = voice;
      entry.loading = false;
      voice.onEnded = () => { this.active.delete(key); this.emit({ active: true }); };
      voice.start();
      this.emit({ active: true });
    }, (err) => {
      this.active.delete(key);
      this.emit({ active: true, error: `Preview failed: ${err.message}` });
    });
  }

  stopPreview() {
    for (const e of [...this.active.values()]) if (e.preview) this._stopEntry(e, 0.15);
    this.emit({ active: true });
  }

  /** Apply a volume edit to running voices of that cue straight away. */
  applyLiveLevel(cue) {
    for (const e of this.active.values()) {
      if (e.cue.id === cue.id && e.voice && !e.stopping) e.voice.setLevelDb(Number(cue.volumeDb) || 0, 0.05);
    }
  }

  entriesForCue(id) {
    return [...this.active.values()].filter((e) => e.cue.id === id);
  }

  resetShowClock() {
    this.showClockStart = null;
    this.emit({ clock: true });
  }

  // ---------- loading ----------

  async checkFiles() {
    const files = [...new Set(store.cues.filter((c) => c.type === 'audio' && c.file).map((c) => c.file))];
    if (!files.length) { this.missing = new Set(); return []; }
    const result = await api.checkFiles(files);
    this.missing = new Set(files.filter((f) => !result[f]));
    this.emit({ load: true });
    return [...this.missing];
  }

  fileState(cue) {
    if (cue.type !== 'audio') return 'ready';
    if (!cue.file) return 'nofile';
    if (this.missing.has(cue.file)) return 'missing';
    return this.engine.status(cue.file);
  }

  /** Make sure the standby cue and the next few are decoded and ready. */
  preloadAround() {
    const cues = store.cues;
    if (!cues.length) return;
    const start = Math.max(0, this.standbyId ? store.cueIndex(this.standbyId) : 0);
    const protect = new Set();
    for (let i = start; i < Math.min(cues.length, start + 6); i++) if (cues[i].file) protect.add(cues[i].file);
    for (const e of this.active.values()) if (e.cue.file) protect.add(e.cue.file);
    for (const f of protect) if (!this.missing.has(f)) this.engine.load(f).catch(() => {});
    this.engine.evict(protect);
  }

  /** Background-load the whole show (while memory allows) so every GO is instant. */
  async preloadAll() {
    const token = ++this._preloadToken;
    this.preloadAround();
    for (const c of store.cues) {
      if (token !== this._preloadToken) return;
      if (c.type !== 'audio' || !c.file || this.missing.has(c.file)) continue;
      if (!this.engine.hasRoom) return;
      try { await this.engine.load(c.file); } catch { /* shown on the cue */ }
    }
  }

  cancelPreload() { this._preloadToken++; }
}
