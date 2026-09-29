// 3DK Browser — Chrome-Leiste: Tabs, Adressleiste, Sicherheitsanzeige.
let tabs = [];
let typedValue = false; // eigene Eingaben nicht überschreiben

const strip = document.getElementById('tabs');
const box = document.getElementById('url');
// Die frühere Verbindungs-Raute ist weg (Spracheingabe mit 0.4.6 wieder
// entfernt). Verbindungsstatus zeigt die Adresszeile weiterhin über
// http/https in der URL selbst.

function render() {
  strip.textContent = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.active ? ' active' : '');
    let label;
    if (t.url === 'start') label = 'Startseite';
    else if (String(t.url).startsWith('search:')) label = 'Suche: ' + String(t.url).slice(7);
    else label = t.title || t.url;
    const span = document.createElement('span');
    span.className = 'label';
    span.textContent = label;
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '✕';
    close.title = 'Tab schließen';
    el.appendChild(span);
    el.appendChild(close);
    el.addEventListener('click', (e) => {
      if (e.target === close) return;
      window.api.activateTab(t.id);
    });
    close.addEventListener('click', () => window.api.closeTab(t.id));
    strip.appendChild(el);
  }

  const plus = document.createElement('button');
  plus.id = 'newtab';
  plus.title = 'Neuer Tab (Strg+T)';
  plus.textContent = '+';
  plus.addEventListener('click', () => window.api.newTab());
  strip.appendChild(plus);

  const active = tabs.find((t) => t.active);

  if (document.activeElement !== box) {
    const internalPage = !active || ['start', 'settings', 'history', ''].includes(active.url) || String(active.url).startsWith('search:');
    box.value = internalPage ? '' : active.url;
    typedValue = false;
  }
}

window.api.onTabs((list) => { tabs = list || []; render(); favZeichnen(); });
// Die Liste kann schon vor dem Laden der Leiste entstanden sein — also einmal
// abholen und dabei das Array füllen (früher: ins Leere gelaufen).
window.api.listTabs().then((list) => { tabs = list || []; render(); }).catch(() => {});

function go() {
  const v = box.value.trim();
  if (!v) return;
  window.api.navigate(v);
}

// Tempo: beim Tippen die Suche vorab starten, damit Enter fast steht.
// 350 ms Pause statt 220 ms — Tippwellen werden gebündelt, Doppelanfragen
// ohnehin im Hauptprozess zusammengelegt.
let prefetchTimer = null;
let lastPrefetch = '';
box.addEventListener('input', () => {
  typedValue = true;
  const v = box.value.trim();
  if (v.length < 3 || /^https?:\/\//i.test(v) || (v.includes('.') && !v.includes(' '))) return;
  clearTimeout(prefetchTimer);
  if (v === lastPrefetch) return;
  prefetchTimer = setTimeout(() => {
    lastPrefetch = v;
    window.api.prefetch(v).catch(() => {});
  }, 350);
});
box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go();
  if (e.key === 'Escape') { typedValue = false; render(); }
});
box.addEventListener('focus', () => box.select());

document.getElementById('back').addEventListener('click', () => window.api.back());
document.getElementById('fwd').addEventListener('click', () => window.api.forward());
document.getElementById('reload').addEventListener('click', () => window.api.reload());
document.getElementById('home').addEventListener('click', () => window.api.home());
document.getElementById('gear').addEventListener('click', () => window.api.openSettings());

// ── Favoriten: Stern im Adressfeld + Dropdown darunter ─────────────────
const star = document.getElementById('star');
const favdrop = document.getElementById('favdrop');
let favListe = [];
let favOffen = false;

function favZeichnen() {
  if (!star) return;
  const aktiv = tabs.find((t) => t.active);
  const url = (aktiv && aktiv.url) || '';
  const drin = favListe.some((f) => f.url === url);
  star.classList.toggle('gespeichert', drin);
  star.title = drin ? 'Aus Favoriten entfernen' : 'Als Favorit speichern';
}

