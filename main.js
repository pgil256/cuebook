// Cuebook — Electron main process.
// Owns everything that touches the disk: show folders, media import, script
// conversion, the app:// protocol that serves UI files and show media, plus
// window-level safety (single instance, close guard, sleep blocking, crash recovery).

const { app, BrowserWindow, ipcMain, dialog, protocol, Menu, powerSaveBlocker, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const APP_DIR = __dirname;
const SHOW_FILE = 'show.cuebook';
const AUDIO_DIR = 'audio';
const SCRIPT_DIR = 'script';
const AUDIO_EXT = ['.mp3', '.wav', '.wave', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.aif', '.aiff', '.webm'];
const SCRIPT_EXT = { '.pdf': 'pdf', '.docx': 'docx', '.txt': 'txt', '.text': 'txt', '.md': 'txt', '.fountain': 'txt' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.webm': 'audio/webm',
};

// Only these parts of the app folder are served to the renderer.
const SERVED_APP_PATHS = ['src/', 'node_modules/pdfjs-dist/build/', 'node_modules/pdfjs-dist/cmaps/',
  'node_modules/pdfjs-dist/standard_fonts/', 'node_modules/pdfjs-dist/wasm/', 'node_modules/pdfjs-dist/iccs/'];

let win = null;
let currentShowDir = null;
let powerBlockerId = null;
let allowClose = false;
let closeTimer = null;
// Kept in memory so a crashed renderer can be reloaded straight back into the show.
let recovery = { showDir: null, standbyId: null, mode: null };

// Automated tests run with their own profile so they never touch the real recent-shows list.
const TEST_MODE = !!process.env.CUEBOOK_TEST;
if (process.env.CUEBOOK_USER_DATA) app.setPath('userData', process.env.CUEBOOK_USER_DATA);

if (!TEST_MODE && !app.requestSingleInstanceLock()) {
  // A second copy of the app could double-fire audio. Focus the first one instead.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ---------- helpers ----------

/** Resolve `rel` inside `root`, refusing anything that escapes it. */
function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new Error('Path escapes its folder: ' + rel);
  }
  return full;
}

function requireShow() {
  if (!currentShowDir) throw new Error('No show is open.');
  return currentShowDir;
}

function toPosix(p) { return p.split(path.sep).join('/'); }

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * Copy `src` into `<show>/<subdir>/`. If a file with the same name already
 * exists and is byte-identical it is reused; otherwise a numbered name is used.
 * Returns the show-relative POSIX path.
 */
async function copyIntoShow(src, subdir) {
  const showDir = requireShow();
  const destDir = path.join(showDir, subdir);
  await fsp.mkdir(destDir, { recursive: true });
  // Already inside this show's folder? Use it where it is.
  const rel = path.relative(showDir, src);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);

  const ext = path.extname(src);
  const base = path.basename(src, ext);
  const srcStat = await fsp.stat(src);
  let srcHash = null;
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`;
    const dest = path.join(destDir, name);
    if (!(await exists(dest))) {
      await fsp.copyFile(src, dest);
      return `${subdir}/${name}`;
    }
    const st = await fsp.stat(dest);
    if (st.size === srcStat.size) {
      srcHash = srcHash || (await hashFile(src));
      if ((await hashFile(dest)) === srcHash) return `${subdir}/${name}`;
    }
  }
  throw new Error('Could not find a free file name for ' + src);
}

/** Write atomically: temp file + rename, keeping the previous version as .bak. */
async function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  if (await exists(file)) {
    try { await fsp.copyFile(file, file + '.bak'); } catch { /* backup is best effort */ }
  }
  await fsp.rename(tmp, file);
}

// ---------- recent shows ----------

const recentFile = () => path.join(app.getPath('userData'), 'recent-shows.json');

async function readRecent() {
  try {
    const list = JSON.parse(await fsp.readFile(recentFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function addRecent(dir, name) {
  const list = (await readRecent()).filter((r) => path.resolve(r.dir) !== path.resolve(dir));
  list.unshift({ dir, name, openedAt: new Date().toISOString() });
  await fsp.mkdir(path.dirname(recentFile()), { recursive: true });
  await fsp.writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 2));
}

// ---------- show folders ----------

function newShowJson(name) {
  const now = new Date().toISOString();
  return {
    format: 'cuebook-show',
    version: 1,
    name,
    createdAt: now,
    modifiedAt: now,
    script: null,
    settings: {
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
    },
    cues: [],
  };
}

async function loadShowFromDir(dir) {
  const file = path.join(dir, SHOW_FILE);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    throw new Error(`No ${SHOW_FILE} file found in ${dir}`);
  }
  let show;
  try {
    show = JSON.parse(text);
  } catch (err) {
    // Fall back to the last good copy rather than refusing to open on show night.
    const bak = file + '.bak';
    if (await exists(bak)) {
      show = JSON.parse(await fsp.readFile(bak, 'utf8'));
      show.__restoredFromBackup = true;
    } else {
      throw new Error('The show file is damaged and there is no backup: ' + err.message);
    }
  }
  if (show.format !== 'cuebook-show') throw new Error('That file is not a Cuebook show.');
  currentShowDir = dir;
  recovery = { showDir: dir, standbyId: null, mode: null };
  await addRecent(dir, show.name);
  return { dir, show };
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  handle('shows:recent', async () => {
    const list = await readRecent();
    return Promise.all(list.map(async (r) => ({ ...r, missing: !(await exists(path.join(r.dir, SHOW_FILE))) })));
  });

  handle('shows:forgetRecent', async (dir) => {
    const list = (await readRecent()).filter((r) => path.resolve(r.dir) !== path.resolve(dir));
    await fsp.writeFile(recentFile(), JSON.stringify(list, null, 2));
    return true;
  });

  handle('shows:defaultParent', async () => path.join(app.getPath('documents'), 'Cuebook Shows'));

  handle('shows:pickFolder', async (defaultPath) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose where to create the show folder',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('shows:create', async (name, parentDir) => {
    const clean = String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '');
    if (!clean) throw new Error('Give the show a name.');
    const dir = path.join(parentDir, clean);
    if (await exists(path.join(dir, SHOW_FILE))) throw new Error(`A show already exists at ${dir}`);
    await fsp.mkdir(path.join(dir, AUDIO_DIR), { recursive: true });
    await fsp.mkdir(path.join(dir, SCRIPT_DIR), { recursive: true });
    await atomicWrite(path.join(dir, SHOW_FILE), JSON.stringify(newShowJson(clean), null, 2));
    return loadShowFromDir(dir);
  });

  handle('shows:openDialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open a show',
      filters: [{ name: 'Cuebook show', extensions: ['cuebook'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return null;
    return loadShowFromDir(path.dirname(r.filePaths[0]));
  });

  handle('shows:open', async (p) => {
    let dir = p;
    try {
      const st = await fsp.stat(p);
      if (st.isFile()) dir = path.dirname(p);
    } catch { /* let loadShowFromDir report it */ }
    return loadShowFromDir(dir);
  });

  handle('shows:close', async () => {
    currentShowDir = null;
    recovery = { showDir: null, standbyId: null, mode: null };
    return true;
  });

  handle('show:save', async (json) => {
    const dir = requireShow();
    await atomicWrite(path.join(dir, SHOW_FILE), json);
    return true;
  });

  handle('show:checkFiles', async (rels) => {
    const dir = requireShow();
    const out = {};
    for (const rel of rels) {
      try { out[rel] = await exists(safeJoin(dir, rel)); } catch { out[rel] = false; }
    }
    return out;
  });

  handle('media:pickAudio', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add sound files',
      filters: [{ name: 'Audio', extensions: AUDIO_EXT.map((e) => e.slice(1)) }],
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  handle('media:import', async (paths) => {
    const results = [];
    for (const p of paths) {
      const ext = path.extname(p).toLowerCase();
      if (!AUDIO_EXT.includes(ext)) {
        results.push({ source: p, error: `${path.basename(p)} isn't a supported audio file` });
        continue;
      }
      try {
        const rel = await copyIntoShow(p, AUDIO_DIR);
        results.push({ source: p, file: rel, name: path.basename(p, path.extname(p)) });
      } catch (err) {
        results.push({ source: p, error: err.message });
      }
    }
    return results;
  });

  handle('script:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import a script',
      filters: [{ name: 'Scripts', extensions: ['pdf', 'docx', 'txt', 'text', 'md', 'fountain'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('script:import', async (src) => {
    const type = SCRIPT_EXT[path.extname(src).toLowerCase()];
    if (!type) throw new Error('Scripts must be PDF, Word (.docx) or plain text.');
    const file = await copyIntoShow(src, SCRIPT_DIR);
    return { file, type, name: path.basename(src) };
  });

  handle('script:saveText', async (text) => {
    const dir = requireShow();
    await fsp.mkdir(path.join(dir, SCRIPT_DIR), { recursive: true });
    let name = 'pasted script.txt';
    for (let i = 2; await exists(path.join(dir, SCRIPT_DIR, name)); i++) name = `pasted script (${i}).txt`;
    await fsp.writeFile(path.join(dir, SCRIPT_DIR, name), text, 'utf8');
    return { file: `${SCRIPT_DIR}/${name}`, type: 'txt', name };
  });

  handle('script:readText', async (rel) => fsp.readFile(safeJoin(requireShow(), rel), 'utf8'));

  handle('script:docxToHtml', async (rel) => {
    const mammoth = require('mammoth');
    const result = await mammoth.convertToHtml({ path: safeJoin(requireShow(), rel) });
    return result.value;
  });

  handle('shell:reveal', async (rel) => {
    shell.showItemInFolder(rel ? safeJoin(requireShow(), rel) : path.join(requireShow(), SHOW_FILE));
    return true;
  });

  handle('app:setShowMode', async (on) => {
    // Keep the screen (and machine) awake while in Show mode.
    if (on && powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && powerBlockerId !== null) { powerSaveBlocker.stop(powerBlockerId); powerBlockerId = null; }
    recovery.mode = on ? 'show' : 'edit';
    return true;
  });

  handle('app:setStandby', async (id) => { recovery.standbyId = id; return true; });
  handle('app:getRecovery', async () => {
    const r = global.__pendingRecovery || null;
    global.__pendingRecovery = null;
    return r;
  });

  handle('app:setTitle', async (t) => { if (win) win.setTitle(t); return true; });

  // Renderer answers the close request: ok to close, or ask the operator first.
  handle('app:closeReply', async ({ needsConfirm, reason }) => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (needsConfirm) {
      const r = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Keep running', 'Quit Cuebook'],
        defaultId: 0,
        cancelId: 0,
        title: 'Quit Cuebook?',
        message: reason || 'Quit Cuebook?',
      });
      if (r.response !== 1) return false;
    }
    allowClose = true;
    win.close();
    return true;
  });
}

