// Preload: Chrome-Leiste (Tabs, Adressleiste, Verbindunganzeige).
// Auch hier: Brücke nur, wenn der Hauptprozess das Dokument als eigene Seite
// erkennt. Die Leiste zeigt ausschließlich index.html — zur Sicherheit läuft
// dieselbe Prüfung wie in preload-tab.js.
const { contextBridge, ipcRenderer } = require('electron');

let brückeErlaubt = false;
try {
  brückeErlaubt = ipcRenderer.sendSync('bridge:anfragen') === true;
} catch {
  brückeErlaubt = false;
}

if (brückeErlaubt) {
  contextBridge.exposeInMainWorld('api', {
    listTabs: () => ipcRenderer.invoke('tabs:list'),
    newTab: () => ipcRenderer.invoke('tabs:new'),
    activateTab: (id) => ipcRenderer.invoke('tabs:activate', id),
    closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
    openSettings: () => ipcRenderer.invoke('tabs:settings'),
    openHistory: () => ipcRenderer.invoke('tabs:history'),
    openFavorites: () => ipcRenderer.invoke('tabs:favorites'),
    chromeExtra: (px) => ipcRenderer.invoke('chrome:extra', px),
    listFavorites: () => ipcRenderer.invoke('favorites:list'),
    addFavorite: (e) => ipcRenderer.invoke('favorites:add', e),
    removeFavorite: (url) => ipcRenderer.invoke('favorites:remove', url),
    renameFavorite: (p) => ipcRenderer.invoke('favorites:rename', p),
    onFavorites: (cb) => ipcRenderer.on('favorites', (_e, list) => cb(list)),
    navigate: (input) => ipcRenderer.invoke('nav:navigate', input),
    prefetch: (q) => ipcRenderer.invoke('search:prefetch', q),
    back: () => ipcRenderer.invoke('nav:back'),
    forward: () => ipcRenderer.invoke('nav:forward'),
    reload: () => ipcRenderer.invoke('nav:reload'),
    home: () => ipcRenderer.invoke('nav:home'),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
    listSites: () => ipcRenderer.invoke('sites:list'),
    addSite: (site) => ipcRenderer.invoke('sites:add', site),
    clearSites: () => ipcRenderer.invoke('sites:clear'),
    appVersion: () => ipcRenderer.invoke('app:version'),
    onTabs: (cb) => ipcRenderer.on('tabs', (_e, list) => cb(list)),
    onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
    onAgentState: (cb) => ipcRenderer.on('agent-state', (_e, s) => cb(s)),
    agentStatus: () => ipcRenderer.invoke('agent:status'),
    onFocusUrlBar: (cb) => ipcRenderer.on('focus-url-bar', () => cb()),
  });
}
