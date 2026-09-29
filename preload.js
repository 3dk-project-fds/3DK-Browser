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
    // Spracheingabe: Arm-Schalter erlaubt das Mikrofon nur für diesen Klick,
    // Umwandlung läuft lokal im Hauptprozess (Whisper), nichts verlässt das Gerät.
    voiceArm: (on) => ipcRenderer.invoke('voice:arm', on === true),
    voiceTranscribe: (b64, lang) => ipcRenderer.invoke('voice:transcribe', b64, lang),
    voiceLog: (zeile) => ipcRenderer.invoke('voice:log', String(zeile).slice(0, 300)),
    onTabs: (cb) => ipcRenderer.on('tabs', (_e, list) => cb(list)),
    onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
    onAgentState: (cb) => ipcRenderer.on('agent-state', (_e, s) => cb(s)),
    agentStatus: () => ipcRenderer.invoke('agent:status'),
    onFocusUrlBar: (cb) => ipcRenderer.on('focus-url-bar', () => cb()),
  });
}
