import { createRequire } from 'node:module';
import type { DeviceProvider } from '../provider.js';
import type { BridgeDevice, DeviceState } from '../../types.js';
import { tuyaDeviceToBridgeDevice, tuyaStatusToState, stateToTuyaCommands } from './mapper.js';
import type { TuyaDevice } from './api.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TuyaDevice = require('tuyapi') as new (opts: TuyApiOptions) => TuyApiInstance;

interface TuyApiOptions {
  id: string;
  key: string;
  ip?: string;
  version?: string;
  issueGetOnConnect?: boolean;
}

interface TuyApiInstance {
  find(opts?: { timeout?: number }): Promise<void>;
  connect(): Promise<void>;
  disconnect(): void;
  get(opts?: { schema?: boolean }): Promise<Record<string, unknown> | unknown>;
  set(opts: { multiple?: boolean; data?: Record<string, unknown>; dps?: number; set?: unknown }): Promise<unknown>;
  on(event: string, handler: (...args: any[]) => void): void;
  removeAllListeners(event?: string): void;
  isConnected(): boolean;
}

export interface LocalTuyaDeviceConfig {
  id: string;
  name: string;
  category: string;
  productId: string;
  localKey: string;
  ip?: string;
  version?: string;
}

export interface LocalTuyaLogger {
  warn(msg: string): void;
  debug?(msg: string): void;
}

/**
 * Standard Tuya light DPS layout. Most cloud-provisioned lights use this exact
 * mapping; if a device uses a different schema, configure a custom dpsMap on
 * the per-device record (future extension — not implemented yet).
 */
const STANDARD_LIGHT_DPS: Record<string, string> = {
  '1': 'switch_led',
  '2': 'work_mode',
  '3': 'bright_value_v2',
  '4': 'temp_value_v2',
  '5': 'colour_data_v2',
};

const CODE_TO_DPS: Record<string, string> = Object.fromEntries(
  Object.entries(STANDARD_LIGHT_DPS).map(([dps, code]) => [code, dps]),
);

/**
 * Tuya LAN provider. Talks to each device directly via tuyapi's local TCP
 * protocol so a stalled or expired cloud subscription doesn't kill control.
 *
 * Requires per-device local keys (16-char strings) — obtain once via the
 * cloud API while it's active using `scripts/extract-tuya-keys.mjs` and
 * paste the result into `tuya.localDevices` in config.
 */
export class TuyaLocalProvider implements DeviceProvider {
  readonly id = 'tuya';
  private readonly devicesById = new Map<string, LocalTuyaDeviceConfig>();
  private readonly clients = new Map<string, TuyApiInstance>();
  private readonly log?: LocalTuyaLogger;

  constructor(devices: LocalTuyaDeviceConfig[], log?: LocalTuyaLogger) {
    for (const d of devices) this.devicesById.set(d.id, d);
    this.log = log;
  }

  async discover(): Promise<BridgeDevice[]> {
    // No network call — we already know our devices from config. Synthesize
    // a cloud-shaped TuyaDevice so the existing mapper picks up capabilities
    // from the DPS schema.
    const out: BridgeDevice[] = [];
    for (const dev of this.devicesById.values()) {
      const fakeStatus = Object.keys(STANDARD_LIGHT_DPS).map(dps => ({
        code: STANDARD_LIGHT_DPS[dps],
        value: dps === '1' ? false : dps === '5' ? '{"h":0,"s":0,"v":0}' : 0,
      }));
      const synthetic: TuyaDevice = {
        id: dev.id,
        name: dev.name,
        category: dev.category,
        online: true,
        product_id: dev.productId,
        status: fakeStatus,
      };
      const bridge = tuyaDeviceToBridgeDevice(synthetic);
      if (bridge) out.push(bridge);
    }
    return out;
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const client = await this.connect(deviceId);
    const raw = (await client.get({ schema: true })) as { dps?: Record<string, unknown> };
    const dps = raw?.dps ?? {};
    const statusArray = Object.entries(dps)
      .filter(([k]) => STANDARD_LIGHT_DPS[k])
      .map(([k, v]) => ({
        code: STANDARD_LIGHT_DPS[k],
        value: v as boolean | number | string,
      }));
    return tuyaStatusToState(statusArray);
  }

  async setState(deviceId: string, state: Partial<DeviceState>): Promise<void> {
    const commands = stateToTuyaCommands(state);
    if (commands.length === 0) return;

    // Translate code-named commands to dps-numbered for the LAN protocol.
    const dpsPayload: Record<string, unknown> = {};
    for (const cmd of commands) {
      const dps = CODE_TO_DPS[cmd.code];
      if (dps) dpsPayload[dps] = cmd.value;
    }
    if (Object.keys(dpsPayload).length === 0) return;

    const client = await this.connect(deviceId);
    await client.set({ multiple: true, data: dpsPayload });
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      try { client.removeAllListeners(); client.disconnect(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  private async connect(deviceId: string): Promise<TuyApiInstance> {
    const existing = this.clients.get(deviceId);
    if (existing?.isConnected()) return existing;

    const dev = this.devicesById.get(deviceId);
    if (!dev) throw new Error(`Unknown local Tuya device: ${deviceId}`);

    const client = new TuyaDevice({
      id: dev.id,
      key: dev.localKey,
      ip: dev.ip,
      version: dev.version ?? '3.3',
      issueGetOnConnect: false,
    });

    if (!dev.ip) {
      await client.find({ timeout: 5 });
    }
    await client.connect();
    this.clients.set(deviceId, client);
    return client;
  }

  /** Test seam — inject pre-built tuyapi instances. */
  static __createForTest(
    devices: LocalTuyaDeviceConfig[],
    clientFactory: (dev: LocalTuyaDeviceConfig) => TuyApiInstance,
  ): TuyaLocalProvider {
    const provider = new TuyaLocalProvider(devices);
    // Pre-populate clients so connect() returns them without touching tuyapi.
    for (const dev of devices) {
      (provider as any).clients.set(dev.id, clientFactory(dev));
    }
    // Override connect to skip actual networking.
    (provider as any).connect = async (id: string) => {
      const c = (provider as any).clients.get(id);
      if (!c) throw new Error(`Unknown local Tuya device: ${id}`);
      return c;
    };
    return provider;
  }
}
