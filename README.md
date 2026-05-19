# homebridge-alexa-sync

Mirror your Alexa-linked smart-home devices into Apple HomeKit via Homebridge. Two-way state sync, one cookie, no vendor developer accounts.

Part of the [Switchboard](https://cloud.johncarroll.dev/switchboard) smart-home plugin family.

## What this gives you

If you've linked any vendor account to Alexa (Smart Life, Hue, Sengled, etc.), this plugin scoops every device Alexa knows about into Homebridge and exposes them to HomeKit. Controls round-trip both ways: tap a light in iOS Home, it turns on; tell Alexa to dim it, HomeKit's state updates within ~60s.

- **One source of truth (Alexa cookie path)** — no per-vendor cloud accounts, no expiring developer subscriptions. The plugin authenticates once with your Amazon account, then talks to Alexa's smart-home API like the Alexa web app does.
- **Optional voice path via Switchboard** — for Homebridge accessories that aren't already in your Alexa account, the Switchboard managed cloud ($3/mo via GitHub Sponsors) hosts an Alexa Smart Home Skill that routes voice commands back to your plugin. Skip if all your devices are already Alexa-linked — they're already voice-controllable through the native skill.

## Quick start

```bash
npm install -g homebridge-alexa-sync
```

Drop into your Homebridge `config.json` `platforms` array:

```json
{
  "platform": "AlexaSync",
  "name": "Alexa Sync",
  "providers": {
    "alexa": { "amazonDomain": "amazon.com" }
  }
}
```

Then capture an Amazon session cookie (one time). The login proxy defaults to **loopback-only** for security — the cookie is too sensitive to expose on the LAN by default. Use SSH port forwarding to reach it from your laptop:

```bash
# Terminal 1: SSH to the host AND forward port 3456 back to your laptop.
ssh -L 3456:127.0.0.1:3456 your-homebridge-host
cd /var/lib/homebridge/node_modules/homebridge-alexa-sync
node scripts/alexa-login-proxy.cjs
```

The script prints `http://localhost:3456/`. Open it in any browser **on your laptop** (since you're forwarded), sign in with your Amazon account (**authenticator-app 2FA only — SMS won't survive the proxy**). The cookie is captured, saved to `<homebridge-storage>/.alexa-sync-cookie.json` with mode `0600`. Restart Homebridge.

If you really want LAN-wide exposure (e.g. you're logging in from a phone), set `ALEXA_PROXY_BIND=0.0.0.0` when running the script. The proxy will print a security warning. Anyone who can reach the bind address during the login window can snoop your Amazon credentials or steal the cookie — only do this on a network you trust.

The plugin auto-refreshes the cookie every 14 days. If Amazon ever forces a re-login (password change, suspicious-activity flag), just re-run the script.

## Config reference

| Option | Description | Default |
|---|---|---|
| `providers.alexa.amazonDomain` | `amazon.com`, `amazon.co.uk`, `amazon.de`, `amazon.ca`, `amazon.com.au` | `amazon.com` |
| `providers.alexa.pollInterval` | State poll interval (seconds) | `60` |
| `providers.alexa.cookieRefreshDays` | How often to refresh the captured cookie | `14` |
| `providers.alexa.deviceTypes` | Which Alexa device categories to import | `["LIGHT", "SWITCH", "SMARTPLUG", "THERMOSTAT"]` |
| `supporter.token` | Switchboard supporter JWT (optional voice path) | — |

## Caveats worth knowing

- Alexa returns multiple entries for devices reachable via more than one skill. The plugin prefers the native vendor skill (`AAA_*` applianceIds) over user-installed custom skills (`SKILL_*`); the latter frequently return `ENDPOINT_UNREACHABLE` on state queries.
- Don't keep a custom Alexa Smart Home Skill enabled in Alexa that points at this plugin while the Alexa cookie provider is also active — you'll create a query loop (skill → plugin → Alexa cookie → skill again). If you want voice via Alexa, the Switchboard supporter path below is the safe option.
- The plugin assumes your Amazon account uses **authenticator-app 2FA**. SMS-based 2FA doesn't survive the cookie capture flow.

## Optional: Switchboard managed voice ($3/mo)

If you have Homebridge accessories that *aren't* already in your Alexa account and you want voice control of them:

1. Sponsor [@johnccarroll on GitHub Sponsors](https://github.com/sponsors/johnccarroll), enable the "Homebridge Sync" skill in your Alexa app.
2. Visit `https://cloud.johncarroll.dev/switchboard`, grab your supporter token.
3. Paste into the plugin's `supporter.token` config field.

The plugin verifies the token offline against an embedded Ed25519 public key — your device data and email never leave your network. The cloud caches state via the plugin's push channel and answers Alexa ReportState within Alexa's 8s deadline. Cancel anytime; tokens last 35 days.

## Architecture

```
┌─────────────────────────────────────────────┐
│            homebridge-alexa-sync            │
├─────────────────────────────────────────────┤
│             Device Manager                  │
│   discovery, state cache, optimistic set    │
├──────────────────┬──────────────────────────┤
│   Alexa cookie   │  optional supporter      │
│   provider       │  cloud (Switchboard)     │
└────────┬─────────┴──────────┬───────────────┘
         │                    │
   alexa-remote2         Supabase Realtime
   (Amazon cookie)       (directives + state)
```

## Development

```bash
git clone https://github.com/johnccarroll/homebridge-alexa-sync.git
cd homebridge-alexa-sync
npm install
npm run build
npm test
```

## License

MIT
