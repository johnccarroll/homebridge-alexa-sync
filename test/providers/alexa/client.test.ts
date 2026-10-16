import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlexaClient, type AlexaClientConfig } from '../../../src/providers/alexa/client.js';

function createMockRemote() {
  return {
    init: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    cookieData: { cookie: 'test', csrf: 'test', macDms: { device_private_key: 'k', adp_token: 't' } },
    getSmarthomeDevicesV2: vi.fn((cb: Function) => cb(null, [
      {
        id: 'amzn1.alexa.endpoint.abc',
        friendlyName: 'Test Light',
        displayCategories: { primary: { value: 'LIGHT' } },
        features: [{ name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] }],
      },
    ])),
    httpsGet: vi.fn((_path: string, cb: Function, flags: any) => {
      const body = JSON.parse(flags.data);
      if (body.query.startsWith('mutation')) return cb(null, { data: { setEndpointFeatures: { errors: [] } } });
      cb(null, { data: { endpoints: { items: [{
        id: 'endpoint-id',
        features: [{ name: 'power', properties: [{ name: 'powerState', powerStateValue: 'ON' }] }],
      }] } } });
    }),
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

      const state = await client.queryDeviceState('endpoint-id');
      expect(state).toHaveProperty('Alexa.PowerController');
      expect(state['Alexa.PowerController'].powerState).toBe('ON');
    });
  });

  describe('executeActions', () => {
    it('sends every operation for an endpoint in one GraphQL mutation', async () => {
      const mock = createMockRemote();
      const client = AlexaClient.__createForTest(mock as any);

      await client.executeActions('endpoint-id', [
        { featureName: 'power', featureOperationName: 'turnOn' },
        { featureName: 'brightness', featureOperationName: 'setBrightness', payload: { brightness: 40 } },
      ]);
      expect(mock.httpsGet).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mock.httpsGet.mock.calls[0][2].data);
      expect(body.query).toMatch(/setEndpointFeatures/);
      expect(body.variables.input.featureControlRequests).toEqual([
        { endpointId: 'endpoint-id', featureName: 'power', featureOperationName: 'turnOn' },
        { endpointId: 'endpoint-id', featureName: 'brightness', featureOperationName: 'setBrightness', payload: { brightness: 40 } },
      ]);
    });

    it('throws with the codes Amazon reports per endpoint', async () => {
      const mock = createMockRemote();
      mock.httpsGet = vi.fn((_p: string, cb: Function) =>
        cb(null, { data: { setEndpointFeatures: { errors: [{ endpointId: 'e', code: 'ENDPOINT_UNREACHABLE' }] } } }));
      const client = AlexaClient.__createForTest(mock as any);
      await expect(client.executeActions('e', [{ featureName: 'power', featureOperationName: 'turnOn' }]))
        .rejects.toThrow('Device error: ENDPOINT_UNREACHABLE');
    });
  });

  describe('state via GraphQL', () => {
    it('treats an endpoint whose values are all null (dead skill) as empty state', async () => {
      const mock = createMockRemote();
      mock.httpsGet = vi.fn((_p: string, cb: Function) => cb(null, { data: { endpoints: { items: [
        { id: 'dead', features: [{ name: 'power', properties: [{ name: 'powerState', powerStateValue: null }] }] },
        { id: 'live', features: [{ name: 'thermostat', properties: [
          { name: 'targetSetpoint', value: { value: 72, scale: 'FAHRENHEIT' } },
          { name: 'thermostatMode', thermostatModeValue: 'COOL' },
        ] }] },
      ] } } }));
      const client = AlexaClient.__createForTest(mock as any);

      const states = await client.queryAllStates();
      expect(states.get('dead')).toEqual({});
      expect(states.get('live')).toEqual({
        'Alexa.ThermostatController': { targetSetpoint: { value: 72, scale: 'FAHRENHEIT' }, thermostatMode: 'COOL' },
      });
    });

    it('rejects on GraphQL errors so the circuit breaker counts them', async () => {
      const mock = createMockRemote();
      mock.httpsGet = vi.fn((_p: string, cb: Function) => cb(null, { errors: [{ message: 'Unauthorized' }] }));
      const client = AlexaClient.__createForTest(mock as any);
      await expect(client.queryDeviceState('x')).rejects.toThrow('State query failed: Unauthorized');
    });
  });

  describe('circuit breaker', () => {
    it('opens after 5 consecutive failures and rejects immediately', async () => {
      const mock = createMockRemote();
      // Simulate immediate errors (not hangs) to avoid needing fake timers
      mock.httpsGet = vi.fn((_path: any, cb: Function, _flags: any) => {
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
      // Exactly 5 state queries (not 6). Opening the breaker also runs one auth check.
      const stateQueries = mock.httpsGet.mock.calls
        .filter((c: any[]) => JSON.parse(c[2].data).query.includes('features'));
      expect(stateQueries).toHaveLength(5);
    });

    it('recovers when a query succeeds after probe interval', async () => {
      const mock = createMockRemote();
      let callCount = 0;
      mock.httpsGet = vi.fn((_path: any, cb: Function, _flags: any) => {
        callCount++;
        if (callCount <= 5) {
          cb(new Error('network error'), null);
        } else {
          cb(null, { data: { endpoints: { items: [] } } });
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
      mock.httpsGet = vi.fn((_path: any, cb: Function, _flags: any) => {
        callCount++;
        if (callCount <= 3) {
          cb(new Error('network error'), null);
        } else {
          cb(null, { data: { endpoints: { items: [] } } });
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
      mock.httpsGet = vi.fn((_path: any, cb: Function, _flags: any) => {
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
      mock.httpsGet = vi.fn((_path: any, cb: Function, _flags: any) => {
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
      mock.httpsGet = vi.fn((_path: any, cb: Function, _flags: any) => {
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
      // Both paths share one GraphQL request now; the test decides per call.
      let failNext = false;
      mock.httpsGet = vi.fn((_path: any, cb: Function, _flags: any) => {
        if (failNext) {
          // Single path: always fail
          cb(new Error('single broken'), null);
        } else {
          // Bulk path: always succeed
          cb(null, { data: { endpoints: { items: [] } } });
        }
      });
      const client = AlexaClient.__createForTest(mock as any);

      // Interleave: single fails, bulk succeeds — repeat 4 times. Single
      // counter should be at 4, bulk at 0, breaker still closed.
      for (let i = 0; i < 4; i++) {
        failNext = true;
        await client.queryDeviceState('app-id').catch(() => {});
        failNext = false;
        await client.queryDeviceStates(['app-id', 'app-id-2']).catch(() => {});
      }
      expect(client.isHealthy()).toBe(true);

      // One more single fail — single hits 5 → breaker opens.
      failNext = true;
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
      let failNext = true;
      mock.httpsGet = vi.fn((_path: any, cb: Function, _flags: any) => {
        if (failNext) {
          cb(new Error('single fails'), null);
        } else {
          cb(null, { data: { endpoints: { items: [] } } });
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
      failNext = false;
      await client.queryDeviceStates(['a', 'b']);
      expect(client.isHealthy()).toBe(true);
      expect((client as any).consecutiveFailuresSingle).toBe(0);
      expect((client as any).consecutiveFailuresBulk).toBe(0);
    });
  });

  describe('isAuthenticated', () => {
    // Checked against the GraphQL API the plugin actually uses. alexa-remote2's
    // checkAuthentication reported "not authenticated" while the same cookie was
    // serving GraphQL fine, so every breaker trip logged a false re-login alarm.
    it('returns true when a GraphQL query succeeds', async () => {
      const mock = createMockRemote();
      const client = AlexaClient.__createForTest(mock as any);
      expect(await client.isAuthenticated()).toBe(true);
    });

    it('returns false only when Amazon rejects the session', async () => {
      const mock = createMockRemote();
      mock.httpsGet = vi.fn((_p: string, cb: Function) => cb(new Error('401 Unauthorized'), null));
      const client = AlexaClient.__createForTest(mock as any);
      expect(await client.isAuthenticated()).toBe(false);
    });

    it('does not claim invalid auth on a timeout or network error', async () => {
      const mock = createMockRemote();
      mock.httpsGet = vi.fn((_p: string, cb: Function) => cb(new Error('timeout of 10000ms exceeded'), null));
      const client = AlexaClient.__createForTest(mock as any);
      expect(await client.isAuthenticated()).toBe(true);
    });
  });
});
