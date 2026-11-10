// Cuebook: a simple media player for a show.
// Script on the left, playlist on the right, player controls along the bottom.

import { h, $, clamp, uid, formatTime, debounce, basename, isAudioPath, isScriptPath } from './util.js';
import { icon } from './icons.js';
import { Player } from './player.js';
import { ScriptView } from './script-view.js';
import { Home } from './home.js';
import { modal, confirmDialog, toast, clearToasts, isModalOpen, closeModal } from './dialogs.js';

const api = window.cuebook;
const player = new Player();
const TRACK_DRAG = 'application/x-cuebook-track';

const state = {
  dir: null,
  show: null,              // { name, script, volume, tracks: [{ id, file, name }] }
  selectedId: null,
  durations: new Map(),    // file -> seconds | null (unknown) | 'error'
  missing: new Set(),      // files not found in the show folder
  muted: false,
  lastRemoved: null,       // { track, index } for Undo
  dirty: false,
};

const els = {};
let scriptView;
let home;

const mediaUrl = (rel) => 'app://local/show/' + rel.split('/').map(encodeURIComponent).join('/');
const tracks = () => (state.show ? state.show.tracks : []);
const trackById = (id) => tracks().find((t) => t.id === id) || null;
const indexOf = (id) => tracks().findIndex((t) => t.id === id);
const tidyName = (name) => name.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ saving

let saveChain = Promise.resolve();
function writeShow() {
  saveChain = saveChain.then(async () => {
    if (!state.show || !state.dirty) return;
    state.dirty = false;
    state.show.modifiedAt = new Date().toISOString();
    try {
      await api.saveShow(JSON.stringify(state.show, null, 2));
    } catch (err) {
      state.dirty = true;
      toast(`Couldn't save the show: ${err.message}. Trying again…`, 'error');
      setTimeout(() => save(), 5000);
    }
  });
  return saveChain;
}
const save = debounce(writeShow, 400);
function changed() { state.dirty = true; save(); }
async function flushSave() { save.cancel(); await writeShow(); }

// ------------------------------------------------------------------ playback

function playTrack(id) {
  const t = trackById(id);
  if (!t) return;
  if (state.missing.has(t.file)) { toast(`The music file for “${t.name}” is missing from the show folder.`, 'error'); return; }
  if (player.track && player.track.id === id) player.seek(0);
  else player.load(t, mediaUrl(t.file));
  select(id, true);
  player.play();
}

/** Space / the big button. With nothing loaded, starts the selected (or first) track. */
function togglePlay() {
  if (!player.track) {
    const t = trackById(state.selectedId) || tracks()[0];
    if (t) playTrack(t.id);
    return;
  }
  if (player.playing) player.pause(); else player.play();
}

/** Load the next/previous track; keep playing if we were playing. */
function step(delta) {
  const ts = tracks();
  const base = player.track ? indexOf(player.track.id) : indexOf(state.selectedId);
  const i = base + delta;
  if (i < 0 || i >= ts.length) return;
  const wasPlaying = player.playing;
  player.load(ts[i], mediaUrl(ts[i].file));
  select(ts[i].id, true);
  if (wasPlaying) player.play();
}

/** Previous: restart the song if it has been playing a few seconds, otherwise go back a track. */
function prev() {
  if (player.track && player.time > 3) player.seek(0);
  else step(-1);
}

/** When a song finishes, get the next one ready (but don't start it). */
function onTrackEnded() {
  const nextTrack = tracks()[indexOf(player.track && player.track.id) + 1];
  if (nextTrack) {
    player.load(nextTrack, mediaUrl(nextTrack.file));
    select(nextTrack.id, true);
  } else {
    player.stop();
  }
}

function onPlayError(t) {
  state.durations.set(t.file, 'error');
  updateRows();
  toast(`Couldn't play “${t.name}”. The file is missing or isn't a supported audio format.`, 'error');
}

