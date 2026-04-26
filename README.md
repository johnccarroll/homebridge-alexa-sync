# homebridge-alexa-sync

Two-way Homebridge ↔ Alexa sync. Bridge smart home devices into HomeKit AND control them with Alexa voice commands using a single plugin. Provider-based architecture supports multiple device backends.

Part of the [Switchboard](https://cloud.johncarroll.dev/switchboard) smart-home plugin family.

## Features

- **Two-way sync** — changes from HomeKit or Alexa propagate to the other
- **Provider architecture** — pluggable backends, drop in new ecosystems with a small interface
- **Tuya / Smart Life** — direct cloud API control (no cookie scraping)
- **Alexa fallback** — cookie-based control for devices only accessible through Alexa (e.g. Sengled Zigbee bulbs paired to Echo)
- **Resideo / Honeywell Home** — thermostats and locks via official OAuth API
- **Voice control via Alexa** — optional, two paths (managed cloud OR self-hosted Lambda)
- **Device deduplication** — direct API providers preferred over Alexa fallback
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

### Tuya / Smart Life

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

### Alexa (cookie-based fallback)

For devices only controllable through Alexa (e.g. Sengled Zigbee bulbs paired directly to Echo).

1. Enable the Alexa provider in config
2. Start Homebridge — it logs a URL like `http://homebridge.local:3456/`
3. Open that URL in your browser, log in with your Amazon account
4. Cookie is saved automatically. Restart Homebridge to discover devices.
5. Cookie auto-refreshes every 4 days. If auth fails, delete `.alexa-sync-cookie.json` from your Homebridge storage directory and re-login.

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
