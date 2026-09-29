// 3DK Browser — Blocklist für Werbe-/Analyse-/Fingerprinting-Infrastruktur.
// Bewusst kuratiert (kein Adblock-Ersatz): nur Dienste, die nachweislich
// geräteübergreifend verfolgen. Inhalte/CDNs bleiben draußen, damit Seiten
// nicht kaputtgehen. Erste Partei bleibt heil.
//
// Die Domains werden in Chromium-URL-Filter übersetzt (*://*.domain/*),
// damit das Matching im Netzwerk-Stack läuft und nicht in JavaScript.

const TRACKER_DOMAINS = [
  // Google: Werbung und Messung
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'dartsearch.net',

  // Meta
  'facebook.net', 'an.facebook.com', 'ct.facebook.net',

  // Amazon / Adobe / Salesforce / Oracle / Tealium
  'amazon-adsystem.com', 'adobedtm.com', 'demdex.net', 'omtrdc.net',
  'adobeanalytics.com', 'coremetrics.com', 'krxd.net', 'tealiumiq.com',
  'ensighten.com', 'everesttech.net', 'rlcdn.com', 'turn.com',

  // Werbevermarkter, SSP/DSP, Video
  'scorecardresearch.com', 'adnxs.com', 'pubmatic.com', 'rubiconproject.com',
  'openx.net', 'casalemedia.com', 'indexww.com', 'smartadserver.com',
  'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'adscale.de',
  'adition.com', 'mathtag.com', 'yieldmo.com', 'medianet.com',
  'conversantmedia.com', 'adsafeprotected.com', 'moatads.com', 'doubleverify.com',
  'smartclip.net', 'adform.net', 'unrulymedia.com', 'innovid.com', 'sizmek.com',
  'ads.tiktok.com',

  // Analyse, Session-Recording, Attribution, A/B-Tests
  'hotjar.com', 'hotjar.io', 'mixpanel.com', 'segment.io', 'amplitude.com',
  'fullstory.com', 'logrocket.com', 'inspectlet.com', 'mouseflow.com',
  'clicktale.net', 'crazyegg.com', 'chartbeat.com', 'quantserve.com',
  'quantcount.com', 'nielsen.com', 'netratings.com', 'piwik.pro',
  'matomo.cloud', 'improvely.com', 'branch.io', 'appsflyer.com', 'adjust.com',
  'optimizely.com', 'vwo.com', 'mparticle.com',

  // Social-Plugins und Share-Buttons
  'platform.twitter.com', 'syndication.twitter.com', 'analytics.twitter.com',
  'ads-twitter.com', 'sharethis.com', 'addthis.com', 'shareaholic.com',
  'px.ads.linkedin.com', 'disqus.com', 'disquscdn.com',

  // Fingerprinting und Bot-Erkennung
  'fingerprint.com', 'fpjs.io', 'perimeterx.net', 'perimeterx.com',
  'geoedge.me', 'maxmind.com', 'mxptint.net',

  // Zähl-/Traffic-Dienste (RU/CN) und Cloudflare-Messung
  'mc.yandex.ru', 'mc.yandex.com', 'counter.yadro.ru', 'top-fwz1.mail.ru',
  'cnzz.com', 'umeng.com', 'cloudflareinsights.com',
];

// Nur saubere Domains kommen in die Filter (Schutz vor Tippfehler-Einträgen).
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const CLEAN_DOMAINS = [...new Set(TRACKER_DOMAINS.filter((d) => DOMAIN_RE.test(d)))];

// Filter für Chromiums webRequest — native Pattern-Prüfung im Netzwerk-Stack.
const URL_FILTERS = CLEAN_DOMAINS.map((d) => '*://*.' + d + '/*');

function isTrackerHost(host) {
  const h = String(host || '').toLowerCase();
  return CLEAN_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}


// ── Adblock (seit 1.0.1): Werbe-Hosts aus StevenBlack/hosts (MIT) ──────
// Eine Zeile = ein Hostname. Wird beim Start in ein Set geladen (74k
 // Einträge); die Anfrage-Prüfung ist ein Set-Lookup. Bewusst NICHT als
 // Chromium-URL-Filter, damit nur ein onBeforeRequest-Handler nötig bleibt.
const fs = require('fs');
const path = require('path');

let WERBUNG_HOSTS = null;

const ZEILENTRENNER = new RegExp("\r?\n");

function adblockLaden() {
  if (WERBUNG_HOSTS) return WERBUNG_HOSTS;
  WERBUNG_HOSTS = new Set();
  try {
    const datei = path.join(__dirname, 'adblock-liste.txt');
    for (const zeile of fs.readFileSync(datei, 'utf8').split(ZEILENTRENNER)) {
      const h = zeile.trim();
      if (h && !h.startsWith('#')) WERBUNG_HOSTS.add(h);
    }
  } catch { /* Liste fehlt im Paket: Adblock bleibt dann wirkungslos */ }
  return WERBUNG_HOSTS;
}

function isWerbungHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h.includes('.')) return false;
  const liste = adblockLaden();
  if (liste.has(h)) return true;
  // Subdomain-Kette prüfen (x.y.bei-z.de → y.bei-z.de → bei-z.de)
  let rest = h;
  let punkt = rest.indexOf(".");
  while (punkt > -1) {
    rest = rest.slice(punkt + 1);
    if (liste.has(rest)) return true;
    punkt = rest.indexOf(".");
  }
  return false;
}

module.exports = { TRACKER_DOMAINS: CLEAN_DOMAINS, URL_FILTERS, isTrackerHost, isWerbungHost };
