import { describe, it, expect, vi } from 'vitest';
import { TuyaLocalProvider, type LocalTuyaDeviceConfig } from '../../../src/providers/tuya/local.js';

const DEVICES: LocalTuyaDeviceConfig[] = [
  {
    id: 'abc123',
    name: 'Bedroom 1',
    category: 'dj',
    productId: 'p_light',
    localKey: '1234567890abcdef',
    ip: '10.0.0.50',
  },
];

function mockClient(dpsValues: Record<string, unknown>) {
  return {
    find: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    get: vi.fn().mockResolvedValue({ dps: dpsValues }),
    set: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
  };
}

describe('TuyaLocalProvider', () => {
  describe('discover', () => {
    it('returns BridgeDevice for each configured device without network', async () => {
      const provider = TuyaLocalProvider.__createForTest(DEVICES, () => mockClient({}) as any);
      const out = await provider.discover();
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe('tuya:abc123');
      expect(out[0].name).toBe('Bedroom 1');
      expect(out[0].type).toBe('light');
      const caps = out[0].capabilities.map(c => c.type);
      expect(caps).toContain('on-off');
      expect(caps).toContain('brightness');
      expect(caps).toContain('color');
      expect(caps).toContain('color-temperature');
    });
  });

  describe('getState', () => {
    it('translates DPS payload back to DeviceState via existing mapper', async () => {
      const client = mockClient({ '1': true, '3': 500 });
      const provider = TuyaLocalProvider.__createForTest(DEVICES, () => client as any);

      const state = await provider.getState('abc123');
      expect(state.on).toBe(true);
      expect(state.brightness).toBe(50); // 500/1000 * 100
      expect(client.get).toHaveBeenCalledWith({ schema: true });
    });

    it('ignores DPS keys not in the standard light layout', async () => {
      const client = mockClient({ '1': true, '99': 'noise' });
      const provider = TuyaLocalProvider.__createForTest(DEVICES, () => client as any);

      const state = await provider.getState('abc123');
      expect(state.on).toBe(true);
      expect(Object.keys(state)).toEqual(['on']);
    });
  });

  describe('setState', () => {
    it('translates state commands to DPS payload', async () => {
      const client = mockClient({});
      const provider = TuyaLocalProvider.__createForTest(DEVICES, () => client as any);

      await provider.setState('abc123', { on: true, brightness: 75 });

      expect(client.set).toHaveBeenCalledTimes(1);
      const callArg = client.set.mock.calls[0][0];
      expect(callArg.multiple).toBe(true);
      expect(callArg.data['1']).toBe(true); // switch_led
      expect(callArg.data['2']).toBe('white'); // work_mode
      expect(callArg.data['3']).toBe(750); // bright_value_v2 (75 * 10)
    });

    it('no-ops when state has no mappable fields', async () => {
      const client = mockClient({});
      const provider = TuyaLocalProvider.__createForTest(DEVICES, () => client as any);

      await provider.setState('abc123', {});
      expect(client.set).not.toHaveBeenCalled();
    });

    it('throws for unknown device id', async () => {
      const provider = TuyaLocalProvider.__createForTest(DEVICES, () => mockClient({}) as any);
      await expect(provider.setState('unknown_id', { on: true })).rejects.toThrow('Unknown local Tuya device');
    });
  });
});
