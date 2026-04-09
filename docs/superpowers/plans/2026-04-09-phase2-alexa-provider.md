# Phase 2: Alexa Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Alexa provider that discovers and controls Alexa-connected devices (Sengled, etc.) via `alexa-remote2`, with reliable cookie management, proper error handling, and graceful degradation.

**Architecture:** Wraps `alexa-remote2` in a promisified client class. Mapper converts between Alexa's device model (features/operations/properties) and our `BridgeDevice`/`DeviceState` types. Provider implements `DeviceProvider` interface. Cookie auth persisted to Homebridge storage directory with health monitoring. Supports lights initially, extensible to other device types via the same feature-mapping pattern.

**Tech Stack:** TypeScript, alexa-remote2 v8.x, Node.js 20+, Vitest

**Key research findings informing this plan:**
- `alexa-remote2` v8.0.4 has built-in TypeScript types and is actively maintained
- Use native methods (`executeSmarthomeDeviceAction`, `querySmarthomeDevices`, `getSmarthomeDevicesV2`) — NOT raw GraphQL
- Native `setColor` supports real HSB values (not named colors like existing plugins)
- No push events for smart home state changes — must poll
- Callback-based API — needs Promise wrappers
- Cookie auto-refresh every 4 days, proxy-based login for initial auth

---

## File Structure

```
src/providers/alexa/
├── index.ts        # AlexaProvider — implements DeviceProvider
├── client.ts       # AlexaClient — promisified wrapper around alexa-remote2
└── mapper.ts       # Maps Alexa devices/state ↔ BridgeDevice/DeviceState

test/providers/alexa/
├── index.test.ts
├── client.test.ts
└── mapper.test.ts
```

**Files modified:**
- `src/config.ts` — add `AlexaConfig` type
- `src/platform.ts` — register Alexa provider
- `config.schema.json` — add Alexa config UI
- `package.json` — add `alexa-remote2` dependency

---

### Task 1: Add alexa-remote2 Dependency and Config

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `config.schema.json`

- [ ] **Step 1: Install alexa-remote2**

Run: `npm install alexa-remote2`

- [ ] **Step 2: Add AlexaConfig to config.ts**

Add to `src/config.ts`, after the `TuyaConfig` interface:

```typescript
export interface AlexaConfig {
  amazonDomain?: string;
  proxyPort?: number;
  pollInterval?: number;
  cookieRefreshDays?: number;
  deviceTypes?: string[];
}
```

Update `PluginConfig`:

```typescript
export interface PluginConfig {
  name: string;
  providers?: {
    tuya?: TuyaConfig;
    alexa?: AlexaConfig;
  };
}
```

Update `validateConfig` — add after the tuya validation block:

```typescript
  const alexa = providers.alexa as Record<string, unknown> | undefined;
  if (alexa) {
    if (alexa.proxyPort !== undefined && typeof alexa.proxyPort !== 'number') return false;
    if (alexa.pollInterval !== undefined && typeof alexa.pollInterval !== 'number') return false;
  }
```

- [ ] **Step 3: Add Alexa section to config.schema.json**

Add inside `schema.properties.providers.properties`, after the `tuya` block:

```json
"alexa": {
  "title": "Alexa (Cookie-Based Fallback)",
  "type": "object",
  "properties": {
    "amazonDomain": {
      "title": "Amazon Domain",
      "type": "string",
      "default": "amazon.com",
      "oneOf": [
        { "title": "US (amazon.com)", "enum": ["amazon.com"] },
        { "title": "UK (amazon.co.uk)", "enum": ["amazon.co.uk"] },
        { "title": "DE (amazon.de)", "enum": ["amazon.de"] },
        { "title": "CA (amazon.ca)", "enum": ["amazon.ca"] },
        { "title": "AU (amazon.com.au)", "enum": ["amazon.com.au"] }
      ]
    },
    "proxyPort": { "title": "Auth Proxy Port", "type": "number", "default": 3456 },
    "pollInterval": { "title": "Poll Interval (seconds)", "type": "number", "default": 60 },
    "cookieRefreshDays": { "title": "Cookie Refresh Interval (days)", "type": "number", "default": 4 },
    "deviceTypes": {
      "title": "Device Types to Import",
      "type": "array",
      "items": { "type": "string" },
      "default": ["LIGHT", "SWITCH", "SMARTPLUG"]
    }
  }
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Compiles without errors

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/config.ts config.schema.json
git commit -m "feat: add alexa-remote2 dependency and AlexaConfig type"
```

