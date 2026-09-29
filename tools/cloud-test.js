// 3DK Browser — Wolkentest: Runden durch Cloud.js gegen einen lokalen
// WebDAV-Attrappen-Server. Prüft genau die Punkte, die kaputt waren:
//   · PUT darf nicht an einem selbst gesetzten Content-Length scheitern
//   · Backup muss ohne die Passphrase unlesbar sein
//   · http nur nach ausdrücklicher Freigabe
//   · Wiederherstellung setzt den Verlauf wirklich zurück
//
//   npm run cloudtest      (startet Electron mit diesem Skript)

const http = require('http');
const { app } = require('electron');

const PORT = 8231;
const daten = new Map(); // Pfad -> Puffer
const protokoll = [];

const server = http.createServer((req, res) => {
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(body);
    protokoll.push({ methode: req.method, pfad: req.url, bytes: buf.length, auth: Boolean(req.headers.authorization) });
    if (req.method === 'PUT') {
      daten.set(req.url, buf);
      res.statusCode = 204; res.end(); return;
    }
    if (req.method === 'GET') {
      const hat = daten.get(req.url);
      if (!hat) { res.statusCode = 404; res.end('nicht da'); return; }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.end(hat);
      return;
    }
    if (req.method === 'PROPFIND') {
      res.statusCode = 207;
      res.setHeader('content-type', 'application/xml');
      res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
      return;
    }
    res.statusCode = 405; res.end();
  });
});

function meldung(text, ok) {
  console.log((ok ? '  PASS   ' : '  FEHLER ') + text);
  return ok ? 0 : 1;
}

app.whenReady().then(async () => {
  let fehl = 0;
  const cloud = require('../app/cloud');
  const history = require('../app/history');
  const store = require('../app/store');

  store.init();
  history.initFiles();
  // Hermetisch: ohne vorherige Lade-Reste im Profil zählt nur, was dieser Test schreibt.
  history.clearHistory();
  history.clearDownloads();
  // Zwei künstliche Besuche, damit das Backup Inhalt hat.
  history.addVisit('https://beispiel.de/erste', 'erste Seite');
  history.addVisit('https://beispiel.de/zweite', 'zweite Seite');

  server.listen(PORT, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 250));

  const grund = {
    url: 'http://127.0.0.1:' + PORT + '/dav/3dk/',
    user: 'testnutzer',
    pass: 'testpasswort',
    phrase: 'korrekte passphrase',
    allowInsecure: true,
  };

  console.log('\n=== 3DK Browser — Wolkentest ===');

  // 1) https-Zwang
  try {
    await cloud.cloudTest({ ...grund, url: 'http://127.0.0.1:' + PORT + '/dav/3dk/', allowInsecure: false });
    fehl += meldung('http ohne Freigabe wird abgelehnt', false);
  } catch (e) {
    fehl += meldung('http ohne Freigabe wird abgelehnt — ' + e.message, /https erlaubt/.test(e.message));
  }

  // 2) Verbindungstest (PROPFIND)
  try {
    const r = await cloud.cloudTest(grund);
    fehl += meldung('Verbindung testen (PROPFIND): ' + r.detail, r.ok);
  } catch (e) {
    fehl += meldung('Verbindung testen: ' + e.message, false);
  }

  // 3) Sichern — hier scheiterte es früher an Content-Length
  let gesichert = null;
  try {
    gesichert = await cloud.cloudSave(grund);
    fehl += meldung('Sichern läuft durch (PUT, ' + gesichert.bytes + ' Bytes)', true);
  } catch (e) {
    fehl += meldung('Sichern: ' + e.message, false);
  }

  // 4) Auf dem Server liegt nur ein undurchsichtiger Blob
  const blob = daten.get('/dav/3dk/' + cloud.FILE_NAME + '/3dk-browser-backup.bin') || daten.get('/dav/3dk/3dk-browser-backup.bin');
  if (blob) {
    const sichtbarerText = /beispiel\.de/.test(blob.toString('latin1'));
    fehl += meldung('Backup auf dem Server unlesbar (kein Verlauf im Klartext)', !sichtbarerText);
  } else {
    fehl += meldung('Backup-Datei auf dem Server gefunden', false);
  }

  // 5) Falsche Passphrase lehnt ab
  try {
    await cloud.cloudRestore({ ...grund, phrase: 'falsche passphrase' });
    fehl += meldung('Falsche Passphrase wird abgewiesen', false);
  } catch (e) {
    fehl += meldung('Falsche Passphrase wird abgewiesen — ' + e.message, true);
  }

  // 6) Umrunden: lokal löschen, aus der Wolke holen
  try {
    history.clearHistory();
    const vorDemLoeschen = history.listHistory().length;
    const wieder = await cloud.cloudRestore(grund);
    const counts = history.replaceFromBackup(wieder.history, wieder.downloads);
    fehl += meldung('Wiederherstellung nach dem Löschen (' + vorDemLoeschen + ' → ' + counts.history + ' Einträge)',
      vorDemLoeschen === 0 && counts.history === 2);
  } catch (e) {
    fehl += meldung('Wiederherstellung: ' + e.message, false);
  }

  console.log('\n  Protokoll des Servers:');
  for (const p of protokoll) console.log('    ' + p.methode.padEnd(9) + p.pfad.padEnd(42) + (p.bytes ? p.bytes + ' Bytes  ' : '') + (p.auth ? 'mit Anmeldung' : ''));
  console.log(fehl ? '\n  → ' + fehl + ' Prüfpunkt(e) fehlgeschlagen\n' : '\n  → alle Prüfpunkte bestanden\n');
  server.close();
  setTimeout(() => process.exit(fehl ? 1 : 0), 150);
});
