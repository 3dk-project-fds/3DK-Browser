// 3DK Browser — Hauptprozess.
//
// Zuständig für: Einstellungen (verschlüsselt), Fenster/Tabs (shell.js),
// IPC mit Vertrauensprüfung, Session-Härtung, Downloads, Verlauf, Suche mit
// progressiven Ergebnissen, Favicon-Cache, Cloud-Backup.
//
// Grundregel im ganzen File: Ein Kanal, der Nutzerdaten anfasst, prüft zuerst,
// ob die Anfrage von einer eigenen Browser-Seite kommt (security.requireInternal).
// Fremde Webseiten sehen diese API nicht — und wenn sie es doch versuchen,
// kommt nichts zurück.

const { app, BrowserWindow, ipcMain, session, net, clipboard, Menu, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const security = require('./security');
const store = require('./store');
const history = require('./history');
const search = require('./search');
const agentApi = require('./agent-api');
const { createShell } = require('./shell');

const SEARCH_LOG_LIMIT = 200 * 1024; // 200 KB, dann rotiert
const FAVICON_DIR_NAME = 'favicons';

// ── Einstellungen ───────────────────────────────────────────────────────
const DEFAULTS = {
  schema: 4,
  theme: 'dark',
  privacy: {
    trackerBlock: true,
    adblock: true,
    blockThirdPartyCookies: true,
    referrerTrim: true,
    signalDoNotTrack: true,
    userAgentShield: true,
  },
  search: { instance: '', publicSearxng: true, deepRead: true, deepCount: 3 },
  // Spracheingabe: nach Fund des Abbruch-Bugs (zweiter Klick verwarf die
  // Aufnahme statt sie umzuwandeln) wieder standardmäßig an.
  cloud: { url: '', user: '', folder: '/3dk-browser/', autoSync: false, allowInsecure: false },
  agent: {
    enabled: false,
    port: 8765,
    token: '',
    tokenErneuertAm: 0,
    tools: { search: true, fetch: true },
    allowScreenshot: true,
  },
  debug: { searchLog: false },
};

// Nur diese Felder dürfen die Oberfläche schreiben — ein Tippfehler oder eine
// manipulierte Seite kann so keine unbekannten Schlüssel unterjubeln.
const WRITABLE = {
  theme: (v) => v === 'dark' || v === 'light',
  'privacy.trackerBlock': Boolean,
  'privacy.adblock': Boolean,
  'privacy.blockThirdPartyCookies': Boolean,
  'privacy.referrerTrim': Boolean,
  'privacy.signalDoNotTrack': Boolean,
  'privacy.userAgentShield': Boolean,
  'search.instance': (v) => typeof v === 'string' && (!v || /^https?:\/\//i.test(v)),
  'search.publicSearxng': (v) => typeof v === 'boolean',
  'search.deepRead': (v) => typeof v === 'boolean',
  'search.deepCount': (v) => [3, 5, 7].includes(Number(v)),
  'cloud.url': (v) => typeof v === 'string' && (!v.trim() || /^https?:\/\//i.test(v.trim())),
  'cloud.user': (v) => typeof v === 'string',
  'cloud.folder': (v) => typeof v === 'string',
  'cloud.autoSync': Boolean,
  'cloud.allowInsecure': Boolean,
  'debug.searchLog': Boolean,
  'agent.enabled': Boolean,
  'agent.port': (v) => Number.isFinite(v) && v >= 1024 && v <= 65535,
  'agent.allowScreenshot': Boolean,
  'agent.tools.search': Boolean,
  'agent.tools.fetch': Boolean,
};

let settings = structuredClone(DEFAULTS);
let favoriten = [];

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function mergeDefaults(loaded) {
  const out = structuredClone(DEFAULTS);
  for (const group of ['privacy', 'search', 'cloud', 'debug', 'agent']) {
    Object.assign(out[group], (loaded && loaded[group]) || {});
  }
  if (loaded && loaded.agent && loaded.agent.tools) out.agent.tools = { ...out.agent.tools, ...loaded.agent.tools };
  if (loaded) {
    if (loaded.theme === 'light' || loaded.theme === 'dark') out.theme = loaded.theme;
    if (loaded.schema) out.schema = loaded.schema;
  }
  return out;
}

function loadSettings() {
  settings = mergeDefaults(store.read('einstellungen', {}));
  // Favoriten einlesen: nur echte Web-URLs, Felder gestutzt — alte oder
  // kaputte Einträge aus fremden Quellen werden beim Laden verworfen.
  favoriten = (store.read('favoriten', []) || [])
    .filter((f) => f && security.isWebUrl(String(f.url || '')))
    .map((f) => ({ name: String(f.name || f.url).slice(0, 120), url: String(f.url), angelegt: String(f.angelegt || '') }));
  // Das Such-Protokoll der alten Version stand im Klartext im Profil. Wenn die
  // Protokollierung aus ist (Standard), gehört die Datei weg.
  if (!settings.debug.searchLog) {
    for (const name of ['suche.log', 'suche.log.1']) {
      try { fs.unlinkSync(path.join(app.getPath('userData'), name)); } catch { /* gab sie nicht */ }
    }
  }
}
// Der Netzwerk-Schalter gegen Drittanbieter-Cookies muss VOR app.whenReady
// gesetzt werden. Die Einstellung liegt deshalb zusätzlich in einer kleinen,
// unbedenklichen Klartextdatei (nur dieses eine Kreuzchen, keine Nutzerdaten).
const LAUNCH_FILE = 'startoptionen.json';
function launchFile() {
  return path.join(app.getPath('userData'), LAUNCH_FILE);
}
function readLaunchOptions() {
  try { return JSON.parse(fs.readFileSync(launchFile(), 'utf8')); }
  catch { return { blockThirdPartyCookies: true }; }
}
function writeLaunchOptions() {
  try {
    fs.writeFileSync(launchFile(), JSON.stringify({
      blockThirdPartyCookies: settings.privacy.blockThirdPartyCookies !== false,
    }));
  } catch { /* Standard gilt beim nächsten Start */ }
}

function applyLaunchSwitches() {
  const opts = readLaunchOptions();
  if (opts.blockThirdPartyCookies !== false) {
    app.commandLine.appendSwitch('test-third-party-cookie-phaseout');
  }
}

function saveSettings() {
  store.writeNow('einstellungen', settings);
  writeLaunchOptions();
}
function getSettings() {
  return settings;
}

// Der Assistenten-Schlüssel gehört nicht in jede Einstellungsmeldung: gesendet
// wird er nur, wenn die Einstellungsseite ihn ausdrücklich anfordert.
function settingsOhneSchluessel(s) {
  const kopie = structuredClone(s);
  if (kopie.agent) kopie.agent.token = kopie.agent.token ? '••••••' : '';
  return kopie;
}

const blocked = { tracker: 0, permission: 0, navigation: 0, data: 0 };
function noteBlocked(kind, url) {
  const k = String(kind);
  if (k.startsWith('Tracker')) blocked.tracker++;
  else if (k.startsWith('Berechtigung')) blocked.permission++;
  else if (k.startsWith('Navigation')) blocked.navigation++;
  else if (k.startsWith('Datenzugriff')) blocked.data++;
  console.warn('[3DK][blockiert] ' + kind + ' — ' + String(url || '').slice(0, 160));
}

// ── Fenster ─────────────────────────────────────────────────────────────
const shells = new Set();

function activeShell() {
  const focused = BrowserWindow.getFocusedWindow();
  for (const s of shells) if (focused && s.win === focused) return s;
  return [...shells].filter((s) => !s.isClosed()).pop() || null;
}

function shellOfSender(sender) {
  for (const s of shells) {
    if (s.isClosed()) continue;
    if (s.owns(sender)) return s;
  }
  return null;
}

function addShell(startUrl) {
  const shell = createShell({
    getSettings,
    version: () => app.getVersion(),
    startUrl,
    onClosed: (s) => {
      shells.delete(s);
      if (!shells.size) app.quit();
    },
  });
  shells.add(shell);
  if (startUrl) shell.createTab(startUrl);
  else shell.createTab(null);
  return shell;
}

function broadcast(channel, payload) {
  for (const s of shells) s.sendToTabs(channel, payload);
}

// ── Protokoll der Suchanfragen (abschaltet, standardmäßig aus) ─────────
function logSearch(query, ms, prefetch, meta) {
  if (!settings.debug.searchLog) return;
  try {
    const file = path.join(app.getPath('userData'), 'suche.log');
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > SEARCH_LOG_LIMIT) {
        fs.renameSync(file, file + '.1');
      }
    } catch { /* Rotation ist egal */ }
    fs.appendFileSync(
      file,
      new Date().toISOString() + ' ' + (prefetch ? '[vorab] ' : '') + ms + 'ms  ' + query +
        (meta ? '  ' + JSON.stringify(meta) : '') + '\n'
    );
  } catch { /* Protokollierung darf nie stören */ }
}

function ipcError(channel, e) {
  console.warn('[3DK][IPC] ' + channel + ': ' + (e && e.message ? e.message : e));
  return { ok: false, error: 'Kein Zugriff' };
}

// Kanal mit Vertrauensprüfung: nur eigene Seiten, sonst ablehnen.
function internalHandler(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    // Wirft bei Anfragen von fremden Seiten: der Aufrufer im Renderer lehnt ab,
    // es wandert kein einziges Byte an ihn. Zählbar bleibt es trotzdem.
    try {
      security.requireInternal(event, channel);
    } catch (e) {
      noteBlocked('Datenzugriff über ' + channel, event.senderFrame && event.senderFrame.url);
      throw e;
    }
    try {
      return await fn(event, ...args);
    } catch (e) {
      return ipcError(channel, e);
    }
  });
}

