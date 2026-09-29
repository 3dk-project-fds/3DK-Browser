# Abnahme — 3DK Browser 1.0.3 · Übersicht je Baustein

Jeder Baustein: was er tut, wie er geprüft ist, wo die Details liegen.

Prüfkürzel der Suiten (alle grün zum Stand 1.0.3):
`npm test` → Cloud, Suche (42), Sicherheit (26), Assistent (24), Favoriten (3).

---

## 1. Suche auf eigenem Weg

- **Was:** Mehrere freie Quellen parallel (Bing, Brave, Mojeek, DuckDuckGo,
  Wikipedia, optional öffentliche SearXNG); lokale Rangfolge statt
  Fremd-Ranking; „Direkt bei"-Kacheln; Auszüge aus den gelesenen Seiten;
  Wetter-Widget; intelligente Frage-Erkennung (Fragekern für Quellen,
  Ortsbezug, seltenes Fragewort als Anker, Beugungsformen gesperrt,
  Wörterbuch- und Rauschen-Strafen).
- **Prüfung:** `npm run suchtest` — 42 Prüfpunkte (E1–E23), inkl. der
  Dauer-Regressionstests aus der Testbatterie (23 Anfragen über Technik,
  Wirtschaft, Handel, Allgemeinwissen, Region).
- **Grenze:** Suchqualität bleibt die der freien Quellen; Nischen-Regional-
  anfragen hängen vom Quellen-Recall ab.

## 2. Favoriten

- **Was:** Stern im Adressfeld (Klick = speichern/entfernen), Dropdown unter
  dem Stern, interne Verwaltungsseite; verschlüsselt (`favoriten.dat`),
  Cloud-Backup inklusive.
- **Prüfung:** `npm run favtest` — 3 Punkte (Rundlauf verschlüsselt, kein
  Klartext, kaputte Einträge verworfen); Screenshots in `docs/bilder/`.
- **Grenze:** keine Ordner/Tags in Fassung 1.

## 3. Assistenten-Anbindung (MCP)

- **Was:** Ein KI-Agent darf suchen (`search3dk`) und Seiten lesen
  (`fetchPage`) — lokal an 127.0.0.1, nur mit Schlüssel, mit
  Ratenbegrenzung und Protokoll. Kein Klick, kein Zugriff auf Profil/Verlauf.
- **Prüfung:** `npm run agenttest` — 24 Punkte; **Live-Test bestanden**:
  echte Aufrufe über die MCP-Brücke (siehe `docs/bilder/agent-protokoll.png`).
- **Details:** [agenten-anbindung.md](agenten-anbindung.md)
- **Grenze:** Text aus Webseiten kann Agenten beeinflussen — deshalb kann
  der Agent über diesen Weg nichts bedienen.

## 4. Cloud-Sicherung (optional)

- **Was:** WebDAV/Nextcloud-Ziel in den Einstellungen; Verlauf, Downloads,
  Einstellungen und Favoriten werden mit der eigenen Passphrase verschlüsselt
  (AES-256-GCM, PBKDF2) und als undurchsichtiger Block hochgeladen.
- **Prüfung:** `npm run cloudtest` — Runden inkl. falscher Passphrase und
  Abwehrfälle.
- **Grenze:** Der Speicherort sieht, dass und wann gesichert wird — nicht, was.

## 5. Sicherheit und Härtung

- **Was:** Berechtigungen nur mit Zustimmung; Drittanbieter-Cookies aus;
  Referrer bescheiden; DNT/GPC; Browser-Kennung glätten; 104 Tracking-Dienste
  blockiert; **Adblock-Schalter** (74.758 Werbe-Hosts, StevenBlack/hosts,
  MIT) — abschaltbar; Profil verschlüsselt (AES-256-GCM + Betriebssystem-
  Tresor); Vertrauensgrenze: fremde Webseiten haben keine Browser-Rechte.
- **Prüfung:** `npm run probe` — 26 Punkte (inkl. Adblock-Liste wirksam,
  Brücke auf fremden Seiten abwesend, Mikrofon/Standort abgelehnt).
- **Grenze:** Adblock stoppt bekannte Werbenetzwerke, nicht jede einzelne
  Werbeanzeige (bewusst, damit Seiten nicht brechen).

## 6. Seitendarstellung

- Bewusst KEIN Zoom: Webseiten laufen in der Größe, die Windows vorgibt.
  Wer kleiner will, stellt die Anzeige in Windows um.

## 7. Rechtstexte im Browser

- **Was:** Impressum (DDG §5, MStV §18) und browser-eigene
  Datenschutzerklärung als interne Seiten; erreichbar über Einstellungen →
  „Herausgeber" oder die Adresswörter `impressum` / `datenschutz`.
- **Prüfung:** Automatische Screenshot-Prüfung der internen Seiten;
  Rechtstexte gegengelesen.
- **Grenze:** keine Rechtsberatung — die Texte sind ohne anwaltliche
  Prüfung entstanden.

## 8. Installer und Pakete

- **Windows:** NSIS-Installer, getestet (Installation über Altversion,
  Sicherheitsprobe gegen den installierten Bau: 8/8). Unsigniert —
  SmartScreen-Hinweis + Prüfsummen: [code-signing.md](code-signing.md).
- **Linux:** AppImage + deb, nativ auf Ubuntu 26.04 gebaut; Paketstruktur
  geprüft (Desktop-Datei, Icon, Metadaten). **Start auf einem Linux-Desktop
  noch nicht getestet** — offener Punkt.

## 9. Release v1.0.3

- GitHub-Release mit Installer, AppImage, deb, Prüfsummen (SHA-256),
  Demo-Video und Screenshots:
  <https://github.com/3dk-project-fds/3DK-Browser/releases/tag/v1.0.3>

## 10. Offene Punkte

1. Linux-Pakete auf einem Linux-Desktop starten (AppImage doppelklicken;
   deb: `sudo apt install ./3dk-browser_1.0.3_amd64.deb`)
2. Code-Signing-Zertifikat (optional, ca. 30–500 €/Jahr je Variante —
   [code-signing.md](code-signing.md))
3. Website-Downloadblock auf 3dkproject.de (wenn die Website fertig ist)
4. Repo öffentlich schalten, damit das Release Downloads bekommt
   (GitHub → Settings → Danger Zone → Change visibility → Public)
