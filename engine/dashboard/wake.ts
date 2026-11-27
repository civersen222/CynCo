/**
 * The phone app wakes this PC when it does not answer (F256, 2026-11-27).
 *
 * The phone opens CynCo at this PC's own HTTPS name (`tailscale serve`, README → Phone access). A PC
 * asleep answers nothing there, and the doorman (`scripts/doorman/`) wakes it only when something
 * knocks on it. The installed app never knocked, so from 2026-11-11, when the phone moved to that
 * name, a phone that found the PC asleep met the browser's error page and nothing woke the PC.
 * Three pieces close that, all switched on by LOCALCODE_DASHBOARD_WAKE_URL (the doorman's https
 * wake address, read in server.ts):
 *
 * - `/sw.js`, a service worker the remote page registers on the HTTPS name. It handles page loads
 *   of this origin and nothing else. A page load with no answer after NAV_KNOCK_AFTER_MS knocks on
 *   the doorman; after NAV_TIMEOUT_MS, or on a network error, it is answered with the cached waking
 *   page instead of the browser's error page. The worker stores that page and nothing else: never
 *   the dashboard, never an API answer.
 * - `/waking`, that page. It knocks, asks this PC's manifest every POLL_EVERY_MS, and reloads when
 *   the PC answers; the reload is a page load again, answered this time.
 * - `window.__CYNCO_WAKE_URL` in the remote page (server.ts `serveIndex`), for a page that is
 *   already open when the PC sleeps: index.html, "Waking the PC".
 *
 * A knock is a GET with `mode: 'no-cors'`, no credentials and no referrer. Its answer is never read,
 * so the doorman needs no CORS rule and learns nothing about the page. The address must be https,
 * because a page on https may not fetch http (mixed content): hence the doorman's own HTTPS name
 * (`tailscale serve` on the doorman, `scripts/doorman/deploy.sh`).
 *
 * Both routes are static, say nothing about the engine, and are fetched by the browser with no
 * Authorization header, so like `/` and the manifest they answer without a token. With no wake
 * address neither answers before the token check (engine/dashboard/CLAUDE.md, Gotchas).
 */
import { createHash } from 'crypto'

export const SERVICE_WORKER_PATH = '/sw.js'
export const WAKING_PAGE_PATH = '/waking'

/** A page load with no answer after this long knocks on the doorman... */
export const NAV_KNOCK_AFTER_MS = 2_500
/** ...and after this long is answered with the waking page. */
export const NAV_TIMEOUT_MS = 6_000
/** The waking page asks this PC this often, each ask cut after PING_TIMEOUT_MS... */
export const POLL_EVERY_MS = 2_500
export const PING_TIMEOUT_MS = 4_000
/** ...knocks again this often while it waits (a burst lasts 60 s, and one already running is not doubled)... */
export const KNOCK_EVERY_MS = 20_000
/** ...and says the PC is still asleep after this long: the doorman's own page waits as long. */
export const GIVE_UP_MS = 180_000
/** Reloads the waking page makes in RELOADS_WINDOW_MS before it stops and offers a button (a slow link, not sleep). */
export const RELOADS_MAX = 3
export const RELOADS_WINDOW_MS = 120_000

export type WakeConfig = { url: string; origin: string }

/** LOCALCODE_DASHBOARD_WAKE_URL as a wake address, or null: https only, no user or password, no fragment. */
export function parseWakeUrl(raw: string | undefined | null): WakeConfig | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (!URL.canParse(s)) return null
  const u = new URL(s)
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) return null
  return { url: u.href, origin: u.origin }
}

