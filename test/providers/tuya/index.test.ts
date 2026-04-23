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

  describe('MQTT push integration', () => {
    it('getState returns cached value after discover (no REST call)', async () => {
      const api = mockApi([LIGHT_DEVICE]);
      const provider = new TuyaProvider(api);
      await provider.discover();
      (api.getDeviceStatus as ReturnType<typeof vi.fn>).mockClear();

      const state = await provider.getState('dev_001');
      expect(state.on).toBe(true);
      expect(state.brightness).toBe(50);
      // Cache hit — no REST call should happen
      expect(api.getDeviceStatus).not.toHaveBeenCalled();
    });

    it('MQTT message updates cache + fires listener', async () => {
      const api = mockApi([LIGHT_DEVICE]);
      const provider = new TuyaProvider(api);
      await provider.discover();

      const listener = vi.fn();
      provider.onStateChange(listener);

      // Simulate an MQTT-delivered status change for a known device
      (provider as unknown as {
        onMqMessage: (m: { devId: string; status: Array<{ code: string; value: boolean | number | string }> }) => void;
      }).onMqMessage({
        devId: 'dev_001',
        status: [{ code: 'switch_led', value: false }],
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toBe('dev_001');
      expect(listener.mock.calls[0][1].on).toBe(false);

      // Cache should reflect the new state
      const state = await provider.getState('dev_001');
      expect(state.on).toBe(false);
      // Previous fields preserved via merge
      expect(state.brightness).toBe(50);
    });

    it('ignores MQTT messages for unknown devices', async () => {
      const api = mockApi([LIGHT_DEVICE]);
      const provider = new TuyaProvider(api);
      await provider.discover();

      const listener = vi.fn();
      provider.onStateChange(listener);

      (provider as unknown as {
        onMqMessage: (m: { devId: string; status: Array<{ code: string; value: boolean | number | string }> }) => void;
      }).onMqMessage({
        devId: 'not_in_my_bridge',
        status: [{ code: 'switch_led', value: true }],
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it('onStateChange returns an unsubscribe function', async () => {
      const api = mockApi([LIGHT_DEVICE]);
      const provider = new TuyaProvider(api);
      await provider.discover();

      const listener = vi.fn();
      const unsubscribe = provider.onStateChange(listener);
      unsubscribe();

      (provider as unknown as {
        onMqMessage: (m: { devId: string; status: Array<{ code: string; value: boolean | number | string }> }) => void;
      }).onMqMessage({
        devId: 'dev_001',
        status: [{ code: 'switch_led', value: false }],
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it('setState optimistically updates cache', async () => {
      const api = mockApi([LIGHT_DEVICE]);
      const provider = new TuyaProvider(api);
      await provider.discover();

      await provider.setState('dev_001', { on: false });
      // Without hitting MQTT/REST again, cache should reflect the optimistic update
      const state = await provider.getState('dev_001');
      expect(state.on).toBe(false);
    });
  });
});