// ── Favicon-Cache (erst Platte, dann Netz) ─────────────────────────────
const faviconMemory = new Map();

function faviconDiskPath(host) {
  const hash = crypto.createHash('sha1').update(host).digest('hex');
  return path.join(app.getPath('userData'), FAVICON_DIR_NAME, hash.slice(0, 24) + '.img');
}

async function fetchFavicon(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  if (!h || !/^[a-z0-9.-]+$/.test(h)) return '';
  if (faviconMemory.has(h)) return faviconMemory.get(h);
  const disk = faviconDiskPath(h);
  try {
    if (fs.existsSync(disk)) {
      const buf = fs.readFileSync(disk);
      const mime = buf.slice(1, 4).toString('latin1') === 'PNG' ? 'image/png' : 'image/x-icon';
      const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
      faviconMemory.set(h, dataUrl);
      return dataUrl;
    }
  } catch { /* Platte ist optional */ }

  for (const url of ['https://' + h + '/favicon.ico', 'https://' + h + '/apple-touch-icon.png']) {
    try {
      const res = await net.fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'follow' });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 200000) continue;
      const type = res.headers.get('content-type') || '';
      if (!/image|icon/i.test(type)) continue;
      const mime = /png/i.test(type) ? 'image/png' : 'image/x-icon';
      try {
        fs.mkdirSync(path.dirname(disk), { recursive: true });
        fs.writeFileSync(disk, buf);
      } catch { /* Cache ist optional */ }
      const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
      faviconMemory.set(h, dataUrl);
      return dataUrl;
    } catch { /* nächste Variante */ }
  }
  faviconMemory.set(h, '');
  return '';
}

