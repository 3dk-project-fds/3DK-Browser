// 3DK Browser — Einstellungen: Logik zu den Schaltern.
const $ = (id) => document.getElementById(id);

const PRIVACY_FIELDS = {
  'p-tracker': 'trackerBlock',
  'p-adblock': 'adblock',
  'p-cookies': 'blockThirdPartyCookies',
  'p-referrer': 'referrerTrim',
  'p-dnt': 'signalDoNotTrack',
  'p-ua': 'userAgentShield',
};

function paintTheme(s) {
  const t = (s && s.theme) || 'dark';
  $('theme-dark').classList.toggle('active', t === 'dark');
  $('theme-light').classList.toggle('active', t === 'light');
}

function paintPrivacy(s) {
  const p = (s && s.privacy) || {};
  for (const [id, key] of Object.entries(PRIVACY_FIELDS)) {
    const box = $(id);
    if (box) box.checked = p[key] !== false;
  }
  const inst = $('search-instance');
  if (inst && document.activeElement !== inst) inst.value = (s.search && s.search.instance) || '';
  if ($('search-public-searxng')) $('search-public-searxng').checked = !s.search || s.search.publicSearxng !== false;
  if ($('search-deep-read')) $('search-deep-read').checked = !s.search || s.search.deepRead !== false;
  if ($('search-deep-count')) $('search-deep-count').value = String((s.search && s.search.deepCount) || 3);
  if ($('cloud-insecure')) $('cloud-insecure').checked = Boolean(s.cloud && s.cloud.allowInsecure);
  const a = s.agent || {};
  if ($('agent-tool-search')) $('agent-tool-search').checked = !a.tools || a.tools.search !== false;
  if ($('agent-tool-fetch')) $('agent-tool-fetch').checked = !a.tools || a.tools.fetch !== false;
  if ($('agent-screenshot')) $('agent-screenshot').checked = a.allowScreenshot !== false;
}

function setPrivacy(key, value) {
  return window.api.setSettings({ privacy: { [key]: value } }).then((s) => {
    paintPrivacy(s);
    flash('p-status', value ? 'Aktiviert.' : 'Abgeschaltet.', 'ok');
    return s;
  });
}

for (const [id, key] of Object.entries(PRIVACY_FIELDS)) {
  const box = $(id);
  if (box) box.addEventListener('change', () => setPrivacy(key, box.checked));
}

$('theme-dark').addEventListener('click', () => window.api.setSettings({ theme: 'dark' }));
$('theme-light').addEventListener('click', () => window.api.setSettings({ theme: 'light' }));

function flash(id, text, cls) {
  const node = $(id);
  if (!node) return;
  node.textContent = text;
  node.className = 'status ' + (cls || '');
}

// ── Daten ───────────────────────────────────────────────────────────────
async function refreshCounts() {
  try {
    const h = (await window.api.listHistory()) || [];
    const d = (await window.api.listDownloads()) || [];
    $('hist-count').textContent = h.length + ' besuchte Seiten';
    $('dl-count').textContent = d.length + ' Downloads protokolliert';
    $('s-hist').textContent = h.length + ' Einträge';
  } catch {
    $('hist-count').textContent = 'keine Anzeige möglich';
  }
  try {
    const st = await window.api.profileStatus();
    $('s-enc').textContent = 'AES-256-GCM';
    $('s-key').textContent = st.keyFile || '—';
    $('s-cache').textContent = (st.searchCache && st.searchCache.cache) || 0;
    const b = st.blocked || {};
    $('p-blocked').textContent =
      'In dieser Sitzung blockiert: ' +
      (b.tracker || 0) + ' Tracker-Anfragen, ' +
      (b.permission || 0) + ' Berechtigungsanfragen, ' +
      (b.navigation || 0) + ' Navigationen, ' +
      (b.data || 0) + ' abgelehnte Datenzugriffe von Webseiten.';
  } catch { /* Status ist optional */ }
}

$('hist-clear').addEventListener('click', async () => {
  const r = await window.api.clearHistory();
  flash('data-status', 'Verlauf gelöscht (' + ((r && r.removed) || 0) + ' Einträge). Cookies und Cache bleiben erhalten — dafür „Restlos leeren“.', 'ok');
  refreshCounts();
});

$('dl-clear').addEventListener('click', async () => {
  await window.api.clearDownloads();
  flash('data-status', 'Download-Liste geleert.', 'ok');
  refreshCounts();
});

