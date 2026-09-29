// 3DK Browser — Entwicklungshilfe für Bildschirmfotos.
// Nur im ausgepackten Zustand (npm start) und nur, wenn eine UmgebungVariable
// gesetzt ist. Ein Auslieferungs-Build enthält diesen Pfad gar nicht erst.
//
//   BROWSER_AUTOTEST=<query>          sucht und fotografiert die Ergebnisliste
//   BROWSER_SHOT_URL=<url>            fotografiert die Leiste mit geladener Seite
//   BROWSER_SHOT_HISTORY=1            fotografiert die Verlaufsseite
//   BROWSER_SHOT_SETTINGS=dark|light  fotografiert die Einstellungen
//   BROWSER_SHOT_TOOLBAR=1            fotografiert nur die Leiste
//   BROWSER_SHOT_OUT=<ordner>         Zielordner (Standard: Systems-Temp)

const os = require('os');
const fs = require('fs');
const path = require('path');

const WAIT = {
  suche: 6000,
  url: 9000,
  verlauf: 3500,
  einstellungen: 3200,
  leiste: 2500,
};

function install(ctx) {
  const { app, shell, setTheme, env = process.env } = ctx;
  if (app.isPackaged) return;

  // Fehler und CSP-Verstöße aus allen Renderern in die Konsole spiegeln.
  if (env.BROWSER_TEST_CONSOLE) {
    app.on('web-contents-created', (_e, wc) => {
      wc.on('console-message', (_ev, level, message, line, sourceId) => {
        if (level >= 2 || /Content Security Policy|Uncaught/i.test(message)) {
          console.log('[3DK][renderer][' + (wc.getURL() || '').slice(0, 60) + '] ' + message.slice(0, 300));
        }
      });
      wc.on('did-fail-load', (_ev2, code, desc, url) => {
        console.log('[3DK][did-fail-load] ' + code + ' ' + desc + ' ' + String(url).slice(0, 120));
      });
    });
  }

  let job = null;
  let name = 'autotest.png';
  if (env.BROWSER_AUTOTEST) { job = () => shotSearch(env.BROWSER_AUTOTEST); name = 'suche-autotest.png'; }
  else if (env.BROWSER_SHOT_URL) { job = () => shotUrl(env.BROWSER_SHOT_URL); }
  else if (env.BROWSER_SHOT_HISTORY) { job = () => shotPage('history', 'history-autotest.png'); }
  else if (env.BROWSER_SHOT_SETTINGS) { job = () => shotSettings(env.BROWSER_SHOT_SETTINGS); }
  else if (env.BROWSER_SHOT_TOOLBAR) { job = () => shotToolbar(); }
  else if (env.BROWSER_SHOT_PAGE) { job = () => shotPage(env.BROWSER_SHOT_PAGE, env.BROWSER_SHOT_PAGE + '-autotest.png'); }
  else if (env.BROWSER_SHOT_FAVORITES) { job = () => shotFavorites(); name = 'favoriten-autotest.png'; }
  // End-to-End-Prüfung des Assistenten-Dienstes am laufenden Programm:
  //   BROWSER_AGENT_TEST=<schluessel>  schaltet den Dienst ein und lässt ihn an
  if (env.BROWSER_AGENT_TEST) {
    app.whenReady().then(async () => {
      try {
        const mit = ctxRef.enableAgent ? await ctxRef.enableAgent(env.BROWSER_AGENT_TEST) : null;
        console.log('[3DK][test] Agentendienst: ' + JSON.stringify(mit));
      } catch (e) {
        console.log('[3DK][test] Agentendienst fehlgeschlagen: ' + e.message);
      }
    });
  }
  if (env.BROWSER_PROBE_URL) { job = () => probe(env.BROWSER_PROBE_URL, env.BROWSER_PROBE_INTERNAL); }
  if (env.BROWSER_DUMP_STATE) {
    app.whenReady().then(() => setTimeout(dumpState, Number(env.BROWSER_DUMP_STATE) || 3000));
  }
  if (!job) return;

  app.whenReady().then(() => setTimeout(job, 1500));
}

