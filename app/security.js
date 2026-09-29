// 3DK Browser — Vertrauensgrenze zwischen eigener UI und fremden Webseiten.
//
// Grundregel: privilegierte IPC-Kanäle (Verlauf, Einstellungen, Cloud, …) sind
// ausschließlich für die eigenen Seiten unter app/chrome/*.html erreichbar.
// Fremde Seiten — auch file://, about:blank-Iframes oder per window.open
// erzeugte Fenster — bekommen nichts. Die Prüfung läuft im Hauptprozess pro
// Aufruf, weil der Preload an jeden Tab gehängt wird und die Seite selbst
// nicht verrät, wer sie ist.

const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { isTrackerHost, isWerbungHost } = require('./blocklist');

function hostAusUrl(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase(); } catch { return ''; }
}

const UI_DIR = path.join(__dirname, 'chrome');

// ── interne Seiten ──────────────────────────────────────────────────────
function isInternalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'file:') return false;
  if (u.hostname && u.hostname !== 'localhost' && u.hostname !== '') return false;
  let file;
  try { file = fileURLToPath(u); } catch { return false; }
  const rel = path.relative(UI_DIR, path.dirname(file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return /\.html$/i.test(file);
}

function internalFileToUrl(name) {
  return pathToFileURL(path.join(UI_DIR, name)).href;
}

// Prüft den Aufrufer eines IPC-Ereignisses. Wirft → Promise im Renderer lehnt ab.
function requireInternal(event, channel) {
  const frame = event.senderFrame;
  const url = frame && frame.url;
  if (!isInternalUrl(url)) {
    const why = `Abgelehnt: "${channel}" gehört zu den internen Browser-Seiten. ` +
      `Anfrage kam von: ${String(url || '(unbekannt)').slice(0, 120)}`;
    console.warn('[3DK][IPC] ' + why);
    throw new Error(why);
  }
  return true;
}

// ── URL-Freigaben ───────────────────────────────────────────────────────
const WEB_SCHEMES = new Set(['http:', 'https:']);
function isWebUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  return WEB_SCHEMES.has(u.protocol);
}

// Navigationen, die ein Tab von einer Seite aus annehmen darf.
// Alles was lokal oder Browser-intern ist, muss aus dem Web heraus gesperrt
// bleiben (sonst liest eine fremde Seite lokale Dateien oder öffnet die
// eigene Einstellungen-Oberfläche).
const FORBIDDEN_NAV_SCHEMES = new Set([
  'file:', 'chrome:', 'chrome-extension:', 'devtools:', 'view-source:',
  'javascript:', 'data:', 'blob:', 'about:', 'ftp:', 'jar:', 'resource:',
]);
function isNavigationAllowed(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return true; } // relative/undekodierte Eingaben durchreichen
  if (u.protocol === 'https:' || u.protocol === 'http:') return true;
  if (FORBIDDEN_NAV_SCHEMES.has(u.protocol)) return false;
  return false; // unbekannte Schemata (mailtest:, custom:) gehen nach außen
}

// ── Session-Härtung ─────────────────────────────────────────────────────
// allow: was ein Webdokument vom Nutzer verlangen darf. Vollbild wird für
// Videoseiten gebraucht, alles andere bleibt aus.
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'pointerLock']);

// Konnte die native Chromium-Voreinstellung gesetzt werden? Wenn nicht, greift
// der JavaScript-Fallback weiter unten.
let cookiePrefWorked = true;

function installSessionHardening(ses, getSettings, onBlocked) {
  const report = (kind, url) => { try { onBlocked && onBlocked(kind, url); } catch { /* egal */ } };

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ok = ALLOWED_PERMISSIONS.has(permission);
    if (!ok) report('Berechtigung: ' + permission, details && details.requestingUrl);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  // Drittanbieter-Cookies: der Chromium-Schalter "test-third-party-cookie-phaseout"
  // blockt sie im Netzwerk-Stack (vor app.whenReady zu setzen, siehe
  // main.js → Startoptionen). Zusätzlich läuft eine zweite Schicht mit:
  // Set-Cookie-Antworten von Drittseiten werden hier verworfen.
  ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const on = getSettings().privacy.blockThirdPartyCookies !== false;
    if (!on || !isThirdParty(details)) return callback({});
    const headers = details.responseHeaders || {};
    let entfernt = false;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'set-cookie') { delete headers[k]; entfernt = true; }
    }
    if (entfernt) report('Drittanbieter-Cookie', details.url);
    callback({ responseHeaders: headers });
  });

  // 1) Tracker + Werbung blockieren. Ein einziger Handler für beide Listen
  //    (Electron erlaubt nur einen onBeforeRequest pro Sitzung): Tracker
  //    über die kuratierte Chromium-Filterliste, Adblock über die
  //    StevenBlack-Hostliste als Set-Lookup. Beides abschaltbar.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const schalter = getSettings().privacy || {};
    const gast = hostAusUrl(details.url);
    if (schalter.trackerBlock !== false && isTrackerHost(gast)) {
      report('Tracker', details.url);
      return callback({ cancel: true });
    }
    if (schalter.adblock !== false && isWerbungHost(gast)) {
      report('Werbung', details.url);
      return callback({ cancel: true });
    }
    callback({});
  });

  // 2) Referrer bescheiden + Ehrlichkeits-Kopfzeilen (Nicht verfolgen / GPC).
  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders || {};
    const p = getSettings().privacy || {};
    if (p.referrerTrim !== false) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'referer') {
          try {
            headers[k] = new URL(headers[k]).origin + '/';
          } catch {
            delete headers[k];
          }
        }
      }
    }
    if (p.signalDoNotTrack !== false) {
      setHeader(headers, 'DNT', '1');
      setHeader(headers, 'Sec-GPC', '1');
    }
    callback({ requestHeaders: headers });
  });

  // 3) Fallback für Drittanbieter-Cookies läuft oben als onHeadersReceived.

  return { cookieSwitch: true };
}

