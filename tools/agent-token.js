// Zeigt den lokal erzeugten Schluessel der Agent-Instanz an, damit du ihn in
// deine PRIVATE MCP-Konfiguration (~/.config/mcp/mcp.json) uebernehmen kannst.
// Der Token verlaesst das Repo nie — er liegt nur im lokalen Agent-Profil.
const fs = require('fs');
const path = require('path');
const os = require('os');

const basis = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const pfad = path.join(basis, '3dk-browser-agent', 'agent-einstellungen.json');
try {
  const s = JSON.parse(fs.readFileSync(pfad, 'utf8'));
  const t = s && s.agent && s.agent.token;
  if (!t) { console.error('Kein Token im Profil gefunden.'); process.exit(1); }
  console.log('Agent-Port  : ' + (s.agent.port || 8766));
  console.log('Agent-Token : ' + t);
  console.log('\nIn  ~/.config/mcp/mcp.json  eintragen (private Datei, nicht committen):');
  console.log('  "headers": { "Authorization": "Bearer ' + t + '" }');
} catch (e) {
  console.error('Agent-Profil nicht lesbar (' + pfad + '). Instanz zuerst starten: npm run agent');
  process.exit(1);
}
