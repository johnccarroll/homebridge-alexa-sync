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
    queryDeviceStates: vi.fn().mockResolvedValue(new Map()),
    queryAllStates: vi.fn().mockResolvedValue(new Map()),
    executeActions: vi.fn().mockResolvedValue(undefined),
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

    it('addresses devices by endpoint id', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.getState('amzn1.alexa.endpoint.abc123');
      expect(client.queryDeviceState).toHaveBeenCalledWith('amzn1.alexa.endpoint.abc123');
    });

    it('picks the duplicate that reports state over a dead skill endpoint', async () => {
      // Real account: "Bedroom 1" appears four times, three from a retired
      // development skill whose endpoints return all-null state.
      const dead = { ...LIGHT_DEVICE, id: 'dead', friendlyName: 'Bedroom 1', legacyAppliance: { applianceId: 'SKILL_dead' } };
      const live = { ...LIGHT_DEVICE, id: 'live', friendlyName: 'Bedroom 1', legacyAppliance: { applianceId: 'SKILL_live' } };
      const client = mockClient([dead, live, { ...dead, id: 'dead2' }]);
      (client.queryAllStates as any).mockResolvedValue(new Map([
        ['dead', {}], ['dead2', {}], ['live', { 'Alexa.PowerController': { powerState: 'ON' } }],
      ]));
      const devices = await new AlexaProvider(client, {}).discover();
      expect(devices.map(d => d.id)).toEqual(['alexa:live']);
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
      expect(client.executeActions).toHaveBeenCalledWith(
        'amzn1.alexa.endpoint.abc123',
        [{ featureName: 'power', featureOperationName: 'turnOff' }],
      );
    });

    it('sends multiple actions for compound state changes', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.setState('amzn1.alexa.endpoint.abc123', { on: true, brightness: 50 });
      expect(client.executeActions).toHaveBeenCalledTimes(1);
      expect((client.executeActions as any).mock.calls[0][1]).toHaveLength(2);
    });

    it('hue-only change preserves cached brightness + saturation in setColor', async () => {
      // Real-world: user dims a colored light to 40%, sets it to saturated red
      // (h=0, s=100), then nudges the hue slider to magenta (h=300). The hue
      // nudge in iOS Home sends only `{ hue: 300 }` — the plugin must NOT
      // snap brightness back to 100% or saturation to anything other than what
      // was last known. Alexa's setColor action takes a full HSB and replaces
      // device state; partial diffs from HomeKit have to be merged before send.
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      const target = { on: true, brightness: 40, hue: 300, saturation: 100 };
      await provider.setState(
        'amzn1.alexa.endpoint.abc123',
        { hue: 300 },
        target,
      );

      const colorCall = (client.executeActions as any).mock.calls[0][1].find(
        (req: { featureOperationName: string }) => req.featureOperationName === 'setColor',
      );
      expect(colorCall).toBeDefined();
      const color = colorCall.payload.color as { hue: number; saturation: number; brightness: number };
      expect(color.hue).toBe(300);
      expect(color.saturation).toBeCloseTo(1.0, 5);     // 100% from target
      expect(color.brightness).toBeCloseTo(0.4, 5);     // 40% from target, NOT 1.0
    });

    it('saturation-only change preserves cached hue + brightness in setColor', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      const target = { on: true, brightness: 60, hue: 180, saturation: 50 };
      await provider.setState(
        'amzn1.alexa.endpoint.abc123',
        { saturation: 50 },
        target,
      );

      const colorCall = (client.executeActions as any).mock.calls[0][1].find(
        (req: { featureOperationName: string }) => req.featureOperationName === 'setColor',
      );
      const color = colorCall.payload.color;
      expect(color.hue).toBe(180);
      expect(color.saturation).toBeCloseTo(0.5, 5);
      expect(color.brightness).toBeCloseTo(0.6, 5);
    });

    it('color change without a target falls back to safe defaults (back-compat)', async () => {
      // Older callers may not pass a target. Behavior should still be sane —
      // not crash, not split the user's setup.
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      await provider.setState('amzn1.alexa.endpoint.abc123', { hue: 240 });
      const colorCall = (client.executeActions as any).mock.calls[0][1].find(
        (req: { featureOperationName: string }) => req.featureOperationName === 'setColor',
      );
      expect(colorCall.payload.color.hue).toBe(240);
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

  // Rediscovery runs every 6h for the life of the process. The appliance-id
  // maps used to only ever grow: a device deleted from the Alexa account kept
  // its mapping forever, so getState on it queried a dead applianceId instead
  // of failing fast with "Unknown Alexa device".
  describe('rediscovery', () => {
    it('forgets devices that disappeared from the account', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();

      // Device still known after the first pass.
      await expect(provider.getState(LIGHT_DEVICE.id)).resolves.toBeDefined();

      // Second discovery no longer returns it.
      (client.discoverDevices as any).mockResolvedValue([]);
      await provider.discover();

      await expect(provider.getState(LIGHT_DEVICE.id))
        .rejects.toThrow(/Unknown Alexa device/);
    });

    it('does not accumulate stale entries in the bulk-state path', async () => {
      const client = mockClient([LIGHT_DEVICE]);
      const provider = new AlexaProvider(client, {});
      await provider.discover();
      (client.discoverDevices as any).mockResolvedValue([]);
      await provider.discover();

      // No known appliance ids left, so no query should be attempted at all.
      const result = await provider.getStates([LIGHT_DEVICE.id]);
      expect(result.size).toBe(0);
      expect((client as any).queryDeviceStates).not.toHaveBeenCalled();
    });
  });
});
