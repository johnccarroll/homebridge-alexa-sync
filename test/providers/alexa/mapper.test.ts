import { describe, it, expect } from 'vitest';
import {
  alexaDeviceToBridgeDevice,
  alexaStateToDeviceState,
  deviceStateToAlexaAction,
} from '../../../src/providers/alexa/mapper.js';

describe('alexaDeviceToBridgeDevice', () => {
  it('maps a full-featured Alexa light', () => {
    const alexaDevice = {
      id: 'amzn1.alexa.endpoint.abc123',
      friendlyName: 'Bedroom Light',
      displayCategories: { primary: { value: 'LIGHT' } },
      features: [
        { name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] },
        { name: 'brightness', operations: [{ name: 'setBrightness' }] },
        { name: 'color', operations: [{ name: 'setColor' }] },
        { name: 'colorTemperature', operations: [{ name: 'setColorTemperature' }] },
      ],
      manufacturer: 'Sengled',
      model: 'E11-G13',
    };

    const device = alexaDeviceToBridgeDevice(alexaDevice);
    expect(device).not.toBeNull();
    expect(device!.id).toBe('alexa:amzn1.alexa.endpoint.abc123');
    expect(device!.name).toBe('Bedroom Light');
    expect(device!.type).toBe('light');
    expect(device!.provider).toBe('alexa');
    expect(device!.capabilities.map(c => c.type)).toEqual(
      expect.arrayContaining(['on-off', 'brightness', 'color', 'color-temperature']),
    );
    expect(device!.manufacturer).toBe('Sengled');
  });

  it('maps a basic on/off switch', () => {
    const alexaDevice = {
      id: 'amzn1.alexa.endpoint.def456',
      friendlyName: 'Smart Plug',
      displayCategories: { primary: { value: 'SMARTPLUG' } },
      features: [
        { name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] },
      ],
    };

    const device = alexaDeviceToBridgeDevice(alexaDevice);
    expect(device).not.toBeNull();
    expect(device!.type).toBe('outlet');
    expect(device!.capabilities).toEqual([{ type: 'on-off' }]);
  });

  it('returns null for unsupported device categories', () => {
    const alexaDevice = {
      id: 'amzn1.alexa.endpoint.xyz',
      friendlyName: 'Apple TV',
      displayCategories: { primary: { value: 'APPLICATION' } },
      features: [],
    };

    expect(alexaDeviceToBridgeDevice(alexaDevice)).toBeNull();
  });

  it('filters by allowed device types', () => {
    const alexaDevice = {
      id: 'amzn1.alexa.endpoint.fan1',
      friendlyName: 'Ceiling Fan',
      displayCategories: { primary: { value: 'FAN' } },
      features: [{ name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] }],
    };

    expect(alexaDeviceToBridgeDevice(alexaDevice, ['LIGHT'])).toBeNull();
    expect(alexaDeviceToBridgeDevice(alexaDevice, ['FAN'])).not.toBeNull();
  });
});

describe('alexaStateToDeviceState', () => {
  it('maps power, brightness, color, and color temp', () => {
    const alexaState = {
      'Alexa.PowerController': { powerState: 'ON' },
      'Alexa.BrightnessController': { brightness: 75 },
      'Alexa.ColorController': { color: { hue: 240, saturation: 0.8, brightness: 1.0 } },
      'Alexa.ColorTemperatureController': { colorTemperatureInKelvin: 4000 },
    };

    const state = alexaStateToDeviceState(alexaState);
    expect(state.on).toBe(true);
    expect(state.brightness).toBe(75);
    expect(state.hue).toBe(240);
    expect(state.saturation).toBe(80);
    expect(state.colorTemperature).toBe(4000);
  });

  it('handles OFF state', () => {
    const alexaState = { 'Alexa.PowerController': { powerState: 'OFF' } };
    expect(alexaStateToDeviceState(alexaState).on).toBe(false);
  });

  it('handles empty state', () => {
    expect(alexaStateToDeviceState({})).toEqual({});
  });
});

describe('deviceStateToAlexaAction', () => {
  it('generates turnOn action', () => {
    const action = deviceStateToAlexaAction({ on: true });
    expect(action).toEqual({ action: 'turnOn' });
  });

  it('generates turnOff action', () => {
    const action = deviceStateToAlexaAction({ on: false });
    expect(action).toEqual({ action: 'turnOff' });
  });

  it('generates setBrightness action', () => {
    const action = deviceStateToAlexaAction({ brightness: 50 });
    expect(action).toEqual({ action: 'setBrightness', brightness: 50 });
  });

  it('generates setColor action with HSB', () => {
    const action = deviceStateToAlexaAction({ hue: 120, saturation: 80 });
    expect(action).toEqual({
      action: 'setColor',
      color: { hue: 120, saturation: 0.8, brightness: 1.0 },
    });
  });

  it('generates setColorTemperature action', () => {
    const action = deviceStateToAlexaAction({ colorTemperature: 4000 });
    expect(action).toEqual({
      action: 'setColorTemperature',
      colorTemperature: { value: 4000 },
    });
  });

  it('returns null for empty state', () => {
    expect(deviceStateToAlexaAction({})).toBeNull();
  });

  it('prioritizes on/off over other properties', () => {
    const action = deviceStateToAlexaAction({ on: true, brightness: 50 });
    expect(action!.action).toBe('turnOn');
  });
});
