import { describe, it, expect, vi } from 'vitest';
import { configureAccessory } from '../src/accessory.js';
import type { BridgeDevice } from '../src/types.js';

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

    configureAccessory(accessory as any, LIGHT, { Service, Characteristic } as any, getState, setState);
    expect(accessory.addService).toHaveBeenCalledWith('Lightbulb');
  });

  it('registers On, Brightness, Hue, Saturation, ColorTemperature for full light', () => {
    const accessory = createMockAccessory();
    configureAccessory(accessory as any, LIGHT, { Service, Characteristic } as any, vi.fn(), vi.fn());

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
