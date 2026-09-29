// 3DK Browser — Assistenten-Dienst (MCP über HTTP, JSON-RPC 2.0).
//
// Hängt ausschließlich an 127.0.0.1, verlangt einen Schlüssel, prüft Host und
// Origin (DNS-Rebinding zu lokalen Diensten ist damit zu), drosselt die Zahl
// der Aufrufe und schreibt ein Protokoll, das in den Einstellungen sichtbar
// ist. Es gibt genau zwei Werkzeuge — Suche und Lesen. Bedienen: Fehlanzeige.
//
// Kein neues Paket: http aus Node, JSON-RPC von Hand. MCP-Clients, die nur
// stdio sprechen, hängen sich an tools/mcp-bridge.js.

const http = require('http');
const crypto = require('crypto');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./store');
const tools = require('./agent-tools');

const PROTOKOLL_MAX = 50;
const MAX_BODY = 1024 * 1024;
const AUFRUFE_PRO_MINUTE = 30;
const PROTKOLL_DATEI = 'agent-protokoll';

let server = null;
let laufend = { port: 0 };
let zähler = []; // Zeitstempel der Aufrufe (für die Ratenbegrenzung)
let protokoll = [];
let heute = { tag: '', anzahl: 0 };

function settingsVon(getSettings) {
  const s = getSettings() || {};
  return {
    enabled: Boolean(s.agent && s.agent.enabled),
    port: Number(s.agent && s.agent.port) || 8765,
    token: String((s.agent && s.agent.token) || ''),
    tools: Object.assign({ search: true, fetch: true }, (s.agent && s.agent.tools) || {}),
    allowScreenshot: s.agent && s.agent.allowScreenshot !== false,
  };
}

function neuesToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function zeitgleich(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function portFrei(port) {
  return new Promise((resolve) => {
    const test = http.createServer();
    test.once('error', () => resolve(false));
    test.listen(port, '127.0.0.1', () => test.close(() => resolve(true)));
  });
}

async function passendenPort(wunsch) {
  if (await portFrei(wunsch)) return wunsch;
  for (const ausweg of [wunsch + 1, wunsch + 2, 8765 + 100]) {
    if (await portFrei(ausweg)) return ausweg;
  }
  return 0; // 0 = System wählt einen freien Port
}

// ── Protokoll ───────────────────────────────────────────────────────────
function notieren(eintrag) {
  protokoll.unshift({ ...eintrag, at: Date.now() });
  if (protokoll.length > PROTOKOLL_MAX) protokoll.length = PROTOKOLL_MAX;
  store.write(PROTKOLL_DATEI, protokoll);
}

function geladenesProtokoll() {
  protokoll = store.read(PROTKOLL_DATEI, []) || [];
}

function aufrufeHeute() {
  // jedes Mal aus dem Protokoll — nur 50 Einträge, und der Zähler in der
  // Leiste soll sich mit jedem Aufruf bewegen.
  const tag = new Date().toISOString().slice(0, 10);
  return protokoll.filter((p) => new Date(p.at).toISOString().slice(0, 10) === tag).length;
}

// ── Prüfung jeder Anfrage ───────────────────────────────────────────────
function anfrageErlaubt(req, cfg) {
  const host = String(req.headers.host || '').toLowerCase();
  const hostName = host.replace(/:\d+$/, '');
  if (hostName !== '127.0.0.1' && hostName !== 'localhost' && hostName !== '[::1]') {
    return { ok: false, code: 403, grund: 'Adresse des Dienstes passt nicht (Schutz gegen Umbiegen)' };
  }
  const origin = String(req.headers.origin || '');
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { return { ok: false, code: 403, grund: 'Herkunft unlesbar' }; }
    const oName = o.hostname;
    if (oName !== '127.0.0.1' && oName !== 'localhost' && oName !== '[::1]') {
      return { ok: false, code: 403, grund: 'Herkunft ist nicht dieser Rechner' };
    }
  }
  const Kopf = String(req.headers.authorization || '');
  const token = Kopf.startsWith('Bearer ') ? Kopf.slice(7).trim() : '';
  if (!cfg.token || !token || !zeitgleich(token, cfg.token)) {
    return { ok: false, code: 401, grund: 'Schlüssel fehlt oder passt nicht' };
  }
  const jetzt = Date.now();
  zähler = zähler.filter((t) => jetzt - t < 60000);
  if (zähler.length >= AUFRUFE_PRO_MINUTE) {
    return { ok: false, code: 429, grund: 'Zu viele Aufrufe in einer Minute', retryAfter: 60 };
  }
  zähler.push(jetzt);
  return { ok: true };
}

