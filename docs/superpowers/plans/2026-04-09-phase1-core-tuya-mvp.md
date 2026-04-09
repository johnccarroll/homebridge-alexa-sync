# Phase 1: Core + Tuya MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Homebridge platform plugin that discovers Tuya/Smart Life lights and exposes them to HomeKit with full control (on/off, brightness, color, color temperature).

**Architecture:** Provider-based Homebridge dynamic platform plugin. Core handles platform registration, device management, and HomeKit accessory mapping. Tuya provider talks to Tuya Cloud API v1.0 using native `fetch` with HMAC-SHA256 signing. No third-party SDKs.

**Tech Stack:** TypeScript, Node.js 20+, Homebridge 2.x, Tuya Cloud API, Vitest

---

## File Structure

```
homebridge-alexa-bridge/
├── src/
│   ├── index.ts                 # Plugin entry — registers platform with Homebridge
│   ├── settings.ts              # Constants: PLATFORM_NAME, PLUGIN_NAME
│   ├── types.ts                 # BridgeDevice, DeviceState, Capability, DeviceType
│   ├── config.ts                # Config type definition and validation
│   ├── platform.ts              # AlexaBridgePlatform — DynamicPlatformPlugin
│   ├── device-manager.ts        # Discovery orchestration, state cache, provider routing
│   ├── accessory.ts             # HomeKit accessory factory — maps capabilities to services
│   └── providers/
│       ├── provider.ts          # DeviceProvider interface
│       └── tuya/
│           ├── index.ts         # TuyaProvider — implements DeviceProvider
│           ├── api.ts           # TuyaApi — auth, signing, HTTP client
│           └── mapper.ts        # Maps Tuya DPs ↔ BridgeDevice/DeviceState
├── test/
│   ├── types.test.ts
│   ├── device-manager.test.ts
│   ├── accessory.test.ts
│   └── providers/
│       └── tuya/
│           ├── api.test.ts
│           ├── mapper.test.ts
│           └── index.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── config.schema.json
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/settings.ts`
- Create: `src/index.ts` (stub)
- Create: `config.schema.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "homebridge-alexa-bridge",
  "displayName": "Alexa Bridge",
  "version": "0.1.0",
  "description": "Two-way bridge between Homebridge and Alexa with provider-based device support",
  "type": "module",
  "main": "dist/index.js",
  "keywords": ["homebridge-plugin"],
  "license": "MIT",
  "engines": {
    "node": "^20.18.0 || ^22.10.0 || ^24.0.0",
    "homebridge": "^1.8.0 || ^2.0.0-beta.0"
  },
  "scripts": {
    "build": "rimraf ./dist && tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "npm run build"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "homebridge": "^2.0.0-beta.55",
    "rimraf": "^6.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "rootDir": "src",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 4: Create src/settings.ts**

```typescript
export const PLATFORM_NAME = 'AlexaBridge';
export const PLUGIN_NAME = 'homebridge-alexa-bridge';
```

- [ ] **Step 5: Create src/index.ts (stub)**

```typescript
import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings.js';

export default (api: API) => {
  // Platform class will be added in Task 8
  api.registerPlatform(PLATFORM_NAME, class {} as any);
};
```

- [ ] **Step 6: Create config.schema.json**

```json
{
  "pluginAlias": "AlexaBridge",
  "pluginType": "platform",
  "singular": true,
  "schema": {
    "type": "object",
    "required": ["name"],
    "properties": {
      "name": {
        "title": "Name",
        "type": "string",
        "default": "Alexa Bridge"
      },
      "providers": {
        "title": "Providers",
        "type": "object",
        "properties": {
          "tuya": {
            "title": "Tuya / Smart Life",
            "type": "object",
            "properties": {
              "accessId": { "title": "Access ID", "type": "string" },
              "accessKey": { "title": "Access Key", "type": "string" },
              "region": {
                "title": "Region",
                "type": "string",
                "oneOf": [
                  { "title": "US", "enum": ["us"] },
                  { "title": "EU", "enum": ["eu"] },
                  { "title": "CN", "enum": ["cn"] },
                  { "title": "IN", "enum": ["in"] }
                ],
                "default": "us"
              },
              "pollInterval": { "title": "Poll Interval (seconds)", "type": "number", "default": 30 }
            },
            "required": ["accessId", "accessKey"]
          }
        }
      }
    }
  }
}
```

- [ ] **Step 7: Install dependencies**

Run: `npm install`
Expected: `node_modules` created, no errors

- [ ] **Step 8: Verify build**

Run: `npm run build`
Expected: `dist/` created with `index.js`, `settings.js`

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts config.schema.json src/settings.ts src/index.ts
git commit -m "feat: scaffold project with package.json, tsconfig, and entry point"
```

---

### Task 2: Types and Provider Interface

**Files:**
- Create: `src/types.ts`
- Create: `src/providers/provider.ts`
- Create: `src/config.ts`
- Create: `test/types.test.ts`

- [ ] **Step 1: Write types test**

```typescript
// test/types.test.ts
import { describe, it, expect } from 'vitest';
import type { BridgeDevice, DeviceState, Capability, DeviceType } from '../src/types.js';

describe('types', () => {
  it('BridgeDevice has required fields', () => {
    const device: BridgeDevice = {
      id: 'tuya:abc123',
      name: 'Living Room Light',
      type: 'light',
      provider: 'tuya',
      capabilities: [
        { type: 'on-off' },
        { type: 'brightness', range: [0, 100] },
        { type: 'color' },
        { type: 'color-temperature', range: [2700, 6500] },
      ],
    };
    expect(device.id).toBe('tuya:abc123');
    expect(device.capabilities).toHaveLength(4);
  });

  it('DeviceState is partial — all fields optional', () => {
    const state: DeviceState = { on: true };
    expect(state.on).toBe(true);
    expect(state.brightness).toBeUndefined();
  });

  it('DeviceType covers all supported types', () => {
    const types: DeviceType[] = ['light', 'thermostat', 'switch', 'lock', 'fan', 'outlet'];
    expect(types).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL — cannot find module `../src/types.js`

- [ ] **Step 3: Create src/types.ts**

```typescript
export type DeviceType = 'light' | 'thermostat' | 'switch' | 'lock' | 'fan' | 'outlet';

