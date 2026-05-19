# homebridge-alexa-sync

Mirror your Alexa-linked smart-home devices into Apple HomeKit via Homebridge. Two-way state sync, no Tuya developer subscription required for the common Smart Life path.

Part of the [Switchboard](https://cloud.johncarroll.dev/switchboard) smart-home plugin family.

## What this gives you

If you've already linked a smart-home account to Alexa (Smart Life, Hue, Sengled, Resideo, etc.), this plugin scoops every device Alexa knows about into Homebridge and exposes them to HomeKit. Controls round-trip both ways: tap a light in iOS Home, it turns on; tell Alexa to dim it, HomeKit's state updates.

- **One source of truth (Alexa cookie path)** — no per-vendor cloud accounts, no expiring developer subscriptions. The plugin authenticates once with your Amazon account, then talks to Alexa's smart-home API like the Alexa web app does.
- **Tuya LAN** *(preview, advanced)* — direct LAN protocol via `tuyapi`, no cloud at runtime, but requires a one-time key extraction during an active Tuya dev subscription.
- **Resideo / Honeywell Home** *(direct)* — official OAuth API for thermostats and locks.
- **Optional voice via Alexa** — two paths, [Switchboard managed cloud](https://cloud.johncarroll.dev/switchboard) ($3/mo) or self-host a Lambda. Most users don't need this — the Alexa cookie path already gives Alexa control of the devices natively.

## Quick start (recommended path)

```bash
npm install -g homebridge-alexa-sync
```

Minimum config — drop this into your Homebridge `config.json` `platforms` array:

```json
{
  "platform": "AlexaSync",
  "name": "Alexa Sync",
  "providers": {
    "alexa": { "amazonDomain": "amazon.com" }
  }
}
```

Then capture an Amazon session cookie (one time):

```bash
ssh your-homebridge-host
cd /var/lib/homebridge/node_modules/homebridge-alexa-sync
node scripts/alexa-login-proxy.cjs
```

The script prints a URL like `http://your-homebridge-host:3456/`. Open it in any browser, sign in with your Amazon account (**authenticator-app 2FA only — SMS won't survive the proxy**). The cookie is captured automatically and saved to `<homebridge-storage>/.alexa-sync-cookie.json`. Restart Homebridge.

The plugin auto-refreshes the cookie every 14 days. If Amazon ever forces a re-login (password change, suspicious-activity flag), just re-run the script.

## Provider details

### Alexa cookie

Default and recommended. Works for any device that's already in your Alexa account. No vendor credentials needed beyond your existing Alexa setup.

| Option | Description | Default |
|---|---|---|
| `amazonDomain` | `amazon.com`, `amazon.co.uk`, `amazon.de`, `amazon.ca`, `amazon.com.au` | `amazon.com` |
| `pollInterval` | State poll interval (seconds) | `60` |
| `cookieRefreshDays` | How often to refresh the captured cookie | `14` |
| `deviceTypes` | Which Alexa device categories to import | `["LIGHT", "SWITCH", "SMARTPLUG", "THERMOSTAT"]` |

**Caveats worth knowing:**
- Alexa returns multiple entries for devices reachable via more than one skill. The plugin prefers the native vendor skill (`AAA_*` applianceIds) over user-installed custom skills (`SKILL_*`); the latter frequently return `ENDPOINT_UNREACHABLE` on state queries.
- Don't enable a self-hosted Alexa Smart Home Skill (`alexaSkill.enabled: true`) AND the Alexa cookie provider for the same devices — you'll create a query loop where Alexa asks the skill which asks the plugin which asks Alexa. The plugin's directive handler defends against this by answering from cache only, but the cleaner config is to pick one path.

### Tuya / Smart Life (preview)

> Pricing reality check (May 2026): Tuya's free IoT Core trial is **1 month**; paid is ~$800/year. For hobbyists, the Alexa cookie path above is almost always the better trade. The Tuya provider stays in the codebase for users with an active subscription or who extracted local keys during the trial window.

Cloud path:
1. Developer account at [iot.tuya.com](https://iot.tuya.com)
2. Cloud Project (Smart Home, correct data center)
3. Link your Smart Life app account to the project
4. Enable **IoT Core** and **Smart Home Device Management** APIs
5. Paste Access ID + Access Key into config

| Option | Default |
|---|---|
| `accessId`, `accessKey` | (required) |
| `region` | `us` |
| `pollInterval` | `30` |

LAN mode (insulates against cloud expiry):

```bash
# While your Tuya dev subscription is still active:
TUYA_ACCESS_ID=xxx TUYA_ACCESS_KEY=yyy TUYA_REGION=us \
  node scripts/extract-tuya-keys.mjs > tuya-local.json
scp tuya-local.json homebridge:/var/lib/homebridge/tuya-local.json
```

Restart. Log will read `Initializing Tuya provider (LAN, N devices)`. The plugin then uses [`tuyapi`](https://github.com/codetheweb/tuyapi)'s LAN protocol; cloud subscription expiry stops mattering for control. Re-run the extractor when you add new devices.

First-pass LAN limitations: assumes the standard Tuya light DPS layout (`1`=switch, `2`=mode, `3`=brightness, `4`=temp, `5`=color), state polling only (no Pulsar push), device IP auto-discovered (can be pinned).

### Resideo / Honeywell Home

1. Sign up at [developer.resideo.com](https://developer.resideo.com), get your app approved (1–2 weeks)
2. Create an app, set redirect URI to `http://localhost:3457/callback`
3. Run the OAuth flow once for a refresh token, paste into config

## Voice control via Alexa (optional)

The Alexa cookie path above already gives you Alexa control of the same devices via their native skill. The sections below are only relevant if you specifically want Homebridge accessories that aren't already in Alexa to be voice-controllable from Echo.

### Path A — Switchboard managed cloud ($3/mo, ~3 min setup)

Sponsor [@johnccarroll on GitHub Sponsors](https://github.com/sponsors/johnccarroll), enable the "Homebridge Sync" skill in your Alexa app, paste the supporter token from `https://cloud.johncarroll.dev/switchboard` into the plugin's **Supporter License** field. The cloud answers Alexa.ReportState from a cached state push, so latency is good and no loops are possible.

The plugin verifies the token offline against an embedded Ed25519 public key — your device data and email never leave your network. Cancel anytime; tokens last 35 days.

### Path B — Self-hosted Lambda (advanced, free, ~2 hr)

You run your own AWS Lambda + Alexa Smart Home Skill. Lambda → Tailscale Funnel → your Pi → plugin's `/alexa/directive` endpoint on port 9090.

> Caution: if you have the Alexa cookie provider ALSO active, Alexa state queries will loop (skill → plugin → Alexa cookie → skill again). The plugin's directive handler now reads from cache only to break the loop in flight, but the cleanest setup is to use Path B *instead of* the cookie provider, not alongside it.

Setup:
1. **AWS Lambda** (`us-east-1`, Node 22.x): paste `alexa-lambda/index.mjs`. Env: `BRIDGE_URL` (Tailscale Funnel URL), `BRIDGE_API_KEY` (matches `alexaSkill.apiKey` below). Timeout 15s.
2. **Alexa Smart Home Skill** at developer.amazon.com/alexa: Smart Home, Payload v3, Lambda ARN as endpoint, add Smart Home trigger to Lambda with the Skill ID.
3. **LWA account linking**: Security Profile at developer.amazon.com/loginwithamazon, Auth URI `https://www.amazon.com/ap/oa`, Token URI `https://api.amazon.com/auth/o2/token`, scope `profile`.
4. Set in config: `alexaSkill.enabled: true`, `alexaSkill.apiKey: <random>`.
5. Enable the skill in Alexa app (Your Skills → Dev tab) and link your account.
6. "Alexa, discover devices."

| Option | Default |
|---|---|
| `enabled` | `false` |
| `apiPort` | `9090` |
| `apiKey` | (required when enabled) |

## Architecture

```
┌──────────────────────────────────────────────┐
│              homebridge-alexa-sync           │
├──────────────────────────────────────────────┤
│              Device Manager                  │
│    discovery, state cache, deduplication     │
├──────────┬──────────┬───────────┬────────────┤
│  Alexa   │ Tuya     │ Tuya LAN  │  Resideo   │
│  cookie  │ cloud    │ (tuyapi)  │  OAuth     │
└────┬─────┴────┬─────┴─────┬─────┴─────┬──────┘
     │          │           │           │
  alexa-     iot.tuya     LAN/UDP    Honeywell
  remote2    .com         broadcast  Home API

      ▲ (optional voice)
      │
┌─────┴────────────────────────────────────────┐
│            Alexa Smart Home Skill            │
│  managed cloud (Switchboard) — OR — self-    │
│  hosted Lambda → API server → Device Manager │
└──────────────────────────────────────────────┘
```

## Development

```bash
git clone https://github.com/johnccarroll/homebridge-alexa-sync.git
cd homebridge-alexa-sync
npm install
npm run build
npm test
```

### Adding a new provider

1. Create `src/providers/<name>/index.ts` implementing `DeviceProvider`
2. Create `src/providers/<name>/mapper.ts` for device/state mapping
3. Add config type to `src/config.ts`
4. Register in `src/platform.ts` `createProviders` method

The `DeviceProvider` interface:

```typescript
interface DeviceProvider {
  readonly id: string;
  discover(): Promise<BridgeDevice[]>;
  getState(deviceId: string): Promise<DeviceState>;
  setState(deviceId: string, state: Partial<DeviceState>): Promise<void>;
  onStateChange?(callback: (deviceId: string, state: DeviceState) => void): void;
  dispose(): void;
}
```

## License

MIT