// ── Werkzeuge für die Werkzeugliste ─────────────────────────────────────
function werkzeugListe(cfg) {
  const liste = [];
  if (cfg.tools.search) {
    liste.push({
      name: 'search3dk',
      description: 'Mit der 3DK-Suche suchen: mehrere freie Quellen parallel, lokal neu gereiht, ohne Betreiber-Server.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Suchanfrage', maxLength: 400 },
          count: { type: 'number', description: 'Treffer, 1 bis 25', minimum: 1, maximum: 25 },
        },
        required: ['query'],
      },
    });
  }
  if (cfg.tools.fetch) {
    liste.push({
      name: 'fetchPage',
      description: 'Eine Webseite im echten Chromium lesen (auch per JavaScript gerenderte) und Titel, Text und Links zurückgeben. Lokale Netze, Dateien und angemeldete Konten sind gesperrt.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http- oder https-Adresse' },
          maxBytes: { type: 'number', description: 'Obergrenze für die Antwort', maximum: 400000 },
          timeoutMs: { type: 'number', description: 'Zeit in Millisekunden, höchstens 15000', maximum: 15000 },
          screenshot: { type: 'boolean', description: 'Zusätzlich ein Bildschirmfoto der Seite als PNG' },
        },
        required: ['url'],
      },
    });
  }
  return liste;
}

async function werkzeugAusfuehren(name, args, cfg) {
  if (name === 'search3dk') {
    if (!cfg.tools.search) throw new Error('Werkzeug ist in den Einstellungen ausgeschaltet');
    return await tools.search3dk(args);
  }
  if (name === 'fetchPage') {
    if (!cfg.tools.fetch) throw new Error('Werkzeug ist in den Einstellungen ausgeschaltet');
    const a = { ...(args || {}) };
    if (a.screenshot === true && !cfg.allowScreenshot) a.screenshot = false;
    const r = await tools.fetchPage(a);
    return r;
  }
  throw new Error('Unbekanntes Werkzeug: ' + name);
}

// ── JSON-RPC ────────────────────────────────────────────────────────────
async function verarbeite(nachricht, cfg) {
  const { id, method, params } = nachricht || {};
  const antwort = (result) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, result });
  const fehler = (code, text) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message: text } });

  if (method === 'initialize') {
    return antwort({
      protocolVersion: (params && params.protocolVersion) || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: '3dk-browser', title: '3DK Browser', version: app.getVersion() },
      instructions: 'Zwei Werkzeuge: search3dk (suchen) und fetchPage (eine Seite lesen). Der Browser wird nicht bedient.',
    });
  }
  if (method === 'ping') return antwort({ ok: true, version: app.getVersion() });
  if (method === 'tools/list') return antwort({ tools: werkzeugListe(cfg) });
  if (method === 'tools/call') {
    const name = String((params && params.name) || '');
    const args = (params && params.arguments) || {};
    try {
      const ergebnis = await werkzeugAusfuehren(name, args, cfg);
      notieren({ werkzeug: name, ziel: String(args.url || args.query || '').slice(0, 200), groesse: JSON.stringify(ergebnis).length, ok: true });
      return antwort({ content: [{ type: 'text', text: JSON.stringify(ergebnis) }], isError: false });
    } catch (e) {
      notieren({ werkzeug: name, ziel: String(args.url || args.query || '').slice(0, 200), ok: false, grund: String(e.message).slice(0, 200) });
      return antwort({ content: [{ type: 'text', text: String(e.message) }], isError: true });
    }
  }
  if (method && method.startsWith('notifications/')) return null; // keine Antwort auf Meldungen
  return fehler(-32601, 'Methode nicht bekannt: ' + method);
}

