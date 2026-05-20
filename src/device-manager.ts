import type { DeviceProvider } from './providers/provider.js';
import type { BridgeDevice, DeviceState } from './types.js';

interface CacheEntry {
  state: DeviceState;
  timestamp: number;
}

export interface DiscoveryLogger {
  warn(message: string): void;
}

export class DeviceManager {
  private readonly providers: Map<string, DeviceProvider>;
  private readonly devices = new Map<string, BridgeDevice>();
  private readonly stateCache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly log?: DiscoveryLogger;
  private onChangeCallback?: (deviceId: string, state: DeviceState) => void;

  constructor(providers: DeviceProvider[], cacheTtlMs = 30_000, log?: DiscoveryLogger) {
    this.providers = new Map(providers.map(p => [p.id, p]));
    this.cacheTtlMs = cacheTtlMs;
    this.log = log;
  }

  async discoverAll(): Promise<BridgeDevice[]> {
    this.devices.clear();

    const providerList = [...this.providers.values()];
    const results = await Promise.allSettled(providerList.map(p => p.discover()));

    // Collect all discovered devices; surface rejections so silent provider
    // failures (expired creds, network blips) don't masquerade as "0 devices".
    const allDevices: BridgeDevice[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allDevices.push(...result.value);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.log?.warn(`Provider "${providerList[i].id}" discovery failed: ${reason}`);
      }
    }

    // Deduplicate by name — prefer direct API providers over fallback
    const PROVIDER_PRIORITY: Record<string, number> = {
      tuya: 10,
      resideo: 10,
      alexa: 1, // cookie-based fallback — lowest priority
    };

    const byName = new Map<string, BridgeDevice>();
    for (const device of allDevices) {
      const key = device.name.trim().toLowerCase();
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, device);
      } else {
        const existingPriority = PROVIDER_PRIORITY[existing.provider] ?? 5;
        const newPriority = PROVIDER_PRIORITY[device.provider] ?? 5;
        if (newPriority > existingPriority) {
          byName.set(key, device);
        }
      }
    }

    for (const device of byName.values()) {
      this.devices.set(device.id, device);
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

    // Merge first so the provider sees the full desired state. Necessary for
    // APIs that replace rather than patch — e.g. Alexa's setColor takes a
    // full HSB and a hue-only partial would otherwise default the other two
    // axes to 0/100.
    const cached = this.stateCache.get(deviceId);
    const merged = { ...(cached?.state ?? {}), ...state };

    await provider.setState(localId, state, merged);

    this.stateCache.set(deviceId, { state: merged, timestamp: Date.now() });
    this.onChangeCallback?.(deviceId, merged);
  }

  onStateChange(callback: (deviceId: string, state: DeviceState) => void): void {
    this.onChangeCallback = callback;
  }

  getProvider(id: string): DeviceProvider | undefined {
    return this.providers.get(id);
  }

  getCachedState(deviceId: string): DeviceState | undefined {
    const cached = this.stateCache.get(deviceId);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.state;
    }
    return undefined;
  }

  updateCache(deviceId: string, state: DeviceState): void {
    this.stateCache.set(deviceId, { state, timestamp: Date.now() });
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

    const localId = deviceId.slice(device.provider.length + 1);
    return { provider, localId };
  }
}
