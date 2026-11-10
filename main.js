// Cuebook — Electron main process.
// Show folders on disk, copying music and scripts into them, Word conversion,
// and the app:// protocol that serves the UI and show files (with byte ranges,
// so the player can jump anywhere in a song).

const { app, BrowserWindow, ipcMain, dialog, protocol, Menu, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Readable } = require('stream');

const APP_DIR = __dirname;
const SHOW_FILE = 'show.cuebook';
const AUDIO_DIR = 'audio';
const SCRIPT_DIR = 'script';
const AUDIO_EXT = ['.mp3', '.wav', '.wave', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm'];
const SCRIPT_EXT = { '.pdf': 'pdf', '.docx': 'docx', '.txt': 'txt', '.text': 'txt', '.md': 'txt', '.fountain': 'txt' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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
  '.webm': 'audio/webm',
};

// Only these parts of the app folder are served to the window.
const SERVED_APP_PATHS = ['src/', 'node_modules/pdfjs-dist/build/', 'node_modules/pdfjs-dist/cmaps/',
  'node_modules/pdfjs-dist/standard_fonts/', 'node_modules/pdfjs-dist/wasm/', 'node_modules/pdfjs-dist/iccs/'];

// Automated tests run with their own profile so they never touch the real recent-shows list.
const TEST_MODE = !!process.env.CUEBOOK_TEST;
if (process.env.CUEBOOK_USER_DATA) app.setPath('userData', process.env.CUEBOOK_USER_DATA);

let win = null;
let currentShowDir = null;
let awakeId = null;
let allowClose = false;
let closeTimer = null;
let pendingOpen = null; // show to open when the window (re)loads: after a crash, or a .cuebook file passed in

if (!TEST_MODE && !app.requestSingleInstanceLock()) {
  // Two copies could play over each other. Focus the first one instead.
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
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) throw new Error('Path escapes its folder: ' + rel);
  return full;
}

function requireShow() {
  if (!currentShowDir) throw new Error('No show is open.');
  return currentShowDir;
}

const toPosix = (p) => p.split(path.sep).join('/');

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * Copy `src` into `<show>/<subdir>/`. An identical file already there is reused;
 * a different file with the same name gets a numbered name. Returns the show-relative path.
 */
async function copyIntoShow(src, subdir) {
  const showDir = requireShow();
  const destDir = path.join(showDir, subdir);
  await fsp.mkdir(destDir, { recursive: true });
  const rel = path.relative(showDir, src);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel); // already in this show

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

