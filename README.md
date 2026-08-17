# homebridge-alexa-sync

Mirror your Alexa-linked smart-home devices into Apple HomeKit via Homebridge. Two-way state sync, one cookie, no vendor developer accounts.

Free and MIT-licensed, with no paid tier and nothing gated behind sponsorship.

## What this gives you

If you've linked any vendor account to Alexa (Smart Life, Hue, Sengled, etc.), this plugin scoops every device Alexa knows about into Homebridge and exposes them to HomeKit. Controls round-trip both ways: tap a light in iOS Home, it turns on; tell Alexa to dim it, HomeKit's state updates within ~60s.

Lights, switches, plugs, fans, locks and thermostats are all supported.

- **One source of truth (Alexa cookie path)** — no per-vendor cloud accounts, no expiring developer subscriptions. The plugin authenticates once with your Amazon account, then talks to Alexa's smart-home API like the Alexa web app does.
- **Optional voice path** — for Homebridge accessories that aren't already in your Alexa account, a hosted Alexa Smart Home Skill can route voice commands back to your plugin. Skip it if all your devices are already Alexa-linked; they're already voice-controllable through the native skill.

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
| `providers.alexa.deviceTypes` | Which Alexa device categories to import | `["LIGHT", "SWITCH", "SMARTPLUG", "SMARTLOCK", "FAN", "THERMOSTAT"]` |
| `cloud.token` | Account-link token for the optional voice path | — |

## Caveats worth knowing

- Alexa returns multiple entries for devices reachable via more than one skill. The plugin prefers the native vendor skill (`AAA_*` applianceIds) over user-installed custom skills (`SKILL_*`); the latter frequently return `ENDPOINT_UNREACHABLE` on state queries.
- Don't keep a custom Alexa Smart Home Skill enabled in Alexa that points at this plugin while the Alexa cookie provider is also active — you'll create a query loop (skill → plugin → Alexa cookie → skill again). If you want voice via Alexa, use the account-link path below instead.
- The plugin assumes your Amazon account uses **authenticator-app 2FA**. SMS-based 2FA doesn't survive the cookie capture flow.
- **Never run the login script with `sudo`.** The cookie is written mode `0600`, so a root-owned cookie is unreadable by the Homebridge user and the plugin will sit idle. Recent versions hand the file back to the storage directory's owner automatically, but running it as the Homebridge user is still the right move.

## Optional: Alexa voice control for Homebridge-only accessories

Only needed if you have Homebridge accessories that *aren't* already in your Alexa account and you want to speak to them. Everything above works without this.

1. Enable the "Homebridge Sync" skill in your Alexa app and link your account.
2. Visit `https://cloud.johncarroll.dev/switchboard` to get your account-link token.
3. Paste it into the plugin's `cloud.token` config field.

The plugin verifies the token offline against an embedded Ed25519 public key — your device data and email never leave your network. The cloud caches state via the plugin's push channel and answers Alexa ReportState within Alexa's 8s deadline. Tokens last 35 days and are refreshed by re-linking.

> Upgrading from an older version? The config key used to be `supporter.token`. That name still works, so existing setups keep running, but `cloud.token` is the current one.

## Architecture

```
┌─────────────────────────────────────────────┐
│            homebridge-alexa-sync            │
├─────────────────────────────────────────────┤
│             Device Manager                  │
│   discovery, state cache, optimistic set    │
├──────────────────┬──────────────────────────┤
│   Alexa cookie   │  optional voice path     │
│   provider       │  (account-linked cloud)  │
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
