// 3DK Browser — Prüfsuite Suche.
//   npm run suchtest
//
// Zwei Teile:
//   1) offline: die Brave-Parser gegen eine gespeicherte Seite (Brave drosselt
//      öffentliche Testanfragen, deshalb braucht der Teil keine Netzverbindung)
//   2) live:   echte Anfragen, mit Qualitätsbehauptungen statt nur Laufzeiten
//
// Der Live-Teil überspringt freundlich, wenn eine Quelle gerade nicht antwortet.

const Module = require('module');
const fs = require('fs');
const path = require('path');
const orig = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { net: { fetch: (u, i) => fetch(u, i) }, app: { getPath: () => require('os').tmpdir() } };
  }
  return orig.apply(this, arguments);
};

const search = require('../app/search');
const prüfungen = [];
const add = (name, ok, grund) => prüfungen.push({ name, ok: ok === null ? null : Boolean(ok), grund: String(grund).slice(0, 100) });

function offline() {
  // ── Baustein 0: Anfrage-Verständnis ──
  const ex = search.expandiere('LLM für STT');
  add('E1 «LLM für STT» wird expandiert',
    /speech/i.test(ex.q) && ex.worter.has('whisper'),
    ex.zusatz.slice(0, 3).join(', ') || 'keine Expansion');
  const ex2 = search.expandiere('rpi 5 kaufen');
  add('E2 «rpi» wird zu Raspberry Pi',
    /raspberry/i.test(ex2.q), ex2.zusatz.slice(0, 3).join(', '));
  const ex3 = search.expandiere('quantenfluktuation messwert');
  add('E3 ohne Wörterbuch-Treffer bleibt die Anfrage unverändert',
    ex3.q === 'quantenfluktuation messwert' && ex3.zusatz.length === 0, ex3.q);

  // ── Baustein 1: Bing-HTML-Parser ──
  const bingSample = '<ol id="b_results"><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy9zZWl0ZQ&amp;ntb=1">Beispiel <strong>Titel</strong></a></h2><div class="b_attribution"><cite>example.org</cite></div><p>Ein Snippet mit Text.</p></li></ol>';
  const bingTreffer = search.parseBingHtml(bingSample);
  add('E4 Bing-HTML: Treffer mit Snippet',
    bingTreffer.length === 1 && bingTreffer[0].snippet.includes('Snippet'),
    (bingTreffer[0] || {}).snippet || 'kein Treffer');
  add('E5 Bing-HTML: ck/a-Umleitung wird zur Ziel-URL aufgelöst',
    (bingTreffer[0] || {}).url === 'https://example.org/seite', (bingTreffer[0] || {}).url);

  // ── Baustein 2: SearXNG-Parser und Bot-Wand ──
  const sxSample = '<div class="results"><article class="result" data-engines="google bing duckduckgo"><h3><a href="https://openai.com/research/whisper">Whisper: Robust Speech Recognition</a></h3><p class="content">Automatische Spracherkennung, trainiert auf 680.000 Stunden.</p></article></div>';
  const sxTreffer = search.parseSearxngHtml(sxSample);
  add('E6 SearXNG-Parser liefert Titel, URL und Snippet',
    sxTreffer.length === 1 && /whisper/i.test(sxTreffer[0].url) && sxTreffer[0].snippet.length > 10,
    (sxTreffer[0] || {}).title || 'kein Treffer');
  add('E18 SearXNG: Engine-Liste wird als Merkmal mitgeführt (A1)',
    Array.isArray((sxTreffer[0] || {}).engines) && sxTreffer[0].engines.length === 3,
    ((sxTreffer[0] || {}).engines || []).join(',') || 'keine Engines');
  // A5: Ortsbezug in der Rangfolge — kontrollierte Liste, kein Netz nötig.
  const ortSammel = [
    { url: 'https://www.wetter.com/deutschland/erlangen/DE0002674.html', title: 'Wetter Erlangen heute - Vorhersage', snippet: 'Wie wird das Wetter heute in Erlangen?' },
    { url: 'https://www.wetter.net/wetter/deutschland/freudenstadt', title: 'Wetter Freudenstadt', snippet: 'Wettervorhersage für Freudenstadt im Schwarzwald' },
    { url: 'https://www.wetter.de/', title: 'Wetter - Wettervorhersage', snippet: 'Wetterbericht für Deutschland' },
  ];
  const ortOrdnung = search.rerank(ortSammel, 'wetter freudenstadt morgen', new Set());
  add('E19 «wetter freudenstadt morgen»: Ort treibt die Reihenfolge (A5)',
    ortOrdnung[0] && /freudenstadt/i.test(ortOrdnung[0].url),
    (ortOrdnung[0] || {}).url || 'leer');
  // A6: Das seltene Fragewort gewinnt — „langgraph" statt der Füllmasse.
  const seltenSammel = [
    { url: 'https://www.delst.de/de/lexikon/dokumentation/', title: 'Dokumentation | Definition und Erklärung', snippet: 'Dokumentation erklärt im Lexikon' },
    { url: 'https://de.wiktionary.org/wiki/Dokumentation', title: 'Dokumentation – Wiktionary', snippet: 'Die Dokumentation, Substantiv' },
    { url: 'https://github.com/langchain-ai/langgraph', title: 'langgraph: Build resilient agents', snippet: 'LangGraph framework für Agenten' },
  ];
  const seltenOrdnung = search.rerank(seltenSammel, 'langgraph dokumentation was ist es', new Set());
  add('E20 «langgraph …»: seltenes Fragewort gewinnt (A6)',
    seltenOrdnung[0] && /langgraph/i.test(seltenOrdnung[0].url),
    (seltenOrdnung[0] || {}).url || 'leer');
  // A6.1 (Nutzerbefund 27.09.): „wer ist der beste ki agent" darf nicht die
  // Firma „Bester Energy" / den Saft „beckers bester" nach oben bringen —
  // Beugungsformen („bester") sind als Anker gesperrt, „agent" gewinnt.
  const ankerSammel = [
    { url: 'https://bester.energy/', title: 'Bester - Bester', snippet: 'Bester is a company that operates in the renewable energy sector' },
    { url: 'https://www.beckers-bester.de/', title: 'BESTER.de - Das Test- & Vergleichsportal', snippet: 'Test- und Vergleichsportal BESTER.de mit Bewertungen' },
    { url: 'https://www.ki-vergleich.example/ki-agenten', title: 'KI-Agenten im Vergleich 2026', snippet: 'Der beste KI Agent: Vergleich autonomer KI-Agenten' },
  ];
  const ankerOrdnung = search.rerank(ankerSammel, 'wer ist der beste ki agent', new Set());
  add('E21 „bester" wird nicht zum Anker — Firma/Saft bleiben unten (A6.1)',
    ankerOrdnung[0] && /ki-agenten/i.test(ankerOrdnung[0].url),
    (ankerOrdnung[0] || {}).url || 'leer');
  // A6.2 (Testbatterie 27.09.): Frage-Wörter als Duden-Seite dürfen echte
  // Antwortseiten nicht verdrängen; Marken-Boost gilt nicht für Beugungsformen.
  const frageSammel = [
    { url: 'https://www.duden.de/rechtschreibung/wer', title: 'wer Rechtschreibung, Bedeutung, Definition', snippet: 'wer, Fragewort' },
    { url: 'https://de.wikipedia.org/wiki/Albert_Einstein', title: 'Albert Einstein – Wikipedia', snippet: 'Albert Einstein war ein deutscher Physiker' },
  ];
  const frageOrdnung = search.rerank(frageSammel, 'wer war albert einstein kurz erklärt', new Set());
  add('E22 Duden-Frage-Wort verliert gegen Einstein (A6.2)',
    frageOrdnung[0] && /einstein/i.test(frageOrdnung[0].url),
    (frageOrdnung[0] || {}).url || 'leer');
  const markeSammel = [
    { url: 'https://www.heise.de/tipps/etf/beste-etfs', title: 'Die besten ETFs für Anfänger', snippet: 'ETF-Sparplan für Anfänger im Vergleich', families: ['bing'], bestWeight: 10 },
    { url: 'https://bester.de/', title: 'BESTER.de - Das Test- & Vergleichsportal', snippet: 'Vergleichsportal BESTER.de', families: ['bing'], bestWeight: 10 },
  ];
  const markeOrdnung = search.rerank(markeSammel, 'bester etf für anfänger', new Set());
  add('E23 „bester ETF": kein Marken-Boost für Beugungsform (A6.2)',
    markeOrdnung[0] && /heise/i.test(markeOrdnung[0].url),
    (markeOrdnung[0] || {}).url || 'leer');
  add('E7 SearXNG: Bot-Wand ergibt keine Scheintreffer',
    search.parseSearxngHtml('<title>Verifying your browser…</title>captcha').length === 0, 'ok');
  add('E8 Instanzliste geladen (mindestens 8)', search.SEARXNG_INSTANZEN.length >= 8,
    search.SEARXNG_INSTANZEN.length + ' Instanzen');

  // ── Baustein B: kuratierter Seitengraph ──
  const direktRpi = search.direktBei('rpi 5 kaufen');
  add('E9 «rpi 5 kaufen» findet „Direkt bei“-Seite',
    direktRpi.some((d) => /raspberrypi|geizhals|reichelt/i.test(d.domain)),
    direktRpi.map((d) => d.name).join(', ') || 'keine');
  const direktFd = search.direktBei('freudenstadt rathaus');
  add('E10 «freudenstadt» findet Stadtseite (regional)',
    direktFd.some((d) => /freudenstadt/i.test(d.domain)),
    direktFd.map((d) => d.name).join(', ') || 'keine');
  const direktLlm = search.direktBei('günstige llm');
  add('E11 «günstige llm» bleibt ohne Regionseintrag',
    !direktLlm.some((d) => d.kategorie === 'behoerde' && /freudenstadt|calw/i.test(d.domain)),
    direktLlm.map((d) => d.name).join(', ') || 'keine');
  add('E12 Verzeichnis hat Grundumfang', search.SITES.length >= 100, search.SITES.length + ' Einträge');
  const direktUrl = search.direktBei('rpi 5 kaufen').find((d) => /geizhals/i.test(d.domain));
  add('E13 Kachel-URL trägt die Anfrage',
    !direktUrl || direktUrl.url.includes('rpi'),
    direktUrl ? direktUrl.url.slice(0, 60) : 'übersprungen');
  const direktGpu = search.direktBei('grafikkarte für lokale ki');
  add('E17 «grafikkarte für lokale ki» zieht keine Karten-Kacheln',
    !direktGpu.some((d) => /openstreetmap|komoot/i.test(d.domain)) &&
    direktGpu.some((d) => /ollama/i.test(d.domain)),
    direktGpu.map((d) => d.name).join(', ') || 'keine');

  // ── Baustein C: Auszug und harte Kante ──
  const seite = 'Whisper ist ein Modell zur automatischen Spracherkennung. Es wandelt gesprochene Sprache in Text um. Die Qualität bleibt auch bei Störgeräuschen hoch. Andere Absätze handeln von ganz anderen Dingen ohne Bezug.';
  const bew = search.excerptUndScore(seite, 'Whisper: Robust Speech Recognition', new Set(['llm', 'stt', 'speech', 'text', 'spracherkennung', 'whisper']));
  add('E14 Auszug wählt den Satz mit den meisten Frage-Wörtern',
    /Spracherkennung|Text/.test(bew.excerpt) && bew.excerpt.length >= 40,
    bew.excerpt.slice(0, 60));
  add('E15 harte Kante: fremder Text bekommt fail',
    search.excerptUndScore('Alles über Hämatologie und Retikulozyten im Blutbild.', 'Hämatologie', new Set(['rpi', 'raspberry', 'pi', 'kaufen'])).fail === true,
    'ok');
  add('E16 passender Text bekommt kein fail', bew.fail === false, 'ok');

  const datei = path.join(__dirname, '..', 'tmp', 'brave.html');
  if (!fs.existsSync(datei)) {
    add('A  Brave-Parser (gespeicherte Seite)', null, 'Beispiel fehlt in tmp/brave.html — übersprungen');
    return;
  }
  const treffer = search.parseBraveHtml(fs.readFileSync(datei, 'utf8'));
  add('A  Brave-Parser liefert Treffer', treffer.length >= 8, treffer.length + ' Treffer');
  const ohneTitel = treffer.filter((t) => !t.title).length;
  add('A2 jeder Treffer hat einen echten Titel', ohneTitel === 0, ohneTitel + ' ohne Titel');
  const mitSnippet = treffer.filter((t) => t.snippet).length;
  add('A3 Texte werden mitgenommen', mitSnippet >= Math.ceil(treffer.length * 0.6), mitSnippet + '/' + treffer.length + ' mit Snippet');
  const erste = treffer[0] || {};
  add('A4 erster Treffer plausibel', /Freudenstadt/i.test((erste.title || '') + (erste.url || '')), (erste.title || '?').slice(0, 50));
  add('A5 keine internen Brave-Links und keine Anzeigen-Weiterleitung',
    !treffer.some((t) => /search\.brave\.com|\/a\/redirect|aid=\d/i.test(t.url)),
    treffer.filter((t) => /search\.brave\.com|aid=\d/i.test(t.url)).map((t) => t.url).slice(0, 2).join(' '));
  add('A6 nicht mehr als 20 Treffer aus einer Quelle', treffer.length <= 20, treffer.length + ' Treffer');

  // Plausibilitätsbremse: fachfremde Auslieferung einer Quelle muss raus
  const muell = Array.from({ length: 8 }, (_, i) => ([
    { title: 'GitHub - 0xk1h0/ChatGPT_DAN: ChatGPT DAN', snippet: 'jailbreak prompts', url: 'https://github.com/0xk1h0/ChatGPT_DAN' },
    { title: 'AITAH - Reddit', snippet: 'wedding drama', url: 'https://www.reddit.com/r/AITAH/' },
    { title: 'Guild Wars 3 - Reddit', snippet: 'mmorpg leak', url: 'https://www.reddit.com/r/GuildWars3/' },
    { title: 'ChatGPT Plus Nutzungsgrenzen', snippet: 'Codex-Grenzfall', url: 'https://www.zhihu.com/question/' + i },
  ][i % 4]));
  const gut = [
    { title: 'Willkommen | Stadt Freudenstadt', snippet: 'Marktplatz Schwarzwald', url: 'https://www.freudenstadt.de/' },
    { title: 'Freudenstadt – Wikipedia', snippet: 'Kreisstadt in Baden-Württemberg', url: 'https://de.wikipedia.org/wiki/Freudenstadt' },
  ];
  add('A7 fachfremde Großlieferung wird verworfen', search.quellensinnvoll(muell, 'freudenstadt') === false, 'erwartet false');
  add('A7b kleine Quelle mit anderem Titel bleibt', search.quellensinnvoll([{ title: 'Raspberry Pi', snippet: 'Einplatinenrechner', url: 'https://de.wikipedia.org/wiki/Raspberry_Pi' }], 'rpi 5 kaufen') === true, 'erwartet true (eine Einzelquelle darf nicht am Kürzel scheitern)');
  add('A8 passende Quelle bleibt', search.quellensinnvoll(gut, 'freudenstadt') === true, 'erwartet true');
  add('A9 Umlaute zählen mit', search.quellensinnvoll([{ title: 'München heute', snippet: '', url: 'https://de.wikipedia.org/wiki/M%C3%BCnchen' }], 'münchen') === true, 'erwartet true');
}

