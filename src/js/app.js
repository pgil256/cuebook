// Cuebook renderer entry: wires the store, audio engine and player to the UI,
// owns every user action, keyboard handling and the per-frame update loop.

import { h, $, numberBetween, compareAnchors, basename } from './util.js';
import { icon } from './icons.js';
import { store, makeAudioCue, makeFadeCue } from './store.js';
import { AudioEngine } from './audio.js';
import { Player } from './player.js';
import { ScriptView } from './script-view.js';
import { CueList } from './cue-list.js';
import { Inspector } from './inspector.js';
import { Transport } from './transport.js';
import { Home } from './home.js';
import { modal, confirmDialog, toast, isModalOpen, closeModal } from './dialogs.js';

const api = window.cuebook;
const engine = new AudioEngine();
const player = new Player(engine);

let scriptView, cueList, inspector, transport, home;

// ---------------------------------------------------------------- actions

function requireEdit() {
  if (store.editing) return true;
  toast('The show is locked in Show mode. Switch to Edit to make changes.', 'warn');
  return false;
}

function prettyName(name) {
  return name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Where a new cue dropped at `anchor` belongs in the list: after the last cue pinned at or before it. */
function indexForAnchor(cues, anchor) {
  let last = -1, firstPinned = -1;
  cues.forEach((c, i) => {
    if (!c.anchor || !scriptView.isPlaceable(c.anchor)) return;
    if (firstPinned < 0) firstPinned = i;
    if (compareAnchors(c.anchor, anchor) <= 0) last = i;
  });
  if (last >= 0) return last + 1;
  return firstPinned >= 0 ? firstPinned : cues.length;
}

const actions = {
  go() {
    if (!store.show) return;
    const r = player.go();
    if (r === 'empty' && store.cues.length) toast('End of the cue list. Double-click a cue or use ↑ ↓ to choose the next one.', 'info', 2500);
  },

  async setMode(mode) {
    if (!store.show || store.mode === mode) return;
    if (mode === 'edit') {
      const ok = await confirmDialog('Unlock editing?', 'Edit mode lets cues be changed, moved and deleted. Switch back to Show mode before the performance.', { ok: 'Unlock' });
      if (!ok) return;
    }
    scriptView.cancelPinMode();
    store.pref((s) => { s.mode = mode; }, { mode: true });
    api.setShowMode(mode === 'show').catch(() => {});
  },

  async setOutput(deviceId) {
    const dev = (transport.devices || []).find((d) => d.deviceId === deviceId);
    try {
      await engine.setOutput(deviceId);
      store.pref((s) => { s.outputDeviceId = deviceId; s.outputDeviceLabel = dev ? dev.label : ''; }, { output: true });
      toast(deviceId ? `Sound now goes to “${dev ? dev.label : 'the selected output'}”.` : 'Sound now goes to the system default output.', 'info', 2500);
    } catch (err) {
      toast(`Couldn't use that output: ${err.message}`, 'error');
      transport.refreshDevices();
    }
  },

  async resetClock() {
    if (player.showClockStart === null) return;
    if (await confirmDialog('Reset the show clock?', 'The running time goes back to 00:00:00 and starts again on the next GO.', { ok: 'Reset' })) player.resetShowClock();
  },

  async closeShow() {
    if (!store.show) return;
    if (player.playing && !(await confirmDialog('Close the show?', 'Sound is still playing. It will stop.', { ok: 'Stop and close', danger: true }))) return;
    player.silence();
    player.cancelPreload();
    await store.flush().catch(() => {});
    await api.closeShow().catch(() => {});
    await api.setShowMode(false).catch(() => {});
    store.unload();
    engine.clear();
    await scriptView.load(null);
    player.standbyId = null;
    player.showClockStart = null;
    $('#toasts').innerHTML = ''; // messages about the closed show no longer apply
    showScreen('home');
    api.setTitle('Cuebook');
    home.render();
  },

  // ----- script -----

  async importScriptDialog() {
    if (!requireEdit()) return;
    const p = await api.pickScript().catch((e) => { toast(e.message, 'error'); return null; });
    if (p) await actions.importScript(p);
  },

  async importScript(path) {
    if (!requireEdit()) return;
    if (store.show.script) {
      const ok = await confirmDialog('Replace the script?', `“${basename(path)}” will replace the current script. Cue pins stay where they are on the page, so check they still line up.`, { ok: 'Replace' });
      if (!ok) return;
    }
    try {
      const info = await api.importScript(path);
      await setScript(info);
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async pasteScript() {
    if (!requireEdit()) return;
    const ta = h('textarea', { class: 'paste-area', placeholder: 'Paste the script text here…', spellcheck: false });
    const text = await modal({
      title: 'Paste script text',
      wide: true,
      body: h('div', {}, h('p', { class: 'hint', text: 'Each line becomes a spot you can pin cues to. The text is saved as a .txt file in the show folder.' }), ta),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Use this script', primary: true }],
      onSubmit: () => (ta.value.trim() ? ta.value : (toast('Paste some text first.', 'warn'), undefined)),
    });
    if (!text) return;
    if (store.show.script && !(await confirmDialog('Replace the script?', 'The pasted text will replace the current script.', { ok: 'Replace' }))) return;
    try {
      const info = await api.saveScriptText(text);
      await setScript(info);
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  // ----- cues -----

  async addAudioDialog() {
    if (!requireEdit()) return;
    const paths = await api.pickAudio().catch(() => []);
    if (!paths.length) return;
    const sel = store.cueIndex(store.selectedId);
    await actions.addAudio(paths, { index: sel >= 0 ? sel + 1 : store.cues.length });
  },

  async addAudio(paths, { index = null, anchor = null } = {}) {
    if (!requireEdit()) return;
    let results;
    try {
      results = await api.importMedia(paths);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    for (const r of results) if (r.error) toast(r.error, 'warn');
    const ok = results.filter((r) => r.file);
    if (!ok.length) return;
    const newIds = [];
    store.edit((show) => {
      let at = anchor ? indexForAnchor(show.cues, anchor) : Math.max(0, Math.min(index ?? show.cues.length, show.cues.length));
      const taken = new Set(show.cues.map((c) => c.number));
      for (const r of ok) {
        const cue = makeAudioCue(r.file, prettyName(r.name), show.settings);
        cue.number = numberBetween(show.cues[at - 1]?.number, show.cues[at]?.number, taken);
        taken.add(cue.number);
        if (anchor) cue.anchor = { ...anchor };
        show.cues.splice(at, 0, cue);
        newIds.push(cue.id);
        at++;
      }
    });
    store.select(newIds[0]);
    if (!player.standbyId) player.setStandby(store.cues[0].id);
    for (const r of ok) engine.load(r.file).catch(() => {});
    toast(`Added ${ok.length} cue${ok.length === 1 ? '' : 's'}${anchor ? ', pinned to the script' : ''}.`, 'info', 2500);
  },

  addFadeCue() {
    if (!requireEdit()) return;
    let id;
    store.edit((show) => {
      const sel = show.cues.findIndex((c) => c.id === store.selectedId);
      const at = sel >= 0 ? sel + 1 : show.cues.length;
      const cue = makeFadeCue();
      cue.number = numberBetween(show.cues[at - 1]?.number, show.cues[at]?.number, new Set(show.cues.map((c) => c.number)));
      show.cues.splice(at, 0, cue);
      id = cue.id;
    });
    store.select(id);
    if (!player.standbyId) player.setStandby(store.cues[0].id);
  },

  moveCue(id, index) {
    if (!requireEdit()) return;
    const from = store.cueIndex(id);
    if (from < 0) return;
    const to = index > from ? index - 1 : index;
    if (to === from) return;
    store.edit((show) => {
      const [c] = show.cues.splice(from, 1);
      show.cues.splice(to, 0, c);
    });
  },

  pinCue(id, anchor) {
    if (!requireEdit()) return;
    store.edit((show) => {
      const c = show.cues.find((x) => x.id === id);
      if (c) c.anchor = { b: anchor.b, y: anchor.y };
    });
    store.select(id);
    // Warn when the pin lands out of order with its neighbours in the list.
    const cues = store.cues;
    const i = store.cueIndex(id);
    const prev = cues.slice(0, i).reverse().find((c) => c.anchor && scriptView.isPlaceable(c.anchor));
    const next = cues.slice(i + 1).find((c) => c.anchor && scriptView.isPlaceable(c.anchor));
    if ((prev && compareAnchors(anchor, prev.anchor) < 0) || (next && compareAnchors(anchor, next.anchor) > 0)) {
      toast(`Q${cues[i].number} is now out of order with the script. Use “Sort by script” to reorder the list.`, 'warn');
    }
  },

  unpinCue(id) {
    if (!requireEdit()) return;
    store.edit((show) => { const c = show.cues.find((x) => x.id === id); if (c) c.anchor = null; });
  },

  deleteCue(id) {
    if (!requireEdit()) return;
    const i = store.cueIndex(id);
    if (i < 0) return;
    const cue = store.cues[i];
    store.edit((show) => { show.cues.splice(i, 1); });
    const neighbour = store.cues[i] || store.cues[i - 1] || null;
    if (store.selectedId === id) store.select(neighbour ? neighbour.id : null);
    if (player.standbyId === id) player.setStandby(neighbour ? neighbour.id : null, { scroll: false });
    toast(`Deleted Q${cue.number} “${cue.name}”. Ctrl+Z to undo.`, 'info', 4000);
  },

  async replaceFile(id) {
    if (!requireEdit()) return;
    const paths = await api.pickAudio().catch(() => []);
    if (!paths.length) return;
    const [r] = await api.importMedia([paths[0]]);
    if (!r || r.error) { toast(r ? r.error : 'Import failed', 'error'); return; }
    engine.forget(r.file);
    store.edit((show) => {
      const c = show.cues.find((x) => x.id === id);
      if (!c) return;
      c.file = r.file;
      if (!c.name) c.name = prettyName(r.name);
      c.trimStart = 0;
      c.trimEnd = null;
    });
    await player.checkFiles();
    engine.load(r.file).catch(() => {});
    inspector.render();
  },

  async renumber() {
    if (!requireEdit() || !store.cues.length) return;
    if (!(await confirmDialog('Renumber all cues?', 'Every cue gets a whole number in list order: 1, 2, 3… Update the prompt book to match.', { ok: 'Renumber' }))) return;
    store.edit((show) => { show.cues.forEach((c, i) => { c.number = String(i + 1); }); });
  },

  sortByScript() {
    if (!requireEdit()) return;
    const slots = [];
    const pinned = [];
    store.cues.forEach((c, i) => {
      if (c.anchor && scriptView.isPlaceable(c.anchor)) { slots.push(i); pinned.push(c); }
    });
    const sorted = [...pinned].sort((a, b) => compareAnchors(a.anchor, b.anchor));
    if (sorted.every((c, i) => c === pinned[i])) { toast('The pinned cues are already in script order.', 'info', 2500); return; }
    store.edit((show) => {
      const out = [...show.cues];
      slots.forEach((slot, k) => { out[slot] = sorted[k]; });
      show.cues = out;
    });
    toast('Cues reordered to match the script. Unpinned cues stayed where they were. Renumber if the numbers are now out of order.', 'info', 6000);
  },

  async openSettings() {
    if (!requireEdit()) return;
    const s = store.show.settings;
    const nameIn = h('input', { type: 'text', value: store.show.name });
    const stopIn = h('input', { type: 'number', min: '0', step: '0.5', value: String(s.defaultStopFade), class: 'num' });
    const guardSel = h('select', {}, ...[[0, 'Off'], [250, '0.25 s'], [500, '0.5 s (recommended)'], [750, '0.75 s'], [1000, '1 s']].map(([v, t]) => h('option', { value: String(v), text: t })));
    guardSel.value = String(s.goGuardMs);
    if (guardSel.value !== String(s.goGuardMs)) { guardSel.append(h('option', { value: String(s.goGuardMs), text: `${s.goGuardMs} ms` })); guardSel.value = String(s.goGuardMs); }
    const panicIn = h('input', { type: 'number', min: '0', step: '0.5', value: String(s.panicFade), class: 'num' });
    const applyAll = h('input', { type: 'checkbox' });
    const field = (label, ctl, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), ctl, hint ? h('span', { class: 'hint', text: hint }) : null);
    const res = await modal({
      title: 'Show settings',
      body: h('div', { class: 'settings-form' },
        field('Show name', nameIn),
        field('Default “fade when stopped” for new cues (s)', stopIn, 'How long a sound takes to fade out when a later cue (or STOP ALL) ends it.'),
        h('label', { class: 'check' }, applyAll, h('span', { text: 'Also apply it to every existing sound cue' })),
        field('Double-GO protection', guardSel, 'Ignore a second GO pressed this soon after the last one, so a fumbled double-tap doesn’t skip a cue.'),
        field('STOP ALL fade time (s)', panicIn, 'Esc / STOP ALL fades everything out over this time. Press it twice to cut instantly.'),
        h('p', { class: 'hint', text: `Show folder: ${store.dir}` })),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true }],
      onSubmit: () => true,
    });
    if (!res) return;
    const stop = Math.max(0, Number(stopIn.value) || 0);
    const name = nameIn.value.trim() || store.show.name;
    if (name !== store.show.name || applyAll.checked) {
      store.edit((show) => {
        show.name = name;
        if (applyAll.checked) show.cues.forEach((c) => { if (c.type === 'audio') c.stopFade = stop; });
      }, { what: { cues: true, name: true } });
    }
    store.pref((st) => {
      st.defaultStopFade = stop;
      st.goGuardMs = Math.max(0, Number(guardSel.value) || 0);
      st.panicFade = Math.max(0, Number(panicIn.value) || 0);
    });
  },

  showShortcuts() {
    const rows = [
      ['Space', 'GO: fire the standby cue'],
      ['Esc', 'STOP ALL: fade out everything (press twice to cut instantly)'],
      ['↑ / ↓', 'Move the standby to the previous / next cue'],
      ['Double-click a cue', 'Make it the standby (jump to it)'],
      ['Delete', 'Delete the selected cue (Edit mode)'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo (Edit mode)'],
      ['Alt+click the script', 'Pin the selected cue there (Edit mode)'],
      ['Ctrl+scroll on the script', 'Zoom the script'],
    ];
    modal({
      title: 'Keyboard shortcuts',
      body: h('table', { class: 'shortcuts' }, ...rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', { text: k })), h('td', { text: d })))),
      buttons: [{ label: 'Close', value: true, primary: true }],
    });
  },
};

async function setScript(info) {
  store.edit((show) => { show.script = info; }, { what: { script: true } });
  await scriptView.load(info); // same promise the store listener started
  if (store.cues.some((c) => c.anchor)) toast('Existing cue pins were kept. Check they still line up with the new script.', 'warn');
}

// ---------------------------------------------------------------- show lifecycle

function showScreen(which) {
  $('#home').classList.toggle('hidden', which !== 'home');
  $('#showScreen').classList.toggle('hidden', which !== 'show');
}

async function openShow({ dir, show }, { standbyId = null, mode = null } = {}) {
  if (store.show) {
    player.silence();
    await store.flush().catch(() => {});
  }
  player.cancelPreload();
  engine.clear();
  player.active.clear();
  player.showClockStart = null;
  player.standbyId = null;
  if (mode === 'show' || mode === 'edit') show.settings = { ...(show.settings || {}), mode };
  store.load(dir, show);
  showScreen('show');
  applyMode();
  api.setTitle(`${show.name} — Cuebook`);
  api.setShowMode(!store.editing).catch(() => {});
  engine.setMasterDb(Number(show.settings.masterDb) || 0);
  transport.refreshDevices();
  player.setStandby(standbyId && store.cue(standbyId) ? standbyId : store.cues[0]?.id || null, { scroll: false });
  renderAll();
  if (show.__restoredFromBackup) {
    delete show.__restoredFromBackup;
    toast('The show file was damaged, so the last good backup was opened instead.', 'warn', 10000);
  }
  await scriptView.load(show.script, { force: true });
  const missing = await player.checkFiles().catch(() => []);
  if (missing.length) toast(`${missing.length} sound file${missing.length === 1 ? ' is' : 's are'} missing from the show folder. Those cues are marked in red.`, 'error', 12000);
  player.preloadAll();
}

function applyMode() {
  const editing = store.editing;
  document.body.classList.toggle('mode-show', !editing);
  document.body.classList.toggle('mode-edit', editing);
}

function renderAll() {
  if (!store.show) return;
  applyMode();
  transport.renderTopbar();
  transport.renderStandby();
  transport.renderActive();
  cueList.render();
  scriptView.applyView();
  scriptView.renderMarkers();
  if (!store.show.script) scriptView.renderEmpty();
  inspector.render();
}

// ---------------------------------------------------------------- event routing

function wireEvents() {
  store.subscribe((what) => {
    if (!store.show) return;
    if (what.all) return; // openShow renders everything itself
    if (what.locked) toast('The show is locked in Show mode. Switch to Edit to make changes.', 'warn');
    if (what.save) transport.renderSave();
    if (what.mode) {
      applyMode();
      transport.renderTopbar();
      cueList.render();
      inspector.render();
      scriptView.renderMarkers();
      if (!store.show.script) scriptView.renderEmpty();
    }
    if (what.cues) {
      cueList.render();
      scriptView.renderMarkers();
      if (inspector._selfEdit) inspector.refreshSoft(); else inspector.render();
      transport.renderStandby();
      if (player.standbyId && !store.cue(player.standbyId)) player.setStandby(null, { scroll: false });
      player.preloadAround();
    }
    if (what.script) scriptView.load(store.show.script); // no-op if already showing it
    if (what.selection) {
      cueList.updateStates();
      scriptView.updateMarkerStates();
      inspector.render();
    }
    if (what.settings || what.view || what.name) {
      transport.renderTopbar();
      scriptView.applyView();
    }
    if (what.name) api.setTitle(`${store.show.name} — Cuebook`);
  });

  player.subscribe((what) => {
    if (!store.show) return;
    if (what.standby) {
      cueList.updateStates();
      scriptView.updateMarkerStates();
      transport.renderStandby();
      if (what.scroll) {
        cueList.scrollToStandby();
        if (store.show.settings.followScript) scriptView.scrollToCue(player.standbyId);
      }
    }
    if (what.active) {
      transport.renderActive();
      scriptView.updateMarkerStates();
    }
    if (what.error) toast(what.error, 'error');
    if (what.guarded) transport.flashGuard();
    if (what.go) transport.flashGo();
    if (what.load) {
      cueList.updateLoadStates();
      transport.renderStandby();
      inspector.onFileLoaded();
    }
  });
}

function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes(el.type);
  return false;
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const typing = isTypingTarget(e.target);
    if (isModalOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
      return;
    }
    if (!store.show) return;

    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      if (!e.repeat) actions.go();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (scriptView.cancelPinMode()) return;
      if (typing) { e.target.blur(); return; }
      player.stopAll();
      return;
    }
    if (typing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      player.moveStandby(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (!store.editing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (!store.undo()) toast('Nothing to undo.', 'info', 1500); return; }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); if (!store.redo()) toast('Nothing to redo.', 'info', 1500); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedId) { e.preventDefault(); actions.deleteCue(store.selectedId); }
  }, true);

  // A focused button would otherwise be "clicked" by the Space bar on keyup.
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) e.preventDefault();
  }, true);

  // Don't let buttons keep keyboard focus after a mouse click.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && e.detail > 0) b.blur();
  });

  const updateTyping = () => transport.setTyping(!!store.show && isTypingTarget(document.activeElement));
  document.addEventListener('focusin', updateTyping);
  document.addEventListener('focusout', () => setTimeout(updateTyping, 0));

  // Files dropped outside a drop zone must never navigate the window away.
  window.addEventListener('dragover', (e) => { if (!e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
  window.addEventListener('drop', (e) => e.preventDefault());
}

function wireSplitters() {
  const ws = $('#workspace');
  const load = (k, d) => { try { return Number(localStorage.getItem(k)) || d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } };
  ws.style.setProperty('--script-w', `${load('cuebook.scriptW', 56)}%`);
  $('#cuePane').style.setProperty('--insp-h', `${load('cuebook.inspH', 44)}%`);

  const drag = (handle, onMove, onEnd) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('active');
      const move = (ev) => onMove(ev);
      const up = () => {
        handle.classList.remove('active');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        onEnd();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  };
  let sw = load('cuebook.scriptW', 56);
  drag($('#splitV'), (ev) => {
    const r = ws.getBoundingClientRect();
    sw = Math.min(75, Math.max(25, ((ev.clientX - r.left) / r.width) * 100));
    ws.style.setProperty('--script-w', `${sw}%`);
  }, () => save('cuebook.scriptW', sw.toFixed(1)));
  let ih = load('cuebook.inspH', 44);
  drag($('#splitH'), (ev) => {
    const r = $('#cuePane').getBoundingClientRect();
    ih = Math.min(80, Math.max(20, ((r.bottom - ev.clientY) / r.height) * 100));
    $('#cuePane').style.setProperty('--insp-h', `${ih}%`);
  }, () => save('cuebook.inspH', ih.toFixed(1)));
}

function frame() {
  if (store.show) {
    transport.updateLive();
    cueList.updateLive();
    inspector.updateLive();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot

async function boot() {
  scriptView = new ScriptView($('#scriptPane'), { player, actions, toast });
  cueList = new CueList($('#cueListPane'), { player, engine, actions, scriptView, toast });
  inspector = new Inspector($('#inspector'), { player, engine, actions, scriptView });
  // Pin positions only make sense once a script is laid out: refresh what depends on them.
  scriptView.onLoaded = () => {
    if (!store.show) return;
    cueList.render();
    inspector.refreshSoft();
  };
  transport = new Transport({ topbar: $('#topbar'), transport: $('#transport') }, { player, engine, actions, toast });
  home = new Home($('#home'), { onOpen: openShow, toast });

  wireEvents();
  wireKeyboard();
  wireSplitters();
  requestAnimationFrame(frame);

  api.onMenu((cmd) => {
    if (cmd === 'reveal' && store.show) api.reveal().catch(() => {});
    if (cmd === 'close-show') actions.closeShow();
    if (cmd === 'shortcuts') actions.showShortcuts();
  });

  api.onBeforeClose(async () => {
    try { await store.flush(); } catch { /* reported in UI */ }
    const playing = player.playing;
    const locked = !!store.show && !store.editing;
    api.closeReply({
      needsConfirm: playing || locked || store.saveState === 'error',
      reason: store.saveState === 'error' ? 'The latest changes could not be saved. Quit anyway?'
        : playing ? 'Sound is still playing. Quit anyway?'
          : 'The show is in Show mode. Quit Cuebook?',
    });
  });

  // Reopen the show after a crash, or a .cuebook file passed on the command line.
  const rec = await api.getRecovery().catch(() => null);
  if (rec && rec.showDir) {
    try {
      await openShow(await api.openShow(rec.showDir), { standbyId: rec.standbyId, mode: rec.mode });
      if (rec.reason && rec.reason !== 'open-file') {
        const c = player.standby;
        toast(`Cuebook restarted after a problem and reopened your show.${c ? ` Next cue: Q${c.number} ${c.name}.` : ''}`, 'warn', 15000);
      }
      return;
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  showScreen('home');
  await home.render();
}

// Exposed for automated testing and debugging from DevTools.
window.__cuebook = { store, player, engine, actions, openShow, get scriptView() { return scriptView; } };

boot();