export type Capability =
  | { type: 'on-off' }
  | { type: 'brightness'; range: [number, number] }
  | { type: 'color' }
  | { type: 'color-temperature'; range: [number, number] }
  | { type: 'temperature'; unit: 'celsius' | 'fahrenheit' }
  | { type: 'target-temperature'; range: [number, number] }
  | { type: 'thermostat-mode'; modes: string[] }
  | { type: 'lock' };

export interface BridgeDevice {
  id: string;
  name: string;
  type: DeviceType;
  provider: string;
  capabilities: Capability[];
  manufacturer?: string;
  model?: string;
  firmware?: string;
}

export interface DeviceState {
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
  colorTemperature?: number;
  temperature?: number;
  targetTemperature?: number;
  thermostatMode?: string;
  locked?: boolean;
}
```

- [ ] **Step 4: Create src/providers/provider.ts**

```typescript
import type { BridgeDevice, DeviceState } from '../types.js';

export interface DeviceProvider {
  readonly id: string;
  discover(): Promise<BridgeDevice[]>;
  getState(deviceId: string): Promise<DeviceState>;
  setState(deviceId: string, state: Partial<DeviceState>): Promise<void>;
  onStateChange?(callback: (deviceId: string, state: DeviceState) => void): void;
  dispose(): void;
}
```

- [ ] **Step 5: Create src/config.ts**

```typescript
export interface TuyaConfig {
  accessId: string;
  accessKey: string;
  region: 'us' | 'eu' | 'cn' | 'in';
  pollInterval?: number;
  localKeys?: Record<string, string>;
}

export interface PluginConfig {
  name: string;
  providers?: {
    tuya?: TuyaConfig;
  };
}

const TUYA_REGIONS = new Set(['us', 'eu', 'cn', 'in']);