// ── Start ────────────────────────────────────────────────────────────
// Prüfmodus (Sicherheitsprobe): eigenes Wegwerf-Profil, damit die Sonde
// parallel zum offenen Browser laufen kann — sonst beendet die Single-
// Instance-Sperre die zweite Instanz sofort und alle Fensterprüfungen
// fallen durch. Vor applyLaunchSwitches, damit auch die Startschalter und
// der Tresor-Schlüssel im Sonden-Profil liegen, nie im Nutzerprofil.
if (process.env.BROWSER_PROBE_URL) {
  app.setPath('userData', path.join(os.tmpdir(), '3dk-sonde-' + process.pid));
}
applyLaunchSwitches();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // Öffnet die Adresse in einem bestehenden Fenster statt einer zweiten
    // Instanz — zwei Prozesse auf demselben Profil wären ein Datenrennen.
    const url = (argv || []).find((a) => /^https?:\/\//i.test(a));
    const shell = activeShell() || addShell();
    if (!shell) return;
    if (url) shell.createTab(url);
    if (shell.win.isMinimized()) shell.win.restore();
    shell.win.focus();
  });

  main();
}

let originalUa = '';

function main() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  Menu.setApplicationMenu(null);

  app.whenReady().then(() => {
    store.init();
    loadSettings();
    history.initFiles();
    search.configure(getSettings);
    // Baustein 2: öffentliche SearXNG-Instanzen werden im leeren Agent-Profil
    // (echter Chromium) geladen — JS-Schutzwände lösen sich dort automatisch.
    search.setSearxngLoader((url, opts) => require('./agent-tools').fetchHtmlImAgentProfil(url, opts));
    search.setPageLoader((url, opts) => require('./agent-tools').fetchHtmlImAgentProfil(url, opts));
    agentApi.init();

    const ses = session.defaultSession;

    // Benutzerkennung entlarvt den Browser als Electron-Bau.
    originalUa = ses.getUserAgent();
    ses.setUserAgent(stripUa(originalUa));

    security.installSessionHardening(ses, getSettings, noteBlocked);
    applyPrivacyToggles(ses);

    // Downloads mitprotokollieren.
    ses.on('will-download', (_e, item) => {
      const entry = { url: item.getURL(), filename: item.getFilename() };
      item.once('done', (_ev, state) => {
        entry.state = state;
        entry.path = item.getSavePath();
        try { entry.size = fs.statSync(entry.path).size; } catch { entry.size = 0; }
        history.addDownload(entry);
      });
    });

    registerIpc(ses);

    // Assistenten-Dienst aus der letzten Sitzung weiterlaufen lassen.
    if (settings.agent.enabled) {
      agentApi.start(agentKontext()).then((st) => broadcast('agent-state', st)).catch((e) => {
        console.warn('[3DK][agent] Dienst konnte nicht starten: ' + e.message);
      });
    }

    // Adresse aus der Aufrufkette öffnen (npm start, Verknüpfung, second-instance).
    const startAusArgument = process.argv.find((a) => /^https?:\/\//i.test(a));
    addShell(startAusArgument);

    // Vorverbindungen zur Suche: kostet beim Start nichts, spart bei der
    // ersten Anfrage DNS und TLS-Handschlag.
    setTimeout(() => search.warmConnections().catch(() => {}), 1200);
    setInterval(() => search.warmConnections().catch(() => {}), 4 * 60 * 1000).unref?.();

    // Entwicklungshilfe für Bildschirmfotos: im Auslieferungs-Build fehlt die
    // Datei (build.files schließt *test* aus) — deshalb mit Absicherung.
    try {
      require('./devtest').install({
        app,
        shell: () => activeShell() || addShell(),
      status: () => ({ blocked: { ...blocked }, settings, profile: store.status() }),
      enableAgent: async (token) => {
        settings.agent = { ...settings.agent, enabled: true, token: String(token) };
        saveSettings();
        const st = await agentApi.start(agentKontext());
        broadcast('agent-state', st);
        return st;
      },
        setTheme: (t) => {
          settings.theme = t;
          saveSettings();
          broadcast('settings', settings);
        },
      });
    } catch (e) {
      if (app.isPackaged !== true) console.warn('[3DK][test] Entwicklerwerkzeug nicht geladen: ' + e.message);
    }

    app.on('activate', () => {
      if (!shells.size) addShell();
    });
  });
}

