import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlexaClient, type AlexaClientConfig } from '../../../src/providers/alexa/client.js';

function createMockRemote() {
  return {
    init: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    cookieData: { cookie: 'test', csrf: 'test', macDms: { device_private_key: 'k', adp_token: 't' } },
    checkAuthentication: vi.fn((cb: Function) => cb(null, { authenticated: true })),
    getSmarthomeDevicesV2: vi.fn((cb: Function) => cb(null, [
      {
        id: 'amzn1.alexa.endpoint.abc',
        friendlyName: 'Test Light',
        displayCategories: { primary: { value: 'LIGHT' } },
        features: [{ name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] }],
      },
    ])),
    querySmarthomeDevices: vi.fn((_ids: any, _type: any, _timeout: any, cb: Function) => cb(null, {
      deviceStates: [{
        entity: { entityId: 'appliance-id' },
        capabilityStates: [
          JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' }),
        ],
      }],
      errors: [],
    })),
    executeSmarthomeDeviceAction: vi.fn((_ids: any, _params: any, _type: any, cb: Function) => cb(null, { controlResponses: [{}] })),
  };
}

describe('AlexaClient', () => {
  describe('discoverDevices', () => {
    it('returns devices from alexa-remote2', async () => {
      const mock = createMockRemote();
      const client = AlexaClient.__createForTest(mock as any);

      const devices = await client.discoverDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].friendlyName).toBe('Test Light');
      expect(mock.getSmarthomeDevicesV2).toHaveBeenCalled();
    });
  });

  describe('queryDeviceState', () => {
    it('queries and parses capability states', async () => {
      const mock = createMockRemote();
      const client = AlexaClient.__createForTest(mock as any);

      const state = await client.queryDeviceState('appliance-id');
      expect(state).toHaveProperty('Alexa.PowerController');
      expect(state['Alexa.PowerController'].powerState).toBe('ON');
    });
  });

  describe('executeAction', () => {
    it('sends action to device', async () => {
      const mock = createMockRemote();
      const client = AlexaClient.__createForTest(mock as any);

      await client.executeAction('appliance-id', { action: 'turnOn' });
      expect(mock.executeSmarthomeDeviceAction).toHaveBeenCalledWith(
        ['appliance-id'],
        { action: 'turnOn' },
        'APPLIANCE',
        expect.any(Function),
      );
    });
  });

  describe('isAuthenticated', () => {
    it('returns true when authenticated', async () => {
      const mock = createMockRemote();
      const client = AlexaClient.__createForTest(mock as any);

      const result = await client.isAuthenticated();
      expect(result).toBe(true);
    });

    it('returns false when not authenticated', async () => {
      const mock = createMockRemote();
      mock.checkAuthentication = vi.fn((cb: Function) => cb(null, { authenticated: false }));
      const client = AlexaClient.__createForTest(mock as any);

      const result = await client.isAuthenticated();
      expect(result).toBe(false);
    });
  });
});