function nachrichtenErkennung() {
  const an = ['die neuesten llm', 'aktuelle KI Modelle', 'latest python release', 'news aus berlin', 'neue grafikkarten 2026'];
  const aus = ['freudenstadt', 'ubuntu download', 'zdf mediathek', 'texthöhle'];
  const trefferAn = an.filter((q) => search.willNachrichten(q));
  const falschAus = aus.filter((q) => search.willNachrichten(q));
  add('B  Aktualitäts-Anfragen werden erkannt', trefferAn.length === an.length, trefferAn.length + '/' + an.length);
  add('B2 normale Anfragen bleiben draußen', falschAus.length === 0, falschAus.join(', ') || 'keine Fehlerrkennung');
}

async function live() {
  const faelle = [
    { q: 'die neuesten llm', erwartet: (r) => r.some((x) => x.quelle), grund: 'Nachrichtenartikel mit Quellenangabe' },
    { q: 'freudenstadt', erwartet: (r) => r.some((x) => /freudenstadt\.de/.test(x.url) && x.official), grund: 'offizielle Seite vorn' },
    { q: 'ubuntu download', erwartet: (r) => /ubuntu\.com/.test((r[0] || {}).url || ''), grund: 'ubuntu.com auf Platz 1' },
  ];
  for (const f of faelle) {
    const t0 = Date.now();
    let aus = null;
    let erste = null;
    let quellen = {};
    try {
      const r = await search.searchWeb(f.q, (p) => { if (!erste && (p.results || []).length) erste = Date.now() - t0; quellen = r && r.sources ? r.sources : p.sources; });
      aus = r.results || [];
      quellen = r.sources || quellen;
    } catch (e) {
      add('C ' + f.q, null, 'Fehler: ' + e.message);
      continue;
    }
    const antwortende = Object.values(quellen || {}).filter((wert) => /^\d+ms\/[1-9]/.test(String(wert))).length;
    if (!aus.length) { add('C ' + f.q, null, 'keine Quelle hat geantwortet (gerade gedrosselt?)'); continue; }
    if (antwortende < 2) {
      // Über Rangqualität urteilen wir nur, wenn mindestens zwei Quellen
      // wirklich Treffer geliefert haben — sonst bestraft uns eine Drosselung.
      add('C  «' + f.q + '»', null, 'nur ' + antwortende + ' Quelle(n) mit Treffern — übersprungen');
    } else {
      add('C  «' + f.q + '»: ' + f.grund, f.erwartet(aus), aus.slice(0, 2).map((x) => (x.quelle ? x.quelle + ': ' : '') + x.title.slice(0, 34)).join(' | '));
    }
    add('C2 «' + f.q + '»: keine nackte Domain in der Liste',
      !aus.some((x) => !x.title || x.title.toLowerCase() === (x.url.replace(/^https?:\/\//, '').split('/')[0] || '')),
      aus.filter((x) => !x.title).length + ' ohne Titel');
    add('C3 «' + f.q + '»: erste Treffer unter 900 ms', erste !== null && erste < 900, erste === null ? 'keine Zwischenmeldung' : erste + ' ms');
  }
}

(async () => {
  search.configure(() => ({ privacy: {}, search: { instance: '' }, cloud: {}, debug: {} }));
  offline();
  nachrichtenErkennung();
  await live();

  let fehl = 0;
  console.log('\n=========== 3DK Browser — Prüfsuite Suche ===========');
  for (const p of prüfungen) {
    const markierung = p.ok === null ? '  ÜBERSPRUNGEN ' : (p.ok ? '  PASS   ' : '  FEHLER ');
    console.log(markierung + p.name.padEnd(48) + ' | ' + p.grund);
    if (p.ok === false) fehl++;
  }
  const gemacht = prüfungen.filter((p) => p.ok !== null).length;
  console.log('');
  console.log(fehl ? '  → ' + fehl + ' von ' + gemacht + ' Prüfpunkten fehlgeschlagen'
    : '  → alle ' + gemacht + ' Prüfpunkte bestanden');
  console.log('====================================================\n');
  process.exit(fehl ? 1 : 0);
})();
