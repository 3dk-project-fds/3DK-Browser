// 3DK Browser — ein Fenster mit seinen Tabs ("Shell").
//
// Jeder Tab ist ein echtes WebContentsView (Chromium-Renderer). Die Chrome-
// Leiste oben (Tabs + Adressleiste) ist eine eigene Ansicht im 3dk-Design.
// Mehrere Fenster = mehrere Shells in EINEM Prozess: gemeinsames Profil,
// keine zwei Schreibzugriffe auf dieselbe Datei.
//
// Vertrauensregel: Ein Tab, der ins Netz geht, bekommt gar keinen Preload.
// Browser-eigene Seiten (Start, Ergebnisse, Einstellungen, Verlauf) bekommen
// preload-tab.js. Wer aus dem Web heraus in einem bereits offenen internen
// Tab landet, läuft trotzdem gegen die Prüfung im Hauptprozess
// (security.requireInternal).

const path = require('path');
const fs = require('fs');
const { BrowserWindow, WebContentsView } = require('electron');
const { isInternalUrl, isWebUrl, isNavigationAllowed } = require('./security');
const history = require('./history');

const CHROME_VIEW_H = 92;
const UI_DIR = path.join(__dirname, 'chrome');

// Ziele, die ein Tab intern anzeigen darf. Alles andere muss eine http(s)-
// Adresse sein.
const INTERNAL_PAGES = {
  start: 'start.html',
  settings: 'settings.html',
  history: 'history.html',
  favorites: 'favorites.html',
  impressum: 'impressum.html',
  datenschutz: 'datenschutz.html',
};

function targetIsInternal(target) {
  if (typeof target !== 'string' || !target) return true; // leer = Startseite
  if (INTERNAL_PAGES[target]) return true;
  if (target.startsWith('search:')) return true;
  if (target.startsWith('internal:')) return true;
  return false;
}

