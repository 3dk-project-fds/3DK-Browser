// 3DK Browser — Profil-Speicher: verschlüsselt auf der Platte, Schlüssel in
// der Betriebssystem-Tresor (Windows DPAPI, macOS Keychain, GNOME Keyring).
//
// Dateien in %APPDATA%/3dk-browser/:
//   profil.key          Zufälliger Daten-Key, selbst mit safeStorage versiegelt
//   verlauf.dat         AES-256-GCM (Klartext war: verlauf.json)
//   downloads.dat       dito
//   einstellungen.dat   dito
// Alte Klartext-Dateien werden beim ersten Start verschlüsselt und gelöscht.
//
// Der verschlüsselte Inhalt ist ohne den Nutzer-Account des Rechners nicht
// lesbar. Auf Systemen ohne Tresor (z. B. Linux ohne Keyring) wird der
// Daten-Key im Klartext abgelegt und eine Warnung ausgegeben — verschlüsselt
// wird trotzdem, dann schützt nur der Dateisystemzugriff.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const MAGIC = Buffer.from('3DKS1');
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_FILE_NAME = 'profil.key';

let key = null;
let keyFromVault = false;
let dir = null;
let warned = false;

function vaultAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function loadKey() {
  const keyFile = path.join(dir, KEY_FILE_NAME);
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile);
    if (raw.slice(0, MAGIC.length).equals(MAGIC)) {
      try {
        return { key: Buffer.from(safeStorage.decryptString(raw.slice(MAGIC.length)), 'hex'), fromVault: true };
      } catch {
        // Tresor nicht mehr verfügbar (Rechnerwechsel, Keyring zurückgesetzt)
        console.error('[3DK] Profil-Key konnte nicht entsiegelt werden — neuer Schlüssel wird angelegt.');
      }
    } else if (/^[0-9a-f]{64}$/.test(raw.toString('utf8').trim())) {
      return { key: Buffer.from(raw.toString('utf8').trim(), 'hex'), fromVault: false };
    }
  }
  const fresh = crypto.randomBytes(32);
  const out = path.join(dir, KEY_FILE_NAME);
  if (vaultAvailable()) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, Buffer.concat([MAGIC, safeStorage.encryptString(fresh.toString('hex'))]));
    return { key: fresh, fromVault: true };
  }
  if (!warned) {
    warned = true;
    console.warn('[3DK] Kein Betriebssystem-Tresor gefunden: Daten werden mit Dateischlüssel verschlüsselt (schwächer).');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, fresh.toString('hex'), { mode: 0o600 });
  return { key: fresh, fromVault: false };
}

function init() {
  dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const loaded = loadKey();
  key = loaded.key;
  keyFromVault = loaded.fromVault;
}

function legacyPath(name) {
  return path.join(dir, name + '.json');
}
function dataPath(name) {
  return path.join(dir, name + '.dat');
}

function encryptBuffer(name, text) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(name, buf) {
  if (buf.length < MAGIC.length + IV_LEN + TAG_LEN) throw new Error('Datei zu kurz');
  if (!buf.slice(0, MAGIC.length).equals(MAGIC)) throw new Error('Fremdes Dateiformat');
  const iv = buf.slice(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.slice(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = buf.slice(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Atomar schreiben: temporäre Datei, dann umbenennen. Ein Absturz beim
// Schreiben darf das Profil nicht zerstören.
function writeFileAtomic(file, buf) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.unlinkSync(file); } catch { /* existiert noch nicht */ }
  fs.renameSync(tmp, file);
}

function read(name, fallback) {
  const file = dataPath(name);
  try {
    if (!fs.existsSync(file)) {
      // Wanderung vom Klartext-Altbestand
      if (fs.existsSync(legacyPath(name))) {
        const raw = fs.readFileSync(legacyPath(name), 'utf8');
        writeFileAtomic(file, encryptBuffer(name, raw));
        fs.unlinkSync(legacyPath(name));
        console.log('[3DK] ' + name + ': Klartextbestand verschlüsselt.');
        return JSON.parse(raw);
      }
      return fallback;
    }
    return JSON.parse(decryptBuffer(name, fs.readFileSync(file)));
  } catch (e) {
    console.error('[3DK] Profil "' + name + '" lesbar machen fehlgeschlagen:', e.message);
    return fallback;
  }
}

// Schreibvorgänge bündeln: der Verlauf schreibt bei jeder Navigation, das
// soll nicht jede Datei einzeln aufs Blatt prügeln.
const pending = new Map(); // name -> value
let timer = null;

function write(name, value) {
  pending.set(name, value);
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, 400);
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  for (const [name, value] of pending) {
    try {
      writeFileAtomic(dataPath(name), encryptBuffer(name, JSON.stringify(value)));
      pending.delete(name);
    } catch (e) {
      console.error('[3DK] Speichern von ' + name + ' fehlgeschlagen:', e.message);
    }
  }
}

function writeNow(name, value) {
  pending.set(name, value);
  flush();
}

function remove(name) {
  pending.delete(name);
  try { fs.unlinkSync(dataPath(name)); } catch { /* ok */ }
}

function status() {
  return {
    vault: keyFromVault,
    algorithm: 'AES-256-GCM',
    keyFile: keyFromVault ? 'Betriebssystem-Tresor' : 'Datei (kein Tresor verfügbar)',
  };
}

module.exports = { init, read, write, writeNow, flush, remove, status };
