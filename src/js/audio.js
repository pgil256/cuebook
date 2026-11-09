// Web Audio playback engine.
//
// Every sound is decoded into memory ahead of time so GO is instant and trims,
// loops and fades are sample-accurate. A memory budget with LRU eviction keeps
// long shows in check; the player preloads around the standby cue.
//
// Signal chain per voice:  source -> fadeGain (fades in/out, stops) -> levelGain (cue volume) -> master -> output

import { clamp, dbToGain } from './util.js';

const MEMORY_BUDGET = 1.5e9; // bytes of decoded audio to keep around

export function mediaUrl(rel) {
  return 'app://local/show/' + rel.split('/').map(encodeURIComponent).join('/');
}

/**
 * Ramp an AudioParam from its current value to `target` over `seconds`.
 * Interpolates in sqrt-gain space (a gentle, natural-sounding curve) using a
 * series of short linear ramps, which never throws "overlapping curve" errors.
 */
function rampParam(ctx, param, target, seconds) {
  const now = ctx.currentTime;
  const from = param.value;
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
  else { param.cancelScheduledValues(now); param.setValueAtTime(from, now); }
  if (!(seconds > 0.015)) {
    param.setValueAtTime(target, now);
    return;
  }
  const a = Math.sqrt(Math.max(0, from));
  const b = Math.sqrt(Math.max(0, target));
  const steps = clamp(Math.ceil(seconds * 30), 6, 240);
  for (let i = 1; i <= steps; i++) {
    const x = i / steps;
    const v = a + (b - a) * x;
    param.linearRampToValueAtTime(v * v, now + seconds * x);
  }
}

export class Voice {
  constructor(engine, cue, buffer, { preview = false } = {}) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.cue = cue;
    this.buffer = buffer;
    this.preview = preview;
    this.state = 'idle'; // idle | playing | stopping | ended
    this.stoppedByUser = false;
    this.onEnded = null;

