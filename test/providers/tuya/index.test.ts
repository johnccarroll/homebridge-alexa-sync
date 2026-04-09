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
