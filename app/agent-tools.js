// 3DK Browser — Werkzeuge für Assistenten (Stufe 1 + 2).
//
// Genau zwei Dinge, bewusst ohne jede Bedienung:
//   search3dk  → die 3DK-Suche (parallele Quellen, lokal neu gereiht)
//   fetchPage  → eine Seite im echten Chromium lesen, auch wenn sie erst durch
//                JavaScript entstanden ist
//
// Der Abruf läuft in einem eigenen, leeren Profil (Partition "3dk-agent"):
// keine Cookies deines Browsers, kein Verlauf, keine angemeldeten Konten.
// Adressen in lokalen Netzen sind gesperrt — auch dann, wenn eine Domain dort
// hin aufgelöst wird, und auch für einen Weiterleitungs-Ziel.

const dns = require('dns').promises;
const { BrowserWindow, session } = require('electron');
const security = require('./security');
const search = require('./search');

const PARTITION = '3dk-agent';
const LIMITS = {
  maxBytes: 400000,
  maxText: 20000,
  maxLinks: 200,
  maxTitle: 300,
  timeoutMs: 15000,
  maxRedirects: 5,
  settleMs: 1200, // Zeit für JavaScript, damit gerenderte Seiten nicht leer kommen
  maxScreenshotBase64: 1600000,
};

const dnsCache = new Map(); // host -> { at, ip, privat }
const DNS_TTL = 5 * 60 * 1000;

let busy = false; // ein Abruf nach dem anderen
let guardInstalled = false;

function agentSession() {
  return session.fromPartition(PARTITION);
}

async function resolveHost(host) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL) return hit;
  const eintrag = { at: Date.now(), ip: '', privat: false };
  try {
    if (/^[\d.]+$/.test(host) || host.includes(':')) {
      eintrag.ip = host;
      eintrag.privat = security.isPrivateAddress(host);
    } else {
      const res = await dns.lookup(host);
      eintrag.ip = res.address;
      eintrag.privat = security.isPrivateAddress(res.address);
    }
  } catch {
    eintrag.privat = false; // nicht auflösbar → Chromium meldet ohnehin
  }
  dnsCache.set(host, eintrag);
  if (dnsCache.size > 500) dnsCache.clear();
  return eintrag;
}

// Eigener Filter für die Agent-Sitzung: jede Anfrage (auch Bilder, Skripte,
// XHR einer fremden Seite) geht durch dieselbe Prüfung.
function installAgentGuard() {
  if (guardInstalled) return;
  guardInstalled = true;
  const ses = agentSession();
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, async (details, callback) => {
    const pruefung = security.agentTargetAllowed(details.url);
    if (!pruefung.ok) return callback({ cancel: true });
    try {
      const host = new URL(details.url).hostname;
      if (security.testFreigabeLoopback() && (host === 'localhost' || host === '127.0.0.1')) return callback({});
      const eintrag = await resolveHost(host);
      if (eintrag.privat) return callback({ cancel: true });
    } catch { /* Auflösung schlägt fehl: Chromium erledigt den Rest */ }
    callback({});
  });
}

// Chromim-Fehlercodes in eine Aussage, die ein Agent und ein Mensch lesen können.
function erklaereLadefehler(code, desc, target) {
  const grund = {
    [-20]: 'Ziel steht auf der Sperrliste (lokales Netz oder gesperrte Adresse)',
    [-311]: 'Die Seite wollte auf eine gesperrte Adresse umleiten',
    [-105]: 'Rechnername nicht auflösbar',
    [-101]: 'Verbindung abgelehnt',
    [-7]: 'Verbindung fehlgeschlagen',
    [-3]: 'Zeit abgelaufen',
  }[Number(code)];
  return 'Seite nicht geladen: ' + (grund || (desc || 'Fehler ' + code)) +
    ' (Code ' + code + ')';
}

