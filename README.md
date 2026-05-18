# homebridge-alexa-sync

Two-way Homebridge ↔ Alexa sync. Bridge smart home devices into HomeKit AND control them with Alexa voice commands using a single plugin. Provider-based architecture supports multiple device backends.

Part of the [Switchboard](https://cloud.johncarroll.dev/switchboard) smart-home plugin family.

## Features

- **Two-way sync** — changes from HomeKit or Alexa propagate to the other
- **Provider architecture** — pluggable backends, drop in new ecosystems with a small interface
- **Tuya / Smart Life (preview)** — direct cloud + LAN. **Requires an active Tuya IoT Core subscription** (1-month free trial as of 2026, paid is ~$800/yr). For hobbyists with a handful of devices, the Alexa-cookie path below is usually the better fit.
- **Alexa cookie** — controls anything paired to your Alexa account (Smart Life link, Sengled, etc.) by talking to Alexa's smart-home API. The pragmatic primary path now that Tuya's free tier shrank.
- **Resideo / Honeywell Home** — thermostats and locks via official OAuth API
- **Voice control via Alexa** — optional, two paths (managed cloud OR self-hosted Lambda)
- **Full light control** — on/off, brightness, color (HSB), color temperature

## Quick start

```bash
npm install -g homebridge-alexa-sync
```

Add to your Homebridge `config.json` `platforms` array:

```json
{
  "platform": "AlexaSync",
  "name": "Alexa Sync",
  "providers": {
    "tuya": {
      "accessId": "YOUR_TUYA_ACCESS_ID",
      "accessKey": "YOUR_TUYA_ACCESS_KEY",
      "region": "us"
    }
  }
}
```

The plugin is **fully free locally**. Voice control via Alexa is optional — see below for the two paths.

## Provider configuration

### Tuya / Smart Life (preview)

> **Pricing reality check (May 2026):** Tuya's free IoT Core trial is **1 month**. After that, the paid tier starts at **~$800/year**. If you only have a handful of devices, skipping the Tuya provider and using the Alexa-cookie path instead (everything in your Smart Life app is already in your Alexa account — see the "Alexa cookie" section below) is usually the better trade. The Tuya provider stays in the codebase but is marked as preview: useful for the niche where someone already has an active subscription or paid plan, otherwise expect cloud calls to fail with `28841002 subscription expired` after the trial.

If you do have an active subscription:

1. Create a developer account at [iot.tuya.com](https://iot.tuya.com)
2. Create a Cloud Project (Smart Home, US/CA → **Western America** data center)
3. Link your Smart Life app account to the project (Devices → Link Tuya App Account → scan QR with Smart Life app)
4. Enable the **IoT Core** and **Smart Home Device Management** API services
5. Copy your **Access ID** and **Access Key** from the project overview

| Option | Description | Default |
|---|---|---|
| `accessId` | Tuya Cloud API Access ID | (required) |
| `accessKey` | Tuya Cloud API Access Key | (required) |
| `region` | `us`, `eu`, `cn`, or `in` | `us` |
| `pollInterval` | State poll fallback (seconds); ignored when Pulsar push works | `30` |

#### LAN mode (recommended — survives cloud trial expiry)

Tuya's IoT Core trial is 6 months at a time. Once it expires, the cloud API returns `No permissions. Your subscription to cloud development plan has expired.` and the plugin loses control of every Tuya device. To insulate yourself, extract each device's local key once while the cloud is alive, then talk to devices directly on your LAN going forward.

```bash
# On a machine with this repo checked out; cloud must be active.
TUYA_ACCESS_ID=xxx TUYA_ACCESS_KEY=yyy TUYA_REGION=us \
  node scripts/extract-tuya-keys.mjs > tuya-local.json

# Copy to the Homebridge storage path on the Pi.
scp tuya-local.json pi@homebridge.local:/var/lib/homebridge/tuya-local.json
```

Restart Homebridge. The log will say `Initializing Tuya provider (LAN, N devices)` and the plugin will use the direct LAN protocol via [`tuyapi`](https://github.com/codetheweb/tuyapi) instead of the cloud. Re-run the extraction script whenever you add new Tuya devices.

**Limitations of first-pass LAN mode (subject to change):**
- Assumes the standard Tuya light DPS layout (`1`=switch, `2`=mode, `3`=brightness, `4`=temp, `5`=color). Most cloud-provisioned bulbs use this — odd devices may need a custom map.
- No Pulsar push — state polling only (`pollInterval` still applies).
- Device IP is auto-discovered on first connect; if your LAN has multicast issues you can pin an `ip` per device in `tuya-local.json`.

### Alexa cookie (recommended primary for Tuya-via-Smart-Life users)

If your Tuya/Smart Life devices are already linked to Alexa (Alexa app → Devices → "+" → Link a service → Smart Life), the Alexa cookie provider sees them all through Alexa's smart-home API and gives you full HomeKit control without ever touching Tuya's dev console. This is the path most hobbyists want.

**Sign-in is one click inside the Homebridge UI:**

1. Open the Homebridge web UI → Plugins → Alexa Sync → **Settings**. The plugin ships a custom UI tab with a single "Sign in with Amazon" button.
2. Click it. A popup opens to the real Amazon login page (proxied through the plugin so the cookie is captured on return).
3. Enter your Amazon password and your **authenticator-app** 2FA code. (SMS 2FA does not currently work with Amazon's proxy flow — switch to an authenticator app on your Amazon security settings if you have not already.)
4. The popup closes itself when the login succeeds; the settings tab updates to *"Signed in"* and writes `.alexa-sync-cookie.json` to your Homebridge storage path.
5. Enable the Alexa provider in your config (`{ "amazonDomain": "amazon.com" }` is enough — no proxy fields), then restart Homebridge. The plugin authenticates with the captured cookie and discovers every device in your Alexa account.

The plugin auto-refreshes the cookie every 4 days while running. If Amazon forces a re-login (password change, suspicious-activity flag, etc.), the settings tab will say *"Not signed in"* — click the button again.

**Headless fallback (no Homebridge UI access).** If you cannot reach the Homebridge UI from a browser, there is a manual CLI path: log into amazon.com in Chrome, copy the `Cookie:` request header from devtools, then run `node scripts/build-alexa-cookie.mjs --cookie '<string>' > cookie.json` and `scp` it to `<homebridge-storage>/.alexa-sync-cookie.json`. The script fetches the CSRF token from `alexa.amazon.com/api/language` and writes the JSON in the format the plugin reads.

### Resideo / Honeywell Home

1. Sign up at [developer.resideo.com](https://developer.resideo.com), get your app approved (1–2 weeks)
2. Create an app, set redirect URI to `http://localhost:3457/callback`
3. Run the OAuth flow once to get a refresh token, paste into config

## Voice control via Alexa (optional)

Two paths — pick one:

### Path A — Switchboard managed cloud ($3/mo, 3 minutes to set up)

Sponsor [@johnccarroll on GitHub Sponsors](https://github.com/sponsors/johnccarroll), enable the "Homebridge Sync" skill in your Alexa app, paste the supporter token from `https://cloud.johncarroll.dev/switchboard` into the plugin's **Supporter License** field. Done.

The plugin verifies the token offline against an embedded Ed25519 public key — your device data and email **never leave your network**. Cancel the sponsorship anytime; tokens last 35 days.

### Path B — Self-hosted Lambda (advanced, free, ~2 hours)

You run your own AWS Lambda + Alexa Smart Home Skill. Lambda → Tailscale Funnel → your Pi.

1. **Create AWS Lambda** in `us-east-1`:
   - Runtime: Node.js 20.x
   - Paste code from `alexa-lambda/index.mjs` (shipped in this package)
   - Env vars: `BRIDGE_URL` (your Tailscale Funnel URL), `BRIDGE_API_KEY` (matches `alexaSkill.apiKey` in config)
   - Timeout: 15 seconds

2. **Create Alexa Smart Home Skill** at [developer.amazon.com/alexa/console/ask](https://developer.amazon.com/alexa/console/ask):
   - Type: Smart Home, Payload v3
   - Set your Lambda ARN as the endpoint
   - Add Alexa Smart Home trigger to Lambda with the Skill ID

3. **Account linking** with Login with Amazon (LWA):
   - Create a Security Profile at [developer.amazon.com/loginwithamazon](https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html)
   - Add Alexa Redirect URLs to the security profile's Allowed Return URLs
   - Skill account-linking config: Auth URI `https://www.amazon.com/ap/oa`, Token URI `https://api.amazon.com/auth/o2/token`, scope `profile`

4. Set `alexaSkill.enabled: true`, `alexaSkill.apiPort: 9090`, `alexaSkill.apiKey: <random>` in your config

5. Enable the skill in the Alexa app (Your Skills → Dev tab) and link your account

6. **"Alexa, discover devices"**

| Option | Description | Default |
|---|---|---|
| `enabled` | Enable the local API server (path B only) | `false` |
| `apiPort` | Port for the local API server | `9090` |
| `apiKey` | Shared secret between Lambda and plugin | (required when enabled) |

## Architecture

```
┌──────────────────────────────────────────────┐
│              homebridge-alexa-sync           │
│             (Homebridge platform)            │
├──────────────────────────────────────────────┤
│              Device Manager                  │
│   discovery, state cache, deduplication      │
├────────┬───────────┬────────────┬────────────┤
│  Tuya  │  Alexa    │  Resideo   │  Future    │
└───┬────┴─────┬─────┴─────┬──────┴────────────┘
    │          │           │
 Tuya Cloud  alexa-      Honeywell
 API + Pulsar remote2    OAuth API
              cookie

      ▲ (optional voice)
      │
┌─────┴────────────────────────────────────────┐
│            Alexa Smart Home Skill            │
│  managed cloud (Switchboard) — OR — self-     │
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
