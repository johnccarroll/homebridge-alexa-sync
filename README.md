# homebridge-alexa-bridge

Two-way bridge between Homebridge and Alexa with provider-based device support. Control your smart home devices from both HomeKit and Alexa with a single plugin.

## Features

- **Two-way sync** — changes from HomeKit or Alexa propagate to the other
- **Provider architecture** — supports multiple device backends, each as a pluggable provider
- **Tuya / Smart Life** — direct cloud API control (no cookie scraping)
- **Alexa fallback** — cookie-based control for devices only accessible through Alexa (e.g., Sengled Zigbee bulbs paired to Echo)
- **Alexa Smart Home Skill** — optional AWS Lambda enables Alexa voice control of all bridged devices
- **Device deduplication** — devices available via direct API are preferred over Alexa fallback
- **Full light control** — on/off, brightness, color (HSB), color temperature

## Supported Devices

| Provider | Device Types | Connection |
|----------|-------------|------------|
| **Tuya / Smart Life** | Lights (full color + temp) | Tuya Cloud API (stable, official) |
| **Alexa** (fallback) | Lights, switches, plugs, thermostats, locks, fans | Cookie-based (requires periodic re-auth) |

## Installation

### From npm (when published)

```bash
npm install -g homebridge-alexa-bridge
```

### From local tarball

```bash
npm run build
npm pack
# Copy tarball to your Homebridge Pi, then:
npm install -g /path/to/homebridge-alexa-bridge-0.1.0.tgz
```

## Configuration

Add to your Homebridge `config.json` `platforms` array:

```json
{
    "platform": "AlexaBridge",
    "name": "Alexa Bridge",
    "providers": {
        "tuya": {
            "accessId": "YOUR_TUYA_ACCESS_ID",
            "accessKey": "YOUR_TUYA_ACCESS_KEY",
            "region": "us",
            "pollInterval": 30
        },
        "alexa": {
            "amazonDomain": "amazon.com",
            "proxyHost": "homebridge.local",
            "proxyPort": 3456,
            "pollInterval": 60,
            "cookieRefreshDays": 4,
            "deviceTypes": ["LIGHT", "SWITCH", "SMARTPLUG", "THERMOSTAT"]
        }
    },
    "alexaSkill": {
        "enabled": true,
        "apiPort": 9090,
        "apiKey": "your-generated-api-key"
    }
}
```

### Provider Configuration

#### Tuya / Smart Life

1. Create a developer account at [iot.tuya.com](https://iot.tuya.com)
2. Create a Cloud Project (Smart Home, your regional data center)
3. Link your Smart Life app account to the project (Devices > Link Tuya App Account > scan QR code with Smart Life app)
4. Enable the **IoT Core** API service
5. Copy your **Access ID** and **Access Key** from the project overview

**Data center selection:** US/Canada = Western America. See [Tuya data center docs](https://developer.tuya.com/en/docs/iot/oem-app-data-center-distributed?id=Kafi0ku9l07qb).

| Option | Description | Default |
|--------|-------------|---------|
| `accessId` | Tuya Cloud API Access ID | (required) |
| `accessKey` | Tuya Cloud API Access Key | (required) |
| `region` | `us`, `eu`, `cn`, or `in` | `us` |
| `pollInterval` | State poll interval in seconds | `30` |

#### Alexa (Cookie-Based Fallback)

For devices that can only be controlled through Alexa (e.g., Sengled Zigbee bulbs paired directly to Echo).

1. Enable the Alexa provider in config
2. Start Homebridge — it will log a URL like `http://homebridge.local:3456/`
3. Open that URL in your browser and log in with your Amazon account
4. The cookie is saved automatically. Restart Homebridge to discover devices.
5. Cookie auto-refreshes every 4 days. If auth fails, delete `.alexa-bridge-cookie.json` from your Homebridge storage directory and re-login.

| Option | Description | Default |
|--------|-------------|---------|
| `amazonDomain` | `amazon.com`, `amazon.co.uk`, `amazon.de`, etc. | `amazon.com` |
| `proxyHost` | IP/hostname for the login proxy (must be accessible from your browser) | `homebridge.local` |
| `proxyPort` | Port for the login proxy | `3456` |
| `pollInterval` | State poll interval in seconds | `60` |
| `cookieRefreshDays` | Cookie refresh interval in days | `4` |
| `deviceTypes` | Alexa device categories to import | `["LIGHT","SWITCH","SMARTPLUG"]` |

### Alexa Smart Home Skill (Two-Way Sync)

Enables Alexa voice control ("Alexa, turn on Kitchen Light") for all devices managed by the plugin.

#### Prerequisites

- AWS account (Lambda free tier covers this permanently)
- Alexa Developer account (same Amazon account as your Echo)
- Tailscale Funnel or similar tunnel (so Lambda can reach your Pi)

#### Setup

1. **Create AWS Lambda** in `us-east-1`:
   - Runtime: Node.js 20.x
   - Paste code from `alexa-lambda/index.mjs`
   - Set environment variables: `BRIDGE_URL` (your Tailscale Funnel URL), `BRIDGE_API_KEY` (matches your config)
   - Timeout: 15 seconds

2. **Create Alexa Smart Home Skill** at [developer.amazon.com/alexa/console/ask](https://developer.amazon.com/alexa/console/ask):
   - Type: Smart Home, Payload v3
   - Set your Lambda ARN as the endpoint
   - Add Alexa Smart Home trigger to Lambda with the Skill ID

3. **Set up Account Linking** with Login with Amazon (LWA):
   - Create a Security Profile at [developer.amazon.com/loginwithamazon](https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html)
   - Add Alexa Redirect URLs to the security profile's Allowed Return URLs
   - Configure account linking in the skill: Auth URI `https://www.amazon.com/ap/oa`, Token URI `https://api.amazon.com/auth/o2/token`, scope `profile`

4. **Enable the skill** in the Alexa app (Your Skills > Dev tab) and link your account

5. **"Alexa, discover devices"**

| Option | Description | Default |
|--------|-------------|---------|
| `enabled` | Enable the API server | `false` |
| `apiPort` | Port for the local API server | `9090` |
| `apiKey` | Shared secret between Lambda and plugin | (required when enabled) |

## Architecture

```
┌──────────────────────────────────────────────┐
│            homebridge-alexa-bridge            │
│             (Homebridge Platform)             │
├──────────────────────────────────────────────┤
│              Device Manager                   │
│    discovery, state cache, deduplication      │
├────────────┬────────────┬────────────────────┤
│   Tuya     │   Alexa    │  Future providers  │
│  Provider  │  Provider  │  (Resideo, etc.)   │
└─────┬──────┴─────┬──────┴────────────────────┘
      │            │
  Tuya Cloud   alexa-remote2
  API (stable)  (cookie-based)

      ▲ (optional)
      │
┌─────┴────────────────────────────────────────┐
│        Alexa Smart Home Skill                 │
│   AWS Lambda → API Server → Device Manager    │
└──────────────────────────────────────────────┘
```

## Development

```bash
git clone https://github.com/johnccarroll/homebridge-alexa-bridge.git
cd homebridge-alexa-bridge
npm install
npm run build
npm test
```

### Adding a New Provider

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