function ableiten(text, max) {
  return String(text == null ? '' : text).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Der eigentliche Lesetext: was ein Mensch sähe, nicht der Quelltext.
const AUFBAU = `(function () {
  function text(n) { return (n && n.innerText ? String(n.innerText) : ''); }
  var main = document.querySelector('main, article, [role=main]') || document.body;
  var body = main ? text(main) : '';
  var links = [];
  var seen = {};
  var anker = (main || document).querySelectorAll('a[href]');
  for (var i = 0; i < anker.length && links.length < 400; i++) {
    var a = anker[i];
    var href = a.href;
    if (!href || !/^https?:/i.test(href)) continue;
    var t = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\\s+/g, ' ').trim();
    if (seen[href]) continue;
    seen[href] = 1;
    links.push({ text: t.slice(0, 160), url: href });
  }
  function meta(name) {
    var m = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
    return m ? (m.getAttribute('content') || '') : '';
  }
  return {
    title: document.title || '',
    url: location.href,
    text: body,
    links: links,
    meta: { description: meta('description') || meta('og:description'), lang: document.documentElement.lang || '' },
    htmlLength: (document.documentElement && document.documentElement.outerHTML || '').length
  };
})()`;

async function fetchPage(args) {
  const { url, maxBytes, timeoutMs, screenshot } = args || {};
  const pruefung = security.agentTargetAllowed(url);
  if (!pruefung.ok) throw new Error('Ziel nicht erlaubt: ' + pruefung.grund);

  const host = new URL(url).hostname;
  if (!security.testFreigabeLoopback()) {
    const eintrag = await resolveHost(host);
    if (eintrag.privat) throw new Error('Ziel nicht erlaubt: interne Adresse');
  }

  if (busy) throw new Error('Der Browser liest gerade schon eine Seite — bitte kurz warten');
  busy = true;
  installAgentGuard();
  const startZeit = Date.now();

  const capBytes = Math.min(Number(maxBytes) || LIMITS.maxBytes, LIMITS.maxBytes);
  const capZeit = Math.min(Number(timeoutMs) || LIMITS.timeoutMs, LIMITS.timeoutMs);

  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const ses = win.webContents.session;

  const fertig = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { win.webContents.stop(); } catch { /* egal */ }
      reject(new Error('Zeit abgelaufen'));
    }, capZeit);
    const sauber = (fn) => (...args) => { clearTimeout(timer); fn(...args); };
    win.webContents.once('did-fail-load', sauber((_e, code, desc, target, main) => {
      if (main) reject(new Error(erklaereLadefehler(code, desc, target)));
    }));
    win.webContents.once('did-finish-load', sauber(() => {
      setTimeout(async () => {
        try {
          const stand = await win.webContents.executeJavaScript(AUFBAU, true);
          let bild = '';
          if (screenshot === true) {
            const png = await win.webContents.capturePage();
            const base64 = png.toPNG().toString('base64');
            bild = base64.length <= LIMITS.maxScreenshotBase64 ? base64 : '';
          }
          resolve({ stand, bild });
        } catch (e) {
          reject(new Error('Seite konnte nicht gelesen werden: ' + e.message));
        }
      }, LIMITS.settleMs);
    }));
    win.webContents.on('will-navigate', (e, target) => {
      if (!security.agentTargetAllowed(target).ok) e.preventDefault();
    });
  });

  try {
    try {
      await win.webContents.loadURL(String(url));
    } catch (e) {
      // loadURL meldet den Fehler selbst — in eine klare Aussage übersetzen.
      const code = /\((-?\d+)\)/.exec(String(e.message));
      throw new Error(erklaereLadefehler(code ? code[1] : -1, String(e.message), url));
    }
    const { stand, bild } = await fertig;

    const finalUrl = win.webContents.getURL();
    const finalPruefung = security.agentTargetAllowed(finalUrl);
    if (!finalPruefung.ok) throw new Error('Umgeleitet auf ein gesperrtes Ziel');
    const finalHost = new URL(finalUrl).hostname;
    if (!security.testFreigabeLoopback()) {
      const finalEintrag = await resolveHost(finalHost);
      if (finalEintrag.privat) throw new Error('Umgeleitet auf eine interne Adresse');
    }

    const geteilt = ableiten(stand.text, LIMITS.maxText);
    const begrenzt = geteilt.length >= LIMITS.maxText || (stand.htmlLength || 0) > capBytes;
    const ergebnis = {
      url: String(url),
      finalUrl,
      title: ableiten(stand.title, LIMITS.maxTitle),
      text: geteilt,
      links: (stand.links || []).slice(0, LIMITS.maxLinks).map((l) => ({
        text: ableiten(l.text, 160), url: String(l.url || '').slice(0, 500),
      })),
      meta: { description: ableiten(stand.meta && stand.meta.description, 400), lang: ableiten(stand.meta && stand.meta.lang, 20) },
      contentType: 'text/html',
      tookMs: Date.now() - startZeit,
      truncated: Boolean(begrenzt),
    };
    if (screenshot === true) {
      if (bild) {
        ergebnis.screenshot = bild;
        ergebnis.screenshotType = 'image/png';
      } else {
        ergebnis.screenshotHinweis = 'Bild zu groß oder nicht erstellt';
      }
    }
    return ergebnis;
  } finally {
    busy = false;
    try { win.destroy(); } catch { /* schon weg */ }
  }
}