$('data-clear-all').addEventListener('click', async () => {
  const btn = $('data-clear-all');
  btn.disabled = true;
  flash('data-status', 'Lösche Profil, Webspeicher und Suchspuren …');
  const r = await window.api.clearAllData();
  btn.disabled = false;
  flash('data-status', r && r.ok ? 'Fertig — Profil ist leer, angemeldete Seiten sind abgemeldet.' : ' Teilweise fehlgeschlagen.', r && r.ok ? 'ok' : 'err');
  refreshCounts();
});

$('hist-open').addEventListener('click', () => window.api.openHistory());

// ── Suche ───────────────────────────────────────────────────────────────
$('search-instance-save').addEventListener('click', async () => {
  const value = $('search-instance').value.trim();
  if (value && !/^https?:\/\//i.test(value)) {
    flash('search-status', 'Adresse muss mit http:// oder https:// beginnen.', 'err');
    return;
  }
  const s = await window.api.setSettings({ search: { instance: value } });
  paintPrivacy(s);
  flash('search-status', value ? 'Eigene Instanz eingetragen und aktiv.' : 'Keine eigene Instanz — es wird ohne zusätzlichen Dienst gesucht.', 'ok');
});

$('search-instance-clear').addEventListener('click', async () => {
  const s = await window.api.setSettings({ search: { instance: '' } });
  paintPrivacy(s);
  $('search-instance').value = '';
  flash('search-status', 'Eigene Instanz entfernt.', 'ok');
});

if ($('search-public-searxng')) {
  $('search-public-searxng').addEventListener('change', async (e) => {
    const s = await window.api.setSettings({ search: { publicSearxng: e.target.checked } });
    paintPrivacy(s);
    flash('search-status', e.target.checked
      ? 'Öffentliche Metasuche aktiviert — Anfragen laufen anonym über Gemeinschafts-Instanzen.'
      : 'Öffentliche Metasuche abgeschaltet.', 'ok');
  });
}

if ($('search-deep-read')) {
  $('search-deep-read').addEventListener('change', async (e) => {
    const s = await window.api.setSettings({ search: { deepRead: e.target.checked } });
    paintPrivacy(s);
    flash('search-status', e.target.checked
      ? 'Gründliche Suche aktiv — die besten Treffer werden selbst gelesen.'
      : 'Gründliche Suche aus — es bleiben die Snippets der Quellen.', 'ok');
  });
}

if ($('search-deep-count')) {
  $('search-deep-count').addEventListener('change', async (e) => {
    const s = await window.api.setSettings({ search: { deepCount: Number(e.target.value) } });
    paintPrivacy(s);
    flash('search-status', 'Es werden jetzt ' + e.target.value + ' Seiten je Suche gelesen.', 'ok');
  });
}

// ── Seitenvorschläge „Direkt bei“ ──
async function siteListeMalen() {
  const node = $('site-list');
  if (!node) return;
  const liste = (await window.api.listSites()) || [];
  node.textContent = '';
  if (!liste.length) {
    node.textContent = 'Keine eigenen Seiten eingetragen.';
    return;
  }
  for (const s of liste) {
    const zeile = document.createElement('div');
    zeile.textContent = s.name + ' — ' + (s.domain || s.suche);
    zeile.style.padding = '3px 0';
    node.appendChild(zeile);
  }
}

if ($('site-add')) {
  $('site-add').addEventListener('click', async () => {
    const r = await window.api.addSite({
      name: $('site-name').value,
      suche: $('site-url').value,
      themen: $('site-themen').value,
    });
    flash('site-status', r && r.ok ? 'Seite eingetragen — „Direkt bei“ kennt sie ab sofort.' : ('Fehler: ' + ((r && r.grund) || 'unbekannt')), r && r.ok ? 'ok' : 'err');
    if (r && r.ok) { $('site-name').value = ''; $('site-url').value = ''; $('site-themen').value = ''; siteListeMalen(); }
  });
  $('site-clear').addEventListener('click', async () => {
    await window.api.clearSites();
    flash('site-status', 'Alle eigenen Seiten entfernt.', 'ok');
    siteListeMalen();
  });
  siteListeMalen();
}

// ── Cloud ───────────────────────────────────────────────────────────────
function cloudForm() {
  return {
    url: $('cloud-url').value.trim(),
    user: $('cloud-user').value.trim(),
    pass: $('cloud-pass').value,
    phrase: $('cloud-phrase').value,
  };
}

async function rememberCloudTargets() {
  const { url, user } = cloudForm();
  await window.api.setSettings({ cloud: { url, user } });
}

