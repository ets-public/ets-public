// Makes the free or premium edition of the app from the one source.
//
//   node scripts/make-edition.mjs web <free|premium> <src www> <out dir> [--version 1.2.3] [--site https://…] [--keys '{"k1":"…"}'] [--platform web]
//       copies the web app to <out dir>, keeps or removes the premium code, writes build-info.js
//       --platform web: the installable web app for iPhone and browsers (manifest, offline service worker,
//       Home Screen icons, hosting headers); the app hides what only works on Android
//   node scripts/make-edition.mjs android <free|premium>
//       puts the right native plugins, MainActivity and AndroidManifest into android/ (run after `cap add android`)
//   node scripts/make-edition.mjs check
//       builds both editions in memory and checks them (no leftover markers, valid JavaScript,
//       and nothing in the free edition refers to code that only exists in the premium one)
//
// In www/app.js:
//   /*<premium>*/ … /*</premium>*/   training, labs and health: removed from the free edition
//   /*<free> … </free>*/              free-only code, written as a comment so the plain source runs as premium
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREMIUM_RE = /\/\*<premium>\*\/[\s\S]*?\/\*<\/premium>\*\//g;
const FREE_RE = /\/\*<free>[\s\S]*?<\/free>\*\//g;

export function transformJs(src, edition) {
  let out;
  if (edition === 'free') out = src.replace(PREMIUM_RE, '').replace(/\/\*<free>/g, '').replace(/<\/free>\*\//g, '');
  else out = src.replace(FREE_RE, '').replace(/\/\*<\/?premium>\*\//g, '');
  if (/<\/?premium>|<\/?free>/.test(out)) throw new Error(`${edition}: unmatched edition marker left in app.js`);
  return out;
}

// top-level names declared only inside premium blocks must not appear in the free edition
export function danglingInFree(src) {
  const spans = [...src.matchAll(PREMIUM_RE)].map(m => [m.index, m.index + m[0].length]);
  const inP = i => spans.some(([a, b]) => i >= a && i < b);
  const decl = new Map();
  for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)/gm)) {
    const n = m[1] || m[2]; const set = decl.get(n) || new Set(); set.add(inP(m.index) ? 'P' : 'C'); decl.set(n, set);
  }
  const free = transformJs(src, 'free').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
  const bad = [];
  for (const [n, set] of decl) {
    if (set.has('C')) continue;
    const re = new RegExp(`(?<![\\w.$])${n}\\b`);
    if (re.test(free)) bad.push(n);
  }
  return bad;
}

// names that are also ordinary local variables in the free code (checked by hand)
const LOCAL_NAMES = new Set(['rest', 'act']);

function syntaxCheck(code, label) { try { new vm.Script(code, { filename: label }); } catch (e) { throw new Error(`${label}: ${e.message}`); } }

function makeWeb(edition, src, out, opts) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const skip = edition === 'free' ? /^vendor[\\/](pdf\.|leaflet)/ : null;
  (function copy(rel) {
    for (const f of readdirSync(join(src, rel))) {
      const r = rel ? `${rel}/${f}` : f;
      if (skip && skip.test(r)) continue;
      if (statSync(join(src, r)).isDirectory()) { mkdirSync(join(out, r), { recursive: true }); copy(r); }
      else cpSync(join(src, r), join(out, r));
    }
  })('');
  const js = transformJs(readFileSync(join(src, 'app.js'), 'utf8'), edition);
  syntaxCheck(js, `${edition}/app.js`);
  writeFileSync(join(out, 'app.js'), js);
  // built: the day this version was made; a licence unlocks versions made while it covered updates
  const info = { version: opts.version || 'dev', edition, siteUrl: opts.site || '', ...(opts.version ? { built: new Date().toISOString().slice(0, 10) } : {}), ...(opts.platform === 'web' ? { platform: 'web' } : {}) };
  if (edition === 'premium' && opts.keys) info.licenceKeys = JSON.parse(opts.keys);
  writeFileSync(join(out, 'build-info.js'), `window.ETS_BUILD = ${JSON.stringify(info)};\n`);
  // the premium app talks to the licence server: allow it in the page's security policy
  if (edition === 'premium' && /^https:\/\/[\w.-]+$/.test(info.siteUrl || '')) {
    const ip = join(out, 'index.html');
    writeFileSync(ip, readFileSync(ip, 'utf8').replace("connect-src 'self'", `connect-src 'self' ${info.siteUrl}`));
  }
  if (opts.platform === 'web') makePwa(out, info);
  console.log(`web: ${edition} edition ${info.version}${opts.platform === 'web' ? ' (web app)' : ''} -> ${out}`);
}