/** `v` as a JavaScript literal that is safe inside an inline `<script>`: no `<`, so no `</script>`. */
export function scriptLiteral(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function cspHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`
}

const WAKING_STYLE = `
:root{--bg:#1e1e1e;--fg:#e6e6e6;--dim:#9a9aa6;--ok:#4ec9b0;--warn:#d29922}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
main{padding:24px 16px;max-width:420px;text-align:center}
.dot{display:inline-block;width:14px;height:14px;border-radius:50%;background:var(--warn);margin-right:8px;vertical-align:-1px;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.35}}
h1{font-size:20px;margin:0 0 8px}p{color:var(--dim);margin:6px 0}
button{margin-top:18px;padding:10px 18px;border:0;border-radius:8px;background:#2e6fdc;color:#fff;font-size:16px}
`

/** The waking page's script: knock, ask, reload. Every number is one of the constants above. */
function wakingScript(w: WakeConfig): string {
  return `
(function () {
  var WAKE = ${scriptLiteral(w.url)};
  var POLL_EVERY_MS = ${POLL_EVERY_MS}, PING_TIMEOUT_MS = ${PING_TIMEOUT_MS}, KNOCK_EVERY_MS = ${KNOCK_EVERY_MS}, GIVE_UP_MS = ${GIVE_UP_MS};
  var RELOADS_KEY = 'cynco-wake-reloads', RELOADS_MAX = ${RELOADS_MAX}, RELOADS_WINDOW_MS = ${RELOADS_WINDOW_MS};
  var started = 0, lastKnock = 0, timer = null, asking = false;
  function el(id) { return document.getElementById(id); }
  function say(title, msg) { el('title').textContent = title; el('msg').textContent = msg; }
  // The doorman's answer is never read: no CORS rule needed there, and nothing about this page sent.
  function knock() {
    lastKnock = Date.now();
    return fetch(WAKE, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function () { return true; }, function (e) { console.log('[cynco] knock not sent: ' + e); return false; });
  }
  // Same origin, no token needed: the manifest answers whoever asks, so a 200 means the PC is up.
  function answers() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var cut = setTimeout(function () { if (ctl) ctl.abort(); }, PING_TIMEOUT_MS);
    return fetch('/manifest.webmanifest', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(cut); return r.ok; }, function () { clearTimeout(cut); return false; });
  }
  function recentReloads(now) {
    var list = [];
    try { list = JSON.parse(sessionStorage.getItem(RELOADS_KEY) || '[]'); } catch (e) { console.log('[cynco] reload count unreadable: ' + e); }
    if (!Array.isArray(list)) return [];
    return list.filter(function (t) { return typeof t === 'number' && now - t >= 0 && now - t < RELOADS_WINDOW_MS; });
  }
  function stop() { clearInterval(timer); timer = null; }
  function reloadNow() {
    var now = Date.now(), list = recentReloads(now);
    if (list.length >= RELOADS_MAX) {
      // The PC answers this page, but a page load still runs out of time: a slow link, not sleep.
      say('CynCo answers slowly', 'The PC is awake, but CynCo took too long to load. Tap to try again.');
      el('retry').textContent = 'Open CynCo';
      el('retry').hidden = false;
      return;
    }
    list.push(now);
    try { sessionStorage.setItem(RELOADS_KEY, JSON.stringify(list)); } catch (e) { console.log('[cynco] reload count not kept: ' + e); }
    say('Awake', 'Opening CynCo.');
    location.reload();
  }
  function tick() {
    if (asking || !timer) return;
    var waited = Date.now() - started;
    el('t').textContent = Math.round(waited / 1000) + ' s';
    if (Date.now() - lastKnock >= KNOCK_EVERY_MS) knock();
    asking = true;
    answers().then(function (ok) {
      asking = false;
      if (!timer) return;
      if (ok) { stop(); reloadNow(); return; }
      if (waited > GIVE_UP_MS) {
        stop();
        say('Still asleep', 'The PC did not answer in 3 minutes.');
        el('retry').hidden = false;
        return;
      }
      if (waited > 30000) say('Waking CynCo\\'s PC...', 'It is coming back from sleep; its network can take a minute.');
    });
  }
  function start() {
    started = Date.now();
    lastKnock = 0;
    el('retry').hidden = true;
    el('retry').textContent = 'Try again';
    say('Waking CynCo\\'s PC...', 'It was asleep. The doorman is waking it, and CynCo opens by itself when it answers.');
    stop();
    timer = setInterval(tick, POLL_EVERY_MS);
    tick();
  }
  el('retry').onclick = function () {
    if (el('retry').textContent === 'Open CynCo') {
      try { sessionStorage.removeItem(RELOADS_KEY); } catch (e) { console.log('[cynco] reload count not cleared: ' + e); }
      location.reload();
      return;
    }
    start();
  };
  start();
})();
`
}

/** The service worker. VERSION changes whenever the waking page or this script does, so a phone takes the new one. */
function serviceWorkerScript(w: WakeConfig, version: string): string {
  return `// CynCo's service worker (engine/dashboard/wake.ts): page loads of this origin, nothing else.
'use strict';
var VERSION = ${scriptLiteral(version)};
var CACHE = 'cynco-wake-' + VERSION;
var WAKING = ${scriptLiteral(WAKING_PAGE_PATH)};
var WAKE = ${scriptLiteral(w.url)};
var KNOCK_AFTER_MS = ${NAV_KNOCK_AFTER_MS}, TIMEOUT_MS = ${NAV_TIMEOUT_MS};

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE)
    .then(function (cache) { return cache.add(new Request(WAKING, { cache: 'no-store' })); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys()
    .then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('cynco-wake-') === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    })
    .then(function () { return self.clients.claim(); }));
});