// Das Agent-Profil entleeren (beim Abschalten des Dienstes und bei
// „Restlos leeren").
async function clearAgentProfile() {
  const ses = agentSession();
  try {
    await ses.clearStorageData({
      storages: ['cookies', 'localStorage', 'indexedDB', 'webSQL', 'serviceWorkers', 'cache', 'blob', 'fileSystems', 'appCache'],
    });
  } catch (e) {
    console.warn('[3DK][agent] Agent-Profil leeren: ' + e.message);
  }
  dnsCache.clear();
}

async function search3dk(args) {
  const query = String((args && args.query) || '').trim().slice(0, 400);
  if (!query) throw new Error('Keine Anfrage angegeben');
  const count = Math.max(1, Math.min(Number((args && args.count) || 10), 25));
  const t0 = Date.now();
  const ergebnis = await search.searchWeb(query);
  return {
    query,
    tookMs: Date.now() - t0,
    results: (ergebnis.results || []).slice(0, count).map((r) => ({
      title: ableiten(r.title, 300),
      url: String(r.url || '').slice(0, 500),
      snippet: ableiten(r.snippet, 500),
      domain: String(r.url || '').replace(/^https?:\/\//, '').split('/')[0],
      official: Boolean(r.official),
    })),
    sources: ergebnis.sources || {},
  };
}

// Roher HTML-Lader im leeren Agent-Profil (Lastenheft Baustein 2): für
// öffentliche SearXNG-Instanzen. Im echten Chromium werden JS-Schutzwände
// (Anubis, Proof-of-Work) automatisch gelöst — dort, wo curl scheitert.
// Gibt { ok, html, status } zurück statt zu werfen, damit die Rotation
// einfach zur nächsten Instanz weitergehen kann.
let loaderBusy = 0;
async function fetchHtmlImAgentProfil(url, opts) {
  const { timeoutMs = 6000 } = opts || {};
  const pruefung = security.agentTargetAllowed(url);
  if (!pruefung.ok) return { ok: false, grund: 'Ziel nicht erlaubt' };
  if (loaderBusy >= 2) return { ok: false, grund: 'Lader ausgelastet' };
  loaderBusy++;
  installAgentGuard();
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    const fertig = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { win.webContents.stop(); } catch { /* egal */ }
        reject(new Error('Zeit abgelaufen'));
      }, Math.min(Number(timeoutMs) || 6000, 12000));
      const sauber = (fn) => (...args) => { clearTimeout(timer); fn(...args); };
      win.webContents.once('did-fail-load', sauber((_e, code, desc, target, main) => {
        if (main) reject(new Error(erklaereLadefehler(code, desc, target)));
      }));
      win.webContents.once('did-finish-load', sauber(async () => {
        // Kurz setzen lassen, damit JS-Schutzwände ihre Arbeit beenden.
        setTimeout(async () => {
          try {
            const html = await win.webContents.executeJavaScript(
              'document.documentElement ? document.documentElement.outerHTML : ""', true);
            resolve(String(html || ''));
          } catch (e) { reject(e); }
        }, 1200);
      }));
    });
    await win.webContents.loadURL(String(url));
    const html = await fertig;
    const finalPruefung = security.agentTargetAllowed(win.webContents.getURL());
    if (!finalPruefung.ok) return { ok: false, grund: 'Umgeleitet auf gesperrtes Ziel' };
    return { ok: true, html };
  } catch (e) {
    return { ok: false, grund: String(e.message || e) };
  } finally {
    loaderBusy--;
    try { win.destroy(); } catch { /* schon weg */ }
  }
}

