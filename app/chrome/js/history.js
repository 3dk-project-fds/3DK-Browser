// 3DK Browser — Verlaufsseite.
// Ein gebündelter Favicon-Aufruf statt einer Anfrage pro Kachel; die Bilder
// liegen im Profil auf der Platte und kommen beim zweiten Blick ohne Netz.
function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Heute';
  if (d.toDateString() === yest.toDateString()) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

(async () => {
  const list = document.getElementById('list');
  let items = [];
  try {
    items = (await window.api.listHistory()) || [];
  } catch {
    list.textContent = '';
    list.appendChild(el('div', 'empty', 'Kein Zugriff auf den Verlauf.'));
    return;
  }
  list.textContent = '';
  if (!items.length) {
    const empty = el('div', 'empty');
    empty.append('Noch keine ');
    empty.appendChild(el('b', null, 'Verlaufseinträge'));
    empty.append('.');
    list.appendChild(empty);
    return;
  }

  const hosts = [...new Set(items.map((it) => hostOf(it.url)))];
  const favicons = await window.api.faviconsGet(hosts).catch(() => ({}));

  const used = new Set();
  let grid = null;
  let lastDay = '';
  for (const it of items) {
    const day = fmtDay(it.at);
    if (day !== lastDay) {
      lastDay = day;
      list.appendChild(el('div', 'day', day));
      grid = document.createElement('div');
      grid.className = 'grid';
      list.appendChild(grid);
    }
    const host = hostOf(it.url);
    const key = day + '|' + host;
    if (used.has(key)) continue; // pro Seite nur die letzte Kachel
    used.add(key);

    const tile = el('div', 'tile');
    tile.title = (it.title || '') + '\n' + it.url;
    const ico = el('div', 'ico', (host[0] || '?').toUpperCase());
    const icon = favicons && favicons[host];
    if (icon) {
      const img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      ico.textContent = '';
      ico.appendChild(img);
    }
    tile.appendChild(ico);
    tile.appendChild(el('div', 'name', (it.title || host).replace(/\s+[–|-]\s+.*$/, '')));
    tile.appendChild(el('div', 'host', host));
    tile.appendChild(el('div', 'time', new Date(it.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })));
    tile.addEventListener('click', () => window.api.openInTab(it.url));
    grid.appendChild(tile);
  }
})();
