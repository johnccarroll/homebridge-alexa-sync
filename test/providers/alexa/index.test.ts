import { describe, it, expect, vi } from 'vitest';
import { AlexaProvider } from '../../../src/providers/alexa/index.js';
import type { AlexaClient } from '../../../src/providers/alexa/client.js';
import type { AlexaDevice } from '../../../src/providers/alexa/mapper.js';

const LIGHT_DEVICE: AlexaDevice = {
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
  legacyAppliance: { applianceId: 'appliance-abc123' },
};

const APP_DEVICE: AlexaDevice = {
  id: 'amzn1.alexa.endpoint.tv1',
  friendlyName: 'Apple TV',
  displayCategories: { primary: { value: 'APPLICATION' } },
  features: [],
};

function mockClient(devices: AlexaDevice[]): AlexaClient {
  return {
    discoverDevices: vi.fn().mockResolvedValue(devices),
    queryDeviceState: vi.fn().mockResolvedValue({
      'Alexa.PowerController': { powerState: 'ON' },
      'Alexa.BrightnessController': { brightness: 75 },
    }),
    executeAction: vi.fn().mockResolvedValue(undefined),
    isAuthenticated: vi.fn().mockResolvedValue(true),
    dispose: vi.fn(),
  } as unknown as AlexaClient;
}

describe('AlexaProvider', () => {
  it('has id "alexa"', () => {
    const provider = new AlexaProvider(mockClient([]), {});
    expect(provider.id).toBe('alexa');
  });

  describe('discover', () => {
    it('discovers and maps supported devices', async () => {
      const provider = new AlexaProvider(mockClient([LIGHT_DEVICE, APP_DEVICE]), {});
      const devices = await provider.discover();

      expect(devices).toHaveLength(1);
      expect(devices[0].name).toBe('Bedroom Light');
      expect(devices[0].type).toBe('light');
      expect(devices[0].capabilities.map(c => c.type)).toContain('color');
    });

    it('filters by configured device types', async () => {
      const provider = new AlexaProvider(mockClient([LIGHT_DEVICE]), { deviceTypes: ['SWITCH'] });
      const devices = await provider.discover();
      expect(devices).toHaveLength(0);
    });

    it('stores appliance ID mapping for control', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.getState('amzn1.alexa.endpoint.abc123');
      expect(client.queryDeviceState).toHaveBeenCalledWith('appliance-abc123');
    });
  });

  describe('getState', () => {
    it('queries and maps device state', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      const state = await provider.getState('amzn1.alexa.endpoint.abc123');
      expect(state.on).toBe(true);
      expect(state.brightness).toBe(75);
    });
  });

  describe('setState', () => {
    it('maps state to action and executes', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.setState('amzn1.alexa.endpoint.abc123', { on: false });
      expect(client.executeAction).toHaveBeenCalledWith(
        'appliance-abc123',
        { action: 'turnOff' },
      );
    });

    it('sends multiple actions for compound state changes', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.setState('amzn1.alexa.endpoint.abc123', { on: true, brightness: 50 });
      expect(client.executeAction).toHaveBeenCalledTimes(2);
    });
  });

  describe('dispose', () => {
    it('disposes the client', () => {
      const client = mockClient([]);
      const provider = new AlexaProvider(client, {});
      provider.dispose();
      expect(client.dispose).toHaveBeenCalled();
    });
  });
});
