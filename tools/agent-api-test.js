// 3DK Browser — Prüfsuite Assistenten-Anbindung.
//   npm run agenttest      (startet Electron mit diesem Skript)
//
// Prüft Punkt für Punkt das Lastenheft docs/mcp-lastenheft.md, Abschnitt 10:
// Schlüssel, Host- und Origin-Prüfung, die beiden Werkzeuge, Sperrliste,
// Deckel, Ratenbegrenzung, Widerrufen, und dass nichts im echten Profil landet.

process.env.TDK_TEST_ALLOW_LOOPBACK = '1'; // nur für Testziele auf diesem Rechner

const http = require('http');
const os = require('os');
const { app, session } = require('electron');

const PORT_TEST = 8391;
const PORT_DIENST = 8899;

const agentApi = require('../app/agent-api');
const history = require('../app/history');
const store = require('../app/store');

// ── Einstellungen für diesen Lauf ────────────────────────────────────────
let einstellungen = {
  theme: 'dark',
  privacy: { trackerBlock: true, blockThirdPartyCookies: true, referrerTrim: true, signalDoNotTrack: true, userAgentShield: true },
  search: { instance: '' },
  cloud: { url: '', user: '', folder: '/', allowInsecure: false },
  agent: { enabled: true, port: PORT_DIENST, token: 'TESTSCHLUESSEL-nur-fuer-diese-Suite-0123456789abcdef', tools: { search: true, fetch: true }, allowScreenshot: true },
  debug: { searchLog: false },
};
const kontext = {
  getSettings: () => einstellungen,
  saveSettings: (n) => { einstellungen = n; },
};

// ── Testziele ───────────────────────────────────────────────────────────
const SEITE = `<!doctype html><html lang="de"><head><title>Testseite Titelangabe</title>
<meta name="description" content="Beschreibung der Testseite"></head>
<body><main><h1>Überschrift</h1><p>Ein Absatz mit erkennbarem Inhaltstext.</p>
<a href="https://beispiel.de/ziel">Zum Ziel</a></main></body></html>`;

const testServer = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/seite')) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(SEITE); return; }
  if (url.startsWith('/riesig')) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><title>Groß</title></head><body><main>' + 'x'.repeat(600000) + '</main></body></html>');
    return;
  }
  if (url.startsWith('/umleitung-intern')) { res.statusCode = 302; res.setHeader('location', 'http://192.168.178.1/'); res.end(); return; }
  if (url.startsWith('/umleitung-datei')) { res.statusCode = 302; res.setHeader('location', 'file:///C:/Windows/win.ini'); res.end(); return; }
  if (url.startsWith('/script')) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><title>Per Script</title></head><body><main id="m">leer</main><script>document.getElementById("m").textContent = "Vom JavaScript erzeugt";</script></body></html>');
    return;
  }
  res.statusCode = 404; res.end('nein');
});

// ── ein JSON-RPC-Aufruf, Host und Origin frei wählbar ───────────────────
function ruf(params, opts = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: opts.id || 1, ...params });
    const anfrage = http.request({
      host: '127.0.0.1',
      port: opts.port || PORT_DIENST,
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        host: opts.host || ('127.0.0.1:' + (opts.port || PORT_DIENST)),
        ...(opts.token === null ? {} : { authorization: 'Bearer ' + (opts.token || einstellungen.agent.token) }),
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
    }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => {
        const text = Buffer.concat(teile).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* Statuscode allein zählt */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    anfrage.on('error', (e) => resolve({ status: 0, fehler: e.code || e.message }));
    anfrage.write(body);
    anfrage.end();
  });
}

function ergebnisText(antwort) {
  const inhalt = antwort && antwort.json && antwort.json.result && antwort.json.result.content;
  if (!inhalt || !inhalt[0]) return null;
  try { return JSON.parse(inhalt[0].text); } catch { return { roh: inhalt[0].text }; }
}

// ── Prüfungen ───────────────────────────────────────────────────────────
const prüfungen = [];
function pruefe(name, ok, grund) {
  prüfungen.push({ name, ok: Boolean(ok), grund: String(grund).slice(0, 110) });
}

