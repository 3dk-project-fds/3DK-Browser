// tools/sites-pruefen.js — Pflege-Werkzeug für das kuratierte Verzeichnis.
// Prüft jede hinterlegte Such-URL in app/sites/de.json (Platzhalter {q} wird
// mit einer Beispielanfrage aus den Themen gefüllt) und meldet tote Einträge.
// Aufruf: node tools/sites-pruefen.js [--langsam] [--fix]
//   --fix  schreibt eine bereinigte Liste nach tmp/sites-tot.json (nicht automatisch zurück).

const fs = require('fs');
const path = require('path');

const datei = path.join(__dirname, '..', 'app', 'sites', 'de.json');
const daten = JSON.parse(fs.readFileSync(datei, 'utf8'));
const sites = daten.sites || [];
const langsam = process.argv.includes('--langsam');
const fix = process.argv.includes('--fix');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function pruefe(site) {
  const beispiel = (site.themen && site.themen[0]) || 'test';
  const url = site.suche.includes('{q}') ? site.suche.replace(/\{q\}/g, encodeURIComponent(beispiel)) : site.suche;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept-Language': 'de' },
      redirect: 'follow',
      signal: AbortSignal.timeout(langsam ? 15000 : 8000),
    });
    const ms = Date.now() - start;
    // 403/429/401/503 sind meist Bot-Wände gegen curl — im echten Browser
    // (dort öffnen die Kacheln) funktionieren diese Seiten in der Regel.
    const botwand = [401, 403, 429, 503].includes(res.status);
    return { site, url, status: res.status, ms, ok: botwand || (res.status >= 200 && res.status < 400), botwand };
  } catch (e) {
    return { site, url, status: 'Fehler', ms: Date.now() - start, ok: false, grund: String(e.message || e).slice(0, 60) };
  }
}

(async () => {
  console.log('Prüfe ' + sites.length + ' Einträge …\n');
  const tot = [];
  let n = 0;
  for (const site of sites) {
    const r = await pruefe(site);
    n++;
    const mark = r.ok ? (r.botwand ? 'WAND' : '  ok ') : 'TOT ';
    console.log(mark + String(n).padStart(3) + '. ' + site.name.padEnd(38) + String(r.status).padStart(6) + '  ' + r.ms + 'ms' + (r.grund ? '  ' + r.grund : ''));
    if (!r.ok) tot.push(r);
  }
  const wand = sites.length ? 0 : 0;
  console.log('\n' + (sites.length - tot.length) + '/' + sites.length + ' erreichbar (davon einige nur Bot-Wand gegen curl, im Browser ok), ' + tot.length + ' tot.');
  if (tot.length) {
    console.log('\nTote Einträge:');
    for (const r of tot) console.log(' - ' + r.site.name + ' (' + r.url.slice(0, 90) + ')');
  }
  if (fix && tot.length) {
    const namen = new Set(tot.map((r) => r.site.name + '|' + r.site.suche));
    daten.sites = sites.filter((s) => !namen.has(s.name + '|' + s.suche));
    const out = path.join(__dirname, '..', 'tmp', 'sites-bereinigt.json');
    fs.writeFileSync(out, JSON.stringify(daten, null, 2));
    console.log('\nBereinigte Liste geschrieben: ' + out + ' (nach Prüfung übernehmen)');
  }
})();