    const dur = buffer.duration;
    this.trimStart = clamp(Number(cue.trimStart) || 0, 0, Math.max(0, dur - 0.01));
    const end = cue.trimEnd == null || cue.trimEnd === '' ? dur : Number(cue.trimEnd);
    this.trimEnd = clamp(end, this.trimStart + 0.01, dur);
    this.length = this.trimEnd - this.trimStart;
    this.loop = !!cue.loop;
  }

  start() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.01;
    this.t0 = t0;

    this.source = ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.fadeGain = ctx.createGain();
    this.levelGain = ctx.createGain();
    this.levelGain.gain.value = dbToGain(Number(this.cue.volumeDb) || 0);
    this.source.connect(this.fadeGain).connect(this.levelGain).connect(this.engine.master);

    const fadeIn = Math.max(0, Number(this.cue.fadeIn) || 0);
    const fadeOutEnd = Math.max(0, Number(this.cue.fadeOutEnd) || 0);
    const g = this.fadeGain.gain;
    if (fadeIn > 0) {
      g.setValueAtTime(0, t0);
      const steps = clamp(Math.ceil(fadeIn * 30), 6, 240);
      for (let i = 1; i <= steps; i++) { const x = i / steps; g.linearRampToValueAtTime(x * x, t0 + fadeIn * x); }
    } else {
      g.setValueAtTime(1, t0);
    }
    if (!this.loop && fadeOutEnd > 0) {
      const endAt = t0 + this.length;
      const fadeStart = Math.max(t0 + fadeIn, endAt - fadeOutEnd);
      const span = endAt - fadeStart;
      if (span > 0.015) {
        g.setValueAtTime(1, fadeStart);
        const steps = clamp(Math.ceil(span * 30), 6, 240);
        for (let i = 1; i <= steps; i++) { const x = i / steps; g.linearRampToValueAtTime((1 - x) * (1 - x), fadeStart + span * x); }
      }
    }

    if (this.loop) {
      this.source.loop = true;
      this.source.loopStart = this.trimStart;
      this.source.loopEnd = this.trimEnd;
      this.source.start(t0, this.trimStart);
    } else {
      this.source.start(t0, this.trimStart, this.length);
    }
    this.source.onended = () => this._ended();
    this.state = 'playing';
  }

  /** Seconds since the cue started. */
  get elapsed() {
    return this.state === 'idle' ? 0 : Math.max(0, this.ctx.currentTime - this.t0);
  }

  /** Current position inside the audio file, in seconds. */
  get position() {
    const e = this.elapsed;
    return this.loop ? this.trimStart + (e % this.length) : this.trimStart + Math.min(e, this.length);
  }

  get remaining() {
    return this.loop ? Infinity : Math.max(0, this.length - this.elapsed);
  }

  /** 0..1 through the cue (or through the current loop pass). */
  get progress() {
    const e = this.elapsed;
    return this.loop ? (e % this.length) / this.length : clamp(e / this.length, 0, 1);
  }

  setLevelDb(db, seconds = 0) {
    if (this.state !== 'playing' && this.state !== 'stopping') return;
    rampParam(this.ctx, this.levelGain.gain, dbToGain(db), seconds);
  }

  /** Fade to silence over `seconds` and stop. Calling again with a shorter time speeds it up. */
  fadeOutAndStop(seconds) {
    if (this.state === 'ended' || this.state === 'idle') return;
    seconds = Math.max(0, Number(seconds) || 0);
    const stopAt = this.ctx.currentTime + seconds + 0.03;
    if (this.state === 'stopping' && this._stopAt <= stopAt) return;
    this.stoppedByUser = true;
    this.state = 'stopping';
    this._stopAt = stopAt;
    rampParam(this.ctx, this.fadeGain.gain, 0, seconds);
    try { this.source.stop(stopAt); } catch { /* already stopped */ }
  }

  stopNow() {
    if (this.state === 'ended' || this.state === 'idle') return;
    this.stoppedByUser = true;
    this.state = 'stopping';
    rampParam(this.ctx, this.fadeGain.gain, 0, 0.02); // tiny ramp avoids a click
    try { this.source.stop(this.ctx.currentTime + 0.03); } catch { /* already stopped */ }
  }

  _ended() {
    if (this.state === 'ended') return;
    const natural = !this.stoppedByUser;
    this.state = 'ended';
    try { this.source.disconnect(); this.fadeGain.disconnect(); this.levelGain.disconnect(); } catch { /* ignore */ }
    if (this.onEnded) this.onEnded(natural);
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.cache = new Map(); // file -> { promise, buffer, bytes, usedAt, error }
    this.peaks = new Map(); // file -> Float32Array of min/max pairs
    this.sinkId = '';
    this.onLoadStateChange = null;
  }

  async resume() {
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* reported by caller */ }
    }
  }

  async setOutput(deviceId) {
    const id = deviceId || '';
    if (typeof this.ctx.setSinkId !== 'function') throw new Error('Choosing an output device is not supported here.');
    await this.ctx.setSinkId(id);
    this.sinkId = id;
  }

  setMasterDb(db) {
    rampParam(this.ctx, this.master.gain, dbToGain(db), 0.05);
  }

  status(file) {
    const e = this.cache.get(file);
    if (!e) return 'unloaded';
    if (e.error) return 'error';
    return e.buffer ? 'ready' : 'loading';
  }

  peek(file) {
    const e = this.cache.get(file);
    if (e && e.buffer) { e.usedAt = performance.now(); return e.buffer; }
    return null;
  }

  duration(file) {
    const e = this.cache.get(file);
    return e && e.buffer ? e.buffer.duration : null;
  }

  error(file) {
    const e = this.cache.get(file);
    return e && e.error ? e.error : null;
  }

  /** Decode a show-relative audio file (cached; concurrent calls share one load). */
  load(file) {
    let e = this.cache.get(file);
    if (e && !e.error) { e.usedAt = performance.now(); return e.promise; }
    e = { buffer: null, bytes: 0, usedAt: performance.now(), error: null };
    e.promise = (async () => {
      const res = await fetch(mediaUrl(file));
      if (!res.ok) throw new Error(res.status === 404 ? 'File not found in the show folder' : `Could not read file (${res.status})`);
      const data = await res.arrayBuffer();
      try {
        return await this.ctx.decodeAudioData(data);
      } catch {
        throw new Error('This audio file could not be decoded (unsupported or damaged)');
      }
    })().then((buffer) => {
      e.buffer = buffer;
      e.bytes = buffer.length * buffer.numberOfChannels * 4;
      this._notify(file);
      return buffer;
    }, (err) => {
      e.error = err.message || String(err);
      this._notify(file);
      throw err;
    });
    this.cache.set(file, e);
    this._notify(file);
    return e.promise;
  }

  _notify(file) {
    if (this.onLoadStateChange) this.onLoadStateChange(file);
  }

  forget(file) {
    this.cache.delete(file);
    this.peaks.delete(file);
  }

  get bytesUsed() {
    let n = 0;
    for (const e of this.cache.values()) n += e.bytes;
    return n;
  }

  get hasRoom() { return this.bytesUsed < MEMORY_BUDGET * 0.85; }

  /** Drop least-recently-used buffers that aren't protected until under budget. */
  evict(protectedFiles) {
    let used = this.bytesUsed;
    if (used <= MEMORY_BUDGET) return;
    const candidates = [...this.cache.entries()]
      .filter(([f, e]) => e.buffer && !protectedFiles.has(f))
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [f, e] of candidates) {
      if (used <= MEMORY_BUDGET * 0.8) break;
      used -= e.bytes;
      this.cache.delete(f);
      this.peaks.delete(f);
    }
  }

  clear() {
    this.cache.clear();
    this.peaks.clear();
  }

  createVoice(cue, buffer, opts) {
    return new Voice(this, cue, buffer, opts);
  }

  /** Min/max pairs for drawing a waveform, computed once per file. */
  getPeaks(file, columns = 1600) {
    const cached = this.peaks.get(file);
    if (cached) return cached;
    const buffer = this.peek(file);
    if (!buffer) return null;
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const len = buffer.length;
    const per = Math.max(1, Math.floor(len / columns));
    const out = new Float32Array(columns * 2);
    for (let col = 0; col < columns; col++) {
      let min = 0, max = 0;
      const start = col * per;
      const end = Math.min(len, start + per);
      // Sample a subset of each column for speed on long files.
      const stride = Math.max(1, Math.floor((end - start) / 400));
      for (let i = start; i < end; i += stride) {
        for (const ch of chans) {
          const v = ch[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      out[col * 2] = min;
      out[col * 2 + 1] = max;
    }
    this.peaks.set(file, out);
    return out;
  }

  /** Short beep to check the output routing. */
  testTone() {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 880;
    const t = ctx.currentTime + 0.01;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15, t + 0.02);
    g.gain.setValueAtTime(0.15, t + 0.35);
    g.gain.linearRampToValueAtTime(0, t + 0.45);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.5);
  }
}
