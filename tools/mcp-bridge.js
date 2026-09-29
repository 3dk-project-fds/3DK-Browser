// 3DK Browser — Brücke zwischen stdio und dem lokalen Assistenten-Dienst.
//
// Manche Assistenten-Programme können nur ein Kindprozess über stdin/stdout
// anbinden (Claude Desktop z. B. für "command"-Server). Dieses Skript hängt
// sich dazwischen: es liest JSON-RPC-Zeilen von stdin, schickt sie an den
// Browser und schreibt die Antworten zurück. Eigene Logik hat es keine —
// alle Prüfungen bleiben im Browser.
//
//   node tools/mcp-bridge.js --url http://127.0.0.1:8765/mcp --token <SCHLUESSEL>
//   oder mit Umgebung: DREI_D_K_URL / DREI_D_K_TOKEN
//
// In einer Client-Konfiguration:
//   { "mcpServers": { "3dk": { "command": "node",
//       "args": ["C:/Pfad/zu/3dk-browser/tools/mcp-bridge.js"],
//       "env": { "DREI_D_K_URL": "http://127.0.0.1:8765/mcp",
//                "DREI_D_K_TOKEN": "<SCHLUESSEL>" } } } }

const readline = require('readline');

function ausUmgebung() {
  const args = process.argv.slice(2);
  const gabe = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : '';
  };
  return {
    url: gabe('--url') || process.env.DREI_D_K_URL || process.env.TDK_URL || 'http://127.0.0.1:8765/mcp',
    token: gabe('--token') || process.env.DREI_D_K_TOKEN || process.env.TDK_TOKEN || '',
  };
}

const { url, token } = ausUmgebung();
if (!token) {
  process.stderr.write('[3dk-bridge] Kein Schlüssel angegeben (--token oder DREI_D_K_TOKEN).\n');
  process.exit(1);
}

const zeilen = readline.createInterface({ input: process.stdin, terminal: false });

async function weiterleiten(nachricht) {
  const antwort = { jsonrpc: '2.0', id: nachricht.id === undefined ? null : nachricht.id };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(nachricht),
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 202) return null; // Meldung ohne Antwort
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    antwort.error = { code: -32000, message: '3DK Browser nicht erreichbar: ' + e.message };
    return antwort;
  }
}

zeilen.on('line', async (zeile) => {
  const text = zeile.trim();
  if (!text) return;
  let nachricht;
  try { nachricht = JSON.parse(text); }
  catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON unlesbar' } }) + '\n');
    return;
  }
  const antwort = await weiterleiten(nachricht);
  if (antwort) process.stdout.write(JSON.stringify(antwort) + '\n');
});

zeilen.on('close', () => process.exit(0));
process.stderr.write('[3dk-bridge] hängt am Browser unter ' + url + '\n');