// ── Dienst starten und stoppen ──────────────────────────────────────────
async function start(deps) {
  const cfg = settingsVon(deps.getSettings);
  if (!cfg.enabled) return { running: false };
  await stop({ stilllegen: false });
  geladenesProtokoll();

  const port = await passendenPort(cfg.port);
  server = http.createServer((req, res) => {
    const anfrage = anfrageErlaubt(req, settingsVon(deps.getSettings));
    if (!anfrage.ok) {
      res.statusCode = anfrage.code;
      if (anfrage.retryAfter) res.setHeader('Retry-After', String(anfrage.retryAfter));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: anfrage.grund } }));
      notieren({ werkzeug: '(abgelehnt)', ziel: String(req.headers.host || ''), ok: false, grund: anfrage.grund });
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405; res.end(); return;
    }
    const stuecke = [];
    let laenge = 0;
    req.on('data', (c) => {
      laenge += c.length;
      if (laenge > MAX_BODY) { req.destroy(); return; }
      stuecke.push(c);
    });
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json');
      let nachricht;
      try { nachricht = JSON.parse(Buffer.concat(stuecke).toString('utf8')); }
      catch { res.statusCode = 400; res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON unlesbar' } })); return; }
      try {
        const antwort = await verarbeite(nachricht, settingsVon(deps.getSettings));
        if (antwort === null) { res.statusCode = 202; res.end(); return; }
        res.end(JSON.stringify(antwort));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e.message).slice(0, 200) } }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  laufend = { port: server.address().port };
  console.log('[3DK][agent] Assistenten-Dienst läuft auf http://127.0.0.1:' + laufend.port + '/mcp');
  return status(deps);
}

async function stop() {
  if (!server) return { running: false };
  const s = server;
  server = null;
  laufend = { port: 0 };
  await new Promise((resolve) => s.close(resolve));
  await tools.clearAgentProfile();
  console.log('[3DK][agent] Assistenten-Dienst beendet, Agent-Profil geleert');
  return { running: false };
}

function status(deps) {
  const cfg = settingsVon(deps.getSettings);
  return {
    running: Boolean(server),
    port: server ? laufend.port : 0,
    url: server ? 'http://127.0.0.1:' + laufend.port + '/mcp' : '',
    tokenVorhanden: Boolean(cfg.token),
    tools: cfg.tools,
    allowScreenshot: cfg.allowScreenshot,
    aufrufeHeute: aufrufeHeute(),
    protokoll: protokoll.slice(0, 50),
  };
}

function verbindungsnachweis(port) {
  return {
    mcpServers: {
      '3dk': {
        type: 'http',
        url: 'http://127.0.0.1:' + port + '/mcp',
        headers: { Authorization: 'Bearer <SCHLUESSEL>' },
      },
    },
  };
}

async function schluesselErneuern(deps) {
  const token = neuesToken();
  const settings = deps.getSettings();
  settings.agent = { ...(settings.agent || {}), token, tokenErneuertAm: Date.now() };
  deps.saveSettings(settings);
  notieren({ werkzeug: '(Schlüssel)', ziel: 'erneuert', ok: true });
  return token;
}

async function zuruecksetzen(deps) {
  await stop();
  const settings = deps.getSettings();
  settings.agent = { ...(settings.agent || {}), enabled: false };
  deps.saveSettings(settings);
  protokoll = [];
  store.writeNow(PROTKOLL_DATEI, protokoll);
  try { store.remove(PROTKOLL_DATEI); } catch { /* egal */ }
  return { running: false };
}

// Nur das Protokoll wegwerfen — Dienst und Schlüssel bleiben, wie sie sind.
function protokollLeeren() {
  protokoll = [];
  store.writeNow(PROTKOLL_DATEI, protokoll);
  zähler = [];
  heute = { tag: new Date().toISOString().slice(0, 10), anzahl: 0 };
  return { ok: true };
}

function init() {
  protokoll = store.read(PROTKOLL_DATEI, []) || [];
}

module.exports = { start, stop, status, init, protokollLeeren, neuesToken, verbindungsnachweis, schluesselErneuern, zuruecksetzen, werkzeugListe, anfrageErlaubt, PARTITION: tools.PARTITION };
