# homebridge-alexa-bridge — Design Spec

A Homebridge platform plugin that bridges smart home devices to both HomeKit and Alexa with true two-way sync. Provider-based architecture supports any device backend. Ships with Tuya, Resideo, and Alexa (cookie-based) providers. Optional Alexa Smart Home Skill enables voice control and proactive state reporting.

## Goals

- **Two-way sync**: changes from HomeKit or Alexa propagate to the other instantly
- **Reliable**: direct device APIs wherever possible, cookie scraping only as fallback
- **Scalable**: new device types and providers added without touching core code
- **Distributable**: publishable to Homebridge plugin registry, clean config UX
- **Lean**: minimal dependencies, no abstractions beyond what's needed

## Non-Goals

- Replacing Homebridge itself (we're a plugin, not a platform)
- Matter support (future consideration when ecosystem matures)
- GUI configuration (use Homebridge UI's JSON config editor)

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                homebridge-alexa-bridge                │
│                 (Homebridge Platform)                 │
├──────────────────────────────────────────────────────┤
│                   Platform Core                       │
│          register providers, manage lifecycle         │
├──────────────────────────────────────────────────────┤
│                   Device Manager                      │
│     discovery orchestration, accessory registry,      │
│     state cache, dedup, HomeKit mapping               │
├───────────┬───────────┬───────────┬──────────────────┤
│   Tuya    │  Resideo  │   Alexa   │   (new provider) │
│  Provider │  Provider │  Provider │                  │
└─────┬─────┴─────┬─────┴─────┬─────┴──────────────────┘
      │           │           │
      ▼           ▼           ▼
  Tuya Cloud   Resideo    alexa-remote2
  / LAN API    Cloud API  (cookie-based)

      ▲ (optional)
      │
┌─────┴────────────────────────────────────────────────┐
│            Alexa Smart Home Skill                     │
│  AWS Lambda (proxy) → Vercel Function → Plugin API    │
│  Handles: Discovery, Control, StateReport, ChangeReport│
└──────────────────────────────────────────────────────┘
```

### Data Flow

**HomeKit → Device:**
1. User toggles light in Home app
2. Homebridge calls accessory's `set` handler
3. Device Manager routes to correct provider
4. Provider calls device API
5. On success, state cache updated, Alexa ChangeReport sent (if skill enabled)

**Alexa → Device (via Smart Home Skill):**
1. User says "Alexa, turn on living room light"
2. Lambda proxies directive to Vercel Function
3. Vercel Function calls plugin's local API (WebSocket or HTTP)
4. Plugin routes to provider, executes command
5. State cache updated, HomeKit characteristic updated

**Device → Both (state poll):**
1. Provider polls device state on interval
2. If state changed, cache updated
3. HomeKit characteristic updated (triggers UI refresh)
4. Alexa ChangeReport sent (if skill enabled)

---

## Provider Interface

```typescript
// src/providers/provider.ts

interface DeviceProvider {
  readonly id: string;

  /** Discover all devices this provider can reach */
  discover(): Promise<BridgeDevice[]>;

  /** Get current state of a device */
  getState(deviceId: string): Promise<DeviceState>;

  /** Set device state. Resolves when confirmed. */
  setState(deviceId: string, state: Partial<DeviceState>): Promise<void>;

  /** Subscribe to state changes (for providers that support push) */
  onStateChange?(callback: (deviceId: string, state: DeviceState) => void): void;

  /** Cleanup connections */
  dispose(): void;
}
```

### Device Model

```typescript
// src/types.ts

type DeviceType = 'light' | 'thermostat' | 'switch' | 'lock' | 'fan' | 'outlet';

interface BridgeDevice {
  id: string;              // unique across providers: `${providerId}:${deviceId}`
  name: string;            // friendly name
  type: DeviceType;
  provider: string;        // provider id
  capabilities: Capability[];
  manufacturer?: string;
  model?: string;
  firmware?: string;
}

type Capability =
  | { type: 'on-off' }
  | { type: 'brightness'; range: [number, number] }
  | { type: 'color' }                              // HSB
  | { type: 'color-temperature'; range: [number, number] }  // kelvin
  | { type: 'temperature'; unit: 'celsius' | 'fahrenheit' }
  | { type: 'target-temperature'; range: [number, number] }
  | { type: 'thermostat-mode'; modes: string[] }
  | { type: 'lock' };

interface DeviceState {
  on?: boolean;
  brightness?: number;        // 0-100
  hue?: number;               // 0-360
  saturation?: number;        // 0-100
  colorTemperature?: number;  // kelvin
  temperature?: number;       // current temp (read-only)
  targetTemperature?: number;
  thermostatMode?: string;
  locked?: boolean;
}
```

### Capability → HomeKit Mapping

Each `DeviceType` maps to a HomeKit service, and each `Capability` maps to characteristics on that service:

| DeviceType | HomeKit Service |
|---|---|
| light | Lightbulb |
| thermostat | Thermostat |
| switch | Switch |
| lock | LockMechanism |
| fan | Fanv2 |
| outlet | Outlet |

| Capability | HomeKit Characteristic | Conversion |
|---|---|---|
| on-off | On | direct boolean |
| brightness | Brightness | direct 0-100 |
| color | Hue, Saturation | direct (HSB) |
| color-temperature | ColorTemperature | kelvin → mireds: 1000000/k |
| temperature | CurrentTemperature | direct |
| target-temperature | TargetTemperature | direct |
| thermostat-mode | TargetHeatingCoolingState | map strings to enum |
| lock | LockCurrentState, LockTargetState | map boolean to enum |

### Capability → Alexa Mapping

| Capability | Alexa Interface |
|---|---|
| on-off | Alexa.PowerController |
| brightness | Alexa.BrightnessController |
| color | Alexa.ColorController |
| color-temperature | Alexa.ColorTemperatureController |
| temperature | Alexa.TemperatureSensor |
| target-temperature | Alexa.ThermostatController |
| thermostat-mode | Alexa.ThermostatController |
| lock | Alexa.LockController |

---

## Providers

### Tuya Provider

**Auth:** Tuya Cloud API OAuth 2.0 via `iot.tuya.com`. User provides `accessId`, `accessKey`, and links their Smart Life account.

**Discovery:** Tuya Cloud API `/v2.0/cloud/thing/device` returns all linked devices with DPs (data points).

**Control:** Tuya Cloud API `/v2.0/cloud/thing/{deviceId}/shadow/properties/issue` for setting DPs.

**State:** Poll via Cloud API. Optional local LAN control via Tuya's encrypted UDP protocol (port 6668) if `localKeys` are provided in config — faster, no cloud dependency.

**Light DP mapping:**
- DP 20: on/off (boolean)
- DP 21: mode (white/colour/scene/music)
- DP 22: brightness (10-1000, scale to 0-100)
- DP 23: color temperature (0-1000, scale to kelvin range)
- DP 24: color (HSV hex string, parse to h/s/v)

**Config:**
```json
{
  "tuya": {
    "accessId": "string",
    "accessKey": "string",
    "region": "us | eu | cn | in",
    "pollInterval": 30,
    "localKeys": {
      "deviceId": "localKey"
    }
  }
}
```

### Resideo Provider

**Auth:** Resideo Cloud API OAuth 2.0 via `developer.resideo.com`. User provides `consumerKey` and `refreshToken` (obtained via one-time OAuth flow).

**Discovery:** `/v2/devices/thermostats` returns all thermostats with location info.

**Control:** `/v2/devices/thermostats/{deviceId}` PUT with desired state.

**State:** Poll via Cloud API. Token auto-refresh every 30 minutes.

**Config:**
```json
{
  "resideo": {
    "consumerKey": "string",
    "consumerSecret": "string",
    "refreshToken": "string",
    "pollInterval": 60
  }
}
```

### Alexa Provider (Cookie-Based Fallback)

**Auth:** `alexa-remote2` with proxy-based Amazon login. Cookies stored in Homebridge persist directory. Auto-refresh every 4 days.

**Discovery:** GraphQL query to `/nexus/v1/graphql` (same as `homebridge-alexa-smarthome`).

**Control:** GraphQL mutations for power, brightness, color temperature. REST fallback for color (named color limitation).

**State:** Poll via GraphQL with configurable interval (default 60s). Longer interval than direct providers due to rate sensitivity.

**Improvements over existing plugin:**
- Cookie stored with encryption at rest
- Configurable retry with exponential backoff on 401
- Health status exposed via Homebridge UI (cookie age, last successful refresh)
- Graceful degradation: if auth fails, devices go "not responding" instead of crashing the plugin
- Device type filtering: skip unsupported types silently instead of throwing

**Color handling:** Use true HSB values via Tuya-style color commands where possible. Fall back to named colors only for devices that require it (detected during discovery).

**Config:**
```json
{
  "alexa": {
    "amazonDomain": "amazon.com",
    "proxyPort": 3456,
    "pollInterval": 60,
    "cookieRefreshDays": 4,
    "deviceTypes": ["LIGHT", "SWITCH", "SMARTPLUG"]
  }
}
```

### Adding a New Provider

1. Create `src/providers/<name>/index.ts` implementing `DeviceProvider`
2. Add config schema to `src/config.ts`
3. Register in `src/platform.ts` provider map

That's it. No changes to Device Manager, HomeKit mapping, or Alexa Skill.

---

## Alexa Smart Home Skill (Two-Way Sync)

Optional component. When enabled, Alexa can discover and control all devices managed by the plugin.

### Components

1. **AWS Lambda** (~30 lines): receives Alexa directives, forwards JSON to Vercel Function endpoint, returns response. Deployed once, never changes.

2. **Vercel Function** (`/api/alexa`): handles Smart Home Skill API v3 directives:
   - `Alexa.Discovery.Discover` → queries Device Manager for all devices, returns Alexa endpoint format
   - `Alexa.PowerController.TurnOn/TurnOff` → routes to provider
   - `Alexa.BrightnessController.SetBrightness` → routes to provider
   - `Alexa.ColorController.SetColor` → routes to provider
   - `Alexa.ColorTemperatureController.SetColorTemperature` → routes to provider
   - `Alexa.ThermostatController.SetTargetTemperature` → routes to provider
   - `Alexa.ReportState` → reads state cache, returns current values

3. **Plugin ↔ Vercel communication**: plugin opens a WebSocket connection to the Vercel backend on startup. Directives flow down, responses flow up. If WebSocket drops, falls back to HTTP polling.

4. **Proactive State Reporting**: when a device state changes (from HomeKit or polling), plugin sends a ChangeReport to the Alexa Event Gateway via the Vercel Function (which holds the LWA tokens).

### Auth

- **Alexa ↔ Lambda**: Amazon handles this (skill registration)
- **Lambda ↔ Vercel**: shared secret in environment variables
- **Vercel ↔ Plugin**: API key generated during plugin setup, stored in Homebridge config
- **Alexa Event Gateway**: LWA (Login with Amazon) OAuth tokens, managed by Vercel Function

### Skill Setup (One-Time)

1. Create Alexa Smart Home Skill in Developer Console (dev mode, personal use)
2. Deploy Lambda with Vercel Function URL
3. Link Amazon account via LWA
4. Enable skill on your Alexa account
5. "Alexa, discover devices"

We'll provide a setup script/guide that walks through this.

---

## Project Structure

```
homebridge-alexa-bridge/
├── src/
│   ├── platform.ts              # Homebridge platform registration
│   ├── device-manager.ts        # Discovery orchestration, accessory registry, state cache
│   ├── accessory.ts             # HomeKit accessory factory (maps capabilities → services)
│   ├── types.ts                 # BridgeDevice, DeviceState, Capability types
│   ├── config.ts                # Config schema and validation
│   ├── providers/
│   │   ├── provider.ts          # DeviceProvider interface
│   │   ├── tuya/
│   │   │   ├── index.ts         # TuyaProvider
│   │   │   └── api.ts           # Tuya Cloud API client
│   │   ├── resideo/
│   │   │   ├── index.ts         # ResideoProvider
│   │   │   └── api.ts           # Resideo Cloud API client
│   │   └── alexa/
│   │       ├── index.ts         # AlexaProvider
│   │       └── remote.ts        # alexa-remote2 wrapper with retry/recovery
│   └── alexa-skill/
│       ├── handler.ts           # Directive → provider routing
│       └── state-reporter.ts    # ChangeReport sender
├── alexa-lambda/
│   └── index.mjs               # Thin AWS Lambda proxy
├── vercel/
│   └── api/
│       └── alexa.ts             # Vercel Function for Smart Home Skill
├── package.json
├── tsconfig.json
└── config.schema.json           # Homebridge UI config schema
```

## Dependencies

| Package | Purpose |
|---|---|
| `alexa-remote2` | Alexa cookie-based API (Alexa provider only) |
| `ws` | WebSocket client for plugin ↔ Vercel communication |
| None others | Tuya and Resideo API clients built in-house with `fetch` — no SDK bloat |

Homebridge provides `hap-nodejs` types. Node 20+ provides native `fetch`, `crypto`, `WebSocket`.

## Testing Strategy

- **Unit tests**: each provider tested in isolation with mocked API responses
- **Integration tests**: full discovery → state → control flow against mock servers
- **Manual testing**: real devices on John's Pi

---

## Phase Plan

**Phase 1 — Core + Tuya (MVP)**
- Platform registration, Device Manager, accessory factory
- Tuya provider (cloud API)
- HomeKit control of Tuya lights (on/off, brightness, color, color temp)

**Phase 2 — Resideo + Alexa Provider**
- Resideo provider for thermostat
- Alexa provider (cookie-based) for Sengled/other Alexa-only devices
- Full HomeKit control of all device types

**Phase 3 — Alexa Smart Home Skill (Two-Way)**
- AWS Lambda + Vercel Function
- Discovery, control directives
- Proactive state reporting (ChangeReports)
- Full two-way sync

**Phase 4 — Polish for Distribution**
- `config.schema.json` for Homebridge UI
- README with setup guides
- npm publish to Homebridge plugin registry
- Error handling, logging, health monitoring
