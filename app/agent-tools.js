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

module.exports = { search3dk, fetchPage, fetchHtmlImAgentProfil, clearAgentProfile, PARTITION, LIMITS };