// ---------- protocol ----------

function registerProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      let full;
      if (pathname.startsWith('show/')) {
        full = safeJoin(requireShow(), pathname.slice('show/'.length));
      } else {
        if (!SERVED_APP_PATHS.some((p) => pathname.startsWith(p))) return new Response('Not found', { status: 404 });
        full = safeJoin(APP_DIR, pathname);
      }
      const data = await fsp.readFile(full);
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'content-type': type, 'cache-control': 'no-store' } });
    } catch (err) {
      return new Response(String(err.message || err), { status: 404 });
    }
  });
}

// ---------- window ----------

function buildMenu() {
  const isDev = !app.isPackaged;
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Show folder in Explorer', click: () => win && win.webContents.send('menu', 'reveal') },
        { label: 'Close show', click: () => win && win.webContents.send('menu', 'close-show') },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Cuebook' },
      ],
    },
    // The Edit menu keeps Ctrl+C / Ctrl+V / Ctrl+A working in text fields.
    // Undo/redo are left to the renderer so they can act on the cue list.
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      // No Reload entry on purpose: reloading mid-show would cut all audio.
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [{ label: 'Keyboard shortcuts', click: () => win && win.webContents.send('menu', 'shortcuts') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0f1216',
    title: 'Cuebook',
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Never slow down timers/audio scheduling when the window is in the background.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (TEST_MODE) { win.showInactive(); return; }
    win.maximize();
    win.show();
  });
  win.loadURL('app://local/src/index.html');

  // Block navigation away from the app (e.g. a file dropped outside a drop zone).
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://local/src/')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    if (closeTimer) return; // already asked
    // Ask the renderer to flush its save and tell us whether a confirm is needed.
    win.webContents.send('app:beforeClose');
    // Safety net: if the renderer never answers (hung), close anyway.
    closeTimer = setTimeout(() => {
      closeTimer = null;
      allowClose = true;
      if (win && !win.isDestroyed()) win.close();
    }, 4000);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    // Reload straight back into the open show with the same next cue.
    global.__pendingRecovery = recovery.showDir ? { ...recovery, reason: details.reason } : null;
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL('app://local/src/index.html'); }, 300);
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Allow listing audio output devices with their names (needed for the output picker).
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'speaker-selection'].includes(permission));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'speaker-selection'].includes(permission)));

  registerProtocol();
  registerIpc();
  buildMenu();
  createWindow();

  // Opening a .cuebook file directly (double-click / command line).
  const fileArg = process.argv.find((a) => a.toLowerCase().endsWith('.cuebook'));
  if (fileArg) global.__pendingRecovery = { showDir: path.dirname(path.resolve(fileArg)), standbyId: null, mode: null, reason: 'open-file' };
});

app.on('window-all-closed', () => app.quit());