// ── Computer-Use: ein sichtbares, persistentes Arbeitsfenster ──────────────
// Bewusst NUR der Browser (keine OS-Maus/Tastatur). Läuft in derselben,
// leeren Partition "3dk-agent" wie der Lese-Abruf und unterliegt demselben
// Guard: lokale Netze, private Adressen, Dateien und angemeldete Konten des
// echten Browsers bleiben gesperrt. Das Fenster wird on-demand erzeugt und
// auf browser_close nur geschlossen — der Dienst bleibt warm.
let agentWin = null;

function fenster() {
  if (agentWin && !agentWin.isDestroyed()) return agentWin;
  installAgentGuard();
  agentWin = new BrowserWindow({
    show: true, width: 1280, height: 900,
    title: '3DK Agent',
    backgroundColor: '#0b0e14',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  agentWin.webContents.on('will-navigate', (e, target) => {
    if (!security.agentTargetAllowed(target).ok) e.preventDefault();
  });
  // Titel an die echte Seite anpassen, damit das Fenster erkennbar bleibt.
  agentWin.webContents.on('page-title-updated', (_e, t) => {
    try { if (t) agentWin.setTitle('3DK Agent — ' + String(t).slice(0, 60)); } catch { /* egal */ }
  });
  return agentWin;
}

// Warten bis did-finish-load + Settle; warft bei Ladefehler oder Zeitablauf.
function bisGeladen(win, timeoutMs) {
  const cap = Math.min(Number(timeoutMs) || LIMITS.timeoutMs, LIMITS.timeoutMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { win.webContents.stop(); } catch { /* egal */ }
      reject(new Error('Zeit abgelaufen'));
    }, cap);
    const sauber = (fn) => (...a) => { clearTimeout(timer); fn(...a); };
    win.webContents.once('did-fail-load', sauber((_e, code, desc, target, main) => {
      if (main) reject(new Error(erklaereLadefehler(code, desc, target)));
    }));
    win.webContents.once('did-finish-load', sauber(() => setTimeout(resolve, LIMITS.settleMs)));
  });
}

async function gewinne(win, url, timeoutMs) {
  const pruefung = security.agentTargetAllowed(url);
  if (!pruefung.ok) throw new Error('Ziel nicht erlaubt: ' + pruefung.grund);
  const fertig = bisGeladen(win, timeoutMs);
  try { await win.webContents.loadURL(String(url)); }
  catch { /* loadURL wirft bei Fehler; 'fertig' liefert die klare Aussage */ }
  await fertig;
  const finalUrl = win.webContents.getURL();
  const finalPruefung = security.agentTargetAllowed(finalUrl);
  if (!finalPruefung.ok) throw new Error('Umgeleitet auf ein gesperrtes Ziel');
  if (!security.testFreigabeLoopback()) {
    const host = new URL(finalUrl).hostname;
    const eintrag = await resolveHost(host);
    if (eintrag.privat) throw new Error('Umgeleitet auf eine interne Adresse');
  }
  return finalUrl;
}

async function leseStand(win) {
  const stand = await win.webContents.executeJavaScript(AUFBAU, true);
  return {
    url: win.webContents.getURL(),
    title: ableiten(stand.title, LIMITS.maxTitle),
    text: ableiten(stand.text, LIMITS.maxText),
    links: (stand.links || []).slice(0, LIMITS.maxLinks).map((l) => ({
      text: ableiten(l.text, 160), url: String(l.url || '').slice(0, 500),
    })),
  };
}

async function browserOpen(args) {
  const win = fenster();
  await gewinne(win, (args && args.url) || 'about:blank', args && args.timeoutMs);
  return await leseStand(win);
}

async function browserNavigate(args) {
  const win = fenster();
  await gewinne(win, args && args.url, args && args.timeoutMs);
  return await leseStand(win);
}

