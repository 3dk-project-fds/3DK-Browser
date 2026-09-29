// 3DK Browser — Such-Backend.
//
// Der Browser hängt an keinem Betreiber-Server und an keinem Konto: mehrere
// unabhängige freie Suchquellen laufen parallel, die Ergebnisse werden lokal
// zusammengeführt und neu gerankt (Marken-Boost, Konsens über mehrere
// Indexfamilien, Dubletten je Domain).
//
// Tempo-Prinzipien:
//   1. Vorabverbindung: DNS + TLS zu den Quellen werden beim Start warmgehalten.
//   2. Parallel statt sequentiell: alle Quellen gleichzeitig, harte Deadlines.
//   3. Progressiv: die schnellste Quelle zeigt sofort Treffer, die anderen
//      mischen sich unter, ohne dass die Seite neu lädt.
//   4. Deduplizierung: Vorab-Suche beim Tippen und Enter teilen dieselbe
//      Anfrage — es geht keine Doppelanfrage raus.
//   5. Cache mit Nachziehen: bekannte Anfragen antworten in ~0 ms.
//
// settings.search.instance (optional, leer by default): wer eine eigene
// SearXNG-Instanz betreibt, hängt sie als zusätzliche Quelle dazu.

const { net, app } = require('electron');
const fs = require('fs');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HDRS = { 'User-Agent': UA, 'Accept-Language': 'de,en;q=0.8' };

const FIRST_PAINT_MS = 1500; // nach dieser Zeit gilt das Bild als vollständig
const ENGINE_TIMEOUT_MS = 2200;
const CACHE_TTL = 20 * 60 * 1000;
const CACHE_MAX = 300;

let getSettings = () => ({});

function configure(fn) {
  if (typeof fn === 'function') getSettings = fn;
}

// ── Netzwerk ────────────────────────────────────────────────────────────
async function fetchText(url, opts = {}) {
  const init = {
    headers: { ...HDRS, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || ENGINE_TIMEOUT_MS),
    redirect: 'follow',
  };
  if (opts.method) init.method = opts.method;
  if (opts.body) init.body = opts.body;
  const res = net && net.fetch ? await net.fetch(url, init) : await fetch(url, init);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

// Vorverbindungen aufbauen, damit die erste echte Suche nicht auch noch
// DNS und Handschlag bezahlen muss.
const WARM_URLS = [
  'https://www.bing.com/',
  'https://search.brave.com/',
  'https://lite.duckduckgo.com/',
  'https://de.wikipedia.org/',
  'https://geocoding-api.open-meteo.com/',
];
async function warmConnections() {
  await Promise.allSettled(
    WARM_URLS.map((u) =>
      fetchText(u, { timeout: 3000, headers: { 'User-Agent': UA } }).catch(() => null)
    )
  );
}

// ── Kleinigkeiten ───────────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => cp(+d))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}
function cp(n) {
  try { return Number.isFinite(n) ? String.fromCodePoint(n) : ''; } catch { return ''; }
}
function stripTags(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function clean(s, max = 400) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
function absolute(href, base) {
  try { return new URL(href, base).href; } catch { return ''; }
}
function httpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '';
}

// ── Baustein 0: Anfrage-Verständnis (Synonym-/Abkürzungs-Expansion) ────
// Engines wie Bing kennen Kurzformen nicht („LLM für STT" → nur generische
// LLM-Treffer). Wir expandieren die Anfrage selbst: trifft ein Wort aus einer
// Synonym-Gruppe, hängen wir die fehlenden Wörter an die Engine-Anfrage an.
// Angezeigt bleibt immer die Originalfrage des Nutzers.
let SYNONYM_GRUPPEN = [];
const SYNONYM_LOOKUP = new Map(); // token -> Phrasen seiner Gruppe (normiert, mehrwortig)
try {
  SYNONYM_GRUPPEN = (require('./synonyme.json').gruppen || []).map((g) => {
    const norm = g.map(normSyn);
    for (const w of norm) {
      for (const t of w.split(/[^a-z0-9]+/).filter((x) => x.length >= 3)) {
        if (!SYNONYM_LOOKUP.has(t)) SYNONYM_LOOKUP.set(t, new Set());
        for (const phrase of norm) SYNONYM_LOOKUP.get(t).add(phrase);
      }
    }
    return norm;
  });
} catch { /* Wörterbuch fehlt → Expansion bleibt aus */ }

function normSyn(s) {
  return String(s).toLowerCase().trim()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]));
}

const MAX_EXPANSION = 6;

function expandiere(q) {
  const orig = String(q || '');
  const normq = ' ' + normSyn(orig).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const worter = new Set(anfrageWorter(orig));
  // Gewichtung: die echten Frage-Wörter zählen dreifach, die angehängten
  // Synonyme einfach — sonst säuft die Frage in der Expansion unter
  // („LLM für STT“: eine Seite nur über LLMs ist KEIN guter Treffer).
  const gewichte = new Map();
  for (const w of worter) gewichte.set(w, 3);
  // A5: Nennt die Frage einen Ort aus dem Seitengraph („freudenstadt"), ist
  // der Ort ein gleichwertiges Frage-Konzept — ohne ihn ist eine Seite kein
  // Volltreffer, auch wenn „wetter" und „morgen" draufstehen.
  for (const w of worter) {
    if (ortsworterAusGraph().has(normiere(w))) gewichte.set(normiere(w), 3);
  }
  const zusatz = [];
  for (const gruppe of SYNONYM_GRUPPEN) {
    const treffer = gruppe.some((w) =>
      w.includes(' ')
        ? normq.includes(' ' + w + ' ')
        : new RegExp('[^a-z0-9]' + w + '[^a-z0-9]').test(normq)
    );
    if (!treffer) continue;
    for (const w of gruppe) {
      const bereits = w.includes(' ')
        ? normq.includes(' ' + w + ' ')
        : new RegExp('[^a-z0-9]' + w + '[^a-z0-9]').test(normq);
      if (bereits) continue;
      for (const t of normSyn(w).split(/[^a-z0-9]+/)) {
        if (t.length >= 3 && !STOPPWOERTER.has(t) && !gewichte.has(t)) { worter.add(t); gewichte.set(t, 1); }
      }
      if (zusatz.length < MAX_EXPANSION && !zusatz.includes(w)) zusatz.push(w);
    }
  }
  // A6.2 (Testbatterie 27.09.): Fragesätze führen bei den Quellen oft zu
  // Wörterbuch-Müll („wer war albert einstein kurz erklärt" → Duden „wer").
  // Für die QUELLEN kürzen wir auf den Kern; Anzeige, Gewichte und Rangfolge
  // nutzen weiter die Originalfrage des Nutzers.
  let kern = orig.toLowerCase()
    .replace(/\b(wer|wie|was|warum|wieso|weshalb|wann|wo|ob)\b/g, ' ')
    .replace(/\b(ist|sind|war|waren|wird|werden|kann|muss|es|ein|eine|einen|der|die|das|den|dem|des|meine?n?)\b/g, ' ')
    .replace(/\b(funktioniert|heißt|bedeutet|koennen|kann|man)\b/g, ' ')
    .replace(/\b(kurz|einfach|erklaert|erklaeren|explained|bedeutung|definition|definiert)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!kern || kern.length < 3) kern = orig.toLowerCase();
  return { q: (zusatz.length ? kern + ' ' + zusatz.join(' ') : kern), worter, gewichte, zusatz };
}

// ── Quellen ─────────────────────────────────────────────────────────────
// family = unabhängiger Index. Nur verschiedene Familien zählen als Konsens.

// Bing als XML/RSS: klein, schnell, ohne JavaScript lesbar.
async function engineBingRss(q) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&format=rss&count=30';
  const xml = await fetchText(url, { timeout: 1700 });
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (name) => {
      const r = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i').exec(m[1]);
      return r ? clean(decodeEntities(r[1].replace(/<!\[CDATA\[|\]\]>/g, '')), 500) : '';
    };
    const title = field('title');
    const link = httpUrl(field('link'));
    if (!title || !link) continue;
    out.push({ title, url: link, snippet: field('description') });
  }
  return out;
}

// Bing-HTML (Baustein 1): voller Trefferblock mit Snippet — RSS hat beides
// nicht in brauchbarer Qualität. Gemessen am 24.09.: ohne Bot-Check erreichbar.
function bingCkAufloesen(href) {
  const h = decodeEntities(String(href || ''));
  if (!h.includes('bing.com/ck/')) return h;
  const u = /[?&]u=a1([^&]+)/.exec(h);
  if (u) {
    try {
      const b = decodeURIComponent(u[1]).replace(/-/g, '+').replace(/_/g, '/');
      const t = Buffer.from(b, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(t)) return t;
    } catch { /* Umleitung bleibt */ }
  }
  return '';
}

