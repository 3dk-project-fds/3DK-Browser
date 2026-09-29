# 3DK Browser an einen KI-Agenten anbinden

Der Browser kann auf diesem Rechner zu zwei Werkzeugen für einen Assistenten
werden: **suchen** (`search3dk`) und **eine Webseite lesen** (`fetchPage`).
Alles bleibt auf dem eigenen Gerät — kein Cloud-Dienst dazwischen, keine
weitergegebene Anfrage an einen Drittanbieter außer den Suchquellen selbst.

Bedienen lässt sich der Browser über diesen Weg **nicht**: kein Klick, keine
Eingabe, kein JavaScript in einer Seite.

## In fünf Schritten einschalten

1. 3DK Browser öffnen, Zahnrad (oder Strg+,) → Abschnitt
   **„Assistenten-Anbindung (MCP)"**.
2. Schalter **„Lokaler Dienst für KI-Agenten"** einschalten. Die Leiste zeigt
   jetzt dauerhaft das Kästchen **AGENT** — solange es da ist, läuft der Dienst.
3. **„Neu erzeugen"** klickt einen Schlüssel, **„Zeigen"** macht ihn sichtbar,
   **„Kopieren"** legt ihn in die Zwischenablage.
4. Unter „Verbindungsdaten" steht ein fertiges JSON-Stück. Wenn du den Schlüssel
   vorher mit „Zeigen" sichtbar gemacht hast, ist er dort schon eingesetzt.
5. Das JSON in den Assistenten einfügen (Claude Code, Claude Desktop, jedes
   andere MCP-Programm).

## In Claude Code / Claude Desktop

Fernzugriff über HTTP (moderne Clients):

```json
{
  "mcpServers": {
    "3dk": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer DEIN_SCHLUESSEL" }
    }
  }
}
```

Kann das Programm nur einen Kindprozess über stdin/stdout anbinden, die Brücke
`tools/mcp-bridge.js` verwenden:

```json
{
  "mcpServers": {
    "3dk": {
      "command": "node",
      "args": ["C:/Users/DEIN/3dk-browser/tools/mcp-bridge.js"],
      "env": {
        "DREI_D_K_URL": "http://127.0.0.1:8765/mcp",
        "DREI_D_K_TOKEN": "DEIN_SCHLUESSEL"
      }
    }
  }
}
```

Port belegt? Der Browser weicht auf den nächsten freien Port aus — welcher es
ist, steht in den Einstellungen neben „Adresse" und in der Leiste über dem
AGENT-Kästchen.

## Die zwei Werkzeuge

**`search3dk`** — `{ "query": "text", "count": 5 }`
liefert `{ query, tookMs, results: [{ title, url, snippet, domain, official }] }`.
Dasselbe wie die Ergebnisliste im Browser: mehrere freie Quellen parallel, das
Neureihen passiert auf diesem Rechner.

**`fetchPage`** — `{ "url": "https://…", "screenshot": false }`
liefert `{ title, text, links, meta, finalUrl, tookMs, truncated }` und auf
Wunsch ein PNG der Seite. Der Abruf läuft im echten Chromium, funktioniert also
auch bei Seiten, die ihren Inhalt erst per JavaScript bauen.

## Was der Agent **nicht** kann

* deinen Verlauf, deine Lesezeichen, deine Einstellungen oder deine Cookies
* Seiten, bei denen du angemeldet bist — der Agent bekommt ein eigenes, leeres
  Profil, getrennt von deinem
* lokale Dateien lesen (`file://`), Browser-Seiten öffnen, `chrome://`
* Adressen in deinem Netz: `localhost`, `.local`, `127.x`, `10.x`,
  `192.168.x`, `172.16–31.x`, `169.254.x`, `100.64–127.x`, IPv6 `::1`, `fc00::/7`,
  `fe80::/10` — auch dann nicht, wenn eine normale Domain dorthin führt
* den Browser bedienen (klicken, tippen, navigieren, herunterladen)
* beliebigen JavaScript-Code ausführen — es gibt kein `evaluate`-Werkzeug

Der Dienst hängt ausschließlich an `127.0.0.1`. Aus dem Netz ist er nicht
erreichbar, und jede Anfrage muss dreierlei mitbringen: richtigen Host,
keygerechten Ursprung (oder gar keinen), passenden Schlüssel.

## Sicherheit, ehrlich

1. **Was der Agent liest, ist bei ihm.** Er sieht Webseiten, die er selbst
   anfordert — aber er schickt das Ergebnis an das Programm, das ihn steuert.
2. **Text aus Webseiten kann einen Agenten umprogrammieren** (Prompt Injection).
   Lass einen Agenten keine Anweisungen aus einer gelesenen Seite befolgen.
   Genau deshalb kann er über diesen Weg nichts bedienen.
3. **Schlüssel sind Zugang.** Nicht ins Chat-Fenster, nicht in ein Repo, nicht
   in eine Notiz. „Widerrufen und abschalten" beendet alles und leert das
   Agent-Profil; „Neu erzeugen" macht den alten Schlüssel sofort ungültig.
4. **Mitlesen ist vorgesehen.** In den Einstellungen stehen die letzten 50
   Aufrufe mit Werkzeug, Ziel und Ergebnisgröße. „Restlos leeren" löscht das
   Protokoll und das Agent-Profil mit.

## Wenn es nicht klappt

| Meldung | Bedeutung |
|---|---|
| `401 Schlüssel fehlt oder passt nicht` | Falscher oder widerrufen Schlüssel, „Zeigen" benutzen und neu einfügen |
| `403 Adresse des Dienstes passt nicht` | Der Client redet mit einer anderen Adresse als `127.0.0.1` — absichtliche Sperre |
| `403 Herkunft ist nicht dieser Rechner` | Eine Webseite wollte den Dienst ansprechen — Sperre hat gegriffen |
| `429 Zu viele Aufrufe in einer Minute` | Ratenbegrenzung (30/Minute), kurz warten |
| `Ziel nicht erlaubt: …` | Das Ziel steht auf der Sperrliste (Datei, eigenes Netz, eigene Seite) |
| `Der Browser liest gerade schon eine Seite` | Ein Abruf nach dem anderen; kurz warten |
| Verbindung gar nicht | Läuft der Browser? AGENT-Kästchen sichtbar? Port in den Einstellungen nachsehen |

## Prüfen, ob alles noch stimmt

```bash
npm run agenttest   # 24 Prüfpunkte: Schlüssel, Sperren, Werkzeuge, Deckel
npm run probe       # 24 Prüfpunkte Sicherheit gegen fremde Webseiten
```
