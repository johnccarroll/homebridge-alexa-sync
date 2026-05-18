#!/usr/bin/env node
// Build an alexa-remote2-compatible cookie JSON from raw Chrome cookies.
//
// Why this exists: alexa-remote2's in-process proxy login keeps breaking on
// Amazon UI changes, and no maintained CLI alternative exists. The pragmatic
// fallback is to grab cookies from a logged-in Chrome session yourself.
//
// Usage:
//   1. In Chrome, log into https://www.amazon.com (the same Amazon account
//      that owns your Echo devices).
//   2. Open DevTools (Cmd-Opt-I) → Application → Storage → Cookies →
//      https://www.amazon.com. Copy ALL cookies into a single string in the
//      Chrome devtools "Cookie:" header format. Easiest path: switch to the
//      Network tab, reload, click any request, copy the `Cookie:` request
//      header value.
//   3. Run:
//        node scripts/build-alexa-cookie.mjs --domain amazon.com --cookie '<cookie-string>' > cookie.json
//   4. scp cookie.json homebridge:/tmp/, then mv to
//      /var/lib/homebridge/.alexa-sync-cookie.json and restart homebridge.
//
// This gets you cookie + csrf, which is enough for the smart-home endpoints
// the plugin uses (getSmarthomeDevicesV2, querySmarthomeDevices,
// executeSmarthomeDeviceAction). macDms is left blank — alexa-remote2 will
// re-acquire it on first call or skip macDms-only features (push channel,
// some account-level queries) without breaking device control.

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const cookie = arg('--cookie', process.env.ALEXA_COOKIE);
const domain = arg('--domain', 'amazon.com');

if (!cookie) {
  console.error('Missing --cookie. Paste the Cookie: request header value from a logged-in amazon.com tab.');
  process.exit(2);
}

// alexa-remote2 fetches /api/language to get csrf. We do the same here so the
// output JSON is plug-and-play.
const serviceHost = {
  'amazon.com': 'alexa.amazon.com',
  'amazon.co.uk': 'alexa.amazon.co.uk',
  'amazon.de': 'alexa.amazon.de',
  'amazon.ca': 'alexa.amazon.ca',
  'amazon.com.au': 'alexa.amazon.com.au',
}[domain] ?? 'alexa.amazon.com';

process.stderr.write(`Fetching csrf from https://${serviceHost}/api/language ...\n`);

const res = await fetch(`https://${serviceHost}/api/language`, {
  headers: {
    Cookie: cookie,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Referer: `https://${serviceHost}/spa/index.html`,
  },
  redirect: 'manual',
});

const csrf = res.headers.get('csrf') ?? res.headers.get('CSRF');
if (!csrf) {
  process.stderr.write(`No csrf header in response (status ${res.status}). Cookie likely stale or you're not signed into ${serviceHost}. Re-log on amazon.com in Chrome and try again.\n`);
  process.exit(1);
}

const out = {
  cookie,
  csrf,
  amazonPage: domain,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.stderr.write('OK. Pipe stdout to your cookie file and drop it at <homebridge-storage>/.alexa-sync-cookie.json.\n');
