// Werkbank für die Suche: läuft ohne Electron (Electron-Module werden
// simuliert), misst Laufzeit und Trefferzahlen je Quelle.
//   node tools/search-benchmark.js "freudenstadt" ["wetter berlin"] ...
const Module = require('module');
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      net: { fetch: (url, init) => fetch(url, init) },
      app: { getPath: () => require('os').tmpdir() },
    };
  }
  return orig.apply(this, arguments);
};

const search = require('../app/search');
const queries = process.argv.slice(2);
if (!queries.length) queries.push('freudenstadt', 'ubuntu download', 'wetter berlin');

(async () => {
  const totals = [];
  for (const q of queries) {
    const t0 = Date.now();
    let first = null;
    let stages = 0;
    const res = await search.searchWeb(q, (p) => {
      stages++;
      if (!first && p.results.length) first = { ms: Date.now() - t0, count: p.results.length };
    });
    const total = Date.now() - t0;
    totals.push(total);
    console.log('\n=== ' + JSON.stringify(q) + ' ===');
    console.log('  erste Treffer: ' + (first ? first.ms + 'ms (' + first.count + ' Treffer)' : 'keine'));
    console.log('  fertig:        ' + total + 'ms, ' + res.results.length + ' Treffer, Zwischenmeldungen: ' + stages);
    console.log('  Quellen:       ' + JSON.stringify(res.sources));
    console.log('  Widget:        ' + (res.widget ? res.widget.type + ' ' + res.widget.place + ' ' + res.widget.temp + '°C' : '—'));
    console.log('  Infobox:       ' + (res.infobox ? res.infobox.title : '—'));
    console.log('  Top 5:');
    res.results.slice(0, 5).forEach((r, i) =>
      console.log('   ' + (i + 1) + '. ' + (r.official ? '[OFFIZIELL] ' : '') + r.title.slice(0, 60) + '  — ' + r.url.slice(0, 70))
    );
  }
  console.log('\nGesamtlaufzeiten: ' + totals.join(' ms, ') + ' ms');
  console.log('Cache: ' + JSON.stringify(search.cacheStats()));

  // Bildersuche separat
  const tI = Date.now();
  const imgs = await search.searchImages('kater bastet');
  console.log('\n=== Bildersuche "kater bastet" === ' + (Date.now() - tI) + 'ms, ' + imgs.length + ' Bilder');
  console.log(JSON.stringify(imgs.slice(0, 2), null, 1));
  process.exit(0);
})();

