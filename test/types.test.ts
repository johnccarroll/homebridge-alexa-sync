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
