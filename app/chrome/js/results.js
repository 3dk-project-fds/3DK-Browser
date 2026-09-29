// 3DK Browser — Ergebnisliste.
// Die Liste baut sich progressiv: der Hauptprozess meldet, sobald die erste
// Quelle geantwortet hat, und schiebt nach, wenn weitere Quellen dazukommen.
// Alle Texte werden als Knoten gesetzt (kein innerHTML mit Fremdtext).
const q = decodeURIComponent(location.hash.slice(1));
const list = document.getElementById('list');
const loading = document.getElementById('loading');
const metaLine = document.getElementById('meta');
const catWeb = document.getElementById('cat-web');
const catImg = document.getElementById('cat-img');
const menu = document.getElementById('ctxmenu');
let letztesTop = null; // für den dezenten Hinweis, wenn ein Treffer aufstieg

let mode = 'web';
let lastSignature = '';
let lastImages = null;
let finished = false;

metaLine.textContent = 'Ergebnisse für „' + q + '“';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ── Trefferliste ────────────────────────────────────────────────────────
function render(payload) {
  const results = payload.results || [];
  // Auszüge (Baustein C) treffen nach dem fertigen Bild ein — die Signatur
  // muss sie kennen, sonst wird das Nachreichen verschluckt.
  const signature = results.map((r) => r.url + (r.excerpt ? '*' : '') + (r.deepFail ? '!' : '')).join('|') + '#' + (payload.done ? 'd' : 'l') +
    '#' + (payload.widget ? payload.widget.temp : '') + '#' + (payload.infobox ? payload.infobox.title : '') +
    '#' + (payload.direkt || []).map((d) => d.domain).join(',');
  if (signature === lastSignature) return;
  lastSignature = signature;
  if (payload.done) finished = true;

  const scroll = window.scrollY;
  const frag = document.createDocumentFragment();

  for (const a of payload.answers || []) frag.appendChild(el('div', 'answers', a));
  if (payload.infobox) frag.appendChild(infoboxNode(payload.infobox));
  if (payload.widget) frag.appendChild(weatherNode(payload.widget));
  if (payload.direkt && payload.direkt.length) frag.appendChild(direktBeiNode(payload.direkt));
  if (payload.reading) frag.appendChild(el('div', 'reading-bar'));

  if (!results.length && payload.done) {
    const empty = el('div', 'empty');
    empty.append('Keine Ergebnisse für ');
    const b = el('b', null, '„' + q + '“');
    empty.append(b);
    empty.append(' gefunden.');
    frag.appendChild(empty);
  }

  let badgeShown = false;
  for (const r of results) {
    frag.appendChild(resultNode(r, !badgeShown && r.official));
    if (!badgeShown && r.official) badgeShown = true;
  }

  list.textContent = '';
  list.className = '';
  list.appendChild(frag);
  // Wenn beim Neuordnen ein Treffer nach oben sprang: kurz dezent markieren.
  const erstes = list.firstElementChild;
  if (erstes && letztesTop && results[0] && results[0].url !== letztesTop) {
    erstes.classList.add('aufgestiegen');
  }
  if (results[0]) letztesTop = results[0].url;
  window.scrollTo(0, scroll);

  const src = payload.sources
    ? Object.values(payload.sources).filter((wert) => !/^Fehler/.test(String(wert))).length
    : 0;
  if (payload.done && src < 2 && results.length < 6) {
    const hinweis = el('div', 'empty');
    hinweis.append('Zurzeit hat nur eine Quelle geantwortet — ');
    hinweis.appendChild(el('b', null, 'Erneut versuchen'));
    hinweis.append(' oder in einer Minute nochmal suchen.');
    list.appendChild(hinweis);
  }
  // Während des Ladens steht hier bewusst NICHTS (Entscheidung 25.09.):
  // kein „Treffer treffen ein …“ — nur der dünne Fortschrittsstrich läuft.
  // Sichtbar wird das Element ausschließlich für echte Fehlermeldungen.
  if (loading) {
    const fehlerText = payload.done && !results.length ? 'Keine Quelle hat geantwortet — erneut versuchen.' : '';
    loading.style.display = fehlerText ? 'block' : 'none';
    loading.textContent = fehlerText;
  }
  if (payload.fromCache && payload.done) {
    metaLine.textContent = 'Ergebnisse für „' + q + '“ · aus dem Zwischenspeicher';
  } else if (payload.done) {
    metaLine.textContent = 'Ergebnisse für „' + q + '“ · ' + results.length + ' Treffer aus ' + src + (src === 1 ? ' Quelle' : ' Quellen');
  }
}