function parseBingHtml(html) {
  const out = [];
  for (const block of String(html).split('<li class="b_algo"').slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const link = httpUrl(bingCkAufloesen(a[1]));
    const title = clean(stripTags(a[2]), 200);
    if (!link || !title) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({ url: link, title, snippet: p ? clean(stripTags(p[1]), 400) : '' });
    if (out.length >= 12) break;
  }
  return out;
}

async function engineBingHtml(q) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=de&cc=de&count=20';
  const html = await fetchText(url, { timeout: 2200 });
  const out = parseBingHtml(html);
  if (!out.length && /consent|captcha/i.test(html)) throw new Error('Consent/Bot-Check');
  return out;
}

// ── Baustein 2: öffentliche SearXNG-Instanzen im echten Chromium ──────
// Anonym, ohne Schlüssel, ohne eigenen Server. Die Anfrage wird im leeren
// Agent-Profil geladen (JS-Schutzwände lösen sich dort automatisch); bei
// Ausfall wandert sie zur nächsten Instanz (Rotation).
let SEARXNG_INSTANZEN = [];
try {
  SEARXNG_INSTANZEN = (require('./searxng-instanzen.json').instanzen || [])
    .map((i) => ({ url: String(i.url || '').replace(/\/+$/, ''), bis: 0, zuletztOk: 0 }))
    .filter((i) => /^https:\/\//.test(i.url));
} catch { /* Liste fehlt → Quelle bleibt aus */ }

let searxngLoader = null;
let searxngCursor = 0;
function setSearxngLoader(fn) { if (typeof fn === 'function') searxngLoader = fn; }

function parseSearxngHtml(html) {
  const out = [];
  const h = String(html || '');
  // Bot-Wand statt Trefferseite → kein Ergebnis, Rotation weiter.
  if (!/class="[^"]*result/i.test(h) && /not a bot|captcha|just a moment|verifying your browser/i.test(h)) return [];
  // Öffnende Tags mitnehmen: SearXNG hängt die Engine-Liste eines Treffers
  // als data-engines an das result-Element (Punkt A1, Restpunkt 2.4/B).
  const re = /<(?:div|article)\b([^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*)>/gi;
  const staende = [];
  let m;
  while ((m = re.exec(h))) staende.push({ at: m.index + m[0].length, attrs: m[1] });
  for (let i = 0; i < staende.length; i++) {
    const block = h.slice(staende[i].at, i + 1 < staende.length ? staende[i + 1].at : h.length);
    const a = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
      || /<a[^>]*class="[^"]*url[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/.exec(block);
    if (!a) continue;
    const url = httpUrl(decodeEntities(a[1]));
    const title = clean(stripTags(a[2]), 200);
    if (!url || !title) continue;
    if (url.includes('/search?')) continue; // Eigenlinks der Instanz
    const c = /<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const eng = /data-engines="([^"]*)"/i.exec(staende[i].attrs) || /data-engine="([^"]*)"/i.exec(staende[i].attrs);
    const engines = eng ? eng[1].trim().split(/\s+/).filter(Boolean) : [];
    out.push({ url, title, snippet: c ? clean(stripTags(c[1]), 400) : '', engines });
    if (out.length >= 15) break;
  }
  return out;
}

async function engineSearxngPublic(q) {
  if (!searxngLoader || !SEARXNG_INSTANZEN.length) return [];
  const eq = encodeURIComponent(q);
  const jetzt = Date.now();
  // Reihenfolge: einsatzbereit zuerst, round-robin über die Liste.
  const bereit = SEARXNG_INSTANZEN
    .map((inst, i) => ({ inst, i }))
    .filter(({ inst }) => inst.bis <= jetzt)
    .sort((a, b) => (a.i + searxngCursor) % SEARXNG_INSTANZEN.length - (b.i + searxngCursor) % SEARXNG_INSTANZEN.length);
  let letzterGrund = 'keine Instanz einsatzbereit';
  for (const { inst } of bereit.slice(0, 4)) {
    let r;
    try {
      r = await searxngLoader(inst.url + '/search?q=' + eq + '&language=de-DE&categories=general', { timeoutMs: 6000 });
    } catch (e) {
      r = { ok: false, grund: String(e.message || e) };
    }
    if (r && r.ok) {
      const results = parseSearxngHtml(r.html);
      if (results.length) {
        inst.zuletztOk = Date.now();
        searxngCursor = (SEARXNG_INSTANZEN.indexOf(inst) + 1) % SEARXNG_INSTANZEN.length;
        return results;
      }
      letzterGrund = 'Bot-Wand oder keine Treffer (' + inst.url + ')';
      inst.bis = Date.now() + 5 * 60 * 1000; // Wand → länger schlafen legen
    } else {
      letzterGrund = (r && r.grund) || 'Ladefehler';
      inst.bis = Date.now() + 90 * 1000; // Ausfall → kurze Pause
    }
  }
  throw new Error(letzterGrund);
}

// ── Baustein B: kuratierter Seitengraph („Direkt bei") ────────────────
// Navigierende Anfragen („rpi 5 kaufen", „freudenstadt rathaus") führen direkt
// zur internen Suche der richtigen Zielseite — ohne Suchmaschinen-Mittelsmann.
let SITES = [];
try { SITES = require('./sites/de.json').sites || []; } catch { /* Liste fehlt */ }

function ladeNutzerSites() {
  try {
    const pfad = require('path').join(app.getPath('userData'), 'Sitenachschlaege.json');
    const daten = JSON.parse(fs.readFileSync(pfad, 'utf8'));
    return Array.isArray(daten) ? daten : [];
  } catch { return []; }
}

const KATEGORIE_WOERTER = {
  kaufen: ['kaufen', 'bestellen', 'preis', 'guenstig', 'billig', 'shop', 'angebot', 'gebraucht'],
  fahrplan: ['fahrplan', 'abfahrt', 'ankunft', 'verspaetung', 'stoerung', 'verbindung', 'zug', 'bus', 'ticket'],
  wetter: ['wetter', 'vorhersage', 'regen', 'temperatur', 'unwetter', 'warnung'],
  dokumentation: ['anleitung', 'doku', 'handbuch', 'forum', 'hilfe', 'tutorial', 'howto', 'einrichten', 'installieren', 'fehler'],
  behoerde: ['rathaus', 'amt', 'behoerde', 'antrag', 'termin', 'ausweis', 'steuer', 'foerderung'],
  nachrichten: ['nachrichten', 'news', 'aktuell', 'heute', 'zeitung', 'meldung'],
  regional: ['sehenswuerdigkeiten', 'ausflug', 'tourismus', 'wanderung', 'stadtplan', 'karte', 'veranstaltung', 'kino', 'restaurant'],
  medizin: ['arzt', 'symptom', 'krankheit', 'medikament', 'notdienst', 'apotheke'],
  rezepte: ['rezept', 'kochen', 'backen', 'gericht'],
  finanzen: ['bank', 'konto', 'kredit', 'versicherung', 'aktien', 'etf', 'steuer'],
  recht: ['gesetz', 'urteil', 'recht', 'paragraph', 'klage', 'vertrag'],
  wohnung: ['wohnung', 'mieten', 'haus', 'immobilie', 'zimmer'],
  auto: ['auto', 'gebrauchtwagen', 'fahrzeug', 'kfz', 'tuev'],
  jobs: ['job', 'arbeit', 'stelle', 'karriere', 'ausbildung'],
  reise: ['urlaub', 'reise', 'hotel', 'uebernachtung', 'flug'],
  nachschlagen: ['was ist', 'definition', 'bedeutung', 'lexikon', 'uebersetzen', 'wort'],
};

function direktBei(q) {
  const orig = String(q || '').toLowerCase().trim();
  if (!orig || orig.split(/\s+/).length > 6) return []; // lange Fragen bleiben offene Suche
  const normq = normiere(orig).replace(/[^a-z0-9äöüß ]+/g, ' ');
  const qWorter = new Set(normq.split(/\s+/).filter((w) => w.length >= 3));
  const alle = SITES.concat(ladeNutzerSites().map((n) => ({ ...n, nutzer: true })));
  const treffer = [];
  for (const site of alle) {
    if (!site || !site.suche || !site.name) continue;
    // Regional nur bei regionalem Bezug der Anfrage (Entscheidung 24.09.).
    if (site.regional) {
      const regionen = (site.region || []).map(normSyn);
      const ortsTreffer = regionen.some((r) => normq.includes(r));
      if (!ortsTreffer) continue;
    }
    let score = 0;
    const name = normSyn(site.name);
    const nameWort = name.split(/\s+/).find((w) => w.length >= 4);
    if (nameWort && (normq.includes(nameWort) || qWorter.has(nameWort))) score += 60;
    for (const t of site.themen || []) {
      const nt = normSyn(t);
      if (nt.includes(' ')) { if (normq.includes(nt)) score += 50; }
      else if (qWorter.has(nt) && nt.length >= 3) score += 40;
    }
    const katWorter = KATEGORIE_WOERTER[site.kategorie] || [];
    // Kategorie-Woerter zaehlen nur als ganze Woerter: sonst steckt "karte"
    // in "grafikkarte" und zieht Regional-Kacheln in eine Fachanfrage.
    // Mehrwort-Eintrage ("was ist") bleiben Teilketten-Treffer.
    if (katWorter.some((w) => (w.includes(' ') ? normq.includes(w) : qWorter.has(w)))) score += 25;
    if (!score) continue;
    score += (4 - (site.prioritaet || 3)) * 8;
    treffer.push({ score, site });
  }
  treffer.sort((a, b) => b.score - a.score);
  return treffer.slice(0, 3).map(({ site }) => ({
    name: site.name,
    domain: site.domain,
    kategorie: site.kategorie,
    url: site.suche.includes('{q}')
      ? site.suche.replace(/\{q\}/g, encodeURIComponent(q))
      : site.suche,
    nutzer: Boolean(site.nutzer),
  }));
}

// ── Baustein C: eigene Rangfolge und Auszüge aus den Seiten selbst ─────
// Die fremden Maschinen liefern nur Kandidaten. Die besten N werden wirklich
// geladen (im leeren Agent-Profil), nach echtem Inhalt bewertet, und ein bis
// zwei Sätze aus der Seite selbst kommen unter den Titel (Google-Stil).
let pageLoader = null;
function setPageLoader(fn) { if (typeof fn === 'function') pageLoader = fn; }

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function normiere(text) {
  return String(text || '').toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]));
}