async function browserBack() {
  const win = fenster();
  if (win.webContents.canGoBack()) win.webContents.goBack();
  await new Promise((r) => setTimeout(r, LIMITS.settleMs));
  return await leseStand(win);
}

async function browserRead() {
  const win = fenster();
  return await leseStand(win);
}

async function browserScreenshot(args) {
  const win = fenster();
  if (args && args.allowScreenshot === false) return { ok: false, hinweis: 'Bildschirmfotos sind abgeschaltet' };
  try { win.show(); win.focus(); win.webContents.focus(); } catch { /* egal */ }
  // capturePage kann direkt nach einer Navigation einen flüchtigen
  // Chromium-Fehler ("UnknownVizError") oder ein leeres Bild liefern.
  // Deshalb mehrfach mit kurzem Abstand nach einem echten Rahmen greifen.
  let letzter = 'leeres Bild';
  for (let versuch = 0; versuch < 5; versuch++) {
    try {
      const png = await win.webContents.capturePage();
      const base64 = png.toPNG().toString('base64');
      if (base64.length > LIMITS.maxScreenshotBase64) return { ok: false, hinweis: 'Bild zu groß' };
      if (base64.length > 64) return { ok: true, url: win.webContents.getURL(), screenshot: base64, screenshotType: 'image/png' };
      letzter = 'leeres Bild';
    } catch (e) {
      letzter = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, hinweis: 'Screenshot fehlgeschlagen: ' + letzter };
}

async function browserClick(args) {
  const win = fenster();
  const x = Number(args && args.x), y = Number(args && args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x und y (Koordinaten) sind nötig');
  const button = args && args.button === 'right' ? 'right' : 'left';
  const clickCount = args && args.double ? 2 : 1;
  try { win.focus(); win.webContents.focus(); } catch { /* egal */ }
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
  if (args && args.settleMs !== undefined) await new Promise((r) => setTimeout(r, Math.min(Number(args.settleMs) || 0, 8000)));
  return { ok: true, geklickt: { x, y, button }, url: win.webContents.getURL() };
}

async function browserType(args) {
  const win = fenster();
  const text = String((args && args.text) || '');
  if (!text) throw new Error('Kein Text angegeben');
  try { win.focus(); win.webContents.focus(); } catch { /* egal */ }
  win.webContents.insertText(text);
  return { ok: true, getippt: text.length, url: win.webContents.getURL() };
}

const TASTEN = { Enter: 'Return', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right' };
async function browserKey(args) {
  const win = fenster();
  const key = String((args && args.key) || '');
  const keyCode = TASTEN[key];
  if (!keyCode) throw new Error('Taste nicht erlaubt (nur Enter, Tab, Escape, Backspace, Delete, Pfeile)');
  try { win.focus(); win.webContents.focus(); } catch { /* egal */ }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  if (args && args.settleMs !== undefined) await new Promise((r) => setTimeout(r, Math.min(Number(args.settleMs) || 0, 8000)));
  return { ok: true, taste: key, url: win.webContents.getURL() };
}

async function browserScroll(args) {
  const win = fenster();
  const dy = Number((args && args.deltaY) || 0);
  const dx = Number((args && args.deltaX) || 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('deltaY/deltaX nötig');
  const x = Number.isFinite(Number(args.x)) ? Number(args.x) : 640;
  const y = Number.isFinite(Number(args.y)) ? Number(args.y) : 450;
  try { win.focus(); win.webContents.focus(); } catch { /* egal */ }
  win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  return { ok: true, gescrollt: { dx, dy } };
}

async function browserClose() {
  const gabFenster = Boolean(agentWin && !agentWin.isDestroyed());
  if (gabFenster) { try { agentWin.destroy(); } catch { /* egal */ } }
  agentWin = null;
  return { ok: true, fensterGeschlossen: gabFenster, dienstWarm: true };
}

module.exports = { search3dk, fetchPage, fetchHtmlImAgentProfil, clearAgentProfile, PARTITION, LIMITS, browserOpen, browserNavigate, browserBack, browserRead, browserScreenshot, browserClick, browserType, browserKey, browserScroll, browserClose };