function resultNode(r, showBadge) {
  const item = el('div', 'result-item');
  const urlText = el('span', 'result-url-text');
  let host = r.url;
  try { host = new URL(r.url).hostname; } catch { /* bleibt rohe Eingabe */ }
  // Bei Artikeltreffern steht die Quelle über dem Link, nicht die
  // Weiterleitungsadresse des Nachrichten-Dienstes.
  urlText.textContent = r.quelle || host;
  urlText.title = host;
  const title = el('a', 'result-title', r.title || r.url);
  title.href = '#';
  title.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openInTab(r.url);
  });
  item.appendChild(urlText);
  item.appendChild(title);
  if (showBadge) item.appendChild(el('span', 'badge-official', 'Offizielle Seite'));
  // Baustein C: eigener Auszug aus der geladenen Seite schlägt den geliehenen
  // Snippet der Suchmaschine (Google-Stil, mit Herkunftskennzeichnung).
  item.appendChild(el('div', 'result-snippet', r.excerpt || r.snippet || ''));
  if (r.excerpt) item.appendChild(el('div', 'result-excerpt-label', '(Auszug aus der Seite)'));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, linkMenu(r.url));
  });
  return item;
}

function direktBeiNode(direkt) {
  const wrap = el('div', 'direkt-block');
  wrap.appendChild(el('div', 'direkt-titel', 'Direkt bei'));
  const tiles = el('div', 'direkt-tiles');
  for (const d of direkt) {
    const tile = el('div', 'direkt-tile');
    tile.appendChild(el('div', 'direkt-name', d.name));
    tile.appendChild(el('div', 'direkt-domain', d.domain));
    tile.title = 'Öffnet die Suche von ' + d.domain + ' mit deiner Anfrage';
    tile.addEventListener('click', () => window.api.openInTab(d.url));
    tiles.appendChild(tile);
  }
  wrap.appendChild(tiles);
  return wrap;
}

function infoboxNode(info) {
  const ib = el('div', 'widget-info');
  if (info.img) {
    const img = document.createElement('img');
    img.src = info.img;
    img.alt = info.title || '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    ib.appendChild(img);
  }
  const body = el('div');
  body.style.flex = '1';
  body.style.minWidth = '0';
  body.appendChild(el('div', 'ib-title', info.title || ''));
  body.appendChild(el('div', 'ib-text', info.text || ''));
  if (info.url) {
    const link = el('div', 'ib-link', 'Mehr auf der Quellseite →');
    link.addEventListener('click', () => window.api.openInTab(info.url));
    body.appendChild(link);
  }
  ib.appendChild(body);
  return ib;
}

function weatherNode(w) {
  const card = el('div', 'widget-weather');
  const now = el('div', 'now');
  now.appendChild(el('div', 'wicon', w.icon));
  const middle = el('div');
  middle.appendChild(el('div', 'wplace', 'Wetter in ' + w.place));
  const temp = el('div', 'wtemp');
  temp.append(String(w.temp));
  const sup = el('sup');
  sup.textContent = '°C';
  temp.appendChild(sup);
  middle.appendChild(temp);
  now.appendChild(middle);
  const metaBox = el('div', 'wmeta');
  metaBox.appendChild(el('div', null, w.desc));
  metaBox.appendChild(el('div', null, 'Gefühlt ' + w.feels + '°C · Wind ' + w.wind + ' km/h · ' + w.humidity + ' % Luftfeuchte'));
  now.appendChild(metaBox);
  card.appendChild(now);

  if (w.days && w.days.length) {
    const days = el('div', 'wdays');
    for (const d of w.days) {
      const cell = el('div', 'wday');
      cell.appendChild(el('div', null, d.date));
      cell.appendChild(el('div', 'di', d.icon));
      const t = el('div');
      t.appendChild(el('span', 'tmax', d.max + '°'));
      t.append(' ' + d.min + '°');
      cell.appendChild(t);
      days.appendChild(cell);
    }
    card.appendChild(days);
  }
  return card;
}