function createShell(deps) {
  const tabs = new Map(); // id -> { view, url, title, secure }
  let nextId = 1;
  let activeId = null;
  let chromeView = null;

  // Fenstersymbol: im Dev-Modus sonst Electron/Chromium-Standard — immer
  // das 3DK-Hexagon zeigen, auch für Entwicklungsläufe und Screenshots.
  const fensterIcon = fs.existsSync(path.join(__dirname, '..', 'build', 'icon.ico'))
    ? path.join(__dirname, '..', 'build', 'icon.ico')
    : path.join(UI_DIR, 'logo-256.png');
  const win = new BrowserWindow({
    icon: fensterIcon,
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: '3DK Browser ' + deps.version(),
    backgroundColor: '#0D0D0D',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const chromePrefs = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
  chromeView = new WebContentsView({ webPreferences: chromePrefs });
  // Transparenter Grund: die Leiste malt ihre eigenen Zeilen, der Zusatz-
  // bereich (Favoriten-Dropdown) lässt die Seite darunter durchscheinen.
  try { chromeView.setBackgroundColor('#00000000'); } catch { /* egal */ }
  win.contentView.addChildView(chromeView);
  // Breite aus dem Inhaltsmaß holen — ein hartes 1280 schneidet auf schmalen
  // Fenstern (oder bei 150 % Skalierung) rechts 14 px ab, Zahnrad und
  // Verbindungsanzeige rutschen dann neben die Seite darunter.
  chromeView.setBounds({ x: 0, y: 0, width: win.getContentSize()[0], height: CHROME_VIEW_H });
  chromeView.webContents.loadFile(path.join(UI_DIR, 'index.html'));
  guardWebContents(chromeView.webContents);
  chromeView.webContents.__bruecke = true; // die Leiste ist immer eigene Seite
  // Tabs, die vor dem Ende des Seitenladens entstanden, nachreichen.
  chromeView.webContents.on('did-finish-load', () => sendTabs());

  function contentBounds() {
    const [w, h] = win.getContentSize();
    return { x: 0, y: CHROME_VIEW_H, width: w, height: Math.max(h - CHROME_VIEW_H, 0) };
  }

  // Zusatzhöhe für Leisten-Overlays (Favoriten-Dropdown): der Bereich unter
  // der eigentlichen Leiste bleibt im Browser transparent und lässt die
  // Seite darunter durchscheinen, während das Dropdown darin liegt.
  let chromeExtraH = 0;
  function setChromeExtra(px) {
    chromeExtraH = Math.max(0, Math.min(520, Number(px) || 0));
    const w = win.getContentSize()[0];
    if (chromeView) {
      chromeView.setBounds({ x: 0, y: 0, width: w, height: CHROME_VIEW_H + chromeExtraH });
      // Im Zusatzbereich liegt die Leiste ÜBER der Seite: wieder nach vorn
      // holen (addChildView verschiebt an das Ende der Kinderliste = oben).
      try { win.contentView.addChildView(chromeView); } catch { /* egal */ }
    }
  }

  win.on('resize', () => {
    const b = contentBounds();
    for (const t of tabs.values()) t.view.setBounds(b);
    if (chromeView) chromeView.setBounds({ x: 0, y: 0, width: b.width, height: CHROME_VIEW_H + chromeExtraH });
  });
  win.on('closed', () => {
    for (const t of tabs.values()) {
      try { t.view.webContents.close(); } catch { /* schon weg */ }
    }
    tabs.clear();
    chromeView = null;
    onClosed && onClosed(shell);
  });

  function sendTabs() {
    if (!chromeView || chromeView.webContents.isDestroyed()) return;
    const list = [...tabs.entries()].map(([id, t]) => ({
      id,
      url: t.url,
      title: t.title,
      secure: t.secure,
      active: id === activeId,
    }));
    try {
      chromeView.webContents.send('tabs', list);
    } catch { /* Fenster gerade im Abbau */ }
  }

  function setActive(id) {
    for (const [tid, t] of tabs) t.view.setVisible(tid === id);
    activeId = id;
    sendTabs();
  }

  function securityStateOf(url) {
    if (!url || url === 'start' || url.startsWith('search:') || url.startsWith('internal:')) return 'internal';
    try {
      const u = new URL(url);
      if (u.protocol === 'https:') return 'secure';
      if (u.protocol === 'http:') return 'insecure';
      return 'other';
    } catch { return 'other'; }
  }

  function guardWebContents(wc) {
    // Brücken-Fenster: die Browser-Brücke bekommt nur ein Dokument, dessen
    // Navigation zu einer eigenen Seite führt. did-start-navigation läuft vor
    // dem neuen Dokument, deshalb weiß der Hauptprozess hier schon Bescheid.
    wc.__bruecke = false;
    wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      wc.__bruecke = isInternalUrl(url);
    });
    // Der Tab bleibt unter Kontrolle: keine Sprünge in lokale oder
    // browser-interne Bereiche, keine Popups außerhalb der Tab-Leiste.
    wc.on('will-navigate', (e, target) => {
      if (!isNavigationAllowed(target)) {
        e.preventDefault();
        console.warn('[3DK] Navigation blockiert: ' + String(target).slice(0, 160));
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (!isWebUrl(url)) return { action: 'deny' };
      createTab(url);
      return { action: 'deny' };
    });
    // Adressleiste muss die Wahrheit sagen — auch bei pushState/Hash.
    wc.on('did-navigate', (_e, url) => {
      const t = tabOf(wc);
      if (!t) return;
      if (url.startsWith('file:')) return; // eigene Seiten behalten ihren Zustandsnamen
      t.url = url;
      t.secure = securityStateOf(url);
      try { t.title = new URL(url).hostname; } catch { t.title = url; }
      history.addVisit(url, t.title);
      sendTabs();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      const t = tabOf(wc);
      if (!t || !isMainFrame) return;
      t.url = url;
      t.secure = securityStateOf(url);
      sendTabs();
    });
    // Tastenkürzel gelten im GANZEN Fenster — auch wenn eine Webseite oder
    // die Startseite den Fokus hat (vorher hing der Handler nur an der Leiste,
    // deshalb wirkten Strg+Tasten nicht).
    wc.on('before-input-event', (_e, input) => handleInput(input));
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = abgebrochen, kein Fehler
      const t = tabOf(wc);
      if (t) { t.title = 'Fehler: ' + (desc || code); sendTabs(); }
    });
    // Tastenkürzel pro Fenster.
    wc.on('before-input-event', (_e, input) => handleInput(input));
  }

  function tabOf(wc) {
    for (const t of tabs.values()) if (t.view.webContents === wc) return t;
    return null;
  }

  function createTab(target) {
    const internal = targetIsInternal(target);
    const view = new WebContentsView({
      webPreferences: {
        // Fremde Seiten bekommen keinerlei Brücke.
        preload: internal ? path.join(__dirname, 'preload-tab.js') : undefined,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const id = 'tab-' + nextId++;
    tabs.set(id, { view, url: internal ? (String(target || 'start').split(':')[0] || 'start') : String(target), title: 'Startseite', secure: 'internal' });
    win.contentView.addChildView(view);
    view.setBounds(contentBounds());
    guardWebContents(view.webContents);
    const t = tabs.get(id);
    if (internal && typeof target === 'string' && target.startsWith('search:')) {
      const q = target.slice(7);
      view.webContents.loadFile(path.join(UI_DIR, 'results.html'), { hash: encodeURIComponent(q) });
      t.url = 'search:' + q;
      t.title = 'Suche: ' + q;
    } else if (internal && typeof target === 'string' && INTERNAL_PAGES[target]) {
      view.webContents.loadFile(path.join(UI_DIR, INTERNAL_PAGES[target]));
      t.url = target;
      t.title = target === 'settings' ? 'Einstellungen' : target === 'history' ? 'Verlauf' : target === 'favorites' ? 'Favoriten' : target === 'impressum' ? 'Impressum' : target === 'datenschutz' ? 'Datenschutzerklärung' : 'Startseite';
    } else if (internal) {
      view.webContents.loadFile(path.join(UI_DIR, 'start.html'));
      t.url = 'start';
      t.title = 'Startseite';
    } else if (isWebUrl(target)) {
      t.url = String(target);
      t.secure = securityStateOf(t.url);
      view.webContents.loadURL(t.url);
    } else {
      // Undeutliche Eingabe: lieber Startseite als irgendwas Lokales.
      view.webContents.loadFile(path.join(UI_DIR, 'start.html'));
      t.url = 'start';
    }
    setActive(id);
    return id;
  }

  function closeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    try { win.contentView.removeChildView(t.view); } catch { /* ok */ }
    try { t.view.webContents.close(); } catch { /* ok */ }
    tabs.delete(id);
    if (activeId === id) {
      const last = [...tabs.keys()].pop();
      if (last) setActive(last);
      else createTab(null);
    } else {
      sendTabs();
    }
  }

  function activeTab() {
    return activeId ? tabs.get(activeId) : null;
  }
  function activeWebContents() {
    const t = activeTab();
    return t ? t.view.webContents : null;
  }

  function navigate(input) {
    const s = String(input || '').trim();
    if (!s) return;
    // Eigenes Schlüsselwort: „favoriten", „impressum" und „datenschutz" in
    // der Adressleiste öffnen die internen Seiten.
    if (/^favorit(en|es)?$/i.test(s)) { createTab('favorites'); return; }
    if (/^impressum$/i.test(s)) { createTab('impressum'); return; }
    if (/^datenschutz$/i.test(s)) { createTab('datenschutz'); return; }
    let target = '';
    if (/^https?:\/\//i.test(s)) target = s;
    else if (!s.includes(' ') && s.includes('.') && !s.endsWith('.')) target = 'https://' + s;

    if (target && isWebUrl(target)) {
      const t = activeTab();
      if (t) {
        t.url = target;
        t.secure = securityStateOf(target);
        t.title = (() => { try { return new URL(target).hostname; } catch { return target; } })();
        t.view.webContents.loadURL(target);
        sendTabs();
      } else {
        createTab(target);
      }
      return;
    }
    createTab('search:' + s);
  }

  function goHome() {
    const t = activeTab();
    if (!t) return;
    t.view.webContents.loadFile(path.join(UI_DIR, 'start.html'));
    t.url = 'start';
    t.title = 'Startseite';
    t.secure = 'internal';
    sendTabs();
  }

  function handleInput(input) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = (input.key || '').toLowerCase();
    const wc = activeWebContents();
    if (ctrl && key === 't') { createTab(null); return; }
    if (ctrl && key === 'w') { if (activeId) closeTab(activeId); return; }
    if (ctrl && key === 'l') {
      if (chromeView) chromeView.webContents.send('focus-url-bar');
      return;
    }
    if (ctrl && key === 'r') { if (wc) wc.reload(); return; }
    if (input.key === 'F5') { if (wc) wc.reload(); return; }
    if (ctrl && key === 'h') { openPage('history'); return; }
    if (ctrl && (key === ',' || key === 'p')) { openPage('settings'); return; }
    if (input.alt && key === 'arrowleft') { if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return; }
    if (input.alt && key === 'arrowright') { if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return; }
    if (input.key === 'Escape') { return; }
  }

  function openPage(name) {
    const t = activeTab();
    if (t && t.url === name) return;
    createTab(name);
  }

  function openExternal(url) {
    const t = activeTab();
    if (t && isWebUrl(url)) {
      t.url = url;
      t.secure = securityStateOf(url);
      try { t.title = new URL(url).hostname; } catch { /* egal */ }
      t.view.webContents.loadURL(url);
      sendTabs();
    } else if (url && String(url).startsWith('search:')) {
      createTab(String(url));
    } else {
      createTab(url);
    }
  }

  const shell = {
    win,
    chromeView,
    tabs,
    createTab,
    closeTab,
    setActive,
    activate: (id) => { if (tabs.has(id)) setActive(id); },
    navigate,
    goHome,
    openPage,
    setChromeExtra,
    openExternal,
    activeTab,
    activeWebContents,
    get activeId() { return activeId; },
    owns: (wc) => {
      if (!wc) return null;
      if (chromeView && chromeView.webContents === wc) return { role: 'chrome' };
      const t = tabOf(wc);
      return t ? { role: 'tab', tab: t } : null;
    },
    sendToTabs: (channel, payload) => {
      for (const t of tabs.values()) {
        try { t.view.webContents.send(channel, payload); } catch { /* ok */ }
      }
      if (chromeView) {
        try { chromeView.webContents.send(channel, payload); } catch { /* ok */ }
      }
    },
    isClosed: () => win.isDestroyed(),
    close: () => { if (!win.isDestroyed()) win.close(); },
  };

  return shell;
}

module.exports = { createShell, CHROME_VIEW_H, INTERNAL_PAGES };
