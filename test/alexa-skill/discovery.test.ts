import { describe, it, expect } from 'vitest';
import { buildDiscoveryResponse } from '../../src/alexa-skill/discovery.js';
import type { BridgeDevice } from '../../src/types.js';

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
  model: 'Smart Bulb',
};

const OUTLET: BridgeDevice = {
  id: 'alexa:plug_001',
  name: 'Desk Plug',
  type: 'outlet',
  provider: 'alexa',
  capabilities: [{ type: 'on-off' }],
};

describe('buildDiscoveryResponse', () => {
  it('builds valid Alexa Discovery.Response', () => {
    const response = buildDiscoveryResponse([LIGHT, OUTLET]);
    expect(response.event.header.namespace).toBe('Alexa.Discovery');
    expect(response.event.header.name).toBe('Discover.Response');
    expect(response.event.header.payloadVersion).toBe('3');
    expect(response.event.payload.endpoints).toHaveLength(2);
  });

  it('maps light with all capabilities', () => {
    const response = buildDiscoveryResponse([LIGHT]);
    const endpoint = response.event.payload.endpoints[0];
    expect(endpoint.endpointId).toBe('tuya:dev_001');
    expect(endpoint.friendlyName).toBe('Kitchen Light');
    expect(endpoint.manufacturerName).toBe('Tuya');
    expect(endpoint.displayCategories).toContain('LIGHT');
    const capabilityInterfaces = endpoint.capabilities.map((c: any) => c.interface);
    expect(capabilityInterfaces).toContain('Alexa.PowerController');
    expect(capabilityInterfaces).toContain('Alexa.BrightnessController');
    expect(capabilityInterfaces).toContain('Alexa.ColorController');
    expect(capabilityInterfaces).toContain('Alexa.ColorTemperatureController');
    expect(capabilityInterfaces).toContain('Alexa');
  });

  it('maps outlet with on-off only', () => {
    const response = buildDiscoveryResponse([OUTLET]);
    const endpoint = response.event.payload.endpoints[0];
    expect(endpoint.displayCategories).toContain('SMARTPLUG');
    const capabilityInterfaces = endpoint.capabilities.map((c: any) => c.interface);
    expect(capabilityInterfaces).toContain('Alexa.PowerController');
    expect(capabilityInterfaces).not.toContain('Alexa.BrightnessController');
  });
});
