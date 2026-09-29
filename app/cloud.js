// 3DK Browser — Cloud-Anbindung: WebDAV-Backup, clientseitig verschlüsselt.
// Der Cloud-Server sieht ausschließlich einen undurchsichtigen Blob.
//
// Format  3DKBK1 | salt(16) | iv(12) | tag(16) | Chiffretext
// Schlüssel: scrypt(N=32768, r=8, p=1) — speicherhart, 32 Byte.
// AES-256-GCM, assoziierter Text (AAD) = Dateiname, damit ein Fremd-Backup
// nicht unter anderem Namen untergeschoben werden kann.

const crypto = require('crypto');

const FILE_NAME = '3dk-browser-backup.bin';
const MAGIC = Buffer.from('3DKBK1');
const MLEN = MAGIC.length;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const TIMEOUT_MS = 15000;
const AAD = Buffer.from(FILE_NAME);

function deriveKey(phrase, salt) {
  // maxmem: 32768 * 8 * 128 Byte ≈ 33 MB — über der Vorgabe von Node, ohne
  // Angabe schlägt die Ableitung mit MEMORY_LIMIT_EXCEEDED fehl.
  return crypto.scryptSync(String(phrase), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
}

function encrypt(plainString, phrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(phrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const enc = Buffer.concat([cipher.update(plainString, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc]);
}

function decrypt(buf, phrase) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (bytes.length < MLEN + 44) throw new Error('Datei zu kurz — kein 3DK-Backup');
  if (!bytes.slice(0, MLEN).equals(MAGIC)) throw new Error('Unbekanntes Backup-Format');
  const salt = bytes.slice(MLEN, MLEN + 16);
  const iv = bytes.slice(MLEN + 16, MLEN + 28);
  const tag = bytes.slice(MLEN + 28, MLEN + 44);
  const data = bytes.slice(MLEN + 44);
  const key = deriveKey(phrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ── Zugangsdaten ────────────────────────────────────────────────────────
function authHeader(user, pass) {
  return 'Basic ' + Buffer.from(String(user) + ':' + String(pass)).toString('base64');
}

// Klartext-WebDAV wäre ein Gau für einen Datenschutz-Browser: Passwort und
// Verlaufsdaten gingen unverschlüsselt übers Netz. Erlaubt nur nach
// ausdrücklicher Freigabe in den Einstellungen.
function checkedUrl(cfg, endpoint) {
  const base = String(cfg.url || '').trim();
  if (!base) throw new Error('Keine Server-URL angegeben');
  let u;
  try {
    u = new URL(base.replace(/\/$/, '') + '/' + endpoint);
  } catch {
    throw new Error('Server-URL ist ungültig');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && cfg.allowInsecure)) {
    throw new Error('Nur https erlaubt (in den Einstellungen bewusst freigebbar)');
  }
  return u.href;
}

async function cloudTest(cfg) {
  const { net } = require('electron');
  const url = checkedUrl(cfg, '');
  const res = await net.fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: authHeader(cfg.user, cfg.pass), Depth: '0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { ok: res.ok, detail: 'HTTP ' + res.status + (res.ok ? '' : ' — Pfad oder Zugriff prüfen') };
}

async function cloudSave(cfg) {
  const { net } = require('electron');
  const history = require('./history');
  const payload = JSON.stringify({
    version: 3,
    savedAt: new Date().toISOString(),
    history: history.listHistory(),
    downloads: history.listDownloads(),
    // Favoriten reisen verschlüsselt mit (Punkt F5).
    favoriten: require('./store').read('favoriten', []),
  });
  const blob = encrypt(payload, cfg.phrase);
  // Content-Length darf nicht manuell gesetzt werden: net.fetch lehnt das als
  // verbotenes Header-Feld ab (net::ERR_INVALID_ARGUMENT) — Chromium rechnet
  // die Länge selbst aus.
  const res = await net.fetch(checkedUrl(cfg, FILE_NAME), {
    method: 'PUT',
    headers: {
      Authorization: authHeader(cfg.user, cfg.pass),
      'Content-Type': 'application/octet-stream',
    },
    body: blob,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('Cloud-PUT fehlgeschlagen: HTTP ' + res.status);
  return { bytes: blob.length, count: history.listHistory().length };
}

async function cloudRestore(cfg) {
  const { net } = require('electron');
  const res = await net.fetch(checkedUrl(cfg, FILE_NAME), {
    method: 'GET',
    headers: { Authorization: authHeader(cfg.user, cfg.pass) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('Cloud-GET fehlgeschlagen: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('Backup-Datei ungewöhnlich groß — abgebrochen');
  const data = JSON.parse(decrypt(buf, cfg.phrase));
  return data;
}

module.exports = { cloudTest, cloudSave, cloudRestore, encrypt, decrypt, FILE_NAME, checkedUrl };
