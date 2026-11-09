// Narrow bridge between the sandboxed UI and the main process.
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
  saveScriptText: (text) => call('script:saveText', text),
  readScriptText: (rel) => call('script:readText', rel),
  docxToHtml: (rel) => call('script:docxToHtml', rel),

  reveal: (rel) => call('shell:reveal', rel),
  setShowMode: (on) => call('app:setShowMode', on),
  setStandby: (id) => call('app:setStandby', id),
  getRecovery: () => call('app:getRecovery'),
  setTitle: (t) => call('app:setTitle', t),
  closeReply: (info) => call('app:closeReply', info),

  /** Real disk path of a File from a drag-and-drop (empty string if none). */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },

  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onBeforeClose: (fn) => ipcRenderer.on('app:beforeClose', () => fn()),
});