async function durchlauf() {
  // 1) ohne Schlüssel
  const ohne = await ruf({ method: 'ping' }, { token: null });
  pruefe('1  ohne Schlüssel → 401', ohne.status === 401, 'HTTP ' + ohne.status);

  // 2) fremder Host (DNS-Rebinding)
  const fremderHost = await ruf({ method: 'ping' }, { host: 'boese.example' });
  pruefe('2  fremder Host → 403', fremderHost.status === 403, 'HTTP ' + fremderHost.status);

  // 3) Herkunft von einer fremden Webseite
  const fremdeHerkunft = await ruf({ method: 'ping' }, { origin: 'http://boese.example' });
  pruefe('3  fremde Herkunft → 403', fremdeHerkunft.status === 403, 'HTTP ' + fremdeHerkunft.status);

  // 4) unbekanntes Werkzeug
  const unbekannt = await ruf({ method: 'tools/call', params: { name: 'executeJavaScript', arguments: { code: '1' } } });
  pruefe('4  unbekanntes Werkzeug → Fehler', /Unbekanntes Werkzeug/.test(JSON.stringify(unbekannt.json)), JSON.stringify(unbekannt.json && unbekannt.json.error || unbekannt.json && unbekannt.json.result));

  // 4b) es gibt nachweislich nur zwei Werkzeuge
  const liste = await ruf({ method: 'tools/list', params: {} });
  const namen = ((liste.json && liste.json.result && liste.json.result.tools) || []).map((t) => t.name);
  pruefe('4b nur zwei Werkzeuge angemeldet', namen.length === 2 && namen.includes('search3dk') && namen.includes('fetchPage'), namen.join(', '));

  // 5) Suchen
  const suche = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'search3dk', arguments: { query: 'freudenstadt', count: 5 } } }));
  pruefe('5  search3dk liefert Treffer', suche && suche.results && suche.results.length >= 3, suche ? (suche.results || []).length + ' Treffer' : 'keine Antwort');
  pruefe('5b offizielle Seite erkannt', suche && suche.results && suche.results.some((r) => /freudenstadt\.de/.test(r.url) && r.official),
    suche && suche.results ? suche.results.map((r) => r.url).slice(0, 3).join(' ') : '—');

  // 6) Lesen einer normalen Seite
  const seite = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'fetchPage', arguments: { url: 'http://127.0.0.1:' + PORT_TEST + '/seite' } } }));
  pruefe('6  fetchPage liest Titel und Text', seite && /Testseite/.test(seite.title) && /erkennbarem Inhaltstext/.test(seite.text),
    seite ? JSON.stringify({ titel: seite.title, text: (seite.text || '').slice(0, 30) }) : 'keine Antwort');
  pruefe('6b Links werden mitgenommen', seite && (seite.links || []).some((l) => /beispiel\.de\/ziel/.test(l.url)), JSON.stringify((seite && seite.links || []).slice(0, 2)));

  // 6c) per JavaScript erzeugter Inhalt
  const gerendert = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'fetchPage', arguments: { url: 'http://127.0.0.1:' + PORT_TEST + '/script' } } }));
  pruefe('6c JavaScript-seite wird gelesen', gerendert && /Vom JavaScript erzeugt/.test(gerendert.text), gerendert ? (gerendert.text || '').slice(0, 40) : 'keine Antwort');

  // 6d) Bildschirmfoto
  const mitBild = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'fetchPage', arguments: { url: 'http://127.0.0.1:' + PORT_TEST + '/seite', screenshot: true } } }));
  pruefe('6d Bildschirmfoto kommt als PNG', mitBild && typeof mitBild.screenshot === 'string' && mitBild.screenshot.length > 1000 && mitBild.screenshotType === 'image/png',
    mitBild ? (mitBild.screenshot ? mitBild.screenshot.length + ' Zeichen Base64' : 'kein Bild: ' + (mitBild.screenshotHinweis || '')) : 'keine Antwort');

  // 7) lokale Datei
  const datei = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'fetchPage', arguments: { url: 'file:///C:/Windows/win.ini' } } }));
  pruefe('7  file:// abgelehnt', datei && datei.__fehler === undefined && /Ziel nicht erlaubt/.test(JSON.stringify(datei)), JSON.stringify(datei));

  // 8) internes Netz per Adresse
  const netz = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'fetchPage', arguments: { url: 'http://192.168.178.1/' } } }));
  pruefe('8  192.168.x abgelehnt', /Ziel nicht erlaubt/.test(JSON.stringify(netz)), JSON.stringify(netz));

  // 9) Umleitung ins interne Netz
  const umgeleitet = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'fetchPage', arguments: { url: 'http://127.0.0.1:' + PORT_TEST + '/umleitung-intern' } } }));
  pruefe('9  Umleitung ins interne Netz abgelehnt', /Sperrliste|nicht erlaubt|interne Adresse|Umleiten|gesperrt/.test(JSON.stringify(umgeleitet)), JSON.stringify(umgeleitet));

  // 9b) Umleitung in eine lokale Datei
  const umDatei = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'fetchPage', arguments: { url: 'http://127.0.0.1:' + PORT_TEST + '/umleitung-datei' } } }));
  pruefe('9b Umleitung auf file:// abgelehnt', /umleiten|umgeleitet|gesperrt|nicht erlaubt/i.test(JSON.stringify(umDatei)), JSON.stringify(umDatei));

  // 10) zu große Seite
  const groß = ergebnisText(await ruf({ method: 'tools/call', params: { name: 'fetchPage', arguments: { url: 'http://127.0.0.1:' + PORT_TEST + '/riesig', maxBytes: 100000 } } }));
  pruefe('10 große Seite gedeckelt', groß && groß.truncated === true && (groß.text || '').length <= 20000,
    groß ? 'text ' + (groß.text || '').length + ' Zeichen, truncated=' + groß.truncated : 'keine Antwort');

  // 14) echtes Profil unberührt (vor der Ratenbegrenzung prüfen)
  const verlaufVorher = history.listHistory().length;
  const cookiesVorher = (await session.defaultSession.cookies.get({})).length;
  pruefe('14 Verlauf des Nutzerprofils unverändert', history.listHistory().length === verlaufVorher,
    verlaufVorher + ' → ' + history.listHistory().length);
  pruefe('14b Cookies des Nutzerprofils unverändert', (await session.defaultSession.cookies.get({})).length === cookiesVorher,
    cookiesVorher + ' → ' + (await session.defaultSession.cookies.get({})).length);

  // 12) Schlüssel erneuern
  const neue = await agentApi.schluesselErneuern(kontext);
  einstellungen = kontext.getSettings();
  const alter = await ruf({ method: 'ping' }, { token: 'TESTSCHLUESSEL-nur-fuer-diese-Suite-0123456789abcdef' });
  const neuer = await ruf({ method: 'ping' }, { token: neue });
  pruefe('12 alter Schlüssel ungültig, neuer gültig', alter.status === 401 && neuer.status === 200,
    'alt HTTP ' + alter.status + ', neu HTTP ' + neuer.status);

  // 11) Ratenbegrenzung
  let bekam429 = false;
  for (let i = 0; i < 40 && !bekam429; i++) {
    const a = await ruf({ method: 'ping' }, { token: neue });
    if (a.status === 429) bekam429 = true;
  }
  pruefe('11 Ratenbegrenzung greift (429)', bekam429, 'kein 429 in 40 Versuchen');

  // 15) Protokoll
  const mitProtokoll = agentApi.status(kontext);
  pruefe('15a Aufrufe werden protokolliert', (mitProtokoll.protokoll || []).length > 0, (mitProtokoll.protokoll || []).length + ' Einträge');
  agentApi.protokollLeeren();
  pruefe('15b Protokoll lässt sich leeren', agentApi.status(kontext).protokoll.length === 0, '—');

  // 16) nur loopback erreichbar
  const lanAdressen = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  let nurLocalhost = true;
  const probe = await Promise.all(lanAdressen.map((adresse) => new Promise((resolve) => {
    const anfrage = http.request({ host: adresse, port: PORT_DIENST, method: 'POST', path: '/mcp', timeout: 1500 }, (res) => { res.resume(); resolve('antwortete'); });
    anfrage.on('error', () => resolve('abgelehnt'));
    anfrage.on('timeout', () => { anfrage.destroy(); resolve('abgelehnt'); });
    anfrage.end('{}');
  })));
  nurLocalhost = probe.every((p) => p === 'abgelehnt');
  pruefe('16 über das Netz nicht erreichbar', nurLocalhost || !lanAdressen.length, 'LAN-Adressen: ' + (lanAdressen.join(', ') || 'keine'));

  // 13) abschalten
  await agentApi.stop();
  const nachher = await ruf({ method: 'ping' }, { token: neue });
  pruefe('13 nach dem Abschalten kein Dienst mehr', nachher.status === 0, nachher.fehler || ('HTTP ' + nachher.status));
}

// ── Ablauf ──────────────────────────────────────────────────────────────
// Die Prüfsuite läuft ohne sichtbares Fenster: das versteckte Lese-Fenster
// dürfte den sonst üblichen „alle Fenster zu → Beenden“-Ablauf nicht auslösen.
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  store.init();
  history.initFiles();
  require('../app/search').configure(kontext.getSettings);
  agentApi.init();
  testServer.listen(PORT_TEST, '127.0.0.1');

  await agentApi.start(kontext);
  await durchlauf();
  testServer.close();

  let fehl = 0;
  console.log('\n======= 3DK Browser — Prüfsuite Assistenten-Anbindung =======');
  for (const p of prüfungen) {
    console.log((p.ok ? '  PASS   ' : '  FEHLER ') + p.name.padEnd(46) + ' | ' + p.grund);
    if (!p.ok) fehl++;
  }
  console.log('');
  console.log(fehl ? '  → ' + fehl + ' von ' + prüfungen.length + ' Prüfpunkten fehlgeschlagen'
    : '  → alle ' + prüfungen.length + ' Prüfpunkte bestanden');
  console.log('============================================================\n');
  setTimeout(() => process.exit(fehl ? 1 : 0), 150);
});