function knock() {
  return fetch(WAKE, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    .catch(function (e) { console.log('[cynco] knock not sent: ' + e); });
}

// The network's answer when it comes in time; otherwise a knock, and the waking page.
function pageLoad(request) {
  var net = fetch(request);
  return new Promise(function (resolve) {
    var done = false, knocked = false;
    function wake() { if (!knocked) { knocked = true; knock(); } }
    function waking() {
      wake();
      // No stored copy (the browser cleared it): wait for the network, as the browser would without this worker.
      resolve(caches.open(CACHE)
        .then(function (cache) { return cache.match(WAKING); })
        .then(function (page) { return page || net; }));
    }
    var knockTimer = setTimeout(wake, KNOCK_AFTER_MS);
    var giveUp = setTimeout(function () { if (done) return; done = true; waking(); }, TIMEOUT_MS);
    net.then(function (res) {
      clearTimeout(knockTimer);
      clearTimeout(giveUp);
      if (done) return;
      done = true;
      resolve(res);
    }, function (e) {
      clearTimeout(knockTimer);
      clearTimeout(giveUp);
      console.log('[cynco] page load failed: ' + e);
      if (done) return;
      done = true;
      waking();
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname === WAKING) return;
  event.respondWith(pageLoad(req));
});
`
}

export type WakeAsset = { body: string; headers: Record<string, string> }

/** What `/sw.js` and `/waking` answer for wake address `w`. Built once per engine start. */
export function wakeAssets(w: WakeConfig): { worker: WakeAsset; page: WakeAsset } {
  const script = wakingScript(w)
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#1e1e1e"><title>CynCo: waking the PC</title>
<style>${WAKING_STYLE}</style></head>
<body><main>
<h1><span class="dot"></span><span id="title">Waking CynCo's PC...</span></h1>
<p id="msg">It was asleep. The doorman is waking it, and CynCo opens by itself when it answers.</p>
<p id="t"></p>
<button id="retry" hidden>Try again</button>
</main>
<script>${script}</script></body></html>
`
  const csp = [
    "default-src 'none'",
    `script-src ${cspHash(script)}`,
    `style-src ${cspHash(WAKING_STYLE)}`,
    `connect-src 'self' ${w.origin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  const version = createHash('sha256').update(html).update(serviceWorkerScript(w, '')).digest('hex').slice(0, 12)
  return {
    worker: {
      body: serviceWorkerScript(w, version),
      // no-cache: the browser asks again on every page load, so a new version reaches the phone at its next open.
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
    },
    page: {
      body: html,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' },
    },
  }
}