/* The installable web app: manifest, icons, iPhone Home Screen tags, an offline service worker, hosting headers. */
function makePwa(out, info) {
  const icons = join(ROOT, 'web-extras', 'icons');
  if (!existsSync(icons)) throw new Error('web-extras/icons is missing');
  cpSync(icons, join(out, 'icons'), { recursive: true });
  // Android-only helpers aren't needed on the web (Leaflet stays: it shows routes recorded on a phone)
  writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
    id: './', name: 'Enhanced Training Studio', short_name: 'ETS', description: 'Injection tracker and training log for enhanced lifters.',
    start_url: './', scope: './', display: 'standalone', orientation: 'portrait', background_color: '#F2F1EC', theme_color: '#1A1C1E',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2));
  const ip = join(out, 'index.html');
  let html = readFileSync(ip, 'utf8');
  // no Capacitor bridge on the web, so no inline scripts are needed at all
  html = html.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'");
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
  if (!csp || /unsafe-inline/.test(csp.match(/script-src[^;]*/)?.[0] || 'unsafe-inline')) throw new Error('web build: could not remove unsafe-inline from the CSP');
  html = html.replace('<title>', `<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ETS">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="referrer" content="no-referrer">
<title>`);
  writeFileSync(ip, html);
  // Cloudflare Pages headers: the service worker must always be fetched fresh; lock down everything else
  writeFileSync(join(out, '_headers'), `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()
  Strict-Transport-Security: max-age=31536000
/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/
  Cache-Control: no-cache
`);
  // offline: cache every file of this version; a new version installs in the background and the app offers a reload
  const files = [];
  (function walk(rel) {
    for (const f of readdirSync(join(out, rel))) {
      const r = rel ? `${rel}/${f}` : f;
      if (statSync(join(out, r)).isDirectory()) walk(r);
      else if (!['_headers', 'sw.js'].includes(r) && !/\.map$/.test(r)) files.push(r);
    }
  })('');
  files.sort();
  const h = createHash('sha256'); for (const f of files) { h.update(f); h.update(readFileSync(join(out, f))); }
  const cache = `ets-web-${info.version}-${h.digest('hex').slice(0, 10)}`;
  writeFileSync(join(out, 'sw.js'), `/* Offline support for the Enhanced Training Studio web app. Written by the build. */
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify(['./', ...files])};
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('ets-web-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;       // the licence server and map tiles go straight to the network
  e.respondWith(caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(hit => hit ||
    fetch(req).catch(() => req.mode === 'navigate' ? c.match('./') : Response.error()))));
});
`);
}

