// 3DK Browser — Verlauf und Downloads.
// Ausschließlich lokal, verschrieben durch store.js (verschlüsselt).
// Kappen: 2000 Besuche, 500 Downloads. Einträge werden beim Lesen geprüft,
// damit eine manipulierte Datei keine üblen Titel/URLs in die Oberfläche bringt.

const store = require('./store');

const MAX_HISTORY = 2000;
const MAX_DOWNLOADS = 500;
const MAX_TEXT = 400;

let history = [];
let downloads = [];
let ready = false;

function cleanText(s, max = MAX_TEXT) {
  return String(s == null ? '' : s).slice(0, max).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

// Nur annehmbare Einträge durchlassen — alles andere war Malware oder Unfug.
function sanitizeHistory(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list.slice(0, MAX_HISTORY)) {
    if (!it || typeof it !== 'object') continue;
    let url;
    try {
      url = new URL(String(it.url));
    } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    out.push({
      url: url.href.slice(0, 2000),
      title: cleanText(it.title, 200),
      at: Number.isFinite(it.at) ? it.at : Date.now(),
    });
  }
  return out;
}

function sanitizeDownloads(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list.slice(0, MAX_DOWNLOADS)) {
    if (!it || typeof it !== 'object') continue;
    out.push({
      url: cleanText(it.url, 2000),
      filename: cleanText(it.filename, 200),
      path: cleanText(it.path, 2000),
      state: cleanText(it.state, 20),
      size: Number.isFinite(it.size) ? it.size : 0,
      at: Number.isFinite(it.at) ? it.at : Date.now(),
    });
  }
  return out;
}

function initFiles() {
  store.init();
  history = sanitizeHistory(store.read('verlauf', []));
  downloads = sanitizeDownloads(store.read('downloads', []));
  ready = true;
}

function addVisit(url, title) {
  if (!ready) return;
  if (!url || url.startsWith('file:') || url.startsWith('devtools:') || url.startsWith('about:')) return;
  const cleanUrl = String(url).slice(0, 2000);
  const last = history[0];
  if (last && last.url === cleanUrl) {
    last.at = Date.now();
    if (title) last.title = cleanText(title, 200);
  } else {
    history.unshift({ url: cleanUrl, title: cleanText(title || cleanUrl, 200), at: Date.now() });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  }
  store.write('verlauf', history);
}

function addDownload(entry) {
  if (!ready) return;
  downloads.unshift({ ...entry, at: Date.now() });
  if (downloads.length > MAX_DOWNLOADS) downloads.length = MAX_DOWNLOADS;
  store.write('downloads', downloads);
}

// Aus dem Cloud-Backup übernehmen (Wolke liefert fremde Daten → erst prüfen).
function replaceFromBackup(nextHistory, nextDownloads) {
  if (Array.isArray(nextHistory)) {
    history = sanitizeHistory(nextHistory);
    store.writeNow('verlauf', history);
  }
  if (Array.isArray(nextDownloads)) {
    downloads = sanitizeDownloads(nextDownloads);
    store.writeNow('downloads', downloads);
  }
  return { history: history.length, downloads: downloads.length };
}

function clearHistory() {
  history = [];
  store.writeNow('verlauf', history);
}

function clearDownloads() {
  downloads = [];
  store.writeNow('downloads', downloads);
}

module.exports = {
  initFiles,
  addVisit,
  addDownload,
  listHistory: () => history,
  listDownloads: () => downloads,
  replaceFromBackup,
  clearHistory,
  clearDownloads,
  sanitizeHistory,
  sanitizeDownloads,
};
