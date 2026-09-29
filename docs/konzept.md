# 3DK Browser — Konzept

Stand: 2026-09-23 (an den Code angepasst — vorheriger Stand beschrieb Tauri
und eine zentrale Suchinstanz, beides ist überholt)

## Ziel

Ein datenschutzfreundlicher Browser für Windows und Linux (iOS später), der DSGVO-konform ist, kein Tracking betreibt und Nutzerdaten ausschließlich lokal speichert — bei gleichzeitig bestmöglichen Suchergebnissen ohne Google.

## Positionierung

- **Autark wie Chrome/Edge:** Der Browser baut keine Verbindung zu Betreiber-Infrastruktur auf. Was auf dem Rechner des Nutzers passiert, bleibt dort.
- **Keine Datenverwertung:** nicht-kommerziell finanziert (Spenden/Förderung), daher kein Geschäftsmodell auf Nutzerdaten.
- **Ehrlich:** Die Suchqualität liegt ohne Tracking-Ökosystem realistisch knapp unter Google (DDG-Niveau). Das Versprechen wird korrekt so formuliert.

## Architektur

### Renderkern

**Chromium über Electron.** Jeder Tab ist ein eigener Renderer
(`WebContentsView`), Chrome-Leiste und eigene Seiten laufen im 3dk-Design.

| Plattform | Engine |
|---|---|
| Windows | gebündeltes Chromium (Electron) |
| Linux | gebündeltes Chromium (Electron) |
| iOS (offen) | WKWebView, eigener Adapter |

Ursprünglich war Tauri/wry mit System-Webviews geplant. Geworden ist es
Electron, weil für die versprochenen Eigenschaften eine eigene, einheitliche
Engine nötig ist:

- **nicht „Microsofts Webview“** — Autarkie auch gegenüber dem System
- einheitliche Härtung (Berechtigungen, Netzwerk-Filter, Blockade von
  Drittanbieter-Cookies) auf einer Engine statt auf drei verschiedenen
- einheitliche Vorhersagbarkeit für die automatischen Prüfungen

Preis dafür: ~200 MB Installationsgröße und mehr Speicherfußabdruck. In Kauf
genommen, weil Datenschutz das Ziel ist und Größe nur Geld kostet.

### Suche (unsichtbar für den Nutzer)

Der Nutzer tippt in die Adressleiste — es gibt keine Pflicht-Konfiguration.

1. **Umgesetzt:** mehrere freie Quellen parallel (Bing, Brave, Mojeek,
   DuckDuckGo, Wikipedia). Die erste Quelle malt die Liste, die anderen mischen
   sich unter. Neureihen, Konsens über Indexfamilien und Dublettenbildung
   passieren auf dem Gerät.
2. **Optional:** wer eine eigene SearXNG-Instanz betreibt, trägt sie in den
   Einstellungen ein; sie wird dann eine Quelle unter mehreren. Leer gelassen
   läuft der Browser ohne jeden Betreiber-Dienst.

Die zentrale Instanz `search.3dkproject.de` ist aus dem Code geflogen: sie war
ein Widerspruch zum Autarkie-Prinzip (der Betreiber sah jede Anfrage).

**Es bleibt bei einem Produkt: dem Browser.** Eine eigenständige
Such-Webseite ist nicht geplant — `design-referenz/3dk-search.html` ist nur die
Gestaltungsvorlage, aus der Start- und Ergebnisliste kommen, und wird nicht
veröffentlicht.

Datenschutz-Vertrag: Abfragen verlassen den Rechner als Suchanfrage an die
gewählten Suchmaschinen und als Seitenabruf — wie beim privaten Fenster. Keine
Cookies, kein Profil, keine mitlaufenden Protokolle. Das Such-Protokoll ist
standardmäßig aus; stand es früher an, löscht der nächste Start die Altdatei.

### Nutzerdaten (alles lokal)

- Profil = verschlüsselte Dateien im Profilordner (AES-256-GCM), Daten-Key in
  der Betriebssystem-Tresor des Nutzerkontos (Windows DPAPI, macOS Keychain,
  GNOME Keyring). Kein Cloud-Account, kein Sync.