// Der Schalter muss vor app.whenReady gesetzt werden; die Einstellung wird
// deshalb zusätzlich in einer kleinen Klartext-Datei vorgehalten.
function cookieSwitchFor(settings) {
  return (settings.privacy && settings.privacy.blockThirdPartyCookies !== false)
    ? ['test-third-party-cookie-phaseout'] : [];
}

function applyCookieMode(ses, block) {
  // Die nativste Umsetzung ist der Netzwerk-Schalter beim Start. Zur Laufzeit
  // bleibt die zweite Schicht (Set-Cookie verwerfen), die hier greift.
  cookiePrefWorked = false;
  return block;
}

function setHeader(headers, name, value) {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      if (k !== name) {
        delete headers[k];
      }
      break;
    }
  }
  headers[name] = value;
}

// Der Assistenten-Zugriff: was darf von außen aufgerufen werden
// Der lokale MCP-Dienst bekommt eine eigene, engere Freigabe als der normale
// Tab-Betrieb: keine lokalen Netze, keine Sonderadressen, keine eigenen Seiten.
// (Der DNS-Teil — eine Domain, die auf eine interne Adresse zeigt — läuft
// async in agent-tools.js, weil dafür eine Auflösung nötig ist.)

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost',
  'metadata.google.internal', 'wpad', 'router', 'fritz.box']);
const BLOCKED_SUFFIXES = ['.local', '.internal', '.home.arpa', '.localdomain'];

function isPrivateAddress(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return true;
  if (s.startsWith('::1') || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8')) return true;
  if (s.startsWith('127.') || s.startsWith('10.') || s.startsWith('0.')) return true;
  if (s.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true; // CGNAT
  return false;
}

// Prüfpfad für die Testsuite: loopback darf vorübergehend durchgelassen werden, damit
// der Test echte Seiten abrufen kann, ohne das Produktverhalten zu ändern.
// Wirkt nur im Entwicklungsbau und nur mit gesetzter UmgebungVariable.
function testFreigabeLoopback() {
  if (process.env.TDK_TEST_ALLOW_LOOPBACK !== '1') return false;
  try {
    const { app } = require('electron');
    return Boolean(app) && app.isPackaged === false;
  } catch {
    return false;
  }
}

// Prüft eine Adresse ohne Auflösung. Gibt { ok, grund } zurück.
function agentTargetAllowed(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, grund: 'Adresse nicht lesbar' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, grund: 'nur http und https' };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, grund: 'kein Ziel angegeben' };
  if (isInternalUrl(u.href)) return { ok: false, grund: 'eigene Browser-Seiten sind gesperrt' };
  if (testFreigabeLoopback() && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')) {
    return { ok: true, host };
  }
  if (BLOCKED_HOSTS.has(host)) return { ok: false, grund: 'lokaler Name ist gesperrt' };
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, grund: 'lokaler Bereich ist gesperrt' };
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isPrivateAddress(host)) return { ok: false, grund: 'interne Adresse ist gesperrt' };
  }
  if (u.username || u.password) return { ok: false, grund: 'Zugangsdaten in der Adresse sind nicht erlaubt' };
  return { ok: true, host };
}

// Hilfsweise Einschätzung "Dritte Partei": Initiator und Ziel-Host gehören
// nicht derselben registrierbaren Domain an. Bewusst grob (ohne Public-Suffix-
// Liste) — der feinsinnige Fall läuft über die native Voreinstellung.
function isThirdParty(details) {
  try {
    const target = new URL(details.url).hostname;
    const top = details.initiator ? new URL(details.initiator).hostname : '';
    if (!top) return false;
    return registrable(target) !== registrable(top);
  } catch { return false; }
}

const MULTI_SUFFIX = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
  'co.in', 'com.br', 'com.mx', 'com.tr', 'com.ar', 'co.jp', 'or.jp', 'ne.jp',
  'ac.jp', 'com.sg', 'com.hk', 'co.za', 'co.il', 'com.pk', 'com.ua', 'or.at',
  'ac.at', 'gv.at', 'co.kr', 'com.cn', 'com.pl', 'com.pt', 'com.pe', 'com.co',
]);
function registrable(host) {
  const parts = String(host).toLowerCase().split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIX.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

module.exports = {
  isInternalUrl,
  internalFileToUrl,
  requireInternal,
  isWebUrl,
  isNavigationAllowed,
  agentTargetAllowed,
  isPrivateAddress,
  testFreigabeLoopback,
  installSessionHardening,
  applyCookieMode,
  cookieSwitchFor,
  isTrackerHost,
  registrable,
  UI_DIR,
};
