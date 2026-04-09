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

    const localId = deviceId.slice(device.provider.length + 1);
    return { provider, localId };
  }
}