/** Write via a temp file + rename, keeping the previous version as .bak. */
async function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  if (await exists(file)) {
    try { await fsp.copyFile(file, file + '.bak'); } catch { /* best effort */ }
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
  return { format: 'cuebook-show', version: 2, name, createdAt: now, modifiedAt: now, script: null, volume: 1, tracks: [] };
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
    // Fall back to the last good copy rather than refusing to open.
    const bak = file + '.bak';
    if (!(await exists(bak))) throw new Error('The show file is damaged and there is no backup: ' + err.message);
    show = JSON.parse(await fsp.readFile(bak, 'utf8'));
    show.__restoredFromBackup = true;
  }
  if (show.format !== 'cuebook-show') throw new Error('That file is not a Cuebook show.');
  currentShowDir = dir;
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
      title: 'Choose where to save the show',
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
      if ((await fsp.stat(p)).isFile()) dir = path.dirname(p);
    } catch { /* loadShowFromDir reports it */ }
    return loadShowFromDir(dir);
  });

  handle('shows:close', async () => { currentShowDir = null; return true; });

  handle('show:save', async (json) => {
    await atomicWrite(path.join(requireShow(), SHOW_FILE), json);
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
      title: 'Add music',
      filters: [{ name: 'Audio', extensions: AUDIO_EXT.map((e) => e.slice(1)) }],
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  handle('media:import', async (paths) => {
    const results = [];
    for (const p of paths) {
      if (!AUDIO_EXT.includes(path.extname(p).toLowerCase())) {
        results.push({ source: p, error: `${path.basename(p)} isn't a supported audio file` });
        continue;
      }
      try {
        results.push({ source: p, file: await copyIntoShow(p, AUDIO_DIR), name: path.basename(p, path.extname(p)) });
      } catch (err) {
        results.push({ source: p, error: err.message });
      }
    }
    return results;
  });

  handle('script:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add a script',
      filters: [{ name: 'Scripts', extensions: ['pdf', 'docx', 'txt', 'text', 'md', 'fountain'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('script:import', async (src) => {
    const type = SCRIPT_EXT[path.extname(src).toLowerCase()];
    if (!type) throw new Error('Scripts must be PDF, Word (.docx) or plain text.');
    return { file: await copyIntoShow(src, SCRIPT_DIR), type, name: path.basename(src) };
  });

  handle('script:readText', async (rel) => fsp.readFile(safeJoin(requireShow(), rel), 'utf8'));

  handle('script:docxToHtml', async (rel) => {
    const mammoth = require('mammoth');
    return (await mammoth.convertToHtml({ path: safeJoin(requireShow(), rel) })).value;
  });

  handle('shell:reveal', async () => {
    shell.showItemInFolder(path.join(requireShow(), SHOW_FILE));
    return true;
  });

  // Keep the screen awake while music is playing.
  handle('app:keepAwake', async (on) => {
    if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
    return true;
  });

  handle('app:takePendingOpen', async () => {
    const p = pendingOpen;
    pendingOpen = null;
    return p;
  });

  handle('app:setTitle', async (t) => { if (win) win.setTitle(t); return true; });

  // The window answers a close request: close now, or ask first.
  handle('app:closeReply', async ({ needsConfirm, reason }) => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (needsConfirm) {
      const r = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Keep playing', 'Quit Cuebook'],
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

/** Serve a file, honouring a `Range: bytes=` header so audio can seek. */
async function serveFile(full, range, stream) {
  const stat = await fsp.stat(full);
  if (!stat.isFile()) throw new Error('Not a file');
  const size = stat.size;
  const headers = {
    'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  if (size === 0) return new Response(null, { status: 200, headers: { ...headers, 'content-length': '0' } });
  headers['content-length'] = String(end - start + 1);
  let body;
  if (stream) {
    body = Readable.toWeb(fs.createReadStream(full, { start, end }));
  } else {
    const data = await fsp.readFile(full); // app files are small (and may live inside the asar archive)
    body = status === 206 ? data.subarray(start, end + 1) : data;
  }
  return new Response(body, { status, headers });
}

function registerProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const range = request.headers.get('range');
      if (pathname.startsWith('show/')) {
        return await serveFile(safeJoin(requireShow(), pathname.slice('show/'.length)), range, true);
      }
      if (!SERVED_APP_PATHS.some((p) => pathname.startsWith(p))) return new Response('Not found', { status: 404 });
      return await serveFile(safeJoin(APP_DIR, pathname), range, false);
    } catch (err) {
      return new Response(String(err.message || err), { status: 404 });
    }
  });
}

// ---------- window ----------

function buildMenu() {
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
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      // No Reload entry on purpose: reloading would cut the music.
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(!app.isPackaged ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    { label: 'Help', submenu: [{ label: 'Keyboard shortcuts', click: () => win && win.webContents.send('menu', 'shortcuts') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0f1216',
    title: 'Cuebook',
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  // Never navigate away from the app (e.g. a file dropped outside a drop area).
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://local/src/')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    if (closeTimer) return;
    win.webContents.send('app:beforeClose');
    // If the window never answers (hung), close anyway.
    closeTimer = setTimeout(() => {
      closeTimer = null;
      allowClose = true;
      if (win && !win.isDestroyed()) win.close();
    }, 4000);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    // Reload straight back into the open show.
    pendingOpen = currentShowDir ? { dir: currentShowDir, reason: 'crash' } : null;
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL('app://local/src/index.html'); }, 300);
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  registerProtocol();
  registerIpc();
  buildMenu();
  createWindow();
  // Opening a .cuebook file directly (double-click / command line).
  const fileArg = process.argv.find((a) => a.toLowerCase().endsWith('.cuebook'));
  if (fileArg) pendingOpen = { dir: path.dirname(path.resolve(fileArg)), reason: 'file' };
});

app.on('window-all-closed', () => app.quit());