---

### Task 2: Alexa Device Mapper

**Files:**
- Create: `src/providers/alexa/mapper.ts`
- Create: `test/providers/alexa/mapper.test.ts`

- [ ] **Step 1: Write mapper tests**

```typescript
// test/providers/alexa/mapper.test.ts
import { describe, it, expect } from 'vitest';
import {
  alexaDeviceToBridgeDevice,
  alexaStateToDeviceState,
  deviceStateToAlexaAction,
} from '../../../src/providers/alexa/mapper.js';

describe('alexaDeviceToBridgeDevice', () => {
  it('maps a full-featured Alexa light', () => {
    const alexaDevice = {
      id: 'amzn1.alexa.endpoint.abc123',
      friendlyName: 'Bedroom Light',
      displayCategories: { primary: { value: 'LIGHT' } },
      features: [
        { name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] },
        { name: 'brightness', operations: [{ name: 'setBrightness' }] },
        { name: 'color', operations: [{ name: 'setColor' }] },
        { name: 'colorTemperature', operations: [{ name: 'setColorTemperature' }] },
      ],
      manufacturer: 'Sengled',
      model: 'E11-G13',
    };

    const device = alexaDeviceToBridgeDevice(alexaDevice);
    expect(device).not.toBeNull();
    expect(device!.id).toBe('alexa:amzn1.alexa.endpoint.abc123');
    expect(device!.name).toBe('Bedroom Light');
    expect(device!.type).toBe('light');
    expect(device!.provider).toBe('alexa');
    expect(device!.capabilities.map(c => c.type)).toEqual(
      expect.arrayContaining(['on-off', 'brightness', 'color', 'color-temperature']),
    );
    expect(device!.manufacturer).toBe('Sengled');
  });

  it('maps a basic on/off switch', () => {
    const alexaDevice = {
      id: 'amzn1.alexa.endpoint.def456',
      friendlyName: 'Smart Plug',
      displayCategories: { primary: { value: 'SMARTPLUG' } },
      features: [
        { name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] },
      ],
    };

    const device = alexaDeviceToBridgeDevice(alexaDevice);
    expect(device).not.toBeNull();
    expect(device!.type).toBe('outlet');
    expect(device!.capabilities).toEqual([{ type: 'on-off' }]);
  });

  it('returns null for unsupported device categories', () => {
    const alexaDevice = {
      id: 'amzn1.alexa.endpoint.xyz',
      friendlyName: 'Apple TV',
      displayCategories: { primary: { value: 'APPLICATION' } },
      features: [],
    };

    expect(alexaDeviceToBridgeDevice(alexaDevice)).toBeNull();
  });

  it('filters by allowed device types', () => {
    const alexaDevice = {
      id: 'amzn1.alexa.endpoint.fan1',
      friendlyName: 'Ceiling Fan',
      displayCategories: { primary: { value: 'FAN' } },
      features: [{ name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] }],
    };

    expect(alexaDeviceToBridgeDevice(alexaDevice, ['LIGHT'])).toBeNull();
    expect(alexaDeviceToBridgeDevice(alexaDevice, ['FAN'])).not.toBeNull();
  });
});

describe('alexaStateToDeviceState', () => {
  it('maps power, brightness, color, and color temp', () => {
    const alexaState = {
      'Alexa.PowerController': { powerState: 'ON' },
      'Alexa.BrightnessController': { brightness: 75 },
      'Alexa.ColorController': { color: { hue: 240, saturation: 0.8, brightness: 1.0 } },
      'Alexa.ColorTemperatureController': { colorTemperatureInKelvin: 4000 },
    };

    const state = alexaStateToDeviceState(alexaState);
    expect(state.on).toBe(true);
    expect(state.brightness).toBe(75);
    expect(state.hue).toBe(240);
    expect(state.saturation).toBe(80);
    expect(state.colorTemperature).toBe(4000);
  });

  it('handles OFF state', () => {
    const alexaState = { 'Alexa.PowerController': { powerState: 'OFF' } };
    expect(alexaStateToDeviceState(alexaState).on).toBe(false);
  });

  it('handles empty state', () => {
    expect(alexaStateToDeviceState({})).toEqual({});
  });
});

describe('deviceStateToAlexaAction', () => {
  it('generates turnOn action', () => {
    const action = deviceStateToAlexaAction({ on: true });
    expect(action).toEqual({ action: 'turnOn' });
  });

  it('generates turnOff action', () => {
    const action = deviceStateToAlexaAction({ on: false });
    expect(action).toEqual({ action: 'turnOff' });
  });

  it('generates setBrightness action', () => {
    const action = deviceStateToAlexaAction({ brightness: 50 });
    expect(action).toEqual({ action: 'setBrightness', brightness: 50 });
  });

  it('generates setColor action with HSB', () => {
    const action = deviceStateToAlexaAction({ hue: 120, saturation: 80 });
    expect(action).toEqual({
      action: 'setColor',
      color: { hue: 120, saturation: 0.8, brightness: 1.0 },
    });
  });

  it('generates setColorTemperature action', () => {
    const action = deviceStateToAlexaAction({ colorTemperature: 4000 });
    expect(action).toEqual({
      action: 'setColorTemperature',
      colorTemperature: { value: 4000 },
    });
  });

  it('returns null for empty state', () => {
    expect(deviceStateToAlexaAction({})).toBeNull();
  });

  it('prioritizes on/off over other properties', () => {
    const action = deviceStateToAlexaAction({ on: true, brightness: 50 });
    expect(action!.action).toBe('turnOn');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/alexa/mapper.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement mapper**

```typescript
// src/providers/alexa/mapper.ts
import type { BridgeDevice, Capability, DeviceState, DeviceType } from '../../types.js';

