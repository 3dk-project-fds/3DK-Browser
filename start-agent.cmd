@echo off
REM 3DK Agent-Instanz starten - eigener Prozess, eigener Port (8766),
REM Computer-Use an. Der Schluessel wird NICHT im Repo gespeichert: ohne
REM Umgebungsvariable erzeugt agent-main.js einen zufaelligen Token und legt
REM ihn lokal im Agent-Profil an (siehe tools/agent-token.js zum Anzeigen).
REM Nur das sichtbare Arbeitsfenster taucht bei Bedarf auf.
setlocal
if not defined DREI_D_K_PORT set DREI_D_K_PORT=8766
cd /d "%~dp0"
if exist node_modules\.bin\electron.cmd (
  call node_modules\.bin\electron.cmd app\agent-main.js
) else (
  echo Electron fehlt. Bitte zuerst:  npm install
  pause
)
endlocal
