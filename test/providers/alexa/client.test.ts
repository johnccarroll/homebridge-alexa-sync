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

  describe('circuit breaker', () => {
    it('opens after 5 consecutive failures and rejects immediately', async () => {
      const mock = createMockRemote();
      // Simulate immediate errors (not hangs) to avoid needing fake timers
      mock.querySmarthomeDevices = vi.fn((_ids: any, _type: any, _timeout: any, cb: Function) => {
        cb(new Error('network error'), null);
      });
      const client = AlexaClient.__createForTest(mock as any);

      // Trigger 5 failures
      for (let i = 0; i < 5; i++) {
        await expect(client.queryDeviceState('app-id')).rejects.toThrow('State query failed');
      }
      expect(client.isHealthy()).toBe(false);

      // 6th call should be rejected immediately without hitting the API
      await expect(client.queryDeviceState('app-id')).rejects.toThrow('Alexa circuit open');
      // Mock should have been called exactly 5 times (not 6)
      expect(mock.querySmarthomeDevices).toHaveBeenCalledTimes(5);
    });

    it('recovers when a query succeeds after probe interval', async () => {
      const mock = createMockRemote();
      let callCount = 0;
      mock.querySmarthomeDevices = vi.fn((_ids: any, _type: any, _timeout: any, cb: Function) => {
        callCount++;
        if (callCount <= 5) {
          cb(new Error('network error'), null);
        } else {
          cb(null, { deviceStates: [{ capabilityStates: [] }], errors: [] });
        }
      });
      const client = AlexaClient.__createForTest(mock as any);

      // Open the circuit
      for (let i = 0; i < 5; i++) {
        await client.queryDeviceState('app-id').catch(() => {});
      }
      expect(client.isHealthy()).toBe(false);

      // Simulate time passing beyond probe interval by manipulating circuitOpenedAt
      (client as any).circuitOpenedAt = Date.now() - (5 * 60 * 1000 + 1);

      // Next call should go through (half-open probe) and succeed
      const state = await client.queryDeviceState('app-id');
      expect(state).toEqual({});
      expect(client.isHealthy()).toBe(true);
    });

    it('resets failure count on success', async () => {
      const mock = createMockRemote();
      let callCount = 0;
      mock.querySmarthomeDevices = vi.fn((_ids: any, _type: any, _timeout: any, cb: Function) => {
        callCount++;
        if (callCount <= 3) {
          cb(new Error('network error'), null);
        } else {
          cb(null, { deviceStates: [{ capabilityStates: [] }], errors: [] });
        }
      });
      const client = AlexaClient.__createForTest(mock as any);

      // 3 failures
      for (let i = 0; i < 3; i++) {
        await client.queryDeviceState('app-id').catch(() => {});
      }
      // Circuit should still be closed (threshold is 5)
      expect(client.isHealthy()).toBe(true);

      // Success resets counter
      await client.queryDeviceState('app-id');
      expect(client.isHealthy()).toBe(true);
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