function outDir() {
  const dir = process.env.BROWSER_SHOT_OUT || path.join(os.tmpdir(), '3dk-browser-tests');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function save(image, name) {
  const file = path.join(outDir(), name);
  fs.writeFileSync(file, image.toPNG());
  console.log('[3DK][test] Bild geschrieben: ' + file);
  return file;
}

function finish(name, capture, wait) {
  setTimeout(async () => {
    try {
      const img = await capture();
      if (img) save(img, name);
    } catch (e) {
      console.error('[3DK][test] ' + e.message);
    }
    setTimeout(() => process.exit(0), 250);
  }, wait);
}

let ctxRef = null;
function activeTabShot() {
  const s = ctxRef.shell();
  const wc = s && s.activeWebContents();
  return wc ? wc.capturePage() : null;
}

function shotSearch(query) {
  const s = ctxRef.shell();
  s.createTab('search:' + query);
  // Baustein C liest nach dem ersten Bild noch Seiten — für Prüfbilder kann
  // die Wartezeit über BROWSER_AUTOTEST_WAIT (ms) verlängert werden.
  const wait = Number(process.env.BROWSER_AUTOTEST_WAIT) || WAIT.suche;
  finish('suche-autotest.png', activeTabShot, wait);
}

function shotUrl(url) {
  const s = ctxRef.shell();
  s.createTab(url);
  finish('urlbar-autotest.png', () => s.chromeView.webContents.capturePage(), WAIT.url);
}

function shotPage(page, name) {
  const s = ctxRef.shell();
  s.createTab(page);
  finish(name, activeTabShot, WAIT.verlauf);
}

function shotSettings(mode) {
  const s = ctxRef.shell();
  if (ctxRef.setTheme) ctxRef.setTheme(mode === 'light' ? 'light' : 'dark');
  // Vorher eine echte Seite laden, damit die Blockier-Zähler gefüllt sind.
  if (process.env.BROWSER_SHOT_PREURL) s.createTab(process.env.BROWSER_SHOT_PREURL);
  const y = Number(process.env.BROWSER_SHOT_SCROLL || 0);
  const name = 'einstellungen-' + (mode === 'light' ? 'hell' : 'dunkel') + (y ? '-unten' : '') + '.png';
  const holen = async () => {
    const id = s.createTab('settings');
    s.activate(id);
    const wc = s.activeWebContents();
    await new Promise((r) => setTimeout(r, 1200));
    if (y && wc) {
      await wc.executeJavaScript('window.scrollTo(0, ' + y + ')').catch(() => {});
      await new Promise((r) => setTimeout(r, 400)); // Bildnachlauf abwarten
    }
    return wc ? wc.capturePage() : null;
  };
  finish(name, holen, process.env.BROWSER_SHOT_PREURL ? 9000 : WAIT.einstellungen);
}

function shotToolbar() {
  const s = ctxRef.shell();
  finish('leiste.png', () => s.chromeView.webContents.capturePage(), WAIT.leiste);
}

// Favoriten: zwei echte Einträge über die eigene Brücke anlegen, dann die
// Seite fotografieren und danach das Dropdown der Leiste (eigener Ablauf,
// weil zwei Bilder entstehen — finish() macht nur eines und beendet).
function shotFavorites() {
  const s = ctxRef.shell();
  setTimeout(async () => {
    try {
      s.createTab('favorites');
      const wc = s.activeWebContents();
      await new Promise((r) => setTimeout(r, 900));
      if (wc) {
        await wc.executeJavaScript("window.api.addFavorite({ name: 'Stadt Freudenstadt', url: 'https://www.freudenstadt.de/' })").catch(() => {});
        await wc.executeJavaScript("window.api.addFavorite({ name: 'Raspberry Pi', url: 'https://www.raspberrypi.com/' })").catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        const seite = await wc.capturePage();
        if (seite) save(seite, 'favoriten-autotest.png');
      }
      // Dropdown in der Leiste aufklappen und die Leiste fotografieren.
      if (s.chromeView) {
        await s.chromeView.webContents.executeJavaScript('window.__fav && window.__fav.dropAuf()').catch(() => {});
        await new Promise((r) => setTimeout(r, 450));
        const leiste = await s.chromeView.webContents.capturePage();
        if (leiste) save(leiste, 'favdrop.png');
        await s.chromeView.webContents.executeJavaScript('window.__fav && window.__fav.dropZu()').catch(() => {});
      }
    } catch (e) {
      console.error('[3DK][test] ' + e.message);
    }
    setTimeout(() => process.exit(0), 300);
  }, 3200);
}

// Sicherheitstest: fremde Seite öffnen — wahlweise erst in einer eigenen
// Browser-Seite (Suchergebnisliste) und dann weiterschalten, damit derselbe
// Tab mit angehängter Brücke im Netz landet (der reale Klick-Fall).
function probe(url, viaInternal) {
  const s = ctxRef.shell();
  if (viaInternal) {
    s.createTab('search:' + viaInternal);
    setTimeout(() => {
      const t = s.activeTab();
      if (t) t.view.webContents.loadURL(url);
    }, 1200);
  } else {
    s.createTab(url);
  }
  // Nach 7 Sekunden der Stand: was zeigt die Adressleiste, wo ist der Tab,
  // was hat die Härtung blockiert?
  setTimeout(async () => {
    try {
      const t = s.activeTab();
      const bar = await s.chromeView.webContents.executeJavaScript(
        'JSON.stringify({ bar: document.getElementById("url").value, tabs: document.querySelectorAll(".tab").length })'
      );
      const barObj = JSON.parse(bar);
      const st = ctxRef.status ? ctxRef.status() : {};
      console.log('[3DK][PROBE] ' + JSON.stringify({
        tabUrl: t ? t.url : null,
        bar: barObj.bar,
        tabs: barObj.tabs,
        blocked: st.blocked,
        profile: st.profile,
      }));
    } catch (e) {
      console.log('[3DK][PROBE] FEHLER ' + e.message);
    }
    setTimeout(() => process.exit(0), 400);
  }, 7000);
}

// Diagnose für Tests: Tab-Bestand in Hauptprozess und Leiste vergleichen.
async function dumpState() {
  try {
    const s = ctxRef.shell();
    const inMain = [...s.tabs.entries()].map(([id, t]) => id + '=' + t.url);
    const inDom = await s.chromeView.webContents.executeJavaScript(
      'JSON.stringify({tabs: document.querySelectorAll(".tab").length, url: document.getElementById("url").value, api: typeof window.api})'
    );
    console.log('[3DK][diagnose] Hauptprozess-Tabs: ' + JSON.stringify(inMain));
    console.log('[3DK][diagnose] Leiste: ' + inDom);
    const probe = await s.chromeView.webContents.executeJavaScript(
      'window.api.listTabs().then(r => JSON.stringify({ok:r})).catch(e => JSON.stringify({fehler: String(e && e.message || e)}))'
    );
    console.log('[3DK][diagnose] listTabs(): ' + probe);
    const nachRender = await s.chromeView.webContents.executeJavaScript(`(async () => {
      const vor = document.querySelectorAll(".tab").length;
      let fehler = "";
      try { render(); } catch (e) { fehler = String(e && e.stack || e); }
      const nach = document.querySelectorAll(".tab").length;
      return JSON.stringify({vor, nach, fehler, hatRender: typeof render, tabsLaenge: (typeof tabs === "undefined" ? "kein tabs" : tabs.length)});
    })()`);
    console.log('[3DK][diagnose] render-Test: ' + nachRender);
    // Maßkontrolle: Breite der Leiste gegen Breite des Tab-Inhalts, Scrollbalken?
    const t = s.activeTab();
    const maass = await s.chromeView.webContents.executeJavaScript(
      'JSON.stringify({leisteBreite: window.innerWidth, leisteHoehe: window.innerHeight})').catch(() => '?');
    const imTab = t ? await t.view.webContents.executeJavaScript(
      'JSON.stringify({tabBreite: window.innerWidth, tabHoehe: window.innerHeight, ueberlaufX: document.documentElement.scrollWidth > document.documentElement.clientWidth, ueberlaufY: document.documentElement.scrollHeight > document.documentElement.clientHeight})').catch(() => '?') : 'kein Tab';
    const ansicht = s.win.getBounds();
    console.log('[3DK][diagnose] Fenster: ' + JSON.stringify(ansicht));
    console.log('[3DK][diagnose] Maß: ' + maass + '   Tab: ' + imTab);
  } catch (e) {
    console.log('[3DK][diagnose] fehlgeschlagen: ' + e.message);
  }
  setTimeout(() => process.exit(0), 300);
}

module.exports = {
  install(context) {
    ctxRef = context;
    install(context);
  },
};