$('cloud-insecure').addEventListener('change', async (e) => {
  await window.api.setSettings({ cloud: { allowInsecure: e.target.checked } });
  flash('cloud-status', e.target.checked ? 'http ist erlaubt — besser nicht in offenen Netzen.' : 'Nur noch https.', e.target.checked ? 'err' : 'ok');
});

$('cloud-test').addEventListener('click', async () => {
  const c = cloudForm();
  if (!c.url || !c.user || !c.pass) return flash('cloud-status', 'URL, Benutzer und Passwort ausfüllen.', 'err');
  flash('cloud-status', 'Teste Verbindung …');
  const r = await window.api.cloudTest({ url: c.url, user: c.user, pass: c.pass });
  flash('cloud-status', r.ok ? 'Verbindung in Ordnung — ' + r.detail : 'Fehlgeschlagen: ' + r.error, r.ok ? 'ok' : 'err');
});

$('cloud-save').addEventListener('click', async () => {
  const c = cloudForm();
  if (!c.url || !c.user || !c.pass || !c.phrase) return flash('cloud-status', 'Bitte alle vier Felder ausfüllen.', 'err');
  flash('cloud-status', 'Verschlüssele und sichere …');
  await rememberCloudTargets();
  const r = await window.api.cloudSave({ pass: c.pass, phrase: c.phrase });
  flash('cloud-status', r.ok ? 'OK — ' + r.detail : 'Fehlgeschlagen: ' + r.error, r.ok ? 'ok' : 'err');
  $('cloud-pass').value = '';
  $('cloud-phrase').value = '';
});

$('cloud-restore').addEventListener('click', async () => {
  const c = cloudForm();
  if (!c.url || !c.user || !c.pass || !c.phrase) return flash('cloud-status', 'Bitte alle vier Felder ausfüllen.', 'err');
  if (!confirm('Wiederherstellen überschreibt den lokalen Verlauf mit dem Backup. Fortfahren?')) return;
  flash('cloud-status', 'Hole und entschlüssele …');
  await rememberCloudTargets();
  const r = await window.api.cloudRestore({ pass: c.pass, phrase: c.phrase });
  flash('cloud-status', r.ok ? 'OK — ' + r.detail : 'Fehlgeschlagen: ' + r.error, r.ok ? 'ok' : 'err');
  refreshCounts();
});

// ── Start ───────────────────────────────────────────────────────────────
window.api.appVersion().then((v) => { $('app-version').textContent = 'Version ' + v; });
window.api.getSettings().then((s) => { paintTheme(s); paintPrivacy(s); });
window.api.onSettings((s) => { paintTheme(s); paintPrivacy(s); refreshCounts(); });
refreshCounts();
setInterval(refreshCounts, 4000);

// ── Assistenten-Anbindung (MCP) ─────────────────────────────────────────
const agentFeld = $('agent-details');
const schalter = $('agent-enabled');
let agentZustand = null;
let tokenImKlartext = '';

function agentMalen(st) {
  agentZustand = st || agentZustand;
  if (!agentFeld) return;
  const an = Boolean(agentZustand && agentZustand.running);
  agentFeld.style.display = an || (schalter && schalter.checked) ? 'block' : 'none';
  $('agent-status').textContent = an ? 'aktiv' : 'abgeschaltet';
  $('agent-url').textContent = an ? agentZustand.url : '—';
  $('agent-calls').textContent = String((agentZustand && agentZustand.aufrufeHeute) || 0);
  if (tokenImKlartext) $('agent-token').value = tokenImKlartext;
  else $('agent-token').value = (agentZustand && agentZustand.tokenVorhanden) ? '••••••••••••••••••••••••' : 'noch keiner';
  snippetFuellen();
  protokollMalen();
}