// Auszug: Navigation-/Reklame-Sätze sind keine Zusammenfassung.
const SCHROTT_SATZ = /datenschutz|impressum|haftungsausschluss|cookie|javascript (aktivieren|deaktivieren|erforderlich)|all rights reserved|sign (in|up)|log (in|out)|abonnieren|newsletter|confirm you.?re human|verifying your browser|enable js|zum (inhalt|hauptmenü) springen|skip to (content|main)|abgerufen von|kategorien ?:|begriffsklärung|this page is for|ist eine Begriffsklärung/i;

// Kern von C: aus dem Seitentext die Trefferquote der Frage messen und den
// Auszug wählen — den Satz mit den meisten Frage-Wörtern (inkl. Synonyme).
function excerptUndScore(text, titel, worter) {
  const normText = normiere(text);
  const normTitel = normiere(titel);
  const kopf = normText.slice(0, 500);
  // worter: Set (alles gleich schwer) oder Map (Frage-Wörter schwerer).
  const gewichte = worter instanceof Map ? worter : new Map([...(worter || [])].map((w) => [w, 1]));
  let imTitel = 0; let imKopf = 0; let imText = 0; let gewichtTitel = 0; let gewichtText = 0;
  for (const [w, g] of gewichte) {
    if (w.length < 3) continue;
    if (normTitel.includes(w)) { imTitel += g; gewichtTitel++; }
    if (kopf.includes(w)) imKopf += g;
    if (normText.includes(w)) { imText += g; gewichtText++; }
  }
  const score = imTitel * 3 + imKopf * 2 + imText;
  // Auszug: der Satz mit den meisten Frage-Wörtern, 1–2 Sätze, max. 320 Zeichen.
  const saetze = String(text || '').split(/(?<=[.!?…])\s+(?=[A-ZÄÖÜ„(0-9])/)
    .map((s) => s.trim()).filter((s) => s.length >= 40 && s.length <= 280 && !SCHROTT_SATZ.test(s));
  let best = null;
  for (const s of saetze.slice(0, 60)) {
    const ns = normiere(s);
    let k = 0;
    for (const [w] of gewichte) if (ns.includes(w)) k++;
    if (!best || k > best.k || (k === best.k && s.length < best.s.length)) best = { s, k };
  }
  let excerpt = best && best.k > 0 ? best.s : '';
  if (excerpt && excerpt.length < 90) {
    const zweite = saetze.find((s) => s !== excerpt && normiere(s).split(/[^a-z0-9]+/).length > 6);
    if (zweite && (excerpt.length + zweite.length) <= 320) excerpt += ' ' + zweite;
  }
  // Harte Kante: kein einziges Frage-Wort (auch kein Synonym) im Text.
  return { excerpt, score, hits: gewichtText, fail: gewichte.size > 0 && gewichtText === 0, gewichtTitel };
}

// Frische: Veröffentlichungsdatum aus dem HTML, wenn vorhanden.
function frischeAusHtml(html) {
  const m = /(?:article:published_time|datePublished|property="date")[^>]*content="([^"]{8,30})"/i.exec(String(html || ''))
    || /content="([^"]{8,30})"[^>]*(?:article:published_time|datePublished)/i.exec(String(html || ''));
  if (!m) return 0;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : 0;
}

// Die Tieflese-Phase: nach dem ersten Bild die besten N Kandidaten wirklich
// laden, bewerten, Auszüge setzen und die Liste einmal neu ordnen.
async function tieflesen(byUrl, results, gewichte, q, snapshot, key, state) {
  if (!pageLoader) return;
  const s = getSettings().search || {};
  if (s.deepRead === false) return;
  const anzahl = [3, 5, 7].includes(Number(s.deepCount)) ? Number(s.deepCount) : 3;
  // Kandidaten: die Bestplatzierten — UND die, deren Titel/Snippet schon die
  // Original-Fragewörter tragen. Ohne die zweite Gruppe bliebe der Whisper-
  // Treffer auf Platz 8 ungelesen, während drei LLM-Lexikonseiten oben stehen.
  const frageWorte = [...(gewichte instanceof Map ? gewichte : new Map()).entries()]
    .filter(([, g]) => g >= 3).map(([w]) => w);
  const kandidat = (results || []).filter((r) => !r.excerpt && !r.deepFail).slice(0, anzahl);
  if (frageWorte.length > 1) {
    // Zusatzkandidaten nach Konzept-Abdeckung: eine Seite, die Titel/Snippet
    // mit MEHREREN Frage-Konzepten bedient (LLM UND Speech-to-Text), wird
    // vor der x-ten generischen LLM-Seite gelesen.
    const konzepte = frageWorte.map((w) => {
      const phrasen = SYNONYM_LOOKUP.get(w);
      return [w, ...(phrasen ? [...phrasen] : [])];
    });
    const zaehlen = (r) => {
      const vorschau = normiere((r.title || '') + ' ' + (r.snippet || ''));
      let k = 0;
      for (const varianten of konzepte) if (varianten.some((v) => vorschau.includes(v))) k++;
      return k;
    };
    const zusatz = (results || [])
      .filter((r) => !kandidat.includes(r) && !r.excerpt && !r.deepFail)
      .map((r) => ({ r, k: zaehlen(r) }))
      .filter((x) => x.k >= 2)
      .sort((a, b) => b.k - a.k)
      .slice(0, Math.min(anzahl, 7 - kandidat.length))
      .map((x) => x.r);
    kandidat.push(...zusatz);
  }
  if (!kandidat.length) return;
  if (state) { state.reading = true; snapshot(false); }
  for (const r of kandidat) {
    const eintrag = byUrl.get(r.url);
    // deepRunning: Frühstart und Spätrunde dürfen dieselbe Seite nicht
    // zweimal laden (Punkt A4).
    if (!eintrag || eintrag.deepDone || eintrag.deepRunning) continue;
    eintrag.deepRunning = true;
    try {
      const geladen = await pageLoader(r.url, { timeoutMs: 2500 });
      if (geladen && geladen.ok && geladen.html) {
        const text = htmlToText(geladen.html).slice(0, 200000);
        // Bot-Wand/Zwischenseite statt Artikel: keine Bewertung, kein Auszug —
        // der Treffer bleibt unverändert stehen (weder belohnt noch bestraft).
        // Google-News-Weiterleitungen landen z. B. auf der Sprach-/Consent-Seite.
        const wand = (text.length < 1200 && /confirm you.?re human|verifying your browser|just a moment|captcha|zugriff verweigert|are you a robot/i.test(text))
          || /bevor sie fortfahren|before you continue|consent\.google|enablejs/i.test(text.slice(0, 400));
        if (!wand) {
        const bew = excerptUndScore(text, eintrag.title, gewichte);
        eintrag.excerpt = bew.excerpt;
        eintrag.keinInhalt = !bew.excerpt; // Seite lasbar, aber kein echter Inhalts-Satz
        eintrag.deepScore = bew.score;
        eintrag.deepFail = bew.fail;
        // Volltreffer: JEDES Original-Fragewort (oder eine seiner Synonym-
        // Phrasen) kommt im Titel oder den ersten 500 Zeichen vor — also
        // dort, worum die Seite wirklich handelt. Ein Wiki-Artikel, der
        // „Spracherkennung“ nur am Rande erwähnt, bekommt den Bonus nicht.
        if (gewichte instanceof Map) {
          const nt = normiere(eintrag.title + ' ' + text.slice(0, 500));
          const w3 = [...gewichte.entries()].filter(([, g]) => g >= 3).map(([w]) => w);
          if (w3.length) {
            let getroffen = 0;
            for (const w of w3) {
              const phrasen = SYNONYM_LOOKUP.get(w);
              if (nt.includes(w) || (phrasen && [...phrasen].some((p) => nt.includes(p)))) getroffen++;
            }
            eintrag.abdeckung = getroffen / w3.length;
            eintrag.voll = eintrag.abdeckung === 1;
          }
        }
        const fresh = frischeAusHtml(geladen.html);
        if (fresh && Date.now() - fresh < 45 * 86400000) eintrag.frisch = true;
        }
      }
    } catch { /* Seite weg/zu langsam — Treffer bleibt ohne Auszug */ }
    eintrag.deepDone = true;
    snapshot(false); // progressiv: jeder fertige Auszug wandert sofort hinein
  }
  if (state) state.reading = false;
  if (state) state.doneGeordnet = false; // finale Rangfolge nach dem Lesen
  const abschluss = snapshot(true);
  cachePut(key, abschluss);
}