function applyVolume() {
  const v = clamp(Number(state.show?.volume ?? 1), 0, 1);
  player.setVolume(v, state.muted);
  els.vol.value = String(Math.round(v * 100));
  els.volVal.textContent = state.muted ? 'Muted' : `${Math.round(v * 100)}%`;
  els.mute.innerHTML = '';
  els.mute.append(icon(state.muted || v === 0 ? 'mute' : 'volume'));
  els.mute.title = state.muted ? 'Unmute' : 'Mute';
}

// ------------------------------------------------------------------ playlist

function select(id, scroll = false) {
  state.selectedId = id;
  updateRows();
  if (scroll) {
    const row = els.list.querySelector(`.track[data-id="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

function moveSelection(delta) {
  const ts = tracks();
  if (!ts.length) return;
  let i = indexOf(state.selectedId);
  if (i < 0) i = delta > 0 ? -1 : ts.length;
  select(ts[clamp(i + delta, 0, ts.length - 1)].id, true);
}

async function addAudio(paths, index = null) {
  let results;
  try {
    results = await api.importMedia(paths);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  for (const r of results) if (r.error) toast(r.error, 'warn');
  const ok = results.filter((r) => r.file);
  if (!ok.length || !state.show) return;
  const at = index == null ? tracks().length : clamp(index, 0, tracks().length);
  const added = ok.map((r) => ({ id: uid('t'), file: r.file, name: tidyName(r.name) }));
  state.show.tracks.splice(at, 0, ...added);
  for (const t of added) { state.missing.delete(t.file); if (state.durations.get(t.file) === 'error') state.durations.delete(t.file); }
  if (!state.selectedId) state.selectedId = added[0].id;
  changed();
  renderPlaylist();
  loadDurations();
}

async function addAudioDialog() {
  const paths = await api.pickAudio().catch(() => []);
  if (paths.length) await addAudio(paths);
}

async function removeTrack(id) {
  const i = indexOf(id);
  if (i < 0) return;
  const t = tracks()[i];
  const isCurrent = player.track && player.track.id === id;
  if (isCurrent && player.playing) {
    const ok = await confirmDialog('Remove the song that is playing?', `“${t.name}” will stop and be taken off the playlist.`, { ok: 'Stop and remove', danger: true });
    if (!ok || indexOf(id) < 0) return;
  }
  state.show.tracks.splice(indexOf(id), 1);
  if (isCurrent) player.unload();
  if (state.selectedId === id) state.selectedId = (tracks()[i] || tracks()[i - 1] || {}).id || null;
  state.lastRemoved = { track: t, index: i };
  changed();
  renderPlaylist();
  toast(`Removed “${t.name}”.`, 'info', { action: { label: 'Undo', run: undoRemove } });
}

function undoRemove() {
  const r = state.lastRemoved;
  if (!r || !state.show) return;
  state.lastRemoved = null;
  state.show.tracks.splice(Math.min(r.index, tracks().length), 0, r.track);
  state.selectedId = r.track.id;
  changed();
  renderPlaylist();
}

function moveTrack(id, toIndex) {
  const from = indexOf(id);
  if (from < 0) return;
  const to = toIndex > from ? toIndex - 1 : toIndex;
  if (to === from) return;
  const [t] = state.show.tracks.splice(from, 1);
  state.show.tracks.splice(to, 0, t);
  changed();
  renderPlaylist();
}

function renderPlaylist() {
  const ts = tracks();
  els.count.textContent = ts.length ? `${ts.length} song${ts.length === 1 ? '' : 's'}` : '';
  els.list.innerHTML = '';
  els.playlistEmpty.classList.toggle('hidden', ts.length > 0);
  els.listScroll.classList.toggle('hidden', ts.length === 0);
  for (const t of ts) {
    const playBtn = h('button', { class: 'tr-play', title: 'Play', onclick: (e) => { e.stopPropagation(); rowPlay(t.id); } }, icon('play'));
    els.list.append(h('div', { class: 'track', draggable: 'true', dataset: { id: t.id } },
      h('span', { class: 'tr-num' }, h('span', { class: 'tr-index' }), playBtn),
      h('div', { class: 'tr-main' }, h('div', { class: 'tr-name', text: t.name, title: t.name }), h('div', { class: 'tr-sub' })),
      h('span', { class: 'tr-dur' }),
      h('button', { class: 'tr-remove', title: 'Remove from the playlist (Delete)', onclick: (e) => { e.stopPropagation(); removeTrack(t.id); } }, icon('close'))));
  }
  updateRows();
  refreshPlayerState();
}

/** The little play button on a row: plays that song, or pauses it if it's the one playing. */
function rowPlay(id) {
  if (player.track && player.track.id === id) togglePlay();
  else playTrack(id);
}

/** Cheap refresh of row highlights, durations and problems. */
function updateRows() {
  if (!els.list) return;
  [...els.list.children].forEach((row, i) => {
    const t = trackById(row.dataset.id);
    if (!t) return;
    const current = !!player.track && player.track.id === t.id;
    const playing = current && player.playing;
    row.classList.toggle('selected', t.id === state.selectedId);
    row.classList.toggle('current', current);
    row.classList.toggle('playing', playing);

    const idx = row.querySelector('.tr-index');
    const mode = playing ? 'playing' : current ? 'paused' : `n${i + 1}`;
    if (idx.dataset.mode !== mode) {
      idx.dataset.mode = mode;
      idx.innerHTML = '';
      if (playing) idx.append(h('span', { class: 'eq' }, h('i'), h('i'), h('i')));
      else if (current) idx.append(icon('pause'));
      else idx.textContent = String(i + 1);
    }
    const btn = row.querySelector('.tr-play');
    const want = playing ? 'pause' : 'play';
    if (btn.dataset.icon !== want) { btn.dataset.icon = want; btn.innerHTML = ''; btn.append(icon(want)); btn.title = playing ? 'Pause' : 'Play'; }

    const d = state.durations.get(t.file);
    const missing = state.missing.has(t.file);
    row.classList.toggle('bad', missing || d === 'error');
    row.querySelector('.tr-dur').textContent = typeof d === 'number' ? formatTime(d) : '';
    row.querySelector('.tr-sub').textContent = missing ? 'File missing from the show folder' : d === 'error' ? "Can't play this file" : '';
  });
}

let durationToken = 0;
/** Look up each song's length (just the file header) to show in the list. */
async function loadDurations() {
  const token = ++durationToken;
  for (const t of [...tracks()]) {
    if (token !== durationToken || !state.show) return;
    if (state.durations.has(t.file) || state.missing.has(t.file)) continue;
    const d = await probeDuration(mediaUrl(t.file));
    if (token !== durationToken) return;
    state.durations.set(t.file, d);
    updateRows();
  }
}

function probeDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      a.load();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 10000);
    a.addEventListener('loadedmetadata', () => done(Number.isFinite(a.duration) ? a.duration : null));
    a.addEventListener('error', () => done('error'));
    a.src = url;
  });
}

// ------------------------------------------------------------------ player bar

function refreshPlayerState() {
  if (!state.show) return;
  const t = player.track;
  const playing = player.playing;
  const want = playing ? 'pause' : 'play';
  if (els.play.dataset.icon !== want) { els.play.dataset.icon = want; els.play.innerHTML = ''; els.play.append(icon(want)); }
  els.play.title = playing ? 'Pause (Space)' : 'Play (Space)';
  const label = !t ? '' : playing ? 'Playing' : player.time < 0.05 ? 'Ready' : 'Paused';
  els.nowLabel.textContent = label;
  els.nowLabel.className = `now-label ${label.toLowerCase()}`;
  els.nowName.textContent = t ? t.name
    : tracks().length ? 'Press play, or double-click a song' : 'Add music to the playlist to get started';
  els.nowName.classList.toggle('idle', !t);
  updateRows();
  if (state.awake !== playing) { state.awake = playing; api.keepAwake(playing).catch(() => {}); }
}

let seekDrag = null; // time the seek handle is being dragged to

function seekTimeAt(clientX) {
  const r = els.seek.getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * player.duration;
}

function buildPlayerBar() {
  els.prev = h('button', { class: 'pb-btn', title: 'Previous song (or back to the start of this one)', onclick: prev }, icon('prev'));
  els.play = h('button', { class: 'pb-play', title: 'Play (Space)', onclick: togglePlay }, icon('play'));
  els.stop = h('button', { class: 'pb-btn', title: 'Stop (Esc)', onclick: () => player.stop() }, icon('stop'));
  els.next = h('button', { class: 'pb-btn', title: 'Next song', onclick: () => step(1) }, icon('next'));
  els.nowLabel = h('span', { class: 'now-label' });
  els.nowName = h('span', { class: 'now-name' });
  els.elapsed = h('span', { class: 'time' });
  els.remaining = h('span', { class: 'time remaining' });
  els.fill = h('div', { class: 'seek-fill' });
  els.thumb = h('div', { class: 'seek-thumb' });
  els.tip = h('div', { class: 'seek-tip hidden' });
  els.seek = h('div', { class: 'seek disabled', title: 'Click or drag to jump to any point' }, h('div', { class: 'seek-track' }, els.fill), els.thumb, els.tip);
  els.mute = h('button', { class: 'pb-btn small', onclick: () => { state.muted = !state.muted; applyVolume(); } });
  els.vol = h('input', { type: 'range', min: '0', max: '100', step: '1', class: 'vol', title: 'Volume' });
  els.volVal = h('span', { class: 'vol-val' });
  els.vol.addEventListener('input', () => {
    state.show.volume = Number(els.vol.value) / 100;
    state.muted = false;
    applyVolume();
    changed();
  });
  els.vol.addEventListener('change', () => els.vol.blur());

  $('#playerBar').append(
    h('div', { class: 'pb-transport' }, els.prev, els.play, els.stop, els.next),
    h('div', { class: 'pb-now' },
      h('div', { class: 'now-head' }, els.nowLabel, els.nowName),
      h('div', { class: 'seek-row' }, els.elapsed, els.seek, els.remaining)),
    h('div', { class: 'pb-volume' }, els.mute, els.vol, els.volVal));

  const s = els.seek;
  s.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !player.track || !player.duration) return;
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    s.classList.add('dragging');
    seekDrag = seekTimeAt(e.clientX);
    player.seek(seekDrag);
  });
  s.addEventListener('pointermove', (e) => {
    if (!player.track || !player.duration) { els.tip.classList.add('hidden'); return; }
    const t = seekTimeAt(e.clientX);
    const r = s.getBoundingClientRect();
    els.tip.textContent = formatTime(t);
    els.tip.style.left = `${clamp(e.clientX - r.left, 0, r.width)}px`;
    els.tip.classList.remove('hidden');
    if (seekDrag !== null) { seekDrag = t; player.seek(t); }
  });
  const endDrag = () => { if (seekDrag !== null) { seekDrag = null; s.classList.remove('dragging'); } };
  s.addEventListener('pointerup', endDrag);
  s.addEventListener('pointercancel', endDrag);
  s.addEventListener('pointerleave', () => { if (seekDrag === null) els.tip.classList.add('hidden'); });
}

/** Every frame: move the seek bar and the clocks. */
function frame() {
  if (state.show) {
    const dur = player.duration;
    const pos = seekDrag ?? player.time;
    const pct = `${((dur ? clamp(pos / dur, 0, 1) : 0) * 100).toFixed(3)}%`;
    if (els.pct !== pct) { els.pct = pct; els.fill.style.width = pct; els.thumb.style.left = pct; }
    const el = formatTime(pos);
    const rem = `−${formatTime(dur ? dur - pos : 0)}`;
    if (els.elapsed.textContent !== el) els.elapsed.textContent = el;
    if (els.remaining.textContent !== rem) els.remaining.textContent = rem;
    const off = !player.track || !dur;
    if (els.seekOff !== off) { els.seekOff = off; els.seek.classList.toggle('disabled', off); }
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ playlist pane & drops

function buildPlaylistPane() {
  els.count = h('span', { class: 'pane-sub' });
  els.list = h('div', { class: 'track-list' });
  els.dropLine = h('div', { class: 'drop-line hidden' });
  els.listScroll = h('div', { class: 'track-scroll' }, els.list, els.dropLine);
  els.playlistEmpty = h('div', { class: 'pane-empty' },
    h('div', { class: 'dropzone' },
      icon('music', 'big'),
      h('h3', { text: 'Drop music here' }),
      h('p', { text: 'MP3, WAV, M4A, OGG or FLAC. The files are copied into the show folder.' }),
      h('button', { class: 'btn primary', onclick: addAudioDialog }, icon('plus'), h('span', { text: 'Add music…' }))));
  const pane = $('#playlistPane');
  pane.append(
    h('div', { class: 'pane-toolbar' },
      h('span', { class: 'pane-label', text: 'Playlist' }), els.count, h('div', { class: 'spacer' }),
      h('button', { class: 'tb-btn', title: 'Add music files', onclick: addAudioDialog }, icon('plus'), h('span', { text: 'Add music…' }))),
    h('div', { class: 'pane-body', dataset: { drop: 'Drop music here' } }, els.listScroll, els.playlistEmpty));

  els.list.addEventListener('click', (e) => {
    const row = e.target.closest('.track');
    if (row) select(row.dataset.id);
  });
  els.list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.track');
    if (row && !e.target.closest('button')) playTrack(row.dataset.id);
  });
  els.list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.track');
    if (!row) return;
    e.dataTransfer.setData(TRACK_DRAG, row.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  els.list.addEventListener('dragend', () => {
    els.list.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
    els.dropLine.classList.add('hidden');
  });

  // Dropping onto the playlist: reorder songs, or add music files at that spot.
  pane.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    const internal = types.includes(TRACK_DRAG);
    if (!internal && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    document.body.classList.add('drop-on-playlist');
    if (!tracks().length) return;
    const { y } = dropIndexAt(e.clientY);
    const sr = els.listScroll.getBoundingClientRect();
    els.dropLine.style.top = `${y - sr.top + els.listScroll.scrollTop - 1}px`;
    els.dropLine.classList.remove('hidden');
  });
  pane.addEventListener('dragleave', (e) => {
    if (!pane.contains(e.relatedTarget)) { els.dropLine.classList.add('hidden'); document.body.classList.remove('drop-on-playlist'); }
  });
  pane.addEventListener('drop', async (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes(TRACK_DRAG) && !types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    endFileDrag();
    const { index } = dropIndexAt(e.clientY);
    if (types.includes(TRACK_DRAG)) moveTrack(e.dataTransfer.getData(TRACK_DRAG), index);
    else await handleDroppedFiles(e.dataTransfer.files, index);
  });
}

function dropIndexAt(clientY) {
  const rows = [...els.list.children];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return { index: i, y: r.top };
  }
  const last = rows[rows.length - 1];
  return { index: rows.length, y: last ? last.getBoundingClientRect().bottom : 0 };
}

/** Scripts go to the script pane, music goes to the playlist. */
async function handleDroppedFiles(files, index = null) {
  const paths = [...files].map((f) => api.pathForFile(f)).filter(Boolean);
  const scripts = paths.filter(isScriptPath);
  const audio = paths.filter(isAudioPath);
  const other = paths.filter((p) => !isScriptPath(p) && !isAudioPath(p));
  if (scripts.length) await importScript(scripts[0]);
  if (audio.length) await addAudio(audio, index);
  if (other.length) toast(`Skipped ${other.length === 1 ? `“${basename(other[0])}”` : `${other.length} files`}: not music or a script.`, 'warn');
}

function endFileDrag() {
  document.body.classList.remove('drag-files', 'drop-on-playlist');
  if (els.dropLine) els.dropLine.classList.add('hidden');
}

function wireDrops() {
  const screen = $('#showScreen');
  screen.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('drag-files');
  });
  screen.addEventListener('drop', async (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    endFileDrag();
    await handleDroppedFiles(e.dataTransfer.files);
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) endFileDrag(); });
  document.addEventListener('dragend', endFileDrag);
  // Files dropped anywhere else must never navigate the window away.
  window.addEventListener('dragover', (e) => { if (!e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
  window.addEventListener('drop', (e) => { e.preventDefault(); endFileDrag(); });
}

async function importScript(path) {
  try {
    const info = await api.importScript(path);
    state.show.script = info;
    changed();
    await scriptView.load(info);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function pickScript() {
  const p = await api.pickScript().catch(() => null);
  if (p) await importScript(p);
}

// ------------------------------------------------------------------ shows

function showScreen(which) {
  $('#home').classList.toggle('hidden', which !== 'home');
  $('#showScreen').classList.toggle('hidden', which !== 'show');
}

/** Older shows stored a cue list; keep their sound files as playlist songs. */
function normalize(show) {
  if (!Array.isArray(show.tracks)) {
    show.tracks = (show.cues || [])
      .filter((c) => c && c.type === 'audio' && c.file)
      .map((c) => ({ id: c.id || uid('t'), file: c.file, name: c.name || basename(c.file) }));
  }
  const seen = new Set();
  for (const t of show.tracks) {
    if (!t.id || seen.has(t.id)) t.id = uid('t');
    seen.add(t.id);
  }
  if (typeof show.volume !== 'number') show.volume = 1;
  show.version = 2;
  return show;
}

async function openShow({ dir, show }) {
  if (state.show) { player.unload(); await flushSave(); }
  player.unload();
  state.dir = dir;
  state.show = normalize(show);
  state.selectedId = show.tracks[0]?.id || null;
  state.durations.clear();
  state.missing.clear();
  state.lastRemoved = null;
  state.muted = false;
  clearToasts();
  els.showName.textContent = show.name;
  api.setTitle(`${show.name} — Cuebook`);
  showScreen('show');
  applyVolume();
  renderPlaylist();
  if (show.__restoredFromBackup) {
    delete show.__restoredFromBackup;
    toast('The show file was damaged, so the last good backup was opened instead.', 'warn', { ms: 10000 });
  }
  scriptView.load(show.script);
  const files = [...new Set(tracks().map((t) => t.file))];
  if (files.length) {
    try {
      const found = await api.checkFiles(files);
      for (const f of files) if (!found[f]) state.missing.add(f);
    } catch { /* leave as is */ }
    updateRows();
    if (state.missing.size) toast(`${state.missing.size} music file${state.missing.size === 1 ? ' is' : 's are'} missing from the show folder. They're marked in red.`, 'error', { ms: 12000 });
  }
  loadDurations();
}

async function closeShow() {
  if (!state.show) return;
  if (player.playing && !(await confirmDialog('Close the show?', 'The music will stop.', { ok: 'Stop and close', danger: true }))) return;
  player.unload();
  await flushSave();
  await api.closeShow().catch(() => {});
  state.show = null;
  state.dir = null;
  durationToken++;
  await scriptView.load(null);
  clearToasts();
  api.setTitle('Cuebook');
  showScreen('home');
  home.render();
}

function showShortcuts() {
  const rows = [
    ['Space', 'Play / pause'],
    ['Esc', 'Stop (back to the start of the song)'],
    ['← / →', 'Jump back / forward 5 seconds'],
    ['↑ / ↓', 'Select the previous / next song'],
    ['Enter', 'Play the selected song'],
    ['Delete', 'Remove the selected song from the playlist'],
  ];
  modal({
    title: 'Keyboard shortcuts',
    body: h('table', { class: 'shortcuts' }, rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', { text: k })), h('td', { text: d })))),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

// ------------------------------------------------------------------ keyboard

function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(el.type);
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (isModalOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
      return;
    }
    if (!state.show || isTyping(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!e.repeat) togglePlay();
        break;
      case 'Escape': e.preventDefault(); player.stop(); break;
      case 'ArrowLeft': e.preventDefault(); player.seek(player.time - 5); break;
      case 'ArrowRight': e.preventDefault(); player.seek(player.time + 5); break;
      case 'ArrowUp': e.preventDefault(); moveSelection(-1); break;
      case 'ArrowDown': e.preventDefault(); moveSelection(1); break;
      case 'Enter': if (state.selectedId) { e.preventDefault(); playTrack(state.selectedId); } break;
      case 'Delete':
      case 'Backspace': if (state.selectedId) { e.preventDefault(); removeTrack(state.selectedId); } break;
      default:
        if (ctrl && e.key.toLowerCase() === 'z' && state.lastRemoved) { e.preventDefault(); undoRemove(); }
    }
  }, true);
  // A focused button would otherwise be "clicked" by Space on key-up.
  window.addEventListener('keyup', (e) => { if (e.key === ' ' && !isTyping(e.target) && !isModalOpen()) e.preventDefault(); }, true);
  // Buttons shouldn't keep keyboard focus after a mouse click.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && e.detail > 0) b.blur();
  });
}

