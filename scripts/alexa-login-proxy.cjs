#!/usr/bin/env node
// One-shot Amazon-login proxy for capturing an Alexa session cookie.
//
// Usage:
//   1. SSH to your Homebridge host (the box running this plugin).
//   2. Run:
//        cd /var/lib/homebridge/node_modules/homebridge-alexa-sync
//        node scripts/alexa-login-proxy.cjs
//   3. The script prints a URL like http://<your-host>:3456/. Open it in
//      a browser, complete Amazon sign-in (authenticator-app 2FA — SMS
//      will not survive the proxy).
//   4. The cookie is captured automatically and written to
//      <homebridge-storage>/.alexa-sync-cookie.json. The script exits.
//   5. Restart Homebridge so the plugin loads the new cookie.
//
// Env overrides:
//   ALEXA_AMAZON_PAGE   default amazon.com — set amazon.co.uk / amazon.de / etc
//   ALEXA_PROXY_HOST    default the machine's hostname — what the URL points at
//   ALEXA_PROXY_PORT    default 3456
//   ALEXA_PROXY_BIND    default 127.0.0.1 (loopback only). Set to 0.0.0.0 to
//                       expose on the LAN — read the security note below first.
//   ALEXA_COOKIE_PATH   default <HOMEBRIDGE_STORAGE_PATH>/.alexa-sync-cookie.json
//                       (falls back to $HOME/.homebridge or /var/lib/homebridge)
//
// SECURITY: the proxy serves Amazon's actual login form for the few minutes
// it's running. Anyone who can reach the bind address during that window can
// (a) snoop the username/password the user types in, and (b) walk away with
// the captured cookie. Defaulting to 127.0.0.1 means "only this host" — use
// SSH port forwarding to reach it from another machine:
//   ssh -L 3456:127.0.0.1:3456 your-homebridge-host
// Then open http://localhost:3456/ in your browser. If you genuinely need
// LAN-wide exposure, set ALEXA_PROXY_BIND=0.0.0.0 and accept the risk —
// the script prints a warning when that happens.
//
// This file exists because Amazon's login flow keeps shifting and an
// in-process proxy started by Homebridge itself is fragile; running it as
// an explicit, separate step makes failure modes obvious.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// alexa-cookie2 lives next to alexa-remote2 in the plugin's deps.
const alexaCookie = require('alexa-cookie2');

const amazonPage = process.env.ALEXA_AMAZON_PAGE ?? 'amazon.com';
const proxyBind = process.env.ALEXA_PROXY_BIND ?? '127.0.0.1';
// proxyOwnIp is the hostname embedded in proxied URLs the browser hits.
// When bound to loopback, the user reaches us via an SSH tunnel so the
// browser's URL is localhost — use that. Otherwise default to the host's
// mDNS name so a browser on the LAN can resolve it.
const proxyHost = process.env.ALEXA_PROXY_HOST
  ?? (proxyBind === '127.0.0.1' || proxyBind === 'localhost'
    ? 'localhost'
    : `${os.hostname()}.local`);
const proxyPort = Number(process.env.ALEXA_PROXY_PORT ?? 3456);

if (proxyBind !== '127.0.0.1' && proxyBind !== 'localhost') {
  process.stderr.write(
    `\n⚠  ALEXA_PROXY_BIND=${proxyBind} — the Amazon login form will be reachable from any host that can route to ${proxyBind}:${proxyPort}.\n` +
    `   Anyone there during this run can snoop your Amazon credentials or steal the captured cookie.\n` +
    `   Prefer the default (loopback) plus an SSH tunnel: ssh -L ${proxyPort}:127.0.0.1:${proxyPort} <this-host>\n\n`,
  );
}

const PROXY_LANGS = {
  'amazon.com': 'en_US',
  'amazon.co.uk': 'en_GB',
  'amazon.de': 'de_DE',
  'amazon.ca': 'en_CA',
  'amazon.com.au': 'en_AU',
};

function resolveCookiePath() {
  if (process.env.ALEXA_COOKIE_PATH) return process.env.ALEXA_COOKIE_PATH;
  const candidates = [
    process.env.HOMEBRIDGE_STORAGE_PATH,
    '/var/lib/homebridge',
    path.join(os.homedir(), '.homebridge'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return path.join(dir, '.alexa-sync-cookie.json');
    } catch { /* keep trying */ }
  }
  return path.join(os.homedir(), '.alexa-sync-cookie.json');
}

const cookiePath = resolveCookiePath();

alexaCookie.generateAlexaCookie(
  '',
  '',
  {
    amazonPage,
    baseAmazonPage: amazonPage,
    amazonPageProxyLanguage: PROXY_LANGS[amazonPage] ?? 'en_US',
    acceptLanguage: 'en-US',
    setupProxy: true,
    proxyOwnIp: proxyHost,
    proxyPort,
    proxyListenBind: proxyBind,
    logger: (msg) => process.stderr.write(`[alexa-cookie] ${msg}\n`),
  },
  (err, result) => {
    if (err && /Please open/.test(err.message ?? err)) {
      process.stderr.write(
        `\nProxy ready. Open this URL in your browser to sign in:\n  http://${proxyHost}:${proxyPort}/\n` +
        `(Authenticator-app 2FA only — SMS won't survive the proxy.)\n\n`,
      );
      return;
    }
    if (err) {
      process.stderr.write(`Login failed: ${err.message ?? err}\n`);
      process.exit(1);
    }
    if (!result?.localCookie && !result?.cookie) {
      process.stderr.write('No cookie in result — Amazon returned an empty payload.\n');
      process.exit(1);
    }
    const toSave = { ...result, amazonPage };
    // 0o600 — see SECURITY note at the top of this file.
    fs.writeFileSync(cookiePath, JSON.stringify(toSave), { mode: 0o600 });
    process.stderr.write(`\nCookie saved to ${cookiePath} (mode 0600)\nRestart Homebridge to load it.\n`);
    process.exit(0);
  },
);