// ── Bilder ──────────────────────────────────────────────────────────────
function renderImages(results, done) {
  lastImages = results;
  loading.style.display = !done && !results.length ? 'block' : 'none';
  loading.textContent = 'Bildersuche läuft …';
  if (done && !results.length) {
    loading.style.display = 'block';
    loading.textContent = 'Keine Bilder gefunden.';
  }
  const frag = document.createDocumentFragment();
  if (!results.length && done) {
    const empty = el('div', 'empty');
    empty.append('Keine Bilder für ');
    empty.appendChild(el('b', null, '„' + q + '“'));
    empty.append(' gefunden.');
    frag.appendChild(empty);
  }
  for (const r of results) {
    const cell = el('div', 'img-cell');
    cell.title = r.title || r.source || '';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.className = 'loading';
    img.src = r.img;
    img.alt = r.title || '';
    img.addEventListener('load', () => img.classList.remove('loading'));
    img.addEventListener('error', () => img.classList.remove('loading'));
    cell.appendChild(img);
    cell.appendChild(el('div', 'cap', r.source || ''));
    cell.addEventListener('click', () => window.api.openInTab(r.url || r.full));
    cell.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, imageMenu(r));
    });
    frag.appendChild(cell);
  }
  list.textContent = '';
  list.className = 'img-grid';
  list.appendChild(frag);
}

async function showWeb() {
  mode = 'web';
  catWeb.classList.add('active');
  catImg.classList.remove('active');
  list.textContent = '';
  lastSignature = '';
  loading.style.display = 'block';
  loading.textContent = 'Suche läuft …';
  try {
    const payload = await window.api.search(q);
    render(payload);
  } catch (e) {
    loading.textContent = 'Suche nicht möglich: ' + (e && e.message ? e.message : e);
    loading.style.display = 'block';
  }
}

async function showImages() {
  mode = 'img';
  catImg.classList.add('active');
  catWeb.classList.remove('active');
  list.textContent = '';
  loading.style.display = 'block';
  if (!lastImages) renderImages([], false);
  try {
    const results = await window.api.searchImages(q);
    renderImages(results || [], true);
  } catch (e) {
    renderImages([], true);
  }
}

catWeb.addEventListener('click', showWeb);
catImg.addEventListener('click', showImages);

// Zwischenmeldungen des Hauptprozesses: nur für dieselbe Anfrage, nur im
// passenden Modus.
window.api.onSearchPartial((payload) => {
  if (mode !== 'web') return;
  if (payload && payload.query && payload.query !== q) return;
  render(payload);
});
window.api.onSearchImagesPartial((payload) => {
  if (mode !== 'img') return;
  if (payload && payload.query && payload.query !== q) return;
  renderImages(payload.results || [], payload.done);
});

// ── Rechtsklick-Menü ────────────────────────────────────────────────────
function hideMenu() { menu.classList.remove('open'); }
document.addEventListener('click', hideMenu);
document.addEventListener('scroll', hideMenu, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

function showMenu(x, y, items) {
  menu.textContent = '';
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', 'sep')); continue; }
    const b = el('button', null, it.label);
    b.addEventListener('click', async () => {
      hideMenu();
      try { await it.action(); } catch { /*egal*/ }
      if (it.toast) toast(it.toast);
    });
    menu.appendChild(b);
  }
  menu.classList.add('open');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

let toastTimer = null;
function toast(text) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div');
    t.id = 'toast';
    t.style.cssText =
      'position:fixed;bottom:26px;left:50%;transform:translateX(-50%);background:var(--bg-card);' +
      'border:1px solid var(--border);color:var(--accent);font-size:13px;padding:9px 18px;' +
      'border-radius:9px;z-index:60;box-shadow:0 10px 30px rgba(0,0,0,.4)';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 1600);
}

function linkMenu(url) {
  return [
    { label: 'In neuem Tab öffnen', action: () => window.api.openInNewTab(url) },
    { label: 'In neuem Fenster öffnen', action: () => window.api.openInNewWindow(url) },
    { label: 'Link kopieren', action: () => window.api.copyText(url), toast: 'Link kopiert' },
    { sep: true },
    { label: 'Seite drucken', action: () => window.api.printUrl(url) },
  ];
}

function imageMenu(r) {
  const full = r.full || r.img;
  return [
    { label: 'Bild in neuem Tab öffnen', action: () => window.api.openInNewTab(full) },
    { label: 'Bild-URL kopieren', action: () => window.api.copyText(full), toast: 'Bild-URL kopiert' },
    { sep: true },
    { label: 'Seite öffnen', action: () => window.api.openInNewTab(r.url || full) },
    { label: 'Seite in neuem Fenster öffnen', action: () => window.api.openInNewWindow(r.url || full) },
  ];
}

showWeb();