// Brave: eigener Index, aber die Oberfläche ist schwer (HTML-Haufen).
async function engineBrave(q) {
  const url = 'https://search.brave.com/search?q=' + encodeURIComponent(q) + '&source=web';
  const html = await fetchText(url, { timeout: 2200 });
  return parseBraveHtml(html);
}

// Reiner Parser — ohne Netzwerk, damit er gegen eine gespeicherte Seite geprüft
// werden kann (Brave drosselt öffentliche Testanfragen schnell).
function parseBraveHtml(html) {
  const out = [];
  const seen = new Set();
  // Webtreffer in Blöcken; Werbung trägt data-type="ad" und bleibt draußen.
  // Der Titel steckt in Brave nicht im Anker-Text, sondern in einem
  // div class="title …" mit title="…"; der Text darunter in
  // generic-snippet > div.content.
  const blocks = html.split(/<div class="snippet svelte-[a-z0-9]+"/i).slice(1);
  for (const block of blocks) {
    const head = block.slice(0, 900);
    if (/data-type="ad"/i.test(head)) continue;
    // „Verwandte Suchanfragen“ sind keine Treffer, sondern Vorschläge.
    if (/related-queries/i.test(block.slice(0, 220))) continue;
    const href = /<a href="(https?:\/\/[^"]+)"/i.exec(block);
    const link = href ? decodeEntities(href[1]) : '';
    if (!httpUrl(link) || /\/a\/redirect/.test(link) || seen.has(link)) continue;
    try {
      if (new URL(link).hostname.endsWith('search.brave.com')) continue;
    } catch { continue; }
    const titelKnoten = /<div class="title[^"]*"[^>]*\btitle="([^"]{4,})"/i.exec(block)
      || /<div class="title[^"]*"[^>]*>([\s\S]{2,220}?)<\/div>/i.exec(block);
    const schnipsel = /<div class="generic-snippet[\s\S]{0,500}?<div class="content[^"]*"[^>]*>([\s\S]{2,900}?)<\/div>/i.exec(block);
    let titel = clean(stripTags(titelKnoten ? titelKnoten[1] : ''), 200);
    if (!titel) {
      const meldung = /data-headline-text="([^"]{4,})"/i.exec(block);
      titel = meldung ? clean(decodeEntities(meldung[1]), 200) : '';
    }
    seen.add(link);
    // Unterlinks eines Treffers (Webcam, Stellen, …) haben keinen eigenen
    // Titel — als eigene Zeile wären sie nur eine nackte Domain.
    if (!titel) continue;
    out.push({
      url: link,
      title: titel,
      snippet: schnipsel ? clean(stripTags(schnipsel[1]), 400) : '',
    });
    if (out.length >= 20) break;
  }
  return out;
}

// Reiner Parser für DuckDuckGo-HTML-Seiten (unverändert genutzt von beiden DDG-Zweigen).
async function engineDdgLite(q) {
  const html = await fetchText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q), { timeout: 1900 });
  return parseDdgLike(html, /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g);
}

async function engineDdgHtml(q) {
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { timeout: 1900 });
  return parseDdgLike(html, /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    /class="result-snippet"[^>]*>([\s\S]*?)<\/(?:td|div)>/g);
}

function parseDdgLike(html, linkRe, snippetRe) {
  const snippets = [];
  for (const m of html.matchAll(snippetRe)) snippets.push(clean(stripTags(m[1]), 400));
  const out = [];
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    let url = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* bleiben */ } }
    if (url.startsWith('//')) url = 'https:' + url.slice(2);
    url = httpUrl(url);
    const title = clean(stripTags(m[2]), 200);
    i++;
    if (!url || !title) continue;
    out.push({ url, title, snippet: snippets[i - 1] || '' });
    if (out.length >= 20) break;
  }
  return out;
}

// Mojeek: unabhängiger Index, ohne Konto und ohne Werbung.
async function engineMojeek(q) {
  const html = await fetchText('https://www.mojeek.com/search?q=' + encodeURIComponent(q), { timeout: 1900 });
  const out = [];
  for (const m of html.matchAll(/<a[^>]+class="ob"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,600}?)<\/(?:li|div)>/g)) {
    const url = httpUrl(decodeEntities(m[1]));
    const title = clean(stripTags(m[2]), 200);
    if (!url || !title) continue;
    const snip = /<p class="s[^"]*">([\s\S]*?)<\/p>/i.exec(m[3]);
    out.push({ url, title, snippet: snip ? clean(stripTags(snip[1]), 400) : '' });
    if (out.length >= 20) break;
  }
  return out;
}

// Eigene SearXNG-Instanz (optional): Metasuche + Infoboxen + Antworten.
async function engineSearxng(q) {
  const base = String((getSettings().search || {}).instance || '').trim().replace(/\/+$/, '');
  if (!base || !httpUrl(base)) return [];
  const eq = encodeURIComponent(q);
  const data = await fetchJson(base + '/search?q=' + eq + '&format=json&language=de-DE', { timeout: 2200 });
  const results = [];
  for (const r of data.results || []) {
    if (!r || !httpUrl(r.url) || !r.title) continue;
    results.push({
      title: clean(stripTags(r.title), 200),
      url: r.url,
      snippet: clean(stripTags(r.content || ''), 400),
      engines: Array.isArray(r.engines) ? r.engines.length : 1,
    });
  }
  const extra = {};
  const ib = (data.infoboxes || []).find((b) => b && b.infobox && (b.img_src || b.content));
  if (ib) {
    extra.infobox = {
      title: clean(stripTags(ib.infobox), 200),
      text: clean(stripTags(ib.content || ''), 400),
      img: httpUrl(ib.img_src || ''),
      url: httpUrl((ib.urls && ib.urls[0] && ib.urls[0].url) || ''),
    };
  }
  for (const a of data.answers || []) {
    if (typeof a === 'string') (extra.answers || (extra.answers = [])).push(clean(a, 400));
    else if (a && a.answer) (extra.answers || (extra.answers = [])).push(clean(stripTags(a.answer), 400));
  }
  return { results, ...extra };
}
// Wikipedia: eigener Artikel-Treffer plus Wisenskarte (Infobox) — ganz ohne
// Betreiber-Server, in der Sprache der Oberfläche.
async function engineWikipedia(q) {
  const api =
    'https://de.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
    encodeURIComponent(q) + '&gsrlimit=1&prop=extracts|pageimages&exintro&explaintext' +
    '&redirects=1&piprop=thumbnail&pithumbsize=320&format=json';
  const data = await fetchJson(api, { timeout: 1500 });
  const pages = (data.query && data.query.pages) || {};
  const page = Object.values(pages)[0];
  if (!page || !page.title) return [];
  const title = clean(page.title, 120);
  const url = 'https://de.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
  const text = clean(page.extract || '', 400);
  const out = [{ title: title + ' – Wikipedia', url, snippet: text }];
  // Die Wisenskarte nur, wenn der Artikel zur Frage passt (nicht zu jedem
  // Wort, das zufällig in einem Titel steht).
  const nQ = q.toLowerCase().trim();
  const nT = title.toLowerCase();
  const passt = nQ === nT || nT.startsWith(nQ) || nQ.startsWith(nT) || nT.includes(nQ) || nQ.includes(nT);
  if (passt && text) {
    return {
      results: out,
      infobox: { title, text, img: (page.thumbnail && page.thumbnail.source) || '', url },
    };
  }
  return { results: out };
}

// ── Nachrichten-Zweig ─────────────────────────────────────────────────
// Anfragen wie „die neuesten llm" meinen aktuelle Meldungen. Freie
// Websuchen antworten darauf mit Nachrichten-Startseiten; Google News liefert
// die Artikel selbst — ohne Konto, ohne Schlüssel, ohne Betreiber-Server.
const REZENZ_WORTER = /\b(neu|neue|neuer|neues|neuen|neueste|neuesten|aktuell|aktuelle|aktuellen|letzte|letzten|heute|gerade|latest|news|neuigkeiten|meldung|meldungen|update|updates|vorgestellt|veroeffentlicht|veröffentlicht)\b|20\d\d/i;

