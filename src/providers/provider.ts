import type { BridgeDevice, DeviceState } from '../types.js';

export interface DeviceProvider {
  readonly id: string;
  discover(): Promise<BridgeDevice[]>;
  getState(deviceId: string): Promise<DeviceState>;
  /**
   * Apply a partial state change. `target`, when provided, is the full desired
   * state (the partial merged with whatever was last cached). Providers that
   * map to APIs which *replace* state rather than patch — Alexa's `setColor`
   * is the canonical one, since it takes a full HSB tuple — use `target` to
   * fill in unchanged fields rather than defaulting them to 0/100/etc.
   */
  setState(deviceId: string, state: Partial<DeviceState>, target?: DeviceState): Promise<void>;
  onStateChange?(callback: (deviceId: string, state: DeviceState) => void): void;
  dispose(): void;
}