function protokollMalen() {
  const feld = $('agent-log').querySelector('tbody');
  feld.textContent = '';
  const liste = (agentZustand && agentZustand.protokoll) || [];
  if (!liste.length) {
    const zeile = document.createElement('tr');
    const zelle = document.createElement('td');
    zelle.colSpan = 4;
    zelle.textContent = 'Noch kein Aufruf.';
    zeile.appendChild(zelle);
    feld.appendChild(zeile);
    return;
  }
  for (const p of liste.slice(0, 12)) {
    const zeile = document.createElement('tr');
    const zeit = document.createElement('td');
    zeit.className = 'z';
    zeit.textContent = new Date(p.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const werk = document.createElement('td');
    werk.textContent = p.werkzeug;
    const ziel = document.createElement('td');
    ziel.textContent = String(p.ziel || '').slice(0, 46);
    const groesse = document.createElement('td');
    groesse.className = p.ok ? 'z' : 'z n';
    groesse.textContent = p.ok ? (Math.round((p.groesse || 0) / 102.4) / 10 + ' KB') : ('abgelehnt: ' + String(p.grund || '').slice(0, 28));
    zeile.append(zeit, werk, ziel, groesse);
    feld.appendChild(zeile);
  }
}

async function snippetFuellen() {
  if (!agentZustand || !agentZustand.running) { $('agent-config').value = 'Erst den Dienst einschalten — dann stehen hier die Verbindungsdaten.'; return; }
  try {
    const cfg = await window.api.agentConfig();
    const snippet = JSON.stringify(cfg.nachweis, null, 2);
    $('agent-config').value = tokenImKlartext
      ? snippet.replace('<SCHLUESSEL>', tokenImKlartext)
      : snippet;
  } catch { /* Knopf funktioniert trotzdem */ }
}

schalter.addEventListener('change', async () => {
  flash('agent-status-text', schalter.checked ? 'Starte Dienst …' : 'Beende Dienst und leere das Agent-Profil …');
  const st = await window.api.agentSetEnabled(schalter.checked);
  agentMalen(st);
  if (schalter.checked && !st.running) {
    flash('agent-status-text', 'Der Dienst konnte nicht starten — ist der Port belegt?', 'err');
    return;
  }
  if (schalter.checked && !tokenImKlartext) {
    const t = await window.api.agentToken();
    if (!t.token) {
      const r = await window.api.agentRotate();
      tokenImKlartext = r.token;
      $('agent-token').value = r.token;
      tokenImKlartext = r.token;
    }
  }
  flash('agent-status-text', st.running ? ('Aktiv auf ' + st.url + ' — nur auf diesem Rechner.') : 'Abgeschaltet.', 'ok');
  snippetFuellen();
});

$('agent-token-show').addEventListener('click', async () => {
  if (tokenImKlartext) { tokenImKlartext = ''; agentMalen(); flash('agent-status-text', 'Schlüssel wieder verdeckt.'); return; }
  const t = await window.api.agentToken();
  if (!t.token) { flash('agent-status-text', 'Noch kein Schlüssel erzeugt — benutze „Neu erzeugen“.', 'err'); return; }
  tokenImKlartext = t.token;
  $('agent-token').value = t.token;
  snippetFuellen();
});

$('agent-token-copy').addEventListener('click', async () => {
  if (!tokenImKlartext) {
    const t = await window.api.agentToken();
    tokenImKlartext = t.token || '';
  }
  if (!tokenImKlartext) return flash('agent-status-text', 'Erst einen Schlüssel erzeugen.', 'err');
  await window.api.copyText(tokenImKlartext);
  flash('agent-status-text', 'Schlüssel in die Zwischenablage gelegt.', 'ok');
});

$('agent-rotate').addEventListener('click', async () => {
  const r = await window.api.agentRotate();
  tokenImKlartext = r.token;
  agentMalen(r);
  flash('agent-status-text', 'Neuer Schlüssel — der alte ist sofort ungültig.', 'ok');
});

$('agent-revoke').addEventListener('click', async () => {
  const st = await window.api.agentRevoke();
  tokenImKlartext = '';
  schalter.checked = false;
  agentMalen(st);
  flash('agent-status-text', 'Dienst beendet, Schlüssel widerrufen, Agent-Profil geleert.', 'ok');
});

for (const [id, pfad] of [['agent-tool-search', ['tools', 'search']], ['agent-tool-fetch', ['tools', 'fetch']]]) {
  $(id).addEventListener('change', async () => {
    const patch = { agent: {} };
    patch.agent[pfad[0]] = { [pfad[1]]: $(id).checked };
    await window.api.setSettings(patch);
    agentMalen(await window.api.agentStatus());
  });
}
$('agent-screenshot').addEventListener('change', async (e) => {
  await window.api.setSettings({ agent: { allowScreenshot: e.target.checked } });
});

window.api.agentStatus().then((st) => {
  agentMalen(st);
  schalter.checked = Boolean(st.running);
});
setInterval(() => { if (schalter.checked) window.api.agentStatus().then(agentMalen).catch(() => {}); }, 5000);

// ── Herausgeber ──
if ($('herausgeber-version')) {
  window.api.appVersion().then((v) => { $('herausgeber-version').textContent = '· Version ' + v; }).catch(() => {});
}
if ($('hg-impressum')) {
  $('hg-impressum').addEventListener('click', () => window.api.openPage('impressum'));
}
if ($('hg-datenschutz')) {
  $('hg-datenschutz').addEventListener('click', () => window.api.openPage('datenschutz'));
}