function willNachrichten(q) {
  return REZENZ_WORTER.test(String(q || '').toLowerCase());
}

function relativDatum(angabe) {
  const zeit = Date.parse(String(angabe || ''));
  if (!Number.isFinite(zeit)) return '';
  const tage = Math.round((Date.now() - zeit) / 86400000);
  if (tage <= 0) return 'heute';
  if (tage === 1) return 'gestern';
  if (tage < 7) return 'vor ' + tage + ' Tagen';
  const wochen = Math.round(tage / 7);
  if (tage < 31) return wochen === 1 ? 'vor 1 Woche' : 'vor ' + wochen + ' Wochen';
  const monate = Math.round(tage / 30);
  if (tage < 365) return monate === 1 ? 'vor 1 Monat' : 'vor ' + monate + ' Monaten';
  const jahre = Math.round(tage / 365);
  return jahre === 1 ? 'vor 1 Jahr' : 'vor ' + jahre + ' Jahren';
}

// Bing News RSS (Ersatz für die Google-News-Umlenk-Stubs, die nicht mehr
// ohne Consent-Seite lesbar sind): liefert Titel, ECHTE Beschreibung und
// Datum; der Artikellink steckt kodiert im url-Parameter der apiclick-URL.
function bingNewsLink(raw) {
  const u = decodeEntities(String(raw || ''));
  const m = /[?&]url=([^&]+)/.exec(u);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* roh */ } }
  return u;
}

async function engineBingNews(q) {
  const url = 'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=RSS&setlang=de&cc=de';
  const xml = await fetchText(url, { timeout: 1800 });
  const out = [];
  const feld = (zweig, name) => {
    const r = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(zweig);
    return r ? decodeEntities(r[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : '';
  };
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = clean(feld(m[1], 'title'), 300);
    const link = httpUrl(bingNewsLink(feld(m[1], 'link')));
    if (!title || !link) continue;
    if (/bing\.com\/news/.test(link)) continue; // Umlenkung blieb stecken
    const quelle = clean((/<News:Source[^>]*>([\s\S]*?)<\/News:Source>/.exec(m[1]) || [, ''])[1]
      .replace(/<!\[CDATA\[|\]\]>/g, ''), 60);
    const wann = relativDatum(feld(m[1], 'pubDate'));
    const beschreibung = clean(stripTags(feld(m[1], 'description')), 400);
    out.push({
      title,
      url: link,
      quelle,
      // Echte Beschreibung statt nur „vor 6 Tagen“ — das Alter kommt dazu.
      snippet: beschreibung ? (wann ? wann + ' — ' + beschreibung : beschreibung) : wann,
    });
    if (out.length >= 12) break;
  }
  return out;
}

const SOURCES = [
  { id: 'searx-public', family: 'searx-public', label: 'SearXNG (öffentlich, anonym)', weight: 12, run: engineSearxngPublic, timeout: 7000, only: () => !!searxngLoader && (getSettings().search || {}).publicSearxng !== false },
  { id: 'bing-html', family: 'bing', label: 'Bing', weight: 10, run: engineBingHtml, timeout: 2200 },
  { id: 'bing', family: 'bing', label: 'Bing RSS', weight: 8, run: engineBingRss, timeout: 1700 },
  { id: 'searxng', family: 'searx', label: 'Eigene Instanz', weight: 12, run: engineSearxng, timeout: 2200, only: () => !!String((getSettings().search || {}).instance || '').trim() },
  { id: 'brave', family: 'brave', label: 'Brave', weight: 8, run: engineBrave, timeout: 2200 },
  { id: 'bing-news', family: 'news', label: 'Bing Nachrichten', weight: 9, run: engineBingNews, timeout: 1800, only: willNachrichten, origQuery: true },
  { id: 'wikipedia', family: 'wikipedia', label: 'Wikipedia', weight: 5, run: engineWikipedia, timeout: 1500 },
  { id: 'ddg-lite', family: 'ddg', label: 'DuckDuckGo', weight: 7, run: engineDdgLite, timeout: 1900 },
  { id: 'ddg-html', family: 'ddg', label: 'DuckDuckGo HTML', weight: 6, run: engineDdgHtml, timeout: 1900 },
  { id: 'mojeek', family: 'mojeek', label: 'Mojeek', weight: 6, run: engineMojeek, timeout: 1900 },
];

// ── Re-Ranking ──────────────────────────────────────────────────────────
// Marken-Boost: Suchwort in der Domain → offizielle Seite nach oben.
// Konsens: mehrere unabhängige Familien (nicht mehrere Quellen desselben
// Index) für denselben Treffer → Vertrauen wächst.
// A5 (Nachtrag 25.09.): Orts- und Regionsnamen aus dem Seitengraph. Nennt
// die Frage einen Ort („wetter freudenstadt morgen"), sollen Treffer, die
// den Ort wirklich tragen, gegen generische Seiten anderer Städte gewinnen.
let ORTS_WOERTER = null;
function ortsworterAusGraph() {
  if (ORTS_WOERTER) return ORTS_WOERTER;
  const generisch = new Set(['stadt', 'landkreis', 'kreis', 'rathaus', 'amt', 'service', 'tourismus', 'stadtwerke', 'gemeinde', 'stadtwerke']);
  const woerter = new Set();
  const aufnehmen = (text) => {
    for (const teil of normiere(String(text || '')).split(/[^a-z]+/)) {
      if (teil.length >= 4 && !generisch.has(teil)) woerter.add(teil);
    }
  };
  for (const site of SITES || []) {
    for (const r of site.region || []) aufnehmen(r);
    if (site.kategorie === 'regional') aufnehmen(site.name);
  }
  ORTS_WOERTER = woerter;
  return woerter;
}

function rerank(collected, q, synoWorter) {
  const tokens = String(q).toLowerCase().split(/[^a-z0-9äöüß]+/).filter((t) => t.length >= 3);
  const synSet = synoWorter instanceof Set ? synoWorter : new Set(synoWorter || []);
  const rezent = willNachrichten(q);
  const ortAlle = ortsworterAusGraph();
  const ortsSet = new Set(tokens.map(normiere).filter((t) => ortAlle.has(t)));
  // A6: Das SELTENE Fragewort gewinnt. „langgraph dokumentation was ist es":
  // „dokumentation" steckt in fast jedem Treffer, „langgraph" in keinem —
  // Kandidaten, die ein Wort tragen, das selten unter den Kandidaten ist,
  // bekommen einen deutlichen Bonus. Dokumentfrequenz vor dem Scoring zählen.
  const nKand = collected.length;
  const normTokens = [...new Set(tokens.map(normiere))].filter((t) => t.length >= 4);
  const df = new Map();
  const nts = collected.map((r) => {
    const nt = normiere(r.url + ' ' + (r.title || '') + ' ' + (r.snippet || ''));
    if (nKand >= 3) {
      for (const t of normTokens) if (nt.includes(t)) df.set(t, (df.get(t) || 0) + 1);
    }
    return nt;
  });
  // Themen-Anker: das erste (leitende) Fragewort, das überhaupt in den
  // Kandidaten vorkommt und dort selten ist. Kommt es nirgends vor, bleibt
  // der Anker leer — dann wird nichts verschoben (kein Falsch-Boost für
  // Füllwörter wie „dokumentation").
  // A6.1 (27.09., Nutzerbefund „wer ist der beste ki agent" → Bester Energy
  // und beckers bester auf Platz 1–3): Beugungsformen von Adjektiven sind
  // NIE das Thema, auch wenn sie selten in den Kandidaten stehen — sie
  // treffen sonst Firmennamen („Bester", „beckers bester"). Diese Formen
  // sind als Anker gesperrt.
  const ANKER_STOPP = new Set(['beste', 'bester', 'bestes', 'besten', 'gut', 'gute', 'guten', 'guter', 'gutes',
    'neu', 'neue', 'neuer', 'neues', 'neuen', 'erste', 'ersten', 'letzte', 'letzten',
    'aktuelle', 'aktuellen', 'wichtige', 'wichtigen', 'grosse', 'grossen', 'kleine', 'kleinen',
    'hohe', 'hohen', 'ganze', 'ganzen', 'eigene', 'eigenen', 'schnelle', 'schnellen',
    'billige', 'billigen', 'gunstige', 'gunstigen', 'top', 'test', 'beste',
    'warum', 'wieso', 'weshalb', 'welcher', 'welche', 'welches', 'unterschied', 'vergleich']);
  let anker = null;
  if (nKand >= 3 && normTokens.length) {
    for (const t of normTokens) {
      if (ANKER_STOPP.has(t)) continue;
      const v = df.get(t) || 0;
      if (v >= 1 && v <= nKand * 0.6) { anker = t; break; }
    }
  }
  // "rpi 5 kaufen" meint einen Einplatinenrechner, nicht das
  // Religionspädagogische Institut rpi-virtuell.de: Marken-Boost gibt es für
  // die exakte Domain-Wurzel — und für deren Anfänge nur bei Eink-Wort-Frage.
  const einWortFrage = tokens.length === 1;
  const scored = collected.map((r, index) => {
    const domain = domainOf(r.url);
    const families = r.families instanceof Set ? r.families : new Set(r.families || []);
    let score = (collected.length - index) * 0.5;
    score += (r.bestWeight || 0) * 2;
    score += (families.size - 1) * 40;
    score += Math.min(r.engines || 1, 4) * 6;
    if (anker) {
      score += nts[index].includes(anker) ? 140 : -120;
    }
    // A6.4: ein Kandidat ohne jedes Fragewort (URL/Titel/Snippet) ist für
    // diese Frage Rauschen — egal, wie hoch die Quelle ihn gestellt hat.
    if (normTokens.length) {
      let ueberlapp = 0;
      for (const t of normTokens) if (nts[index].includes(t)) ueberlapp++;
      if (!ueberlapp) score -= 600;
    }
    if (/^https:/i.test(r.url)) score += 8;
    // A5: Nennt die Frage einen Ort, gewinnen Treffer, die den Ort tragen
    // (URL, Titel oder Snippet) — zwei Treffer zählen doppelt.
    if (ortsSet.size) {
      const nt = normiere(r.url + ' ' + (r.title || '') + ' ' + (r.snippet || ''));
      let ortTreffer = 0;
      for (const ort of ortsSet) if (nt.includes(ort)) ortTreffer++;
      if (ortTreffer) score += 130 * Math.min(ortTreffer, 2);
    }
    // Baustein C: Rangfolge aus echtem Inhalt. Harte Kante: ein Kandidat,
    // dessen geladener Text die Frage in keiner Weise enthält (auch keine
    // Synonyme), fällt unter die Liste — der Fall „rpi 5 kaufen" →
    // „Hämatologie: Retikulozytenproduktionsindex" ist damit erledigt.
    if (r.deepFail) score -= 100000;
    if (r.voll) score += 1200; // deckt die ganze Frage ab — stärker als fremder Konsens
    else if (typeof r.abdeckung === 'number' && !r.deepFail) score -= 1300 * (1 - r.abdeckung); // gelesen, deckt die Frage aber nur teilweise
    if (r.keinInhalt) score -= 300; // gelesen, aber kein echter Inhalt-Satz gefunden (Begriffsklärung, Gerüstseite)
    if (r.deepScore) score += Math.min(r.deepScore, 20) * (r.voll ? 80 : 30);
    if (r.frisch && rezent) score += 150;
    // Synonym-Treffer (Baustein 0): Ein Treffer, dessen Titel/Snippet die
    // expandierten Begriffe enthält, ist inhaltlich näher an der Frage als
    // einer, der nur das nackte Kürzel wiederholt („LLM für STT").
    if (synSet.size) {
      const text = ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase()
        .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]));
      let k = 0;
      for (const w of synSet) if (w.length >= 4 && text.includes(w)) k++;
      if (k) score += Math.min(k, 4) * 45;
    }
    // Artikel schlagen Nachrichten-Startseiten, wenn die Frage auf
    // Aktualität zielt.
    if (r.quelle) score += rezent ? 1400 : 120;
    // Kehrseite: nackte Startseiten ohne Artikel sind für solche Fragen Müll.
    if (pathDepth(r.url) === 0 && /nachrichten|schlagzeilen|startseite|home|aktuelles|home\b/i.test(r.title || '')) {
      score -= rezent ? 900 : 200;
    }
    const FALSCHE_MARKE = new Set(['beste', 'bester', 'bestes', 'besten', 'gut', 'gute', 'guten', 'guter', 'gutes', 'neue', 'neuer', 'neues', 'erste', 'ersten']);
    let official = false;
    for (const t of tokens) {
    // A6.3 (Testbatterie 27.09.): „bester laptop" ist keine Suche nach der
    // Firma „Bester" — exakte Domain-Treffer auf Beugungsformen sind
    // Marken-Rauschen und werden abgewertet. Echte Marken wie test.de
    // (Stiftung Warentest) stehen bewusst nicht auf dieser Liste.
    if (FALSCHE_MARKE.has(t)) {
      const bare0 = domain.split('.')[0];
      if (bare0 === t) { score -= 800; break; }
      continue;
    }
      const bare = domain.split('.')[0];
      if (bare === t && t.length >= 3) { score += 1000; official = true; break; }
      if (einWortFrage && t.length >= 4 && (bare.startsWith(t) || t.startsWith(bare))) { score += 500; official = true; break; }
      if (t.length >= 5 && domain.includes(t)) { score += 120; break; } // leiser Hinweis, keine Marke
    }
    // A6.2: Wörterbuch-Seiten, die ein reines Frage-/Füllwort erklären
    // (Duden „wer", DWDS „Unterschied"), sind in Satz-Fragen fast immer Müll.
    if (/duden.de|wiktionary|dwds.de|wortbedeutung/i.test(domain)) {
      const titel = String(r.title || '').toLowerCase();
      if (/^(wer|wie|warum|was|wann|wieso|weshalb|ob|unterschied|vergleich|kurz|einfach|bester|beste|bestes|besten|guter|gute|neuer|neue|erste)\b/.test(titel)
        || /\bsuchen\b/.test(titel)) {
        score -= 500;
      }
    }
    return { ...r, domain, official, score };
  });

  // Dubletten je Domain zusammenführen: offizielle Treffer zuerst, dann die
  // Variante mit dem kürzesten Pfad. Pro Domain bleiben zwei Seiten übrig —
  // eine einzelne wäre zu ausgedünnt, drei werden schnell eine Site-Liste.
  // Artikeltreffern über einen Weiterleitungsdienst (News) liegt die Domain
  // nicht zugrunde, sonst würde die ganze Quelle auf zwei Treffer stauchen.
  const proDomain = new Map();
  for (const r of scored) {
    const schluessel = r.quelle ? 'artikel:' + r.url : r.domain;
    const behalten = proDomain.get(schluessel) || [];
    if (behalten.length < 2) {
      behalten.push(r);
    } else if (r.official && !behalten[0].official) {
      behalten[0] = r;
    } else if (r.official === behalten[1].official && pathDepth(r.url) < pathDepth(behalten[1].url)) {
      behalten[1] = r;
    }
    proDomain.set(schluessel, behalten);
  }
  const merged = [...proDomain.values()].flat().sort((a, b) => b.score - a.score);
  return merged.map(({ domain, families, bestWeight, ...rest }) => rest);
}