export function validateConfig(config: Record<string, unknown>): config is PluginConfig {
  if (!config.name || typeof config.name !== 'string') return false;
  const providers = config.providers as Record<string, unknown> | undefined;
  if (!providers) return true;

  const tuya = providers.tuya as Record<string, unknown> | undefined;
  if (tuya) {
    if (!tuya.accessId || typeof tuya.accessId !== 'string') return false;
    if (!tuya.accessKey || typeof tuya.accessKey !== 'string') return false;
    if (tuya.region && !TUYA_REGIONS.has(tuya.region as string)) return false;
  }
  return true;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/types.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: Compiles without errors

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/providers/provider.ts src/config.ts test/types.test.ts
git commit -m "feat: add core types, provider interface, and config validation"
```

---

### Task 3: Tuya API Client

**Files:**
- Create: `src/providers/tuya/api.ts`
- Create: `test/providers/tuya/api.test.ts`

- [ ] **Step 1: Write Tuya API signing test**

```typescript
// test/providers/tuya/api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuyaApi } from '../../../src/providers/tuya/api.js';

describe('TuyaApi', () => {
  describe('signing', () => {
    it('generates correct HMAC-SHA256 signature for token request', () => {
      const api = new TuyaApi({
        accessId: 'test_client_id',
        accessKey: 'test_secret',
        region: 'us',
      });

      // The sign method is used internally, but we can verify via a token request
      // by mocking fetch and inspecting headers
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          result: {
            access_token: 'mock_token',
            expire_time: 7200,
            refresh_token: 'mock_refresh',
            uid: 'mock_uid',
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      return api.getToken().then(() => {
        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe('https://openapi.tuyaus.com/v1.0/token?grant_type=1');
        expect(options.headers.client_id).toBe('test_client_id');
        expect(options.headers.sign_method).toBe('HMAC-SHA256');
        expect(options.headers.sign).toMatch(/^[A-F0-9]{64}$/);
        expect(options.headers.t).toMatch(/^\d+$/);
      });
    });
  });

  describe('region URLs', () => {
    it.each([
      ['us', 'https://openapi.tuyaus.com'],
      ['eu', 'https://openapi.tuyaeu.com'],
      ['cn', 'https://openapi.tuyacn.com'],
      ['in', 'https://openapi.tuyain.com'],
    ] as const)('maps region %s to %s', (region, expected) => {
      const api = new TuyaApi({ accessId: 'x', accessKey: 'x', region });
      expect(api.baseUrl).toBe(expected);
    });
  });

  describe('getToken', () => {
    it('stores token and uid on success', async () => {
      const api = new TuyaApi({ accessId: 'x', accessKey: 'x', region: 'us' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          result: {
            access_token: 'tok_123',
            expire_time: 7200,
            refresh_token: 'ref_456',
            uid: 'uid_789',
          },
        }),
      }));

      await api.getToken();
      expect(api.accessToken).toBe('tok_123');
      expect(api.uid).toBe('uid_789');
    });

    it('throws on API error', async () => {
      const api = new TuyaApi({ accessId: 'x', accessKey: 'x', region: 'us' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false, code: 1004, msg: 'sign invalid' }),
      }));

      await expect(api.getToken()).rejects.toThrow('sign invalid');
    });
  });

  describe('getDevices', () => {
    let api: TuyaApi;

    beforeEach(async () => {
      api = new TuyaApi({ accessId: 'x', accessKey: 'x', region: 'us' });
      // Pre-set token so we skip the auth step
      api.accessToken = 'tok_123';
      api.uid = 'uid_789';
    });

    it('returns device list', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          result: [{
            id: 'dev_001',
            name: 'Kitchen Light',
            category: 'dj',
            online: true,
            product_id: 'prod_1',
            status: [
              { code: 'switch_led', value: true },
              { code: 'bright_value_v2', value: 500 },
            ],
          }],
        }),
      }));

      const devices = await api.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe('dev_001');
      expect(devices[0].name).toBe('Kitchen Light');
    });
  });

  describe('sendCommands', () => {
    let api: TuyaApi;

    beforeEach(() => {
      api = new TuyaApi({ accessId: 'x', accessKey: 'x', region: 'us' });
      api.accessToken = 'tok_123';
      api.uid = 'uid_789';
    });

    it('sends POST with commands body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, result: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await api.sendCommands('dev_001', [
        { code: 'switch_led', value: true },
      ]);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://openapi.tuyaus.com/v1.0/devices/dev_001/commands');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({
        commands: [{ code: 'switch_led', value: true }],
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/tuya/api.test.ts`
Expected: FAIL — cannot find module `../../../src/providers/tuya/api.js`

- [ ] **Step 3: Implement TuyaApi**

```typescript
// src/providers/tuya/api.ts
import { createHmac, createHash } from 'node:crypto';

export interface TuyaCommand {
  code: string;
  value: boolean | number | string;
}

export interface TuyaDevice {
  id: string;
  name: string;
  category: string;
  online: boolean;
  product_id: string;
  status: Array<{ code: string; value: boolean | number | string }>;
}

interface TuyaApiConfig {
  accessId: string;
  accessKey: string;
  region: 'us' | 'eu' | 'cn' | 'in';
}

const REGION_URLS: Record<string, string> = {
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

export class TuyaApi {
  public readonly baseUrl: string;
  public accessToken = '';
  public uid = '';
  private refreshToken = '';
  private tokenExpiry = 0;
  private readonly accessId: string;
  private readonly accessKey: string;

  constructor(config: TuyaApiConfig) {
    this.accessId = config.accessId;
    this.accessKey = config.accessKey;
    this.baseUrl = REGION_URLS[config.region];
  }

  async getToken(): Promise<void> {
    const result = await this.request<{
      access_token: string;
      expire_time: number;
      refresh_token: string;
      uid: string;
    }>('GET', '/v1.0/token?grant_type=1', '', false);

    this.accessToken = result.access_token;
    this.refreshToken = result.refresh_token;
    this.uid = result.uid;
    this.tokenExpiry = Date.now() + result.expire_time * 1000;
  }

  async getDevices(): Promise<TuyaDevice[]> {
    await this.ensureToken();
    return this.request<TuyaDevice[]>('GET', `/v1.0/users/${this.uid}/devices`);
  }

  async getDeviceStatus(deviceId: string): Promise<Array<{ code: string; value: boolean | number | string }>> {
    await this.ensureToken();
    return this.request('GET', `/v1.0/devices/${deviceId}/status`);
  }

  async sendCommands(deviceId: string, commands: TuyaCommand[]): Promise<void> {
    await this.ensureToken();
    await this.request('POST', `/v1.0/devices/${deviceId}/commands`, JSON.stringify({ commands }));
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry - 60_000) {
      if (this.refreshToken) {
        try {
          const result = await this.request<{
            access_token: string;
            expire_time: number;
            refresh_token: string;
            uid: string;
          }>('GET', `/v1.0/token/${this.refreshToken}`, '', false);
          this.accessToken = result.access_token;
          this.refreshToken = result.refresh_token;
          this.uid = result.uid;
          this.tokenExpiry = Date.now() + result.expire_time * 1000;
          return;
        } catch {
          // Refresh failed, get new token
        }
      }
      await this.getToken();
    }
  }

  private async request<T>(method: string, path: string, body = '', authenticated = true): Promise<T> {
    const t = Date.now().toString();
    const sign = this.sign(t, method, path, body, authenticated);

    const headers: Record<string, string> = {
      client_id: this.accessId,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
    };
    if (authenticated) {
      headers.access_token = this.accessToken;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body || undefined,
    });

    const json = await response.json() as { success: boolean; result: T; code?: number; msg?: string };
    if (!json.success) {
      throw new Error(json.msg || `Tuya API error ${json.code}`);
    }
    return json.result;
  }

  private sign(t: string, method: string, path: string, body: string, authenticated: boolean): string {
    const contentHash = createHash('sha256').update(body).digest('hex');
    const stringToSign = `${method}\n${contentHash}\n\n${path}`;
    const signStr = authenticated
      ? `${this.accessId}${this.accessToken}${t}${stringToSign}`
      : `${this.accessId}${t}${stringToSign}`;
    return createHmac('sha256', this.accessKey)
      .update(signStr)
      .digest('hex')
      .toUpperCase();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/providers/tuya/api.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/tuya/api.ts test/providers/tuya/api.test.ts
git commit -m "feat: add Tuya Cloud API client with signing and token management"
```

---

### Task 4: Tuya DP Mapper

**Files:**
- Create: `src/providers/tuya/mapper.ts`
- Create: `test/providers/tuya/mapper.test.ts`

- [ ] **Step 1: Write mapper tests**

```typescript
// test/providers/tuya/mapper.test.ts
import { describe, it, expect } from 'vitest';
import { tuyaDeviceToBridgeDevice, tuyaStatusToState, stateToTuyaCommands } from '../../../src/providers/tuya/mapper.js';
import type { TuyaDevice } from '../../../src/providers/tuya/api.js';

describe('tuyaDeviceToBridgeDevice', () => {
  it('maps a full-featured light', () => {
    const tuya: TuyaDevice = {
      id: 'dev_001',
      name: 'Kitchen Light',
      category: 'dj',
      online: true,
      product_id: 'prod_1',
      status: [
        { code: 'switch_led', value: true },
        { code: 'bright_value_v2', value: 500 },
        { code: 'temp_value_v2', value: 300 },
        { code: 'colour_data_v2', value: '{"h":120,"s":500,"v":800}' },
        { code: 'work_mode', value: 'white' },
      ],
    };

    const device = tuyaDeviceToBridgeDevice(tuya);
    expect(device.id).toBe('tuya:dev_001');
    expect(device.name).toBe('Kitchen Light');
    expect(device.type).toBe('light');
    expect(device.provider).toBe('tuya');
    expect(device.capabilities.map(c => c.type)).toEqual(
      expect.arrayContaining(['on-off', 'brightness', 'color', 'color-temperature'])
    );
  });

  it('maps a basic on/off light', () => {
    const tuya: TuyaDevice = {
      id: 'dev_002',
      name: 'Closet Light',
      category: 'dj',
      online: true,
      product_id: 'prod_2',
      status: [{ code: 'switch_led', value: false }],
    };

    const device = tuyaDeviceToBridgeDevice(tuya);
    expect(device.capabilities.map(c => c.type)).toEqual(['on-off']);
  });

  it('returns null for non-light categories', () => {
    const tuya: TuyaDevice = {
      id: 'dev_003',
      name: 'Door Sensor',
      category: 'mcs',
      online: true,
      product_id: 'prod_3',
      status: [],
    };

    const device = tuyaDeviceToBridgeDevice(tuya);
    expect(device).toBeNull();
  });
});

describe('tuyaStatusToState', () => {
  it('maps all light DPs to DeviceState', () => {
    const status = [
      { code: 'switch_led', value: true },
      { code: 'bright_value_v2', value: 500 },
      { code: 'temp_value_v2', value: 500 },
      { code: 'colour_data_v2', value: '{"h":240,"s":800,"v":600}' },
      { code: 'work_mode', value: 'colour' },
    ];

    const state = tuyaStatusToState(status);
    expect(state.on).toBe(true);
    expect(state.brightness).toBe(50); // 500/1000 * 100
    expect(state.colorTemperature).toBe(4600); // 2700 + (500/1000) * (6500-2700)
    expect(state.hue).toBe(240);
    expect(state.saturation).toBe(80); // 800/1000 * 100
  });

  it('handles missing DPs gracefully', () => {
    const status = [{ code: 'switch_led', value: false }];
    const state = tuyaStatusToState(status);
    expect(state.on).toBe(false);
    expect(state.brightness).toBeUndefined();
  });
});

describe('stateToTuyaCommands', () => {
  it('generates on/off command', () => {
    const cmds = stateToTuyaCommands({ on: true });
    expect(cmds).toEqual([{ code: 'switch_led', value: true }]);
  });

  it('generates brightness command (scaled to 10-1000)', () => {
    const cmds = stateToTuyaCommands({ brightness: 50 });
    expect(cmds).toContainEqual({ code: 'bright_value_v2', value: 500 });
    expect(cmds).toContainEqual({ code: 'work_mode', value: 'white' });
  });

  it('generates color command with work_mode switch', () => {
    const cmds = stateToTuyaCommands({ hue: 120, saturation: 80 });
    expect(cmds).toContainEqual({ code: 'work_mode', value: 'colour' });
    expect(cmds).toContainEqual({
      code: 'colour_data_v2',
      value: JSON.stringify({ h: 120, s: 800, v: 1000 }),
    });
  });

  it('generates color temperature command', () => {
    const cmds = stateToTuyaCommands({ colorTemperature: 4600 });
    expect(cmds).toContainEqual({ code: 'work_mode', value: 'white' });
    expect(cmds).toContainEqual({ code: 'temp_value_v2', value: 500 });
  });

  it('returns empty array for empty state', () => {
    expect(stateToTuyaCommands({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/tuya/mapper.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement mapper**

```typescript
// src/providers/tuya/mapper.ts
import type { TuyaCommand, TuyaDevice } from './api.js';
import type { BridgeDevice, Capability, DeviceState } from '../../types.js';

// Tuya categories that map to lights
const LIGHT_CATEGORIES = new Set(['dj', 'dd', 'fwd', 'dc', 'xdd', 'fsd', 'tgq']);

// Tuya brightness range
const TUYA_BRIGHTNESS_MIN = 10;
const TUYA_BRIGHTNESS_MAX = 1000;

// Color temp range in kelvin
const KELVIN_MIN = 2700;
const KELVIN_MAX = 6500;

export function tuyaDeviceToBridgeDevice(tuya: TuyaDevice): BridgeDevice | null {
  if (!LIGHT_CATEGORIES.has(tuya.category)) return null;

  const dpCodes = new Set(tuya.status.map(s => s.code));
  const capabilities: Capability[] = [];

  if (dpCodes.has('switch_led')) {
    capabilities.push({ type: 'on-off' });
  }
  if (dpCodes.has('bright_value_v2')) {
    capabilities.push({ type: 'brightness', range: [0, 100] });
  }
  if (dpCodes.has('colour_data_v2')) {
    capabilities.push({ type: 'color' });
  }
  if (dpCodes.has('temp_value_v2')) {
    capabilities.push({ type: 'color-temperature', range: [KELVIN_MIN, KELVIN_MAX] });
  }

  if (capabilities.length === 0) return null;

  return {
    id: `tuya:${tuya.id}`,
    name: tuya.name,
    type: 'light',
    provider: 'tuya',
    capabilities,
    manufacturer: 'Tuya',
    model: tuya.product_id,
  };
}

export function tuyaStatusToState(status: Array<{ code: string; value: boolean | number | string }>): DeviceState {
  const state: DeviceState = {};
  const map = new Map(status.map(s => [s.code, s.value]));

  if (map.has('switch_led')) {
    state.on = map.get('switch_led') as boolean;
  }

  if (map.has('bright_value_v2')) {
    const raw = map.get('bright_value_v2') as number;
    state.brightness = Math.round(((raw - TUYA_BRIGHTNESS_MIN) / (TUYA_BRIGHTNESS_MAX - TUYA_BRIGHTNESS_MIN)) * 100);
  }

  if (map.has('temp_value_v2')) {
    const raw = map.get('temp_value_v2') as number;
    state.colorTemperature = Math.round(KELVIN_MIN + (raw / 1000) * (KELVIN_MAX - KELVIN_MIN));
  }

  if (map.has('colour_data_v2')) {
    const raw = map.get('colour_data_v2') as string;
    try {
      const { h, s } = JSON.parse(raw) as { h: number; s: number; v: number };
      state.hue = h;
      state.saturation = Math.round((s / 1000) * 100);
    } catch {
      // Ignore malformed color data
    }
  }

  return state;
}

export function stateToTuyaCommands(state: Partial<DeviceState>): TuyaCommand[] {
  const commands: TuyaCommand[] = [];

  if (state.on !== undefined) {
    commands.push({ code: 'switch_led', value: state.on });
  }

  if (state.brightness !== undefined) {
    commands.push({ code: 'work_mode', value: 'white' });
    const scaled = Math.round(TUYA_BRIGHTNESS_MIN + (state.brightness / 100) * (TUYA_BRIGHTNESS_MAX - TUYA_BRIGHTNESS_MIN));
    commands.push({ code: 'bright_value_v2', value: scaled });
  }

  if (state.hue !== undefined || state.saturation !== undefined) {
    commands.push({ code: 'work_mode', value: 'colour' });
    const h = state.hue ?? 0;
    const s = Math.round((state.saturation ?? 100) / 100 * 1000);
    commands.push({
      code: 'colour_data_v2',
      value: JSON.stringify({ h, s, v: 1000 }),
    });
  }

  if (state.colorTemperature !== undefined) {
    commands.push({ code: 'work_mode', value: 'white' });
    const scaled = Math.round(((state.colorTemperature - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN)) * 1000);
    commands.push({ code: 'temp_value_v2', value: Math.max(0, Math.min(1000, scaled)) });
  }

  return commands;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/providers/tuya/mapper.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/tuya/mapper.ts test/providers/tuya/mapper.test.ts
git commit -m "feat: add Tuya DP mapper for lights (status ↔ DeviceState ↔ commands)"
```

---

### Task 5: Tuya Provider

**Files:**
- Create: `src/providers/tuya/index.ts`
- Create: `test/providers/tuya/index.test.ts`

- [ ] **Step 1: Write provider tests**

```typescript
// test/providers/tuya/index.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuyaProvider } from '../../../src/providers/tuya/index.js';
import type { TuyaApi, TuyaDevice } from '../../../src/providers/tuya/api.js';

function mockApi(devices: TuyaDevice[]): TuyaApi {
  return {
    baseUrl: 'https://openapi.tuyaus.com',
    accessToken: 'tok',
    uid: 'uid',
    getToken: vi.fn(),
    getDevices: vi.fn().mockResolvedValue(devices),
    getDeviceStatus: vi.fn().mockResolvedValue([
      { code: 'switch_led', value: true },
      { code: 'bright_value_v2', value: 500 },
    ]),
    sendCommands: vi.fn().mockResolvedValue(undefined),
  } as unknown as TuyaApi;
}

const LIGHT_DEVICE: TuyaDevice = {
  id: 'dev_001',
  name: 'Kitchen Light',
  category: 'dj',
  online: true,
  product_id: 'prod_1',
  status: [
    { code: 'switch_led', value: true },
    { code: 'bright_value_v2', value: 500 },
    { code: 'temp_value_v2', value: 300 },
    { code: 'colour_data_v2', value: '{"h":0,"s":0,"v":1000}' },
    { code: 'work_mode', value: 'white' },
  ],
};

const SENSOR_DEVICE: TuyaDevice = {
  id: 'dev_002',
  name: 'Door Sensor',
  category: 'mcs',
  online: true,
  product_id: 'prod_2',
  status: [],
};

describe('TuyaProvider', () => {
  it('has id "tuya"', () => {
    const provider = new TuyaProvider(mockApi([]));
    expect(provider.id).toBe('tuya');
  });

  describe('discover', () => {
    it('returns only light devices', async () => {
      const provider = new TuyaProvider(mockApi([LIGHT_DEVICE, SENSOR_DEVICE]));
      const devices = await provider.discover();
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe('tuya:dev_001');
      expect(devices[0].type).toBe('light');
    });

    it('returns empty array when no devices', async () => {
      const provider = new TuyaProvider(mockApi([]));
      const devices = await provider.discover();
      expect(devices).toEqual([]);
    });
  });

  describe('getState', () => {
    it('fetches and maps device status', async () => {
      const api = mockApi([LIGHT_DEVICE]);
      const provider = new TuyaProvider(api);
      const state = await provider.getState('dev_001');
      expect(state.on).toBe(true);
      expect(state.brightness).toBe(50);
      expect(api.getDeviceStatus).toHaveBeenCalledWith('dev_001');
    });
  });

  describe('setState', () => {
    it('sends mapped commands to API', async () => {
      const api = mockApi([LIGHT_DEVICE]);
      const provider = new TuyaProvider(api);
      await provider.setState('dev_001', { on: false });
      expect(api.sendCommands).toHaveBeenCalledWith('dev_001', [
        { code: 'switch_led', value: false },
      ]);
    });
  });

  describe('dispose', () => {
    it('does not throw', () => {
      const provider = new TuyaProvider(mockApi([]));
      expect(() => provider.dispose()).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/tuya/index.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement TuyaProvider**

```typescript
// src/providers/tuya/index.ts
import type { DeviceProvider } from '../provider.js';
import type { BridgeDevice, DeviceState } from '../../types.js';
import { TuyaApi } from './api.js';
import { tuyaDeviceToBridgeDevice, tuyaStatusToState, stateToTuyaCommands } from './mapper.js';
import type { TuyaConfig } from '../../config.js';

export class TuyaProvider implements DeviceProvider {
  readonly id = 'tuya';
  private readonly api: TuyaApi;

  constructor(apiOrConfig: TuyaApi | TuyaConfig) {
    if (apiOrConfig instanceof TuyaApi) {
      this.api = apiOrConfig;
    } else {
      this.api = new TuyaApi(apiOrConfig);
    }
  }

  async discover(): Promise<BridgeDevice[]> {
    const devices = await this.api.getDevices();
    return devices
      .map(tuyaDeviceToBridgeDevice)
      .filter((d): d is BridgeDevice => d !== null);
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const status = await this.api.getDeviceStatus(deviceId);
    return tuyaStatusToState(status);
  }

  async setState(deviceId: string, state: Partial<DeviceState>): Promise<void> {
    const commands = stateToTuyaCommands(state);
    if (commands.length > 0) {
      await this.api.sendCommands(deviceId, commands);
    }
  }

  dispose(): void {
    // No persistent connections to clean up (cloud API is stateless)
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/providers/tuya/index.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/tuya/index.ts test/providers/tuya/index.test.ts
git commit -m "feat: add TuyaProvider implementing DeviceProvider interface"
```

---

### Task 6: Device Manager

**Files:**
- Create: `src/device-manager.ts`
- Create: `test/device-manager.test.ts`

- [ ] **Step 1: Write Device Manager tests**

```typescript
// test/device-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceManager } from '../src/device-manager.js';
import type { DeviceProvider } from '../src/providers/provider.js';
import type { BridgeDevice, DeviceState } from '../src/types.js';

function mockProvider(id: string, devices: BridgeDevice[]): DeviceProvider {
  return {
    id,
    discover: vi.fn().mockResolvedValue(devices),
    getState: vi.fn().mockResolvedValue({ on: true, brightness: 50 }),
    setState: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

const LIGHT: BridgeDevice = {
  id: 'tuya:dev_001',
  name: 'Kitchen Light',
  type: 'light',
  provider: 'tuya',
  capabilities: [{ type: 'on-off' }, { type: 'brightness', range: [0, 100] }],
};

describe('DeviceManager', () => {
  describe('discoverAll', () => {
    it('aggregates devices from all providers', async () => {
      const p1 = mockProvider('tuya', [LIGHT]);
      const p2 = mockProvider('resideo', [{
        ...LIGHT,
        id: 'resideo:therm_001',
        name: 'Thermostat',
        type: 'thermostat',
        provider: 'resideo',
      }]);

      const manager = new DeviceManager([p1, p2]);
      const devices = await manager.discoverAll();
      expect(devices).toHaveLength(2);
      expect(devices.map(d => d.provider)).toEqual(['tuya', 'resideo']);
    });

    it('handles provider discovery failure gracefully', async () => {
      const p1 = mockProvider('tuya', [LIGHT]);
      const p2: DeviceProvider = {
        id: 'broken',
        discover: vi.fn().mockRejectedValue(new Error('auth failed')),
        getState: vi.fn(),
        setState: vi.fn(),
        dispose: vi.fn(),
      };

      const manager = new DeviceManager([p1, p2]);
      const devices = await manager.discoverAll();
      expect(devices).toHaveLength(1); // broken provider skipped
    });
  });

  describe('getState', () => {
    it('routes to correct provider and caches result', async () => {
      const provider = mockProvider('tuya', [LIGHT]);
      const manager = new DeviceManager([provider]);
      await manager.discoverAll();

      const state = await manager.getState('tuya:dev_001');
      expect(state).toEqual({ on: true, brightness: 50 });
      expect(provider.getState).toHaveBeenCalledWith('dev_001');

      // Second call within cache TTL returns cached
      await manager.getState('tuya:dev_001');
      expect(provider.getState).toHaveBeenCalledTimes(1);
    });

    it('throws for unknown device', async () => {
      const manager = new DeviceManager([]);
      await expect(manager.getState('unknown:123')).rejects.toThrow('Unknown device');
    });
  });

  describe('setState', () => {
    it('routes to correct provider and updates cache', async () => {
      const provider = mockProvider('tuya', [LIGHT]);
      const manager = new DeviceManager([provider]);
      await manager.discoverAll();

      await manager.setState('tuya:dev_001', { on: false });
      expect(provider.setState).toHaveBeenCalledWith('dev_001', { on: false });
    });
  });

  describe('dispose', () => {
    it('disposes all providers', () => {
      const p1 = mockProvider('tuya', []);
      const p2 = mockProvider('resideo', []);
      const manager = new DeviceManager([p1, p2]);
      manager.dispose();
      expect(p1.dispose).toHaveBeenCalled();
      expect(p2.dispose).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/device-manager.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement DeviceManager**

```typescript
// src/device-manager.ts
import type { DeviceProvider } from './providers/provider.js';
import type { BridgeDevice, DeviceState } from './types.js';

interface CacheEntry {
  state: DeviceState;
  timestamp: number;
}

export class DeviceManager {
  private readonly providers: Map<string, DeviceProvider>;
  private readonly devices = new Map<string, BridgeDevice>();
  private readonly stateCache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private onChangeCallback?: (deviceId: string, state: DeviceState) => void;

  constructor(providers: DeviceProvider[], cacheTtlMs = 30_000) {
    this.providers = new Map(providers.map(p => [p.id, p]));
    this.cacheTtlMs = cacheTtlMs;
  }

  async discoverAll(): Promise<BridgeDevice[]> {
    this.devices.clear();

    const results = await Promise.allSettled(
      [...this.providers.values()].map(p => p.discover()),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const device of result.value) {
          this.devices.set(device.id, device);
        }
      }
    }

    return [...this.devices.values()];
  }

  getDevice(deviceId: string): BridgeDevice | undefined {
    return this.devices.get(deviceId);
  }

  getAllDevices(): BridgeDevice[] {
    return [...this.devices.values()];
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const { provider, localId } = this.resolveDevice(deviceId);

    const cached = this.stateCache.get(deviceId);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.state;
    }

    const state = await provider.getState(localId);
    this.stateCache.set(deviceId, { state, timestamp: Date.now() });
    return state;
  }

  async setState(deviceId: string, state: Partial<DeviceState>): Promise<void> {
    const { provider, localId } = this.resolveDevice(deviceId);
    await provider.setState(localId, state);

    // Optimistic cache update
    const cached = this.stateCache.get(deviceId);
    const merged = { ...(cached?.state ?? {}), ...state };
    this.stateCache.set(deviceId, { state: merged, timestamp: Date.now() });

    this.onChangeCallback?.(deviceId, merged);
  }

  onStateChange(callback: (deviceId: string, state: DeviceState) => void): void {
    this.onChangeCallback = callback;
  }

  invalidateCache(deviceId: string): void {
    this.stateCache.delete(deviceId);
  }

  dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
  }

  private resolveDevice(deviceId: string): { provider: DeviceProvider; localId: string } {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Unknown device: ${deviceId}`);

    const provider = this.providers.get(device.provider);
    if (!provider) throw new Error(`Unknown provider: ${device.provider}`);

    // Strip provider prefix from device ID (e.g., "tuya:dev_001" → "dev_001")
    const localId = deviceId.slice(device.provider.length + 1);
    return { provider, localId };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/device-manager.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/device-manager.ts test/device-manager.test.ts
git commit -m "feat: add DeviceManager with discovery, state caching, and provider routing"
```

---

### Task 7: HomeKit Accessory Factory

**Files:**
- Create: `src/accessory.ts`
- Create: `test/accessory.test.ts`

- [ ] **Step 1: Write accessory tests**

```typescript
// test/accessory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureAccessory } from '../src/accessory.js';
import type { BridgeDevice, DeviceState } from '../src/types.js';

// Minimal mocks for Homebridge types
const mockCharacteristic = () => ({
  onGet: vi.fn().mockReturnThis(),
  onSet: vi.fn().mockReturnThis(),
  updateValue: vi.fn().mockReturnThis(),
  setProps: vi.fn().mockReturnThis(),
});

function createMockService(name: string) {
  const chars = new Map<string, ReturnType<typeof mockCharacteristic>>();
  return {
    name,
    getCharacteristic: vi.fn((char: string) => {
      if (!chars.has(char)) chars.set(char, mockCharacteristic());
      return chars.get(char)!;
    }),
    setCharacteristic: vi.fn().mockReturnThis(),
  };
}

function createMockAccessory() {
  const services = new Map<string, ReturnType<typeof createMockService>>();
  return {
    getService: vi.fn((name: string) => services.get(name)),
    addService: vi.fn((name: string) => {
      const svc = createMockService(name);
      services.set(name, svc);
      return svc;
    }),
    context: {} as any,
  };
}

const Characteristic = {
  On: 'On',
  Brightness: 'Brightness',
  Hue: 'Hue',
  Saturation: 'Saturation',
  ColorTemperature: 'ColorTemperature',
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
};

const Service = {
  Lightbulb: 'Lightbulb',
  AccessoryInformation: 'AccessoryInformation',
};

const LIGHT: BridgeDevice = {
  id: 'tuya:dev_001',
  name: 'Kitchen Light',
  type: 'light',
  provider: 'tuya',
  capabilities: [
    { type: 'on-off' },
    { type: 'brightness', range: [0, 100] },
    { type: 'color' },
    { type: 'color-temperature', range: [2700, 6500] },
  ],
  manufacturer: 'Tuya',
  model: 'prod_1',
};

describe('configureAccessory', () => {
  it('creates Lightbulb service for light device', () => {
    const accessory = createMockAccessory();
    const getState = vi.fn().mockResolvedValue({ on: true });
    const setState = vi.fn().mockResolvedValue(undefined);

    configureAccessory(
      accessory as any,
      LIGHT,
      { Service, Characteristic } as any,
      getState,
      setState,
    );

    expect(accessory.addService).toHaveBeenCalledWith('Lightbulb');
  });

  it('registers On characteristic for on-off capability', () => {
    const accessory = createMockAccessory();
    const getState = vi.fn().mockResolvedValue({ on: true });
    const setState = vi.fn().mockResolvedValue(undefined);

    configureAccessory(accessory as any, LIGHT, { Service, Characteristic } as any, getState, setState);

    const service = accessory.addService.mock.results[0].value;
    expect(service.getCharacteristic).toHaveBeenCalledWith('On');
    const onChar = service.getCharacteristic.mock.results.find(
      (r: any) => r.value && service.getCharacteristic.mock.calls[
        service.getCharacteristic.mock.results.indexOf(r)
      ][0] === 'On'
    );
    expect(onChar).toBeDefined();
  });

  it('registers Brightness, Hue, Saturation, ColorTemperature for full light', () => {
    const accessory = createMockAccessory();
    const getState = vi.fn().mockResolvedValue({ on: true });
    const setState = vi.fn().mockResolvedValue(undefined);

    configureAccessory(accessory as any, LIGHT, { Service, Characteristic } as any, getState, setState);

    const service = accessory.addService.mock.results[0].value;
    const charNames = service.getCharacteristic.mock.calls.map((c: any) => c[0]);
    expect(charNames).toContain('On');
    expect(charNames).toContain('Brightness');
    expect(charNames).toContain('Hue');
    expect(charNames).toContain('Saturation');
    expect(charNames).toContain('ColorTemperature');
  });

  it('skips color characteristics for basic on-off light', () => {
    const basicLight: BridgeDevice = {
      ...LIGHT,
      capabilities: [{ type: 'on-off' }],
    };
    const accessory = createMockAccessory();
    configureAccessory(accessory as any, basicLight, { Service, Characteristic } as any, vi.fn(), vi.fn());

    const service = accessory.addService.mock.results[0].value;
    const charNames = service.getCharacteristic.mock.calls.map((c: any) => c[0]);
    expect(charNames).toContain('On');
    expect(charNames).not.toContain('Brightness');
    expect(charNames).not.toContain('Hue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/accessory.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement accessory factory**

```typescript
// src/accessory.ts
import type { PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import type { BridgeDevice, DeviceState } from './types.js';

interface HapTypes {
  Service: typeof Service;
  Characteristic: typeof Characteristic;
}

type GetState = (deviceId: string) => Promise<DeviceState>;
type SetState = (deviceId: string, state: Partial<DeviceState>) => Promise<void>;

// Convert kelvin to HomeKit mireds
function kelvinToMired(kelvin: number): number {
  return Math.round(1_000_000 / kelvin);
}

// Convert HomeKit mireds to kelvin
function miredToKelvin(mired: number): number {
  return Math.round(1_000_000 / mired);
}

export function configureAccessory(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  hap: HapTypes,
  getState: GetState,
  setState: SetState,
): void {
  accessory.context.device = device;

  // Accessory info
  const infoService = accessory.getService(hap.Service.AccessoryInformation);
  if (infoService) {
    infoService
      .setCharacteristic(hap.Characteristic.Manufacturer, device.manufacturer ?? 'Unknown')
      .setCharacteristic(hap.Characteristic.Model, device.model ?? 'Unknown')
      .setCharacteristic(hap.Characteristic.SerialNumber, device.id);
  }

  if (device.type === 'light') {
    configureLightAccessory(accessory, device, hap, getState, setState);
  }
  // Future: thermostat, switch, lock, fan, outlet
}

function configureLightAccessory(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  hap: HapTypes,
  getState: GetState,
  setState: SetState,
): void {
  const service = accessory.getService(hap.Service.Lightbulb)
    || accessory.addService(hap.Service.Lightbulb);

  const caps = new Set(device.capabilities.map(c => c.type));

  if (caps.has('on-off')) {
    service.getCharacteristic(hap.Characteristic.On)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.on ?? false;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { on: value as boolean });
      });
  }

  if (caps.has('brightness')) {
    service.getCharacteristic(hap.Characteristic.Brightness)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.brightness ?? 100;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { brightness: value as number });
      });
  }

  if (caps.has('color')) {
    service.getCharacteristic(hap.Characteristic.Hue)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.hue ?? 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { hue: value as number });
      });

    service.getCharacteristic(hap.Characteristic.Saturation)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.saturation ?? 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { saturation: value as number });
      });
  }

  if (caps.has('color-temperature')) {
    const ctCap = device.capabilities.find(c => c.type === 'color-temperature');
    const range = ctCap && 'range' in ctCap ? ctCap.range : [2700, 6500];

    service.getCharacteristic(hap.Characteristic.ColorTemperature)
      .setProps({
        minValue: kelvinToMired(range[1]), // Higher kelvin = lower mired
        maxValue: kelvinToMired(range[0]),
      })
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return kelvinToMired(state.colorTemperature ?? 4000);
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { colorTemperature: miredToKelvin(value as number) });
      });
  }
}

export function updateAccessoryState(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  state: DeviceState,
  hap: HapTypes,
): void {
  if (device.type !== 'light') return;

  const service = accessory.getService(hap.Service.Lightbulb);
  if (!service) return;

  const caps = new Set(device.capabilities.map(c => c.type));

  if (caps.has('on-off') && state.on !== undefined) {
    service.updateCharacteristic(hap.Characteristic.On, state.on);
  }
  if (caps.has('brightness') && state.brightness !== undefined) {
    service.updateCharacteristic(hap.Characteristic.Brightness, state.brightness);
  }
  if (caps.has('color')) {
    if (state.hue !== undefined) {
      service.updateCharacteristic(hap.Characteristic.Hue, state.hue);
    }
    if (state.saturation !== undefined) {
      service.updateCharacteristic(hap.Characteristic.Saturation, state.saturation);
    }
  }
  if (caps.has('color-temperature') && state.colorTemperature !== undefined) {
    service.updateCharacteristic(hap.Characteristic.ColorTemperature, kelvinToMired(state.colorTemperature));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/accessory.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/accessory.ts test/accessory.test.ts
git commit -m "feat: add HomeKit accessory factory with light capability mapping"
```

---

### Task 8: Platform Integration

**Files:**
- Create: `src/platform.ts`
- Modify: `src/index.ts` (replace stub)

- [ ] **Step 1: Implement platform.ts**

```typescript
// src/platform.ts
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { PluginConfig } from './config.js';
import { validateConfig } from './config.js';
import { DeviceManager } from './device-manager.js';
import type { DeviceProvider } from './providers/provider.js';
import { TuyaProvider } from './providers/tuya/index.js';
import { configureAccessory, updateAccessoryState } from './accessory.js';
import type { BridgeDevice } from './types.js';

export class AlexaBridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private deviceManager?: DeviceManager;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!validateConfig(config as unknown as Record<string, unknown>)) {
      this.log.error('Invalid plugin configuration');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.init().catch(err => this.log.error('Initialization failed:', err));
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async init(): Promise<void> {
    const pluginConfig = this.config as unknown as PluginConfig;
    const providers = this.createProviders(pluginConfig);

    if (providers.length === 0) {
      this.log.warn('No providers configured');
      return;
    }

    this.deviceManager = new DeviceManager(providers);
    await this.discoverAndRegister();
    this.startPolling(pluginConfig);
  }

  private createProviders(config: PluginConfig): DeviceProvider[] {
    const providers: DeviceProvider[] = [];

    if (config.providers?.tuya) {
      this.log.info('Initializing Tuya provider');
      providers.push(new TuyaProvider(config.providers.tuya));
    }

    // Future: resideo, alexa providers

    return providers;
  }

  private async discoverAndRegister(): Promise<void> {
    if (!this.deviceManager) return;

    this.log.info('Discovering devices...');
    const devices = await this.deviceManager.discoverAll();
    this.log.info(`Discovered ${devices.length} device(s)`);

    const activeUUIDs = new Set<string>();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.id);
      activeUUIDs.add(uuid);

      let accessory = this.cachedAccessories.get(uuid);
      const isNew = !accessory;

      if (!accessory) {
        accessory = new this.api.platformAccessory(device.name, uuid);
      }

      configureAccessory(
        accessory,
        device,
        { Service: this.Service, Characteristic: this.Characteristic },
        (id) => this.deviceManager!.getState(id),
        (id, state) => this.deviceManager!.setState(id, state),
      );

      if (isNew) {
        this.log.info(`Adding new accessory: ${device.name}`);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
      }
    }

    // Remove accessories for devices that no longer exist
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!activeUUIDs.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.delete(uuid);
      }
    }
  }

  private startPolling(config: PluginConfig): void {
    const interval = (config.providers?.tuya?.pollInterval ?? 30) * 1000;

    this.pollTimer = setInterval(async () => {
      if (!this.deviceManager) return;

      for (const device of this.deviceManager.getAllDevices()) {
        try {
          this.deviceManager.invalidateCache(device.id);
          const state = await this.deviceManager.getState(device.id);
          const uuid = this.api.hap.uuid.generate(device.id);
          const accessory = this.cachedAccessories.get(uuid);
          if (accessory) {
            updateAccessoryState(
              accessory,
              device,
              state,
              { Service: this.Service, Characteristic: this.Characteristic },
            );
          }
        } catch (err) {
          this.log.warn(`Failed to poll ${device.name}:`, err);
        }
      }
    }, interval);
  }
}
```

- [ ] **Step 2: Update src/index.ts**

```typescript
// src/index.ts
import type { API } from 'homebridge';
import { AlexaBridgePlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, AlexaBridgePlatform);
};
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors. `dist/` contains all compiled files.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/platform.ts src/index.ts
git commit -m "feat: add AlexaBridgePlatform with discovery, polling, and accessory lifecycle"
```

---

### Task 9: End-to-End Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (types, api, mapper, provider, device-manager, accessory)

- [ ] **Step 2: Build clean**

Run: `rm -rf dist && npm run build`
Expected: Clean compile, no errors, no warnings

- [ ] **Step 3: Verify plugin structure**

Run: `ls dist/`
Expected: `index.js`, `settings.js`, `types.js`, `config.js`, `platform.js`, `device-manager.js`, `accessory.js`, `providers/` directory

Run: `node -e "import('./dist/index.js').then(m => console.log(typeof m.default))"`
Expected: `function`

- [ ] **Step 4: Verify config.schema.json is valid**

Run: `node -e "const s = JSON.parse(require('fs').readFileSync('config.schema.json','utf8')); console.log(s.pluginAlias, s.pluginType)"`
Expected: `AlexaBridge platform`

- [ ] **Step 5: Commit final state**

```bash
git add -A
git commit -m "chore: phase 1 complete — core + Tuya MVP"
```