function stripUa(ua) {
  return String(ua).replace(/\s*Electron\/[\d.]+/i, '').replace(/\s*3DK-Browser\/[\d.]+/i, '').trim();
}

function applyPrivacyToggles(ses) {
  security.applyCookieMode(ses, settings.privacy.blockThirdPartyCookies);
  ses.setUserAgent(settings.privacy.userAgentShield ? stripUa(originalUa) : originalUa);
}

// Dem Assistenten-Dienst erlaubter Zugriff auf die Einstellungen: lesen und
// nur die eigenen Felder schreiben.
function agentKontext() {
  return {
    getSettings,
    saveSettings: (naechste) => {
      settings = mergeDefaults(naechste);
      saveSettings();
      applyPrivacyToggles(session.defaultSession);
      broadcast('settings', settingsOhneSchluessel(settings));
    },
  };
}

// ── IPC ─────────────────────────────────────────────────────────────────
function registerIpc(ses) {
  // Anfrage des Preloads: darf dieses Dokument die Browser-Brücke haben?
  // Nur das Hauptrahmen eines Tabs, dessen Navigation zu einer eigenen Seite
  // führt — shell.js setzt das Fenster schon vor dem neuen Dokument.
  ipcMain.on('bridge:anfragen', (event) => {
    const wc = event.sender;
    const hauptRahmen = event.senderFrame && wc.mainFrame && event.senderFrame === wc.mainFrame;
    event.returnValue = Boolean(hauptRahmen && wc.__bruecke === true);
  });

  // Chrome-Leiste
  internalHandler('tabs:list', (e) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (!shell) return [];
    return [...shell.tabs.entries()].map(([id, t]) => ({
      id, url: t.url, title: t.title, secure: t.secure, active: id === shell.activeId,
    }));
  });
  internalHandler('tabs:new', (e) => {
    (shellOfSender(e.sender) || activeShell() || addShell()).createTab(null);
    return true;
  });
  internalHandler('tabs:activate', (e, id) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (shell) shell.activate(String(id));
    return true;
  });
  internalHandler('tabs:close', (e, id) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (shell) shell.closeTab(String(id));
    return true;
  });
  internalHandler('tabs:settings', (e) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (shell) shell.openPage('settings');
    return true;
  });
  internalHandler('tabs:history', (e) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (shell) shell.openPage('history');
    return true;
  });
  internalHandler('tabs:favorites', (e) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (shell) shell.openPage('favorites');
    return true;
  });
  // Interne Rechtstexte (Impressum, Datenschutz) — feste Whitelist.
  internalHandler('tabs:page', (e, name) => {
    const sauber = String(name || '');
    if (!['impressum', 'datenschutz', 'favorites', 'history', 'settings'].includes(sauber)) return false;
    const shell = shellOfSender(e.sender) || activeShell();
    if (shell) shell.openPage(sauber);
    return true;
  });
  internalHandler('chrome:extra', (e, px) => {
    const shell = shellOfSender(e.sender);
    if (shell && shell.setChromeExtra) shell.setChromeExtra(px);
    return true;
  });

  // ── Favoriten: verschlüsselt wie Verlauf und Einstellungen ──────────
  const favKopie = () => favoriten.map((f) => ({ ...f }));
  const favSpeichern = () => {
    store.writeNow('favoriten', favoriten);
    broadcast('favorites', favKopie());
  };
  internalHandler('favorites:list', () => favKopie());
  internalHandler('favorites:add', (_e, eintrag) => {
    const url = String((eintrag && eintrag.url) || '').trim();
    if (!security.isWebUrl(url)) return false;
    if (favoriten.some((f) => f.url === url)) return false;
    let name = String((eintrag && eintrag.name) || '').trim().slice(0, 120);
    if (!name) { try { name = new URL(url).hostname; } catch { name = url; } }
    favoriten.push({ name, url, angelegt: new Date().toISOString() });
    favSpeichern();
    return true;
  });
  internalHandler('favorites:remove', (_e, url) => {
    const vorher = favoriten.length;
    favoriten = favoriten.filter((f) => f.url !== String(url || ''));
    if (favoriten.length === vorher) return false;
    favSpeichern();
    return true;
  });
  internalHandler('favorites:rename', (_e, patch) => {
    const f = favoriten.find((x) => x.url === String((patch && patch.url) || ''));
    if (!f) return false;
    const name = String((patch && patch.name) || '').trim().slice(0, 120);
    if (!name) return false;
    f.name = name;
    favSpeichern();
    return true;
  });
  internalHandler('nav:navigate', (e, input) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (shell) shell.navigate(String(input || ''));
    return true;
  });
  internalHandler('nav:open-in-tab', (e, input) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (!shell) return false;
    const s = String(input || '').trim();
    if (!s) return false;
    if (security.isWebUrl(s) || s.startsWith('search:')) {
      shell.openExternal(s);
      return true;
    }
    // Keine lokalen oder Browser-Sonderziele von einer Seite aus.
    shell.navigate(s);
    return true;
  });
  internalHandler('nav:new-tab-url', (e, url) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (!shell || !security.isWebUrl(url)) return false;
    shell.createTab(String(url));
    return true;
  });
  internalHandler('window:new', (e, url) => {
    const target = security.isWebUrl(url) ? String(url) : null;
    addShell(target);
    return true;
  });
  internalHandler('nav:back', (e) => {
    const wc = (shellOfSender(e.sender) || activeShell() || { activeWebContents: () => null }).activeWebContents();
    if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    return true;
  });
  internalHandler('nav:forward', (e) => {
    const wc = (shellOfSender(e.sender) || activeShell() || { activeWebContents: () => null }).activeWebContents();
    if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    return true;
  });
  internalHandler('nav:reload', (e) => {
    const wc = (shellOfSender(e.sender) || activeShell() || { activeWebContents: () => null }).activeWebContents();
    if (wc) wc.reload();
    return true;
  });
  internalHandler('nav:home', (e) => {
    const shell = shellOfSender(e.sender) || activeShell();
    if (shell) shell.goHome();
    return true;
  });

  // Suche: erste Antwort sofort, weitere Zwischenmeldungen über den Kanal.
  internalHandler('search:query', (e, q) => {
    const query = String(q || '');
    const sender = e.sender;
    const t0 = Date.now();
    return search.searchWeb(query, (payload) => {
      if (sender.isDestroyed()) return;
      sender.send('search:partial', { query, ...payload });
    }).then((payload) => {
      logSearch(query, Date.now() - t0, false, payload.sources);
      return payload;
    });
  });
  internalHandler('search:prefetch', (e, q) => {
    const query = String(q || '').trim();
    if (query.length < 3) return { ok: false };
    const t0 = Date.now();
    return search
      .searchWeb(query)
      .then((p) => { logSearch(query, Date.now() - t0, true, p.sources); return { ok: true }; })
      .catch(() => ({ ok: false }));
  });
  internalHandler('search:images', (e, q) => {
    const query = String(q || '');
    const sender = e.sender;
    return search.searchImages(query, (list, done) => {
      if (sender.isDestroyed()) return;
      sender.send('search:images-partial', { query, results: list, done });
    });
  });

  // ── Spracheingabe: lokal auf dem Gerät ───────────────────────────────
  // Einstellungen
  internalHandler('settings:get', () => settingsOhneSchluessel(settings));
  internalHandler('settings:set', (_e, patch) => {
    const accepted = {};
    for (const [dotted, value] of Object.entries(flatten(patch || {}))) {
      const check = WRITABLE[dotted];
      if (!check) {
        console.warn('[3DK][Einstellungen] unbeknter Schlüssel abgelehnt: ' + dotted);
        continue;
      }
      let ok = false;
      try { ok = Boolean(check(value)); } catch { ok = false; }
      if (!ok) {
        console.warn('[3DK][Einstellungen] Wert abgelehnt: ' + dotted);
        continue;
      }
      accepted[dotted] = value;
    }
    for (const [dotted, value] of Object.entries(accepted)) setPath(settings, dotted, value);
    settings = mergeDefaults(settings);
    saveSettings();
    applyPrivacyToggles(ses);
    broadcast('settings', settingsOhneSchluessel(settings));
    return settingsOhneSchluessel(settings);
  });
  internalHandler('app:version', () => app.getVersion());

  // Seitenvorschläge für „Direkt bei“ (Baustein B) — Sitenachschlaege.json im Profil
  const sitePfad = () => require('path').join(app.getPath('userData'), 'Sitenachschlaege.json');
  const siteLesen = () => { try { const d = JSON.parse(fs.readFileSync(sitePfad(), 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } };
  const siteSchreiben = (liste) => { try { fs.writeFileSync(sitePfad(), JSON.stringify(liste, null, 2)); return true; } catch { return false; } };
  internalHandler('sites:list', () => siteLesen());
  internalHandler('sites:add', (_e, site) => {
    const name = String((site && site.name) || '').trim().slice(0, 80);
    const suche = String((site && site.suche) || '').trim().slice(0, 300);
    const themen = String((site && site.themen) || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12);
    if (!name || !/^https:\/\/[^\s]+/.test(suche)) return { ok: false, grund: 'Name und https-Such-URL nötig' };
    const liste = siteLesen();
    if (liste.length >= 60) return { ok: false, grund: 'Mehr als 60 eigene Seiten werden nicht gespeichert' };
    let domain = '';
    try { domain = new URL(suche).hostname; } catch { /* leer */ }
    liste.push({ name, domain, suche, themen, kategorie: 'eigen', prioritaet: 1, sprache: 'de' });
    return siteSchreiben(liste) ? { ok: true, liste } : { ok: false, grund: 'Speichern fehlgeschlagen' };
  });
  internalHandler('sites:clear', () => (siteSchreiben([]) ? { ok: true, liste: [] } : { ok: false }));
  internalHandler('app:profile-status', () => ({
    ...store.status(),
    searchCache: search.cacheStats(),
    blocked: { ...blocked },
  }));

  // Verlauf und Downloads
  internalHandler('history:list', () => history.listHistory());
  internalHandler('downloads:list', () => history.listDownloads());
  internalHandler('history:clear', () => {
    const before = history.listHistory().length;
    history.clearHistory();
    return { ok: true, removed: before };
  });
  internalHandler('downloads:clear', () => {
    history.clearDownloads();
    return { ok: true };
  });
  // "Alles löschen" im Sinne des Datenschutzes: auch Cookies, Cache,
  // LocalStorage und die Suchspuren.
  internalHandler('data:clear-all', async () => {
    history.clearHistory();
    history.clearDownloads();
    search.clearCaches();
    faviconMemory.clear();
    try {
      await ses.clearCache();
      await ses.clearStorageData({
        storages: [
          'cookies', 'localStorage', 'indexedDB', 'webSQL', 'serviceWorkers',
          'cache', 'blob', 'fileSystems', 'appCache', 'shaderCache',
        ],
      });
    } catch (e) {
      console.warn('[3DK] Webspeicher leeren: ' + e.message);
    }
    try {
      fs.unlinkSync(path.join(app.getPath('userData'), 'suche.log'));
      fs.unlinkSync(path.join(app.getPath('userData'), 'suche.log.1'));
    } catch { /* gab nichts zu löschen */ }
    try {
      fs.rmSync(path.join(app.getPath('userData'), FAVICON_DIR_NAME), { recursive: true, force: true });
    } catch { /* egal */ }
    try {
      await require('./agent-tools').clearAgentProfile();
      agentApi.protokollLeeren();
    } catch { /* Dienst war vielleicht schon aus */ }
    return { ok: true };
  });

  // Favicon(s)
  internalHandler('favicon:get', async (_e, host) => fetchFavicon(host));
  internalHandler('favicons:get', async (_e, hosts) => {
    const list = [...new Set((Array.isArray(hosts) ? hosts : []).slice(0, 60).map(String))];
    const out = {};
    // Reihenfolge egal, aber nicht 60 Anfragen hintereinander wegschicken.
    const chunk = [];
    for (let i = 0; i < list.length; i += 8) {
      chunk.push(Promise.all(list.slice(i, i + 8).map(async (h) => { out[h] = await fetchFavicon(h); })));
    }
    await Promise.all(chunk);
    return out;
  });

  // Rechtsklick-Aktionen
  internalHandler('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text || '').slice(0, 8000));
    return true;
  });
  internalHandler('page:print', (e) => {
    const shell = shellOfSender(e.sender) || activeShell();
    const wc = shell && shell.activeWebContents();
    if (!wc) return false;
    return new Promise((resolve) => wc.print({}, () => resolve(true)));
  });
  internalHandler('page:print-url', async (_e, url) => {
    if (!security.isWebUrl(url)) return false;
    const tmp = new BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      await tmp.loadURL(String(url));
      await new Promise((resolve) => tmp.webContents.print({}, () => resolve(true)));
    } catch (e) {
      console.warn('[3DK] Drucken: ' + e.message);
    } finally {
      tmp.destroy();
    }
    return true;
  });

  // Assistenten-Anbindung (MCP)
  internalHandler('agent:status', () => agentApi.status({ getSettings }));
  internalHandler('agent:token', () => (settings.agent.token ? {
    token: settings.agent.token,
    erneuertAm: settings.agent.tokenErneuertAm || 0,
  } : { token: '', erneuertAm: 0 }));
  internalHandler('agent:set-enabled', async (_e, an) => {
    settings.agent.enabled = Boolean(an);
    saveSettings();
    const st = an ? await agentApi.start(agentKontext()) : await agentApi.stop();
    if (!an) await require('./agent-tools').clearAgentProfile();
    broadcast('agent-state', st);
    return st;
  });
  internalHandler('agent:rotate', async () => {
    const token = await agentApi.schluesselErneuern(agentKontext());
    const st = agentApi.status({ getSettings });
    broadcast('agent-state', st);
    return { token, ...st };
  });
  internalHandler('agent:revoke', async () => {
    settings.agent.enabled = false;
    settings.agent.token = '';
    saveSettings();
    await agentApi.stop();
    await require('./agent-tools').clearAgentProfile();
    const st = agentApi.status({ getSettings });
    broadcast('agent-state', st);
    return st;
  });
  internalHandler('agent:config', () => {
    const st = agentApi.status({ getSettings });
    return {
      nachweis: agentApi.verbindungsnachweis(st.port || settings.agent.port),
      port: st.port,
      url: st.url,
    };
  });

  // Cloud
  internalHandler('cloud:test', async (_e, { url, user, pass } = {}) => {
    try {
      const cloud = require('./cloud');
      return { ok: true, ...await cloud.cloudTest({ ...settings.cloud, url: url || settings.cloud.url, user: user || settings.cloud.user, pass }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  internalHandler('cloud:save', async (_e, { pass, phrase } = {}) => {
    try {
      const cloud = require('./cloud');
      const r = await cloud.cloudSave({ ...settings.cloud, pass, phrase });
      return { ok: true, detail: r.bytes + ' Bytes gesichert (' + r.count + ' Verlaufsstücke, verschlüsselt)' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  internalHandler('cloud:restore', async (_e, { pass, phrase } = {}) => {
    try {
      const cloud = require('./cloud');
      const r = await cloud.cloudRestore({ ...settings.cloud, pass, phrase });
      const counts = history.replaceFromBackup(r.history, r.downloads);
      let zusatz = '';
      if (Array.isArray(r.favoriten)) {
        favoriten = r.favoriten
          .filter((f) => f && security.isWebUrl(String(f.url || '')))
          .map((f) => ({ name: String(f.name || f.url).slice(0, 120), url: String(f.url), angelegt: String(f.angelegt || new Date().toISOString()) }));
        store.writeNow('favoriten', favoriten);
        broadcast('favorites', favKopie());
        zusatz = ', ' + favoriten.length + ' Favoriten';
      }
      return { ok: true, detail: counts.history + ' Verlaufseinträge, ' + counts.downloads + ' Downloads' + zusatz + ' wiederhergestellt' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// Flache Darstellung eines verschachtelten Patches: {privacy:{x:1}} → {"privacy.x":1}
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

app.on('window-all-closed', () => {
  store.flush();
  app.quit();
});
app.on('before-quit', () => store.flush());