function wireSplitter() {
  const ws = $('#workspace');
  let w = 55;
  try { w = Number(localStorage.getItem('cuebook.scriptW')) || 55; } catch { /* default */ }
  ws.style.setProperty('--script-w', `${w}%`);
  const handle = $('#splitter');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    const move = (ev) => {
      const r = ws.getBoundingClientRect();
      w = clamp(((ev.clientX - r.left) / r.width) * 100, 25, 75);
      ws.style.setProperty('--script-w', `${w}%`);
    };
    const up = () => {
      handle.classList.remove('active');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      try { localStorage.setItem('cuebook.scriptW', w.toFixed(1)); } catch { /* ignore */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  els.showName = h('div', { class: 'show-name' });
  $('#topbar').append(
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), h('span', { text: 'Cuebook' })),
    els.showName,
    h('div', { class: 'spacer' }),
    h('button', { class: 'tb-btn', title: 'Open the show folder in Explorer', onclick: () => api.reveal().catch(() => {}) }, icon('folder'), h('span', { text: 'Show folder' })),
    h('button', { class: 'tb-btn', title: 'Close this show', onclick: closeShow }, icon('close'), h('span', { text: 'Close show' })));

  scriptView = new ScriptView($('#scriptPane'), { onPick: pickScript, mediaUrl });
  buildPlaylistPane();
  buildPlayerBar();
  home = new Home($('#home'), { onOpen: openShow, toast });

  player.onChange = refreshPlayerState;
  player.onEnded = onTrackEnded;
  player.onError = onPlayError;

  wireKeyboard();
  wireDrops();
  wireSplitter();
  requestAnimationFrame(frame);

  api.onMenu((cmd) => {
    if (cmd === 'reveal' && state.show) api.reveal().catch(() => {});
    if (cmd === 'close-show') closeShow();
    if (cmd === 'shortcuts') showShortcuts();
  });
  api.onBeforeClose(async () => {
    try { await flushSave(); } catch { /* reported already */ }
    api.closeReply({ needsConfirm: player.playing, reason: 'Music is still playing. Quit anyway?' });
  });

  // Reopen the show after a crash, or a .cuebook file passed on the command line.
  const pending = await api.takePendingOpen().catch(() => null);
  if (pending && pending.dir) {
    try {
      await openShow(await api.openShow(pending.dir));
      if (pending.reason === 'crash') toast('Cuebook restarted after a problem and reopened your show.', 'warn', { ms: 12000 });
      return;
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  showScreen('home');
  await home.render();
}

// For automated tests and debugging from DevTools.
window.__cuebook = {
  state, player, openShow, closeShow,
  actions: { playTrack, togglePlay, step, prev, addAudio, importScript, removeTrack, undoRemove, moveTrack },
  get scriptView() { return scriptView; },
};

boot();