function dropZeichnen() {
  favdrop.textContent = '';
  if (!favListe.length) {
    const leer = document.createElement('div');
    leer.className = 'leer';
    leer.textContent = 'Noch keine Favoriten — klicke den Stern im Adressfeld.';
    favdrop.appendChild(leer);
  } else {
    for (const f of [...favListe].sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
      const z = document.createElement('div');
      z.className = 'zeile';
      const n = document.createElement('span');
      n.className = 'name';
      n.textContent = f.name;
      const dm = document.createElement('span');
      dm.className = 'dom';
      try { dm.textContent = new URL(f.url).hostname; } catch { dm.textContent = ''; }
      z.append(n, dm);
      z.addEventListener('click', () => { dropZu(); window.api.navigate(f.url); });
      favdrop.appendChild(z);
    }
  }
  const fuss = document.createElement('div');
  fuss.className = 'fuss';
  fuss.textContent = 'Alle verwalten';
  fuss.addEventListener('click', () => { dropZu(); window.api.openFavorites(); });
  favdrop.appendChild(fuss);
}

function dropAuf() {
  if (favOffen) return;
  favOffen = true;
  dropZeichnen();
  favdrop.hidden = false;
  // Zusatzhöhe anfordern, damit das Dropdown nicht an der 92-px-Leiste
  // abgeschnitten wird; der freie Bereich bleibt transparent.
  try { window.api.chromeExtra(360); } catch { /* egal */ }
}
function dropZu() {
  favOffen = false;
  favdrop.hidden = true;
  try { window.api.chromeExtra(0); } catch { /* egal */ }
}

if (star) {
  star.addEventListener('click', async () => {
    const aktiv = tabs.find((t) => t.active);
    const url = (aktiv && aktiv.url) || '';
    if (!/^https?:\/\//i.test(url)) return; // eigene Seiten werden nicht gespeichert
    if (favListe.some((f) => f.url === url)) await window.api.removeFavorite(url);
    else await window.api.addFavorite({ url, name: (aktiv && aktiv.title) || url });
  });
  // Dropdown: nach kurzem Verweilen auf dem Stern aufklappen, ohne den Klick
  // (Speichern/Entfernen) zu stören.
  let hoverTimer = null;
  star.addEventListener('mouseenter', () => { hoverTimer = setTimeout(dropAuf, 350); });
  star.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    setTimeout(() => { if (!favdrop.matches(':hover')) dropZu(); }, 220);
  });
  favdrop.addEventListener('mouseleave', () => {
    setTimeout(() => { if (!star.matches(':hover') && !favdrop.matches(':hover')) dropZu(); }, 220);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'd') {
      e.preventDefault();
      star.click();
    }
    if (e.key === 'Escape') dropZu();
  });
  window.api.onFavorites((list) => {
    favListe = list || [];
    favZeichnen();
    if (favOffen) dropZeichnen();
  });
  window.api.listFavorites().then((l) => { favListe = l || []; favZeichnen(); }).catch(() => {});
  // Testhaken für die Bildschirmfotos der Prüfrunde.
  window.__fav = { dropAuf, dropZu };
}

window.api.onFocusUrlBar(() => { box.focus(); box.select(); });

// Hinweis in der Leiste, solange der Assistenten-Dienst läuft.
const badge = document.getElementById('agent-badge');
const zahl = document.getElementById('agent-count');
function zeigeAgent(st) {
  if (!badge) return;
  const an = st && st.running;
  badge.classList.toggle('sichtbar', Boolean(an));
  if (an) {
    badge.title = 'Assistenten-Anbindung aktiv auf Port ' + st.port + ' — heute ' + st.aufrufeHeute + ' Aufrufe';
    if (zahl) zahl.textContent = String(st.aufrufeHeute || 0);
  }
}
if (window.api.onAgentState) window.api.onAgentState(zeigeAgent);
if (window.api.agentStatus) window.api.agentStatus().then(zeigeAgent).catch(() => {});