// Alexa device types from research
interface AlexaDeviceFeature {
  name: string;
  operations: Array<{ name: string }>;
}

export interface AlexaDevice {
  id: string;
  friendlyName: string;
  displayCategories: { primary: { value: string } };
  features: AlexaDeviceFeature[];
  manufacturer?: string;
  model?: string;
  legacyAppliance?: { applianceId: string };
}

export interface AlexaDeviceState {
  [namespace: string]: Record<string, unknown>;
}

// Map Alexa display category → our DeviceType
const CATEGORY_MAP: Record<string, DeviceType> = {
  LIGHT: 'light',
  SWITCH: 'switch',
  SMARTPLUG: 'outlet',
  SMARTLOCK: 'lock',
  FAN: 'fan',
  THERMOSTAT: 'thermostat',
};

// Default allowed categories
const DEFAULT_DEVICE_TYPES = ['LIGHT', 'SWITCH', 'SMARTPLUG', 'SMARTLOCK', 'FAN', 'THERMOSTAT'];

export function alexaDeviceToBridgeDevice(
  device: AlexaDevice,
  allowedTypes?: string[],
): BridgeDevice | null {
  const category = device.displayCategories?.primary?.value;
  if (!category) return null;

  const allowed = allowedTypes ?? DEFAULT_DEVICE_TYPES;
  if (!allowed.includes(category)) return null;

  const deviceType = CATEGORY_MAP[category];
  if (!deviceType) return null;

  const featureNames = new Set(device.features.map(f => f.name));
  const capabilities: Capability[] = [];

  if (featureNames.has('power')) {
    capabilities.push({ type: 'on-off' });
  }
  if (featureNames.has('brightness')) {
    capabilities.push({ type: 'brightness', range: [0, 100] });
  }
  if (featureNames.has('color')) {
    capabilities.push({ type: 'color' });
  }
  if (featureNames.has('colorTemperature')) {
    capabilities.push({ type: 'color-temperature', range: [2200, 6500] });
  }
  if (featureNames.has('temperatureSensor')) {
    capabilities.push({ type: 'temperature', unit: 'celsius' });
  }
  if (featureNames.has('thermostat')) {
    capabilities.push({ type: 'target-temperature', range: [10, 35] });
    capabilities.push({ type: 'thermostat-mode', modes: ['heat', 'cool', 'auto', 'off'] });
  }
  if (featureNames.has('lock')) {
    capabilities.push({ type: 'lock' });
  }

  if (capabilities.length === 0) return null;

  return {
    id: `alexa:${device.id}`,
    name: device.friendlyName,
    type: deviceType,
    provider: 'alexa',
    capabilities,
    manufacturer: device.manufacturer,
    model: device.model,
  };
}

