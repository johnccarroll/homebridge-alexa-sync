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
    stopProxyServer: vi.fn((cb?: Function) => cb && cb()),
  };
}

// Regression guard for the leaked login proxy. alexa-cookie2 starts an
// interactive Amazon-login HTTP server whenever it is asked for a cookie
// without credentials, and that branch ignores `setupProxy: false`. If init
// fails we must (a) have pinned the listener to loopback and (b) shut it down,
// or every Homebridge restart with a stale cookie strands another world-
// reachable Amazon login form on a random port.
describe('AlexaClient.init — leaked login proxy', () => {
  function clientWithMock(mock: ReturnType<typeof createMockRemote>) {
    const client = AlexaClient.__createForTest(mock as any);
    (client as any).initialized = false;
    return client;
  }

  const STORED = { localCookie: 'c', macDms: { device_private_key: 'k', adp_token: 't' } };

  it('binds the fallback proxy to loopback rather than every interface', async () => {
    const mock = createMockRemote();
    mock.init = vi.fn((_opts: any, cb: Function) => cb(null));
    const client = clientWithMock(mock);

    await client.init(STORED as any);

    const opts = (mock.init as any).mock.calls[0][0];
    expect(opts.proxyListenBind).toBe('127.0.0.1');
    expect(opts.proxyOwnIp).toBe('127.0.0.1');
  });

  it('stops the proxy server when init fails', async () => {
    const mock = createMockRemote();
    mock.init = vi.fn((_opts: any, cb: Function) =>
      cb(new Error('Please open http://undefined:43573/ with your browser')));
    const client = clientWithMock(mock);

    await expect(client.init(STORED as any)).rejects.toThrow();
    expect(mock.stopProxyServer).toHaveBeenCalled();
  });

  it('replaces the unusable "please open http://…" prompt with the real fix', async () => {
    const mock = createMockRemote();
    mock.init = vi.fn((_opts: any, cb: Function) =>
      cb(new Error('Please open http://undefined:43573/ with your browser and login to Amazon.')));
    const client = clientWithMock(mock);

    const err = await client.init(STORED as any).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/alexa-login-proxy\.cjs/);
    // The dead port and the "open this URL" instruction must not survive.
    expect((err as Error).message).not.toMatch(/43573/);
    expect((err as Error).message).not.toMatch(/Please open/i);
  });

  it('passes through auth errors that are not the proxy prompt', async () => {
    const mock = createMockRemote();
    mock.init = vi.fn((_opts: any, cb: Function) => cb(new Error('no csrf found')));
    const client = clientWithMock(mock);

    await expect(client.init(STORED as any)).rejects.toThrow(/no csrf found/);
  });
});

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

    it('bulk path opens after 5 consecutive failures', async () => {
      const mock = createMockRemote();
      mock.querySmarthomeDevices = vi.fn((_ids: any, _type: any, _timeout: any, cb: Function) => {
        cb(new Error('bulk network error'), null);
      });
      const client = AlexaClient.__createForTest(mock as any);

      for (let i = 0; i < 5; i++) {
        await client.queryDeviceStates(['app-id']).catch(() => {});
      }
      expect(client.isHealthy()).toBe(false);
      await expect(client.queryDeviceStates(['app-id'])).rejects.toThrow('Alexa circuit open');
    });

    it('counts single + bulk failures separately — alternating 4+4 does NOT trip the breaker', async () => {
      // Pre-fix bug: the two paths shared `consecutiveFailures`, so 4 single
      // fails + 4 bulk fails accumulated to 8 and tripped the breaker at the
      // 5th overall failure even though no single path had hit threshold.
      // After the fix: each path has its own counter and either hitting 5
      // opens the breaker. 4+4 means max-per-path = 4, breaker stays closed.
      const mock = createMockRemote();
      mock.querySmarthomeDevices = vi.fn((_ids: any, _type: any, _timeout: any, cb: Function) => {
        cb(new Error('network blip'), null);
      });
      const client = AlexaClient.__createForTest(mock as any);

      for (let i = 0; i < 4; i++) {
        await client.queryDeviceState('app-id').catch(() => {});
        await client.queryDeviceStates(['app-id']).catch(() => {});
      }
      expect(client.isHealthy()).toBe(true);
    });

    it('sustained outage on both paths still opens at 5 per-path failures', async () => {
      // The other end of the spec: if both paths individually hit threshold,
      // the breaker still opens.
      const mock = createMockRemote();
      mock.querySmarthomeDevices = vi.fn((_ids: any, _type: any, _timeout: any, cb: Function) => {
        cb(new Error('sustained outage'), null);
      });
      const client = AlexaClient.__createForTest(mock as any);

      for (let i = 0; i < 5; i++) {
        await client.queryDeviceState('app-id').catch(() => {});
        await client.queryDeviceStates(['app-id']).catch(() => {});
      }
      expect(client.isHealthy()).toBe(false);
    });

    it('success on either path resets only its own counter — not the other', async () => {
      // Independence: if single is failing but bulk works, single counter
      // continues to accumulate. The opposite for bulk.
      const mock = createMockRemote();
      let count = 0;
      mock.querySmarthomeDevices = vi.fn((ids: any, _type: any, _timeout: any, cb: Function) => {
        count++;
        if (ids.length === 1) {
          // Single path: always fail
          cb(new Error('single broken'), null);
        } else {
          // Bulk path: always succeed
          cb(null, { deviceStates: [{ capabilityStates: [] }], errors: [] });
        }
      });
      const client = AlexaClient.__createForTest(mock as any);

      // Interleave: single fails, bulk succeeds — repeat 4 times. Single
      // counter should be at 4, bulk at 0, breaker still closed.
      for (let i = 0; i < 4; i++) {
        await client.queryDeviceState('app-id').catch(() => {});
        await client.queryDeviceStates(['app-id', 'app-id-2']).catch(() => {});
      }
      expect(client.isHealthy()).toBe(true);

      // One more single fail — single hits 5 → breaker opens.
      await client.queryDeviceState('app-id').catch(() => {});
      expect(client.isHealthy()).toBe(false);
    });

    it('half-open recovery resets BOTH counters so the other path does not immediately re-open', async () => {
      // Real race that motivated this: single path opens the breaker. Time
      // passes. A bulk query in half-open mode succeeds. If bulk's success
      // only reset bulk's counter, single's counter would still be at 5 and
      // the very next single-path call would re-open the breaker. Reset
      // both on circuit close.
      const mock = createMockRemote();
      let bulkCallCount = 0;
      mock.querySmarthomeDevices = vi.fn((ids: any, _type: any, _timeout: any, cb: Function) => {
        if (ids.length === 1) {
          // Single path: always fail. Caller decides whether to call it.
          cb(new Error('single fails'), null);
        } else {
          bulkCallCount++;
          cb(null, { deviceStates: [{ capabilityStates: [] }], errors: [] });
        }
      });
      const client = AlexaClient.__createForTest(mock as any);

      // 5 single fails open the breaker.
      for (let i = 0; i < 5; i++) {
        await client.queryDeviceState('app-id').catch(() => {});
      }
      expect(client.isHealthy()).toBe(false);

      // Probe interval passes.
      (client as any).circuitOpenedAt = Date.now() - (5 * 60 * 1000 + 1);

      // Bulk probe succeeds — circuit closes. Both counters must reset.
      await client.queryDeviceStates(['a', 'b']);
      expect(client.isHealthy()).toBe(true);
      expect((client as any).consecutiveFailuresSingle).toBe(0);
      expect((client as any).consecutiveFailuresBulk).toBe(0);
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