- Inhalt: Verlauf, Downloads, Einstellungen. Lesezeichen sind noch nicht gebaut
  (frühere Erwähnung war Vorschau, keine Umsetzung).
- Optional: verschlüsseltes WebDAV-Backup mit eigener Passphrase
  (scrypt + AES-256-GCM), https Pflicht.
- Wo kein Tresor erreichbar ist (z. B. Linux ohne Keyring), bleibt die Datei
  verschlüsselt, der Schlüssel liegt aber im Profil — die Oberfläche zeigt das
  ehrlich unter „Einstellungen → Profil und Schutz“.

### Anti-Tracking ab Werk

- Third-Party-Cookies aus (Chromium-Schalter + zweite Schicht im Browser-Stack)
- Referrer-Trimming auf die Herkunfts-Domain
- kuratierte Blocklist für Werbe-, Analyse- und Fingerprinting-Dienste
  (~120 Domains, `app/blocklist.js`) — kein Adblock, kein Vollzähler
- Berechtigungen (Kamera, Mikrofon, Standort, Benachrichtigungen) standardmäßig
  abgewiesen; Vollbild und Zeigersperre erlaubt
- Browser-Kennung geglättet (kein „Electron“ im User-Agent), DNT und GPC
  mitgesandt — letzteres ist ehrlich als „wenig wirksam“ beschriftet
- **Ehrliche Grenze:** 100 %-Fingerprint-Schutz (Tor-Niveau) gibt es hier nicht.
  Positionierung: „keine Datenabflüsse von uns, starke Standard-Abwehr“ statt
  „anonym surfen“.

### Design

Übernommen aus der 3DK-Suchseite (search.3dkproject.de):

- Dark-Theme: Hintergrund `#0D0D0D`, Karten `#141414`, Text `#EDEDED`, gedimmt `#8A8A8A`
- Akzent: Orange `#E8621A` (Layer: rgba(232,98,26, .12/.25/.18))
- Schriften: Barlow (300–600), Barlow Condensed (700/800) — **gebündelt**, nicht von Google Fonts geladen
- Topbar 60px mit Blur, Hero-Startseite mit radial Glow

Bewusst NICHT übernommen (widerspricht dem Autarkie-Prinzip):

- ~~Google Fonts~~ → gebündelt
- ~~analytics.3dkproject.de (Umami)~~ → komplett entfernt, keine Telemetrie
- ~~unpkg.com (Leaflet)~~ → Karten-Tab in v1 weggelassen; falls später, dann gebündelt

## Auslieferung

- Windows: NSIS-Installer `.exe` (electron-builder); Code-Signing später
  (SmartScreen-Warnung ohne Zertifikat, kostet Geld)
- Linux: `.deb` + `.AppImage`
- iOS: später (WKWebView, Xcode-Toolchain)

## Verwandte Entscheidungen

- **Lizenz:** AGPL-3.0 (verhindert Closed-Source-Forks; Rechte-Verkauf bleibt per Vertrag möglich)
- **Finanzierung:** nicht-kommerziell — Spenden, GitHub Sponsors, Förderprogramme (z. B. NLnet)
- **Repo:** dieses, strikt getrennt von allen anderen Projekten des Autors

## Verworfene Alternativen

| Option | Grund der Verwerfung |
|---|---|
| Qt WebEngine (Chromium, LGPL) | ~150 MB Binaries, LGPL-Pflichten; iOS eh WebKit-Pflicht |
| Servo | technisch reizvoll (Rust, MPL), aber produktiv zu unreif |
| Zentrale SearXNG-Instanz des Autors | widerspricht „keine Verbindung zum Betreiber“ — Ende September 2026 aus dem Code entfernt |
| Tauri/wry mit System-Webviews | war der Plan bis 21.09.; verworfen wegen drei unterschiedlicher Engines, Microsoft-WebView auf Windows und fehlender einheitlicher Härtung |