function pathDepth(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).length; } catch { return 0; }
}

// ── Plausibilitätsbremse pro Quelle ─────────────────────────────────────
// Freie Endpunkte liefern bei Drosselung gern HTTP 200 mit inhaltlich fremden
// Sachen (Beobachtung am 23.09.: „freudenstadt" → ChatGPT-DAN, Reddit, Zhihu).
// Eine Quelle, deren Treffer in keiner Beziehung zur Frage stehen, wird
// verworfen statt mitgemischt — sonst kippt sie eine sonst gute Liste.
const STOPPWOERTER = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'oder', 'mit', 'von', 'fur', 'für', 'fuer', 'zu', 'zur', 'zum', 'im', 'in', 'an', 'auf', 'aus', 'bei', 'nur', 'wie', 'was', 'wer', 'the', 'and', 'for', 'with', 'from', 'how', 'what', 'who']);

function anfrageWorter(q) {
  return String(q).toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]))
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPPWOERTER.has(t));
}

function quellensinnvoll(results, q, extraWorter) {
  if (!results || results.length < 5) return true;
  // Nur eine Quelle mit vielen Treffern kann man als „fremd" verwerfen —
  // sonst erwischt es schon einen einzelnen Wikipedia-Artikel, weil die
  // Frage eine Abkürzung war („rpi 5 kaufen" → Artikel heißt „Raspberry Pi").
  const worter = extraWorter && extraWorter.size ? [...extraWorter] : anfrageWorter(q);
  if (!worter.length) return true;
  const probe = results.slice(0, 10);
  let passend = 0;
  for (const r of probe) {
    const text = (String(r.title || '') + ' ' + String(r.snippet || '') + ' ' + String(r.url || '')).toLowerCase()
      .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]));
    if (worter.some((t) => text.includes(t))) passend++;
  }
  return passend > 0;
}

