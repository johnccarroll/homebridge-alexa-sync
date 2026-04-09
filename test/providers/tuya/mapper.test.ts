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
