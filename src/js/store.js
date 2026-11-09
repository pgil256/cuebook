// The open show: data, undo/redo, edit lock, and debounced atomic autosave.

import { debounce, uid } from './util.js';

const api = window.cuebook;

export const DEFAULT_SETTINGS = {
  outputDeviceId: '',
  outputDeviceLabel: '',
  masterDb: 0,
  defaultStopFade: 2,
  goGuardMs: 500,
  panicFade: 1,
  mode: 'edit',
  followScript: true,
  darkScript: false,
  scriptZoom: 1,
};

const AUDIO_DEFAULTS = {
  type: 'audio', number: '', name: '', file: '', volumeDb: 0,
  fadeIn: 0, fadeOutEnd: 0, stopFade: 2, trimStart: 0, trimEnd: null, loop: false,
  onStart: 'fadeOthers', follow: 'none', followDelay: 0, notes: '', anchor: null,
};

const FADE_DEFAULTS = {
  type: 'fade', number: '', name: 'Fade out all sound', target: 'all', action: 'stop',
  levelDb: -12, duration: 3, follow: 'none', followDelay: 0, notes: '', anchor: null,
};

export function makeAudioCue(file, name, settings) {
  return { ...AUDIO_DEFAULTS, id: uid(), file, name, stopFade: settings?.defaultStopFade ?? 2 };
}

export function makeFadeCue() {
  return { ...FADE_DEFAULTS, id: uid() };
}

function normalizeCue(c) {
  const base = c.type === 'fade' ? FADE_DEFAULTS : AUDIO_DEFAULTS;
  const out = { ...base, ...c };
  if (!out.id) out.id = uid();
  out.number = String(out.number ?? '');
  return out;
}

class Store {
  constructor() {
    this.show = null;
    this.dir = null;
    this.selectedId = null;
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.saveState = 'saved';
    this.saveError = '';
    this._saveChain = Promise.resolve();
    this._dirty = false;
    this._lastCoalesce = null;
    this._lastEditAt = 0;
    this._save = debounce(() => this._queueSave(), 400);
  }

  get mode() { return this.show?.settings.mode || 'edit'; }
  get editing() { return this.mode === 'edit'; }
  get cues() { return this.show ? this.show.cues : []; }

  load(dir, show) {
    show.settings = { ...DEFAULT_SETTINGS, ...(show.settings || {}) };
    const seen = new Set();
    show.cues = (show.cues || []).map((c) => {
      const n = normalizeCue(c);
      if (seen.has(n.id)) n.id = uid();
      seen.add(n.id);
      return n;
    });
    this.show = show;
    this.dir = dir;
    this.selectedId = show.cues[0]?.id || null;
    this.undoStack = [];
    this.redoStack = [];
    this.saveState = 'saved';
    this._dirty = false;
    this.emit({ all: true });
  }

  unload() {
    this.show = null;
    this.dir = null;
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(what) {
    for (const fn of [...this.listeners]) {
      try { fn(what); } catch (err) { console.error(err); }
    }
  }

  cue(id) { return this.cues.find((c) => c.id === id) || null; }
  cueIndex(id) { return this.cues.findIndex((c) => c.id === id); }

  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit({ selection: true });
  }

  _snapshot() {
    return JSON.stringify({ name: this.show.name, script: this.show.script, cues: this.show.cues });
  }

  /**
   * Make an undoable change to the show. Refused in Show mode.
   * `coalesce`: a key; repeated edits with the same key in quick succession
   * (e.g. dragging a slider) collapse into one undo step.
   */
  edit(fn, { coalesce = null, what = { cues: true } } = {}) {
    if (!this.show) return false;
    if (!this.editing) { this.emit({ locked: true }); return false; }
    const now = performance.now();
    const merge = coalesce && this._lastCoalesce === coalesce && now - this._lastEditAt < 1500;
    if (!merge) {
      this.undoStack.push(this._snapshot());
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this._lastCoalesce = coalesce;
    this._lastEditAt = now;
    fn(this.show);
    this._changed(what);
    return true;
  }

  /** Change a show setting that is allowed even in Show mode (volume, output, view prefs). */
  pref(fn, what = { settings: true }) {
    if (!this.show) return;
    fn(this.show.settings);
    this._changed(what);
  }

  undo() {
    if (!this.editing || !this.undoStack.length) return false;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    return true;
  }

  redo() {
    if (!this.editing || !this.redoStack.length) return false;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    return true;
  }

  _restore(snap) {
    const s = JSON.parse(snap);
    this.show.name = s.name;
    this.show.script = s.script;
    this.show.cues = s.cues;
    this._lastCoalesce = null;
    if (this.selectedId && !this.cue(this.selectedId)) this.selectedId = this.show.cues[0]?.id || null;
    this._changed({ cues: true, script: true, name: true, selection: true });
  }

  _changed(what) {
    this.show.modifiedAt = new Date().toISOString();
    this._dirty = true;
    this.saveState = 'pending';
    this._save();
    this.emit(what);
  }

  _queueSave() {
    this._saveChain = this._saveChain.then(() => this._write());
    return this._saveChain;
  }

  async _write() {
    if (!this.show || !this._dirty) return;
    this._dirty = false;
    this.saveState = 'saving';
    this.emit({ save: true });
    try {
      await api.saveShow(JSON.stringify(this.show, null, 2));
      this.saveState = this._dirty ? 'pending' : 'saved';
      this.saveError = '';
    } catch (err) {
      this._dirty = true;
      this.saveState = 'error';
      this.saveError = err.message;
      setTimeout(() => this._save(), 5000);
    }
    this.emit({ save: true });
  }

  /** Write any pending change right now (before closing, switching shows, etc). */
  async flush() {
    this._save.cancel();
    await this._queueSave();
  }
}

export const store = new Store();
