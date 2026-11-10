// Narrow bridge between the sandboxed window and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld('cuebook', {
  recentShows: () => call('shows:recent'),
  forgetRecent: (dir) => call('shows:forgetRecent', dir),
  defaultShowParent: () => call('shows:defaultParent'),
  pickFolder: (defaultPath) => call('shows:pickFolder', defaultPath),
  createShow: (name, parentDir) => call('shows:create', name, parentDir),
  openShowDialog: () => call('shows:openDialog'),
  openShow: (p) => call('shows:open', p),
  closeShow: () => call('shows:close'),
  saveShow: (json) => call('show:save', json),
  checkFiles: (rels) => call('show:checkFiles', rels),

  pickAudio: () => call('media:pickAudio'),
  importMedia: (paths) => call('media:import', paths),

  pickScript: () => call('script:pick'),
  importScript: (p) => call('script:import', p),
  readScriptText: (rel) => call('script:readText', rel),
  docxToHtml: (rel) => call('script:docxToHtml', rel),

  reveal: () => call('shell:reveal'),
  keepAwake: (on) => call('app:keepAwake', on),
  takePendingOpen: () => call('app:takePendingOpen'),
  setTitle: (t) => call('app:setTitle', t),
  closeReply: (info) => call('app:closeReply', info),

  /** Real disk path of a dropped File (empty string if none). */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },

  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onBeforeClose: (fn) => ipcRenderer.on('app:beforeClose', () => fn()),
});
