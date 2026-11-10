// One <audio> element: load a track, play/pause, stop, seek, volume.

import { clamp } from './util.js';

export class Player {
  constructor() {
    const a = this.audio = new Audio();
    a.preload = 'auto';
    this.track = null;
    this.onChange = null; // play/pause/seek/load state changed
    this.onEnded = null;  // the track played to the end
    this.onError = null;  // (track) the file couldn't be played
    const changed = () => this.onChange && this.onChange();
    for (const ev of ['play', 'pause', 'loadedmetadata', 'durationchange', 'seeked', 'emptied']) a.addEventListener(ev, changed);
    a.addEventListener('ended', () => this.onEnded && this.onEnded());
    a.addEventListener('error', () => {
      if (this.track && a.getAttribute('src') && this.onError) this.onError(this.track);
    });
  }

  load(track, url) {
    this.track = track;
    this.audio.src = url;
    this.audio.load();
    if (this.onChange) this.onChange();
  }

  unload() {
    this.track = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.onChange) this.onChange();
  }

  async play() {
    if (!this.track) return;
    if (this.audio.error) { if (this.onError) this.onError(this.track); return; }
    if (this.audio.ended) this.audio.currentTime = 0;
    try {
      await this.audio.play();
    } catch (err) {
      // AbortError: another track was loaded meanwhile. NotSupportedError: reported by the 'error' event.
      if (err.name !== 'AbortError' && err.name !== 'NotSupportedError' && this.onError) this.onError(this.track);
    }
  }

  pause() { this.audio.pause(); }

  /** Pause and go back to the start of the track. */
  stop() {
    this.audio.pause();
    if (this.track && this.duration) this.audio.currentTime = 0;
    if (this.onChange) this.onChange();
  }

  get playing() { return !!this.track && !this.audio.paused && !this.audio.ended; }
  get time() { return this.audio.currentTime || 0; }
  get duration() { const d = this.audio.duration; return Number.isFinite(d) ? d : 0; }

  seek(seconds) {
    if (!this.track || !this.duration) return;
    this.audio.currentTime = clamp(seconds, 0, Math.max(0, this.duration - 0.05));
  }

  /** volume 0..1 (squared, so the slider feels even), muted on/off */
  setVolume(volume, muted) {
    this.audio.volume = clamp(volume, 0, 1) ** 2;
    this.audio.muted = !!muted;
  }
}
