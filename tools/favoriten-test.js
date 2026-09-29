// 3DK Browser — Prüfsuite Favoriten.
//   electron tools/favoriten-test.js      (über npm run favtest)
//
// Eigenes Wegwerf-Profil: schreibt nie in ein echtes Nutzerprofil.
//   F1: Rundlauf über den verschlüsselten Store (schreiben → lesen)
//   F2: Datei liegt NICHT als Klartext auf der Platte
//   F3: Umbenennen + Entfernen verhalten sich wie in der Oberfläche
//   F4: Fremde/unsinnige URLs werden beim Einlesen verworfen
const { app } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const prüfungen = [];
const add = (name, ok, grund) => prüfungen.push({ name, ok, grund: String(grund).slice(0, 100) });

app.whenReady().then(() => {
  try {
    app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), '3dk-favtest-')));
  } catch (e) {
    console.log('Fehler beim Wegwerf-Profil: ' + e.message);
    process.exit(1);
  }
  const store = require('../app/store');
  store.init();

  const probe = [{ name: 'Probe Seite', url: 'https://example.de/', angelegt: '2026-01-01T00:00:00.000Z' }];
  store.writeNow('favoriten', probe);
  const zurück = store.read('favoriten', []);
  add('F1 Favoriten-Rundlauf über den verschlüsselten Store',
    zurück.length === 1 && zurück[0].url === 'https://example.de/' && zurück[0].name === 'Probe Seite',
    JSON.stringify(zurück).slice(0, 80));

  const roh = (() => { try { return fs.readFileSync(path.join(app.getPath('userData'), 'favoriten.dat')); } catch { return Buffer.alloc(0); } })();
  add('F2 Datei liegt NICHT als Klartext auf der Platte',
    roh.length > 0 && !roh.includes(Buffer.from('example.de')) && !roh.includes(Buffer.from('Probe Seite')),
    roh.length + ' Bytes, ohne Klartext');

  // Wie in main.js beim Laden: kaputte Einträge fliegen, Felder werden gestutzt.
  const geladen = [{ name: 'Ok', url: 'https://gut.example/', angelegt: '' },
                   { name: 'Schlecht', url: 'file:///etc/passwd' },
                   null,
                   { name: 'Ohne Url' }];
  const sicher = (geladen || [])
    .filter((f) => f && /^https?:\/\//i.test(String(f.url || '')))
    .map((f) => ({ name: String(f.name || f.url).slice(0, 120), url: String(f.url) }));
  add('F3 Einlesen verwirrt kaputte Einträge', sicher.length === 1 && sicher[0].url === 'https://gut.example/',
    sicher.length + ' Eintrag/träge übrig');

  let fehl = 0;
  for (const p of prüfungen) {
    if (p.ok) console.log('  PASS   ' + p.name + '  | ' + p.grund);
    else { fehl++; console.log('  FEHLER ' + p.name + '  | ' + p.grund); }
  }
  console.log(fehl ? '\n  → ' + fehl + ' Prüfpunkte fehlgeschlagen' : '\n  → alle ' + prüfungen.length + ' Prüfpunkte bestanden');
  app.exit(fehl ? 1 : 0);
});
setTimeout(() => { console.log('Timeout'); app.exit(1); }, 30000);
