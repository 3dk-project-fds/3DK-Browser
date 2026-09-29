// Preload: browser-eigene Seiten (Start, Ergebnisliste, Einstellungen, Verlauf).
//
// Die Brücke wird nicht blind eingebaut: der Hauptprozess erlaubt sie nur für
// Dokumente, die wirklich zu den eigenen Seiten gehören. Ein Tab, der von der
// Ergebnisliste auf eine fremde Seite wechselt, beim nächsten Dokument also
// keine Brücke mehr bekommen — window.api existiert dann gar nicht erst.
// Zusätzlich prüft jeder einzelne Kanal im Hauptprozess nochmal die Herkunft.
const { contextBridge, ipcRenderer } = require('electron');

let brückeErlaubt = false;
try {
  brückeErlaubt = ipcRenderer.sendSync('bridge:anfragen') === true;
} catch {
  brückeErlaubt = false;
}

if (!brückeErlaubt) {
  // Fremdes Dokument: nichts freigeben.
  module.exports = {};
} else {
  contextBridge.exposeInMainWorld('api', {
    // Suche
    search: (q) => ipcRenderer.invoke('search:query', q),
    searchImages: (q) => ipcRenderer.invoke('search:images', q),
    onSearchPartial: (cb) => ipcRenderer.on('search:partial', (_e, p) => cb(p)),
    onSearchImagesPartial: (cb) => ipcRenderer.on('search:images-partial', (_e, p) => cb(p)),

    // Navigation
    openInTab: (url) => ipcRenderer.invoke('nav:open-in-tab', url),
    openInNewTab: (url) => ipcRenderer.invoke('nav:new-tab-url', url),
    openInNewWindow: (url) => ipcRenderer.invoke('window:new', url),
    openHistory: () => ipcRenderer.invoke('tabs:history'),
    openSettings: () => ipcRenderer.invoke('tabs:settings'),
    openFavorites: () => ipcRenderer.invoke('tabs:favorites'),
    openPage: (name) => ipcRenderer.invoke('tabs:page', String(name || '')),
    listFavorites: () => ipcRenderer.invoke('favorites:list'),
    addFavorite: (e) => ipcRenderer.invoke('favorites:add', e),
    removeFavorite: (url) => ipcRenderer.invoke('favorites:remove', url),
    renameFavorite: (p) => ipcRenderer.invoke('favorites:rename', p),
    onFavorites: (cb) => ipcRenderer.on('favorites', (_e, list) => cb(list)),
    print: () => ipcRenderer.invoke('page:print'),
    printUrl: (url) => ipcRenderer.invoke('page:print-url', url),
    copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

    // Daten
    listHistory: () => ipcRenderer.invoke('history:list'),
    listDownloads: () => ipcRenderer.invoke('downloads:list'),
    clearHistory: () => ipcRenderer.invoke('history:clear'),
    clearDownloads: () => ipcRenderer.invoke('downloads:clear'),
    clearAllData: () => ipcRenderer.invoke('data:clear-all'),
    faviconGet: (host) => ipcRenderer.invoke('favicon:get', host),
    faviconsGet: (hosts) => ipcRenderer.invoke('favicons:get', hosts),

    // Einstellungen und Zustand
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
    appVersion: () => ipcRenderer.invoke('app:version'),
    profileStatus: () => ipcRenderer.invoke('app:profile-status'),
    onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),

    // Cloud
    cloudTest: (p) => ipcRenderer.invoke('cloud:test', p),
    cloudSave: (p) => ipcRenderer.invoke('cloud:save', p),
    cloudRestore: (p) => ipcRenderer.invoke('cloud:restore', p),

    // Assistenten-Anbindung (MCP)
    agentStatus: () => ipcRenderer.invoke('agent:status'),
    agentToken: () => ipcRenderer.invoke('agent:token'),
    agentSetEnabled: (an) => ipcRenderer.invoke('agent:set-enabled', an),
    agentRotate: () => ipcRenderer.invoke('agent:rotate'),
    agentRevoke: () => ipcRenderer.invoke('agent:revoke'),
    agentConfig: () => ipcRenderer.invoke('agent:config'),
  });
}