export function alexaStateToDeviceState(state: AlexaDeviceState): DeviceState {
  const result: DeviceState = {};

  const power = state['Alexa.PowerController'];
  if (power?.powerState !== undefined) {
    result.on = power.powerState === 'ON';
  }

  const brightness = state['Alexa.BrightnessController'];
  if (brightness?.brightness !== undefined) {
    result.brightness = brightness.brightness as number;
  }

  const color = state['Alexa.ColorController'];
  if (color?.color) {
    const c = color.color as { hue: number; saturation: number; brightness: number };
    result.hue = c.hue;
    result.saturation = Math.round(c.saturation * 100);
  }

  const colorTemp = state['Alexa.ColorTemperatureController'];
  if (colorTemp?.colorTemperatureInKelvin !== undefined) {
    result.colorTemperature = colorTemp.colorTemperatureInKelvin as number;
  }

  const temp = state['Alexa.TemperatureSensor'];
  if (temp?.temperature) {
    const t = temp.temperature as { value: number; scale: string };
    result.temperature = t.value;
  }

  return result;
}

export function deviceStateToAlexaAction(
  state: Partial<DeviceState>,
): Record<string, unknown> | null {
  // Only one action per call — prioritize on/off > brightness > color > colorTemp
  if (state.on !== undefined) {
    return { action: state.on ? 'turnOn' : 'turnOff' };
  }
  if (state.brightness !== undefined) {
    return { action: 'setBrightness', brightness: state.brightness };
  }
  if (state.hue !== undefined || state.saturation !== undefined) {
    return {
      action: 'setColor',
      color: {
        hue: state.hue ?? 0,
        saturation: (state.saturation ?? 100) / 100,
        brightness: 1.0,
      },
    };
  }
  if (state.colorTemperature !== undefined) {
    return {
      action: 'setColorTemperature',
      colorTemperature: { value: state.colorTemperature },
    };
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/providers/alexa/mapper.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/alexa/mapper.ts test/providers/alexa/mapper.test.ts
git commit -m "feat: add Alexa device mapper (device/state/action conversions)"
```

---

### Task 3: Alexa Client (Promisified alexa-remote2 Wrapper)

**Files:**
- Create: `src/providers/alexa/client.ts`
- Create: `test/providers/alexa/client.test.ts`

- [ ] **Step 1: Write client tests**

```typescript
// test/providers/alexa/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlexaClient, type AlexaClientConfig } from '../../../src/providers/alexa/client.js';

// Mock alexa-remote2 — it's a callback-based class
function createMockRemote() {
  return {
    init: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    cookieData: { cookie: 'test', csrf: 'test', macDms: { device_private_key: 'k', adp_token: 't' } },
    checkAuthentication: vi.fn((cb: Function) => cb(null, { authenticated: true })),
    getSmarthomeDevicesV2: vi.fn((cb: Function) => cb(null, [
      {
        id: 'amzn1.alexa.endpoint.abc',
        friendlyName: 'Test Light',
        displayCategories: { primary: { value: 'LIGHT' } },
        features: [{ name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] }],
      },
    ])),
    querySmarthomeDevices: vi.fn((_ids: any, _type: any, _timeout: any, cb: Function) => cb(null, {
      deviceStates: [{
        entity: { entityId: 'appliance-id' },
        capabilityStates: [
          JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' }),
        ],
      }],
      errors: [],
    })),
    executeSmarthomeDeviceAction: vi.fn((_ids: any, _params: any, _type: any, cb: Function) => cb(null, { controlResponses: [{}] })),
  };
}

describe('AlexaClient', () => {
  describe('discoverDevices', () => {
    it('returns devices from alexa-remote2', async () => {
      const mock = createMockRemote();
      const client = new AlexaClient.__createForTest(mock as any);

      const devices = await client.discoverDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].friendlyName).toBe('Test Light');
      expect(mock.getSmarthomeDevicesV2).toHaveBeenCalled();
    });
  });

  describe('queryDeviceState', () => {
    it('queries and parses capability states', async () => {
      const mock = createMockRemote();
      const client = new AlexaClient.__createForTest(mock as any);

      const state = await client.queryDeviceState('appliance-id');
      expect(state).toHaveProperty('Alexa.PowerController');
      expect(state['Alexa.PowerController'].powerState).toBe('ON');
    });
  });

  describe('executeAction', () => {
    it('sends action to device', async () => {
      const mock = createMockRemote();
      const client = new AlexaClient.__createForTest(mock as any);

      await client.executeAction('appliance-id', { action: 'turnOn' });
      expect(mock.executeSmarthomeDeviceAction).toHaveBeenCalledWith(
        ['appliance-id'],
        { action: 'turnOn' },
        'APPLIANCE',
        expect.any(Function),
      );
    });
  });

  describe('isAuthenticated', () => {
    it('returns true when authenticated', async () => {
      const mock = createMockRemote();
      const client = new AlexaClient.__createForTest(mock as any);

      const result = await client.isAuthenticated();
      expect(result).toBe(true);
    });

    it('returns false when not authenticated', async () => {
      const mock = createMockRemote();
      mock.checkAuthentication = vi.fn((cb: Function) => cb(null, { authenticated: false }));
      const client = new AlexaClient.__createForTest(mock as any);

      const result = await client.isAuthenticated();
      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/alexa/client.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement AlexaClient**

```typescript
// src/providers/alexa/client.ts
import AlexaRemote from 'alexa-remote2';
import type { AlexaDevice, AlexaDeviceState } from './mapper.js';

export interface AlexaClientConfig {
  amazonDomain: string;
  proxyPort: number;
  cookieRefreshDays: number;
  persistPath: string;
  logger?: (msg: string) => void;
}

interface CookieData {
  cookie?: string;
  csrf?: string;
  macDms?: { device_private_key: string; adp_token: string };
  localCookie?: string;
}

const ALEXA_SERVICE_HOSTS: Record<string, string> = {
  'amazon.com': 'pitangui.amazon.com',
  'amazon.co.uk': 'layla.amazon.co.uk',
  'amazon.de': 'layla.amazon.de',
  'amazon.ca': 'pitangui.amazon.com',
  'amazon.com.au': 'alexa.amazon.com.au',
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class AlexaClient {
  private remote: AlexaRemote;
  private initialized = false;
  private readonly config: AlexaClientConfig;

  constructor(config: AlexaClientConfig) {
    this.config = config;
    this.remote = new AlexaRemote();
  }

  /**
   * Initialize the Alexa connection. Resolves when authenticated.
   * If no stored cookie, starts proxy server for browser login.
   */
  async init(storedCookie?: CookieData): Promise<void> {
    const serviceHost = ALEXA_SERVICE_HOSTS[this.config.amazonDomain] ?? 'pitangui.amazon.com';

    return new Promise<void>((resolve, reject) => {
      this.remote.init(
        {
          acceptLanguage: 'en-US',
          amazonPage: this.config.amazonDomain,
          alexaServiceHost: serviceHost,
          cookie: storedCookie?.localCookie ?? storedCookie?.cookie,
          formerRegistrationData: storedCookie as any,
          macDms: storedCookie?.macDms as any,
          proxyOwnIp: '127.0.0.1',
          proxyPort: this.config.proxyPort,
          cookieRefreshInterval: this.config.cookieRefreshDays * ONE_DAY_MS,
          usePushConnection: false,
          useWsMqtt: false,
          logger: this.config.logger,
        } as any,
        (err: Error | null) => {
          if (err) {
            reject(new Error(`Alexa auth failed: ${err.message}`));
          } else {
            this.initialized = true;
            resolve();
          }
        },
      );
    });
  }

  /** Get stored cookie data for persistence */
  getCookieData(): CookieData | null {
    if (!this.remote.cookieData) return null;
    return this.remote.cookieData as CookieData;
  }

  /** Listen for cookie refresh events */
  onCookieRefresh(callback: (cookie: CookieData) => void): void {
    this.remote.on('cookie', (cookie: string, csrf: string, macDms: any) => {
      callback({ cookie, csrf, macDms, localCookie: cookie });
    });
  }

  /** Check if current session is authenticated */
  async isAuthenticated(): Promise<boolean> {
    return new Promise((resolve) => {
      this.remote.checkAuthentication((err: Error | null, result: any) => {
        if (err || !result?.authenticated) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /** Discover all smart home devices */
  async discoverDevices(): Promise<AlexaDevice[]> {
    return new Promise((resolve, reject) => {
      this.remote.getSmarthomeDevicesV2((err: Error | null, result: any) => {
        if (err) return reject(new Error(`Discovery failed: ${err.message}`));
        resolve(Array.isArray(result) ? result : []);
      });
    });
  }

  /** Query current state of a device */
  async queryDeviceState(applianceId: string): Promise<AlexaDeviceState> {
    return new Promise((resolve, reject) => {
      this.remote.querySmarthomeDevices(
        [applianceId],
        'APPLIANCE',
        15000,
        (err: Error | null, result: any) => {
          if (err) return reject(new Error(`State query failed: ${err.message}`));

          const state: AlexaDeviceState = {};
          const deviceState = result?.deviceStates?.[0];
          if (!deviceState?.capabilityStates) return resolve(state);

          for (const raw of deviceState.capabilityStates) {
            try {
              const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              const ns = parsed.namespace;
              if (ns) {
                if (!state[ns]) state[ns] = {};
                state[ns][parsed.name] = parsed.value;
              }
            } catch {
              // Skip malformed capability state
            }
          }
          resolve(state);
        },
      );
    });
  }

  /** Execute a control action on a device */
  async executeAction(applianceId: string, params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.remote.executeSmarthomeDeviceAction(
        [applianceId],
        params,
        'APPLIANCE',
        (err: Error | null, result: any) => {
          if (err) return reject(new Error(`Action failed: ${err.message}`));
          // Check for device-level errors
          if (result?.errors?.length > 0) {
            const errMsg = result.errors.map((e: any) => e.code).join(', ');
            return reject(new Error(`Device error: ${errMsg}`));
          }
          resolve();
        },
      );
    });
  }

  /** Cleanup */
  dispose(): void {
    // alexa-remote2 doesn't have a formal close, but we can remove listeners
    this.remote.removeAllListeners?.();
    this.initialized = false;
  }

  /** Test helper — create client with pre-injected mock remote */
  static __createForTest(mockRemote: AlexaRemote): AlexaClient {
    const client = Object.create(AlexaClient.prototype) as AlexaClient;
    (client as any).remote = mockRemote;
    (client as any).initialized = true;
    (client as any).config = { amazonDomain: 'amazon.com', proxyPort: 3456, cookieRefreshDays: 4, persistPath: '/tmp' };
    return client;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/providers/alexa/client.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/alexa/client.ts test/providers/alexa/client.test.ts
git commit -m "feat: add AlexaClient — promisified wrapper around alexa-remote2"
```

---

### Task 4: Alexa Provider

**Files:**
- Create: `src/providers/alexa/index.ts`
- Create: `test/providers/alexa/index.test.ts`

- [ ] **Step 1: Write provider tests**

```typescript
// test/providers/alexa/index.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AlexaProvider } from '../../../src/providers/alexa/index.js';
import type { AlexaClient } from '../../../src/providers/alexa/client.js';
import type { AlexaDevice } from '../../../src/providers/alexa/mapper.js';

const LIGHT_DEVICE: AlexaDevice = {
  id: 'amzn1.alexa.endpoint.abc123',
  friendlyName: 'Bedroom Light',
  displayCategories: { primary: { value: 'LIGHT' } },
  features: [
    { name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] },
    { name: 'brightness', operations: [{ name: 'setBrightness' }] },
    { name: 'color', operations: [{ name: 'setColor' }] },
    { name: 'colorTemperature', operations: [{ name: 'setColorTemperature' }] },
  ],
  manufacturer: 'Sengled',
  model: 'E11-G13',
  legacyAppliance: { applianceId: 'appliance-abc123' },
};

const APP_DEVICE: AlexaDevice = {
  id: 'amzn1.alexa.endpoint.tv1',
  friendlyName: 'Apple TV',
  displayCategories: { primary: { value: 'APPLICATION' } },
  features: [],
};

function mockClient(devices: AlexaDevice[]): AlexaClient {
  return {
    discoverDevices: vi.fn().mockResolvedValue(devices),
    queryDeviceState: vi.fn().mockResolvedValue({
      'Alexa.PowerController': { powerState: 'ON' },
      'Alexa.BrightnessController': { brightness: 75 },
    }),
    executeAction: vi.fn().mockResolvedValue(undefined),
    isAuthenticated: vi.fn().mockResolvedValue(true),
    dispose: vi.fn(),
  } as unknown as AlexaClient;
}

describe('AlexaProvider', () => {
  it('has id "alexa"', () => {
    const provider = new AlexaProvider(mockClient([]), {});
    expect(provider.id).toBe('alexa');
  });

  describe('discover', () => {
    it('discovers and maps supported devices', async () => {
      const provider = new AlexaProvider(mockClient([LIGHT_DEVICE, APP_DEVICE]), {});
      const devices = await provider.discover();

      expect(devices).toHaveLength(1);
      expect(devices[0].name).toBe('Bedroom Light');
      expect(devices[0].type).toBe('light');
      expect(devices[0].capabilities.map(c => c.type)).toContain('color');
    });

    it('filters by configured device types', async () => {
      const provider = new AlexaProvider(mockClient([LIGHT_DEVICE]), { deviceTypes: ['SWITCH'] });
      const devices = await provider.discover();
      expect(devices).toHaveLength(0);
    });

    it('stores appliance ID mapping for control', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.getState('amzn1.alexa.endpoint.abc123');
      expect(client.queryDeviceState).toHaveBeenCalledWith('appliance-abc123');
    });
  });

  describe('getState', () => {
    it('queries and maps device state', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      const state = await provider.getState('amzn1.alexa.endpoint.abc123');
      expect(state.on).toBe(true);
      expect(state.brightness).toBe(75);
    });
  });

  describe('setState', () => {
    it('maps state to action and executes', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.setState('amzn1.alexa.endpoint.abc123', { on: false });
      expect(client.executeAction).toHaveBeenCalledWith(
        'appliance-abc123',
        { action: 'turnOff' },
      );
    });

    it('sends multiple actions for compound state changes', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.setState('amzn1.alexa.endpoint.abc123', { on: true, brightness: 50 });
      expect(client.executeAction).toHaveBeenCalledTimes(2);
    });
  });

  describe('dispose', () => {
    it('disposes the client', () => {
      const client = mockClient([]);
      const provider = new AlexaProvider(client, {});
      provider.dispose();
      expect(client.dispose).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/alexa/index.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement AlexaProvider**

```typescript
// src/providers/alexa/index.ts
import type { DeviceProvider } from '../provider.js';
import type { BridgeDevice, DeviceState } from '../../types.js';
import type { AlexaClient } from './client.js';
import type { AlexaConfig } from '../../config.js';
import {
  alexaDeviceToBridgeDevice,
  alexaStateToDeviceState,
  deviceStateToAlexaAction,
  type AlexaDevice,
} from './mapper.js';

export class AlexaProvider implements DeviceProvider {
  readonly id = 'alexa';
  private readonly client: AlexaClient;
  private readonly config: Partial<AlexaConfig>;
  // Maps endpoint ID → appliance ID (needed for control/state queries)
  private readonly applianceIds = new Map<string, string>();

  constructor(client: AlexaClient, config: Partial<AlexaConfig>) {
    this.client = client;
    this.config = config;
  }

  async discover(): Promise<BridgeDevice[]> {
    const alexaDevices = await this.client.discoverDevices();
    const devices: BridgeDevice[] = [];

    for (const ad of alexaDevices) {
      const device = alexaDeviceToBridgeDevice(ad, this.config.deviceTypes);
      if (device) {
        devices.push(device);
        // Store the legacy appliance ID for control — alexa-remote2 needs it
        const applianceId = ad.legacyAppliance?.applianceId ?? ad.id;
        this.applianceIds.set(ad.id, applianceId);
      }
    }

    return devices;
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const applianceId = this.applianceIds.get(deviceId);
    if (!applianceId) throw new Error(`Unknown Alexa device: ${deviceId}`);

    const alexaState = await this.client.queryDeviceState(applianceId);
    return alexaStateToDeviceState(alexaState);
  }

  async setState(deviceId: string, state: Partial<DeviceState>): Promise<void> {
    const applianceId = this.applianceIds.get(deviceId);
    if (!applianceId) throw new Error(`Unknown Alexa device: ${deviceId}`);

    // Split compound state into individual actions
    // alexa-remote2 only supports one action per call
    const actions: Array<Record<string, unknown>> = [];

    if (state.on !== undefined) {
      actions.push({ action: state.on ? 'turnOn' : 'turnOff' });
    }
    if (state.brightness !== undefined) {
      actions.push({ action: 'setBrightness', brightness: state.brightness });
    }
    if (state.hue !== undefined || state.saturation !== undefined) {
      actions.push({
        action: 'setColor',
        color: {
          hue: state.hue ?? 0,
          saturation: (state.saturation ?? 100) / 100,
          brightness: 1.0,
        },
      });
    }
    if (state.colorTemperature !== undefined) {
      actions.push({
        action: 'setColorTemperature',
        colorTemperature: { value: state.colorTemperature },
      });
    }

    for (const action of actions) {
      await this.client.executeAction(applianceId, action);
    }
  }

  dispose(): void {
    this.client.dispose();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/providers/alexa/index.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/alexa/index.ts test/providers/alexa/index.test.ts
git commit -m "feat: add AlexaProvider with discovery, state, and multi-action control"
```

---

### Task 5: Platform Integration

**Files:**
- Modify: `src/platform.ts`

- [ ] **Step 1: Add Alexa provider to platform**

In `src/platform.ts`, add import at top:

```typescript
import { AlexaProvider } from './providers/alexa/index.js';
import { AlexaClient } from './providers/alexa/client.js';
```

Add to `createProviders` method, after the Tuya block:

```typescript
    if (config.providers?.alexa) {
      this.log.info('Initializing Alexa provider');
      const alexaClient = new AlexaClient({
        amazonDomain: config.providers.alexa.amazonDomain ?? 'amazon.com',
        proxyPort: config.providers.alexa.proxyPort ?? 3456,
        cookieRefreshDays: config.providers.alexa.cookieRefreshDays ?? 4,
        persistPath: this.api.user.storagePath(),
        logger: (msg: string) => this.log.debug('[Alexa]', msg),
      });

      // Load persisted cookie
      const cookiePath = `${this.api.user.storagePath()}/.alexa-bridge-cookie.json`;
      let storedCookie;
      try {
        const fs = await import('node:fs');
        const data = fs.readFileSync(cookiePath, 'utf8');
        storedCookie = JSON.parse(data);
      } catch {
        this.log.info('No stored Alexa cookie — proxy login required at http://127.0.0.1:' + (config.providers.alexa.proxyPort ?? 3456));
      }

      try {
        await alexaClient.init(storedCookie);
        this.log.info('Alexa authenticated');

        // Persist cookie on refresh
        alexaClient.onCookieRefresh((cookie) => {
          try {
            const fs = require('node:fs');
            fs.writeFileSync(cookiePath, JSON.stringify(cookie));
            this.log.info('Alexa cookie refreshed and saved');
          } catch (err) {
            this.log.warn('Failed to save Alexa cookie:', err);
          }
        });

        // Save initial cookie
        const cookieData = alexaClient.getCookieData();
        if (cookieData) {
          try {
            const fs = require('node:fs');
            fs.writeFileSync(cookiePath, JSON.stringify(cookieData));
          } catch { /* ignore */ }
        }

        providers.push(new AlexaProvider(alexaClient, config.providers.alexa));
      } catch (err) {
        this.log.error('Alexa initialization failed:', err);
        this.log.warn('Alexa devices will not be available. Check proxy login.');
      }
    }
```

Update `startPolling` to use provider-specific intervals:

```typescript
  private startPolling(config: PluginConfig): void {
    // Use shortest configured interval, minimum 15s
    const tuyaInterval = config.providers?.tuya?.pollInterval ?? 30;
    const alexaInterval = config.providers?.alexa?.pollInterval ?? 60;
    const interval = Math.max(15, Math.min(tuyaInterval, alexaInterval)) * 1000;
```

- [ ] **Step 2: Make createProviders async**

The `createProviders` method now uses `await` (for dynamic import of fs and alexaClient.init). Update its signature and the call in `init`:

Change `private createProviders(config: PluginConfig): DeviceProvider[]` to:
```typescript
  private async createProviders(config: PluginConfig): Promise<DeviceProvider[]> {
```

The `init` method already awaits the result pattern, so this should work as-is.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/platform.ts
git commit -m "feat: integrate Alexa provider with cookie persistence and graceful degradation"
```

---

### Task 6: End-to-End Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Build clean**

Run: `rm -rf dist && npm run build`
Expected: Clean compile, no errors

- [ ] **Step 3: Verify dist structure**

Run: `ls dist/providers/alexa/`
Expected: `index.js`, `client.js`, `mapper.js` and corresponding `.d.ts`/`.js.map` files

- [ ] **Step 4: Verify plugin loads**

Run: `node -e "import('./dist/index.js').then(m => console.log(typeof m.default))"`
Expected: `function`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: phase 2 complete — Alexa provider with cookie auth"
```
