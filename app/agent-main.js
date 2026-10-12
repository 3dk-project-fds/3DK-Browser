// 3DK Browser — eigenständige Assistenten-Instanz (Agent-Betrieb).
//
// Was das ist: ein ZWEITER, vom normalen Browser getrennter Electron-Prozess
// mit eigenem userData-Ordner und eigenem Einzelinstanz-Schloss. Er öffnet
// KEIN Benutzerfenster beim Start. Er stellt ausschließlich den Assistente-
// Dienst (MCP über HTTP) auf http://127.0.0.1:8766/mcp bereit. Wenn ein
// browser_*-Werkzeug ein Fenster braucht, erscheint EIN sichtbares, isoliertes
// Arbeitsfenster im leeren Agent-Profil — ohne deine Cookies, Konten oder
// deinen Verlauf. Schließt der Agent es (browser_close), bleibt der Dienst
// warm; das nächste Werkzeug öffnet es wieder.
//
// Grundregel wie im Hauptbrowser: lokale Netze, private Adressen, Dateien und
// angemeldete Konten sind gesperrt. Bedient wird nur der eigene Browser, nie
// das Betriebssystem. Schlüsselpflicht bleibt.

const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const store = require('./store');
const agentApi = require('./agent-api');

// ── Eigene Instanz: userData UND Schloss müssen VOR der Sperre umgebogen ──
const AGENT_DIR = path.join(app.getPath('appData'), '3dk-browser-agent');
try { fs.mkdirSync(AGENT_DIR, { recursive: true }); } catch { /* egal */ }
app.setPath('userData', AGENT_DIR);

const hatSperre = app.requestSingleInstanceLock();
if (!hatSperre) {
  // Bereits eine Agent-Instanz läuft — nicht doppelt starten.
  console.log('[3DK][agent] Es läuft bereits eine Assistenten-Instanz. Beende diese.');
  app.quit();
} else {
  app.on('second-instance', () => { /* ignorieren; eine Instanz genügt */ });

  // Fenster schließen = Dienst bleibt warm. Kein auto-quit.
  app.on('window-all-closed', () => { /* bewusst leer */ });
  app.on('activate', () => { /* bewusst leer */ });

  const EINSTELLUNGEN = path.join(AGENT_DIR, 'agent-einstellungen.json');

  function ladeEinstellungen() {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(EINSTELLUNGEN, 'utf8')); } catch { s = null; }
    if (!s || typeof s !== 'object') s = {};
    s.agent = s.agent && typeof s.agent === 'object' ? s.agent : {};
    // Der Assistenten-Schlüssel kommt aus der Umgebung (einmalig beim Start),
    // sonst wird einer erzeugt. Er liegt nur in diesem eigenen Ordner.
    if (!s.agent.token) s.agent.token = String(process.env.DREI_D_K_TOKEN || agentApi.neuesToken());
    s.agent.enabled = true;                       // in dieser Instanz immer an
    s.agent.port = Number(process.env.DREI_D_K_PORT) || Number(s.agent.port) || 8766;
    s.agent.tools = Object.assign({ search: true, fetch: true, computer: true }, s.agent.tools || {});
    if (s.agent.allowScreenshot !== false) s.agent.allowScreenshot = true;
    return s;
  }

  let einstellungen = ladeEinstellungen();
  function speichere() {
    try { fs.writeFileSync(EINSTELLUNGEN, JSON.stringify(einstellungen, null, 2)); } catch { /* egal */ }
  }
  function hole() { return einstellungen; }

  app.whenReady().then(async () => {
    store.init();
    agentApi.init();
    speichere();
    try {
      const st = await agentApi.start({ getSettings: hole, saveSettings: () => { /* In-Memory */ } });
      console.log('[3DK][agent] Assistenten-Instanz bereit: ' + (st && st.url ? st.url : '(läuft)'));
    } catch (e) {
      console.warn('[3DK][agent] Dienst konnte nicht starten: ' + e.message);
    }
  });

  // Sauber abschalten: Profil leeren, Schloss des Dienstes loslassen.
  const fahreHerunter = () => { agentApi.stop({ getSettings: hole }).catch(() => {}); };
  app.on('before-quit', fahreHerunter);
  process.on('SIGTERM', () => { fahreHerunter(); app.quit(); });
  process.on('SIGINT', () => { fahreHerunter(); app.quit(); });
}
