// Kontroll-Lauf für die Agent-Instanz (8766): prüft jeden Lastenheft-Punkt.
// Der Schluessel kommt aus der Umgebung oder dem lokalen Agent-Profil —
// er steht bewusst nirgends im Repository.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

function lokalerToken() {
  if (process.env.DREI_D_K_TOKEN) return process.env.DREI_D_K_TOKEN;
  const basis = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  try {
    const s = JSON.parse(fs.readFileSync(path.join(basis, '3dk-browser-agent', 'agent-einstellungen.json'), 'utf8'));
    if (s && s.agent && s.agent.token) return String(s.agent.token);
  } catch { /* Profil (noch) nicht da */ }
  throw new Error('Kein Schluessel: DREI_D_K_TOKEN setzen oder Agent-Instanz zuerst starten.');
}
const TOKEN = lokalerToken();

function call(name, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const req = http.request({ host: '127.0.0.1', port: 8766, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN } }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', (e) => resolve(JSON.stringify({ _err: e.message })));
    req.write(body); req.end();
  });
}

function unw(r) { try { const j = JSON.parse(r); const t = j.result.content[0].text; try { return { isError: j.result.isError, o: JSON.parse(t) }; } catch { return { isError: j.result.isError, o: { text: t } }; } } catch (e) { return { parseFail: true, raw: r }; } }

async function check(label, name, args, want, expectBlocked) {
  const r = unw(await call(name, args));
  let ok, msg;
  if (r.parseFail) { ok = false; msg = r.raw.slice(0, 70); }
  else {
    const s = JSON.stringify(r.o);
    if (expectBlocked) ok = r.isError && s.includes(want);      // gewollte Sperre: Fehler + Grund
    else ok = !r.isError && (want ? s.includes(want) : true);
    msg = s.slice(0, 70);
  }
  console.log((ok ? '  OK  ' : '  FEHLER ') + label + '  ->  ' + msg);
  return ok;
}

(async () => {
  console.log('KONTROLLE je Lastenheft-Punkt (http://127.0.0.1:8766/mcp):\n');
  const res = [];
  res.push(await check('B9 search3dk', 'search3dk', { query: 'pi coding agent', count: 2 }, 'results'));
  res.push(await check('   fetchPage', 'fetchPage', { url: 'https://example.com' }, 'Example Domain'));
  res.push(await check('B1 browser_open', 'browser_open', { url: 'https://example.com' }, 'Example Domain'));
  res.push(await check('B3 browser_screenshot', 'browser_screenshot', {}, 'screenshot'));
  res.push(await check('B4 browser_click', 'browser_click', { x: 400, y: 300 }, 'geklickt'));
  res.push(await check('B5 browser_type', 'browser_type', { text: 'hi' }, 'getippt'));
  res.push(await check('B6 browser_key Enter', 'browser_key', { key: 'Enter' }, 'taste'));
  res.push(await check('B7 browser_back', 'browser_back', {}, 'url'));
  res.push(await check('C2 private IP block', 'browser_open', { url: 'http://192.168.1.1' }, 'gesperrt', true));
  res.push(await check('C2 loopback block', 'browser_open', { url: 'http://127.0.0.1:9' }, 'gesperrt', true));
  res.push(await check('A5 browser_close', 'browser_close', {}, 'dienstWarm'));
  const warm = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 8766, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN } }, (res2) => { let d = ''; res2.on('data', (c) => d += c); res2.on('end', () => resolve(d)); });
    req.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })); req.end();
  });
  console.log((warm.includes('"ok":true') ? '  OK  ' : '  FEHLER ') + 'E   ping nach close (Dienst warm)');
  const bestanden = res.filter(Boolean).length + (warm.includes('"ok":true') ? 1 : 0);
  console.log('\n' + bestanden + '/' + (res.length + 1) + ' Punkte bestanden.');
})();
