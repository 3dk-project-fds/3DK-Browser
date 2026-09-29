# Code-Signing und SmartScreen — ehrlicher Stand

Stand: 2026-09-25 · Lastenheft-Punkt B des Windows-Finishs

## Warum der Browser heute eine SmartScreen-Warnung zeigt

Windows prüft Installer über den Ruf des Signatur-Zertifikats, nicht über den
Inhalt. Ein **unsignierter** Installer löst „Windows hat deinen PC geschützt"
aus — egal wie sauber der Code ist. Daran ändert auch eine Selbstsignatur
**nichts**: Selbstsignierte Zertifikate haben keinen Vertrauensanker, der
SmartScreen warnt weiter (manchmal sogar strenger).

## Die drei Wege

| Weg | Wirkung gegen SmartScreen | Kosten/Folgen |
|---|---|---|
| **OV-/EV-Code-Signing-Zertifikat** einer vertrauenswürdigen Stelle (Sectigo, DigiCert, GlobalSign …) | Warnung verschwindet, sobald der Ruf aufgebaut ist (OV: nach einiger Zeit/Downloads; EV: sofort) | ca. 200–500 €/Jahr, Identitätsprüfung (Handelsregister/Personalausweis), privater Schlüssel auf Token/HSM |
| **Selbstsignatur** (eigenes Zertifikat) | **keine** — nur Integrität: man sieht, ob die Datei nachträglich verändert wurde | kostenlos; Vertrauen muss außerhalb entstehen (Prüfsummen) |
| **Keine Signatur + Prüfsummen + Anleitung** | Warnung bleibt; Nutzer prüfen SHA-256 und klicken „Trotzdem ausführen" | kostenlos; ehrlich dokumentiert |

## Beschluss-Fassung (ohne Zertifikat, Stand 0.5.0)

1. Je Release liegt `dist/CHECKSUMMEN.txt` mit SHA-256 über jedem Installer;
   dieselben Werte stehen im Abnahme-Dokument und können über einen
   Zweitweg (z. B. Signatur-Mail oder Website) gegengeprüft werden.
2. README und Installer-Finish zeigen den SmartScreen-Leitfaden:
   „Mehr Informationen" → „Trotzdem ausführen".
3. `docs/abnahme.md` nennt die Warnung ausdrücklich als bekannten Zustand.

## Falls ein Zertifikat gestellt wird (Nachlieferung)

- Build-Pfad: `electron-builder` mit `win.certificateFile`/`certificateSha1`
  oder `signtool sign /tr http://timestamp.sectigo.com /td sha256 /fd sha256`
  nach dem Packen; EV zusätzlich mit Hardware-Token.
- Reihenfolge: erst signieren, dann blockmap/latest.yml erzeugen, damit
  Autoupdate-Dateien und Signatur zusammenpassen.
- Abnahme-Punkt: Signatur mit `signtool verify /pa` prüfen und
  SmartScreen-Verhalten auf frischer Windows-VM fotografieren.