// ── Anfragen zusammenführen ─────────────────────────────────────────────
function mergeInto(byUrl, results, source) {
  for (const r of results) {
    const url = httpUrl(r.url);
    if (!url) continue;
    // Qualitätsboden: eine Zeile, die nur die Domain zeigt, bringt niemandem
    // etwas — die Quelle hat nichts Lesbares geliefert.
    const titel = clean(r.title || '', 200);
    if (!titel || titel.toLowerCase() === domainOf(url)) continue;
    const prev = byUrl.get(url);
    if (prev) {
      prev.families.add(source.family);
      prev.sources.push(source.id);
      prev.bestWeight = Math.max(prev.bestWeight, source.weight);
      prev.engines = Math.max(prev.engines, r.engines || 1) + 1;
      if (!prev.snippet && r.snippet) prev.snippet = r.snippet;
      if (r.quelle && !prev.quelle) prev.quelle = r.quelle;
      if ((!prev.title || prev.title === domainOf(prev.url)) && r.title) prev.title = r.title;
    } else {
      byUrl.set(url, {
        title: clean(r.title, 200),
        url,
        snippet: clean(r.snippet || '', 400),
        quelle: clean(r.quelle || '', 60),
        families: new Set([source.family]),
        sources: [source.id],
        bestWeight: source.weight,
        engines: r.engines || 1,
      });
    }
  }
}

// ── Cache + laufende Anfragen ───────────────────────────────────────────
const cache = new Map(); // key -> { at, payload }
const inflight = new Map(); // key -> { promise, listeners:Set, payload }

function cachePut(key, payload) {
  cache.set(key, { at: Date.now(), payload });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

// Bildercache für ausgefallene/übel gelaunte Quellen: kurz schlafen legen,
// damit ein 429 nicht jede Suche ausbremst.
const penalty = new Map(); // sourceId -> bis-Zeitstempel
function inPenalty(source) {
  const until = penalty.get(source.id) || 0;
  return Date.now() < until;
}
function noteFailure(source, message) {
  const secs = /429|Zeit überschritten|timeout/i.test(String(message)) ? 90 : 30;
  penalty.set(source.id, Date.now() + secs * 1000);
}

function runSources(q, onSource, deadlineMs, ctx) {
  const started = Date.now();
  const origQ = (ctx && ctx.orig) || q;
  const usable = SOURCES.filter((s) => (!s.only || s.only(origQ)) && !inPenalty(s));
  const jobs = usable.map(async (source) => {
    try {
      const p = Promise.resolve(source.run(source.origQuery ? origQ : q));
      const withTimeout = Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Zeit überschritten')), source.timeout || deadlineMs)),
      ]);
      const data = await withTimeout;
      const results = Array.isArray(data) ? data : data.results || [];
      const meta = Array.isArray(data) ? {} : data;
      if (results.length && !quellensinnvoll(results, origQ, ctx && ctx.worter)) {
        noteFailure(source, 'unpassende Ergebnisse');
        onSource(source, [], {}, Date.now() - started, 'Resultate standen in keiner Beziehung zur Frage (verworfen)');
        return { id: source.id, ok: false, error: 'unpassende Ergebnisse', verworfen: true };
      }
      penalty.delete(source.id);
      onSource(source, results, meta, Date.now() - started);
      return { id: source.id, ok: true, count: results.length, ms: Date.now() - started, ...meta };
    } catch (e) {
      noteFailure(source, e.message);
      onSource(source, [], {}, Date.now() - started, e.message + ' (Quelle pausiert kurz)');
      return { id: source.id, ok: false, error: e.message };
    }
  });
  return { jobs, count: usable.length };
}

// Eine Websuche, mehrere Rückmeldungen.
// emit(payload) wird mindestens einmal aufgerufen: zuerst so schnell wie
// möglich, am Ende mit dem vollständigen Stand.
async function searchWeb(q, emit) {
  const query = String(q || '').trim();
  if (!query) return { results: [], widget: null, infobox: null, answers: [], done: true };
  const key = 'w:' + query.toLowerCase();
  const listeners = emit ? new Set([emit]) : new Set();

  const existing = inflight.get(key);
  if (existing) {
    if (emit) existing.listeners.add(emit);
    if (existing.payload) return existing.payload;
    return new Promise((resolve) => {
      existing.doneHandlers.push(resolve);
      setTimeout(() => resolve(existing.payload || { results: [], done: true }), FIRST_PAINT_MS + 4000);
    });
  }

  // Frischer Cache → sofort fertig. Veralteter Cache → erst mal daraus
  // antworten und im Hintergrund auffrischen.
  const hit = cache.get(key);
  const fresh = hit && Date.now() - hit.at < CACHE_TTL;
  if (fresh) {
    const payload = { ...hit.payload, fromCache: true, done: true };
    if (emit) emit(payload);
    return payload;
  }

  const state = { listeners, doneHandlers: [], payload: null, order: null, doneGeordnet: false };
  inflight.set(key, state);

  // Baustein 0: Anfrage verstehen — die Engines bekommen die erweiterte
  // Frage, Oberfläche und Cache bleiben bei der Originalfrage.
  const ex = expandiere(query);

  const byUrl = new Map();
  const infoboxHolder = { value: hit ? hit.payload.infobox : null };
  const answersHolder = { value: hit ? hit.payload.answers : [] };
  const widgetHolder = { value: null };
  const sourceTimes = {};
  let lastEmit = 0;
  let firstDone = false;

  // Ordnung (Weg A, 27.09.): die Rangfolge wird nur dreimal berechnet —
  // Erstanzeige, alle Quellen da, finale Rangfolge nach dem Lesen. Dazwischen
  // kommen neue Treffer nur ans Ende, Auszüge erscheinen an Ort und Stelle.
  // Hysterese: das Top-1 rutscht nur bei klarem Vorsprung (kein Wackeln).
  function neuOrdnen(alle) {
    const neu = rerank(alle, query, ex.worter);
    const alt = state.order;
    if (!alt || !alt.length || !neu.length) return neu;
    const byU = new Map(neu.map((r) => [r.url, r]));
    const altTop = byU.get(alt[0]);
    if (altTop && neu[0] && neu[0].url !== altTop.url) {
      const schlag = (neu[0].score || 0) - (altTop.score || 0);
      if (schlag < 40) return [altTop, ...neu.filter((r) => r.url !== altTop.url)];
    }
    return neu;
  }

  const snapshot = (done) => {
    const alle = [...byUrl.values()];
    let results;
    if (!state.order || (done && !state.doneGeordnet)) {
      results = neuOrdnen(alle);
      state.order = results.map((r) => r.url);
      if (done) state.doneGeordnet = true;
    } else {
      const byU = new Map(alle.map((r) => [r.url, r]));
      const bekannt = new Set(state.order);
      results = state.order.map((u) => byU.get(u)).filter(Boolean);
      for (const r of alle) if (!bekannt.has(r.url)) results.push(r);
    }
    const payload = {
      results,
      direkt: direktBei(query),
      reading: Boolean(state.reading),
      widget: widgetHolder.value,
      infobox: infoboxHolder.value,
      answers: answersHolder.value,
      sources: sourceTimes,
      done,
    };
    state.payload = payload;
    for (const l of listeners) { try { l(payload); } catch { /* Seite weg */ } }
    if (done) {
      for (const h of state.doneHandlers) { try { h(payload); } catch { /* egal */ } }
      state.doneHandlers = [];
    }
    return payload;
  };

  const onSource = (source, results, meta, ms, err) => {
    sourceTimes[source.id] = err ? 'Fehler: ' + err : ms + 'ms/' + results.length;
    if (results.length) mergeInto(byUrl, results, source);
    if (meta && meta.infobox && !infoboxHolder.value) infoboxHolder.value = meta.infobox;
    if (meta && meta.answers && meta.answers.length) answersHolder.value = meta.answers;
    // Leere Zwischenmeldungen bringen der Oberfläche nichts: die erste kommt,
    // sobald der erste Treffer da ist, danach höchstens alle 150 ms.
    if (!byUrl.size) return;
    const now = Date.now();
    if (!firstDone || now - lastEmit > 150) {
      firstDone = true;
      lastEmit = now;
      snapshot(false);
    }
  };

  const { jobs } = runSources(ex.q, onSource, FIRST_PAINT_MS, { orig: query, worter: ex.worter });

  // A4: Auszüge nicht erst nach allen Quellen lesen — der Frühstart nimmt
  // sich 1,2 s nach Beginn die dann besten drei Kandidaten. Die Spätrunde
  // liest nur, was das Rerank neu nach oben bringt (deepDone/deepRunning
  // schützen vor Doppelabrufen).
  setTimeout(() => {
    if (!byUrl.size || state.deepStarted) return;
    state.deepStarted = true;
    const frueh = rerank([...byUrl.values()], query, ex.worter);
    tieflesen(byUrl, frueh, ex.gewichte, query, snapshot, key, state).catch(() => {});
  }, 1200);

  // Wetter läuft mit, bremst aber die Treffer nicht aus.
  const weatherJob = weatherWidget(query).then((w) => {
    if (!w) return;
    widgetHolder.value = w;
    lastEmit = Date.now();
    snapshot(false);
  }).catch(() => null);

  const finish = async () => {
    const deadline = new Promise((r) => setTimeout(r, FIRST_PAINT_MS));
    await Promise.race([Promise.allSettled([...jobs, weatherJob]), deadline]);
    const payload = snapshot(true);
    cachePut(key, payload);
    inflight.delete(key);
    // Späte Quellen sollen nicht verloren gehen: nachliefern und Cache
    // aktualisieren, ohne dass die Oberfläche warten musste.
    Promise.allSettled([...jobs, weatherJob]).then(() => {
      const late = snapshot(true);
      cachePut(key, late);
      // Baustein C: danach die besten Kandidaten wirklich lesen, Auszüge
      // setzen und die Liste neu ordnen — progressiv, ohne die UI warten zu lassen.
      tieflesen(byUrl, late.results, ex.gewichte, query, snapshot, key, state).catch(() => {});
    });
    return payload;
  };

  return finish();
}