const PREMIUM_PLUGINS = ['HealthDataPlugin', 'HeartRatePlugin', 'TrackerPlugin', 'AppUpdatePlugin'];
export function freeManifest(xml) {
  const drop = [
    /\s*<intent-filter>\s*<action android:name="androidx\.health\.ACTION_SHOW_PERMISSIONS_RATIONALE"\s*\/>\s*<\/intent-filter>/g,
    /\s*<activity-alias[\s\S]*?<\/activity-alias>/g,
    /\s*<service\s+android:name="\.(HrService|TrackService)"[\s\S]*?\/>/g,
    /\s*<!-- (Live heart rate|GPS routes|Health Connect|In-app updates)[^>]*-->/g,
    /\s*<uses-permission android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"[^>]*\/>/g,
    /\s*<uses-feature android:name="android\.hardware\.(bluetooth_le|location\.gps)"[^>]*\/>/g,
    /\s*<uses-permission android:name="android\.permission\.(BLUETOOTH\w*|ACCESS_(FINE|COARSE)_LOCATION|FOREGROUND_SERVICE\w*|health\.\w+)"[^>]*\/>/g,
    /\s*<queries>[\s\S]*?<\/queries>/g,
  ];
  for (const re of drop) xml = xml.replace(re, '');
  if (/health|BLUETOOTH|LOCATION|HrService|TrackService|INSTALL_PACKAGES/.test(xml)) throw new Error('free manifest still mentions a premium permission or service');
  return xml;
}
function makeAndroid(edition) {
  const extras = join(ROOT, 'android-extras');
  const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'adam', 'injectiontracker');
  const mfPath = join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const tmpl = join(extras, 'AndroidManifest.premium.xml');
  if (!existsSync(javaDir) || !existsSync(tmpl)) throw new Error('android/ or android-extras/AndroidManifest.premium.xml is missing');
  mkdirSync(javaDir, { recursive: true });
  for (const f of readdirSync(join(extras, 'java'))) {
    const isPremium = PREMIUM_PLUGINS.some(p => f.startsWith(p));
    if (edition === 'free' && isPremium) { rmSync(join(javaDir, f), { force: true }); continue; }
    let text = readFileSync(join(extras, 'java', f), 'utf8');
    if (edition === 'free' && f === 'MainActivity.java') text = text.split('\n').filter(l => !PREMIUM_PLUGINS.some(p => l.includes(`registerPlugin(${p}.class)`))).join('\n');
    writeFileSync(join(javaDir, f), text);
  }
  let xml = readFileSync(tmpl, 'utf8');
  if (edition === 'free') xml = freeManifest(xml);
  writeFileSync(mfPath, xml);
  // Health Connect library only in the premium app
  const gradle = join(ROOT, 'android', 'app', 'build.gradle');
  let g = readFileSync(gradle, 'utf8');
  const dep = 'implementation "androidx.health.connect:connect-client:1.1.0"';
  const off = '// (premium only) ' + dep;
  g = edition === 'free' ? g.replace(new RegExp(`(?<!// \\(premium only\\) )${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), off) : g.replace(off, dep);
  writeFileSync(gradle, g);
  console.log(`android: ${edition} edition native code and manifest in place`);
}

function check() {
  const src = readFileSync(join(ROOT, 'www', 'app.js'), 'utf8');
  for (const ed of ['premium', 'free']) syntaxCheck(transformJs(src, ed), `${ed}/app.js`);
  const bad = danglingInFree(src).filter(n => !LOCAL_NAMES.has(n));
  if (bad.length) throw new Error('The free edition refers to premium-only code: ' + bad.join(', '));
  const free = transformJs(src, 'free');
  for (const w of ['renderLabs', 'openLabPdfImport', 'renderWorkoutTab', 'healthSync', 'licActivate', 'edVerifyJs', 'updDownload']) if (free.includes(w)) throw new Error(`free edition still contains ${w}`);
  const man = join(ROOT, 'android-extras', 'AndroidManifest.premium.xml');
  if (existsSync(man)) freeManifest(readFileSync(man, 'utf8'));
  console.log(`check: both editions OK (free app.js ${Math.round(free.length / 1024)} KB, premium ${Math.round(transformJs(src, 'premium').length / 1024)} KB)`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === 'web') {
      const [edition, src, out] = rest;
      if (!['free', 'premium'].includes(edition) || !src || !out) throw new Error('usage: web <free|premium> <src www> <out dir>');
      // site address and licence public keys come from the website project's config (flags override)
      const cfgPath = flag('--config') || join(ROOT, '..', 'ets-web', 'site', 'config.json');
      const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
      const keys = flag('--keys') || (cfg.licenceKeys && Object.keys(cfg.licenceKeys).length ? JSON.stringify(cfg.licenceKeys) : undefined);
      const platform = flag('--platform');
      if (platform && platform !== 'web') throw new Error('--platform can only be "web"');
      makeWeb(edition, src, out, { version: flag('--version'), site: flag('--site') ?? cfg.siteUrl, keys, platform });
    } else if (cmd === 'android') {
      if (!['free', 'premium'].includes(rest[0])) throw new Error('usage: android <free|premium>');
      makeAndroid(rest[0]);
    } else if (cmd === 'check') check();
    else throw new Error('usage: web | android | check');
  } catch (e) { console.error('make-edition: ' + e.message); process.exit(1); }
}