// ── Instant Answers ─────────────────────────────────────────────────────
// Wetter über Open-Meteo (kein Konto, kein Tracking der Anfrage).
async function weatherWidget(q) {
  const m = /^(?:wetter|weather)\s*(?:in\s+|für\s+|fuer\s+)?(.+)$/i.exec(String(q).trim());
  if (!m) return null;
  // Ort stufenweise suchen: Zusatzwörter („morgen", „heute", „3 Tage") dürfen
  // nicht im Geocoding landen — „freudenstadt morgen" findet sonst nichts und
  // das Widget verschwindet (Nutzerbefund 27.09.).
  const woerter = m[1].trim().split(/\s+/).filter((w) => w);
  const zusaetze = /^(morgen|heute|jetzt|jetzt\b|übermorgen|uber morgen|3|4|5|7|tage|tag|woche|wochen|diese|dieser|dieses|wochenende|bald|jetzt gleich)$/i;
  const kandidaten = [];
  for (let ende = woerter.length; ende >= 1; ende--) {
    const versuch = woerter.slice(0, ende).join(' ');
    const ohneZusatz = versuch.replace(zusaetze, '').trim();
    if (ohneZusatz && ohneZusatz.length >= 3 && !kandidaten.includes(ohneZusatz)) kandidaten.push(ohneZusatz);
    if (versuch !== ohneZusatz && ohneZusatz.length >= 3) kandidaten.push(versuch);
  }
  if (!kandidaten.length) return null;
  let loc = null;
  for (const ort of kandidaten) {
    const geo = await fetchJson(
      'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(ort) + '&count=1&language=de&format=json',
      { timeout: 1400 }
    );
    if (geo.results && geo.results[0]) { loc = geo.results[0]; break; }
  }
  if (!loc) return null;
  const wx = await fetchJson(
    'https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4',
    { timeout: 1400 }
  );
  const WMO = {
    0: ['Klar', '☀️'], 1: ['Überwiegend klar', '🌤️'], 2: ['Teils wolkig', '⛅'],
    3: ['Bedeckt', '☁️'], 45: ['Nebel', '🌫️'], 48: ['Reifnebel', '🌫️'],
    51: ['Leichter Sprühregen', '🌦️'], 53: ['Sprühregen', '🌦️'], 55: ['Dichter Sprühregen', '🌦️'],
    61: ['Leichter Regen', '🌧️'], 63: ['Regen', '🌧️'], 65: ['Starker Regen', '🌧️'],
    71: ['Leichter Schneefall', '🌨️'], 73: ['Schneefall', '🌨️'], 75: ['Starker Schneefall', '❄️'],
    80: ['Regenschauer', '🌦️'], 81: ['Regenschauer', '🌧️'], 82: ['Heftige Schauer', '⛈️'],
    95: ['Gewitter', '⛈️'], 96: ['Gewitter mit Hagel', '⛈️'], 99: ['Schweres Gewitter', '⛈️'],
  };
  const code = (c) => WMO[c] || ['', '🌡️'];
  const cur = wx.current || {};
  const daily = wx.daily || {};
  const days = (daily.time || []).map((t, i) => ({
    date: new Date(t).toLocaleDateString('de-DE', { weekday: 'short' }),
    icon: code(daily.weather_code[i])[1],
    max: Math.round(daily.temperature_2m_max[i]),
    min: Math.round(daily.temperature_2m_min[i]),
  }));
  return {
    type: 'weather',
    place: loc.name + (loc.admin1 && loc.admin1 !== loc.name ? ', ' + loc.admin1 : ''),
    temp: Math.round(cur.temperature_2m),
    feels: Math.round(cur.apparent_temperature),
    desc: code(cur.weather_code)[0],
    icon: code(cur.weather_code)[1],
    wind: Math.round(cur.wind_speed_10m),
    humidity: cur.relative_humidity_2m,
    days,
  };
}

// ── Bildersuche ─────────────────────────────────────────────────────────
// Bing Bilder liefert die Original-URLs im m-Attribut (entity-kodiert).
async function imagesBing(q) {
  const html = await fetchText('https://www.bing.com/images/search?q=' + encodeURIComponent(q) + '&form=HDRSC2&count=35', { timeout: 2200 });
  const out = [];
  const seen = new Set();
  const attr = (name, tag) => {
    const r = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
    return r ? decodeEntities(r[1]) : '';
  };
  for (const m of html.matchAll(/<a\b[^>]*class="[^"]*iusc[^"]*"[^>]*>/gi)) {
    const tag = m[0];
    let meta = null;
    try { meta = JSON.parse(attr('m', tag)); } catch { continue; }
    const full = httpUrl(meta.murl);
    if (!full || seen.has(full)) continue;
    seen.add(full);
    const pageUrl = httpUrl(meta.purl) || httpUrl(attr('href', tag));
    out.push({
      title: clean(meta.t || '', 200),
      url: httpUrl(pageUrl) || '',
      img: httpUrl(meta.turl) || full, // Bing-Vorschau lädt spürbar schneller
      full,
      source: meta.purl ? domainOf(meta.purl) : domainOf(full),
    });
    if (out.length >= 40) break;
  }
  return out;
}

async function imagesSearxng(q) {
  const base = String((getSettings().search || {}).instance || '').trim().replace(/\/+$/, '');
  if (!base) return [];
  const data = await fetchJson(base + '/search?q=' + encodeURIComponent(q) + '&categories=images&format=json&language=de-DE', { timeout: 2200 });
  const out = [];
  for (const r of data.results || []) {
    if (!r || !httpUrl(r.img_src)) continue;
    out.push({
      title: clean(stripTags(r.title || ''), 200),
      url: httpUrl(r.url || ''),
      img: httpUrl(r.thumbnail_src || r.img_src),
      full: r.img_src,
      source: (r.parsed_url && r.parsed_url[1]) || domainOf(r.url || ''),
    });
    if (out.length >= 40) break;
  }
  return out;
}

const IMAGE_SOURCES = [
  { id: 'bing-img', run: imagesBing, timeout: 2200 },
  { id: 'searxng-img', run: imagesSearxng, timeout: 2200, only: () => !!String((getSettings().search || {}).instance || '').trim() },
];

const imageCache = new Map(); // q -> { at, results }

async function searchImages(q, emit) {
  const query = String(q || '').trim();
  if (!query) return [];
  const key = query.toLowerCase();
  const hit = imageCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    if (emit) emit(hit.results, false);
    return hit.results;
  }
  const usable = IMAGE_SOURCES.filter((s) => (!s.only || s.only()) && !inPenalty(s));
  let best = [];
  const jobs = usable.map(async (source) => {
    try {
      const withTimeout = Promise.race([
        source.run(query),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Zeit überschritten')), source.timeout)),
      ]);
      const list = await withTimeout;
      penalty.delete(source.id);
      if (list.length > best.length) {
        best = list;
        if (emit) emit(best, false);
      }
      return { id: source.id, ok: true, count: list.length };
    } catch (e) {
      noteFailure(source, e.message);
      return { id: source.id, ok: false, error: e.message };
    }
  });
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 2600))]);
  imageCache.set(key, { at: Date.now(), results: best });
  if (imageCache.size > 60) {
    const oldest = [...imageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) imageCache.delete(oldest[0]);
  }
  if (emit) emit(best, true);
  return best;
}

function cacheStats() {
  return { cache: cache.size, images: imageCache.size, inflight: inflight.size };
}

function clearCaches() {
  cache.clear();
  imageCache.clear();
}

module.exports = {
  configure,
  searchWeb,
  searchImages,
  rerank,
  domainOf,
  weatherWidget,
  warmConnections,
  cacheStats,
  clearCaches,
  willNachrichten,
  quellensinnvoll,
  anfrageWorter,
  expandiere,
  setSearxngLoader,
  setPageLoader,
  htmlToText,
  excerptUndScore,
  direktBei,
  SITES,
  parseSearxngHtml,
  SEARXNG_INSTANZEN,
  parseBingHtml,
  bingCkAufloesen,
  parseBraveHtml,
  SOURCES,
};
