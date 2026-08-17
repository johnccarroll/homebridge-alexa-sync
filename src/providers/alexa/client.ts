import { createRequire } from 'node:module';
import type { AlexaDevice, AlexaDeviceState } from './mapper.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AlexaRemote = require('alexa-remote2') as new () => AlexaRemoteInstance;

interface AlexaRemoteInstance {
  init(options: Record<string, unknown>, callback: (err: Error | null) => void): void;
  on(event: string, callback: (...args: any[]) => void): void;
  removeAllListeners(event?: string): void;
  cookieData: unknown;
  checkAuthentication(callback: (err: Error | null, result: any) => void): void;
  getSmarthomeDevicesV2(callback: (err: Error | null, result: any) => void): void;
  querySmarthomeDevices(
    ids: string[],
    entityType: string,
    timeout: number,
    callback: (err: Error | null, result: any) => void,
  ): void;
  executeSmarthomeDeviceAction(
    ids: string[],
    params: Record<string, unknown>,
    entityType: string,
    callback: (err: Error | null, result: any) => void,
  ): void;
  stopProxyServer(callback?: (err?: Error | null) => void): void;
}

export interface AlexaClientConfig {
  amazonDomain: string;
  cookieRefreshDays: number;
  persistPath: string;
  logger?: (msg: string) => void;
  warnLogger?: (msg: string) => void;
}

interface CookieData {
  cookie?: string;
  csrf?: string;
  macDms?: { device_private_key: string; adp_token: string };
  localCookie?: string;
}

const ALEXA_SERVICE_HOSTS: Record<string, string> = {
  'amazon.com': 'pitangui.amazon.com',
  'amazon.co.uk': 'layla.amazon.co.uk',
  'amazon.de': 'layla.amazon.de',
  'amazon.ca': 'pitangui.amazon.com',
  'amazon.com.au': 'alexa.amazon.com.au',
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class AlexaClient {
  private remote: AlexaRemoteInstance;
  private initialized = false;
  private readonly config: AlexaClientConfig;
  // Per-path failure counters. Single (queryDeviceState, called by HomeKit
  // cache misses) and bulk (queryDeviceStates, called by the poll tick) each
  // track their own consecutive-fail streak so a network blip during which
  // both paths are in flight doesn't double-count toward the breaker
  // threshold. Either reaching CIRCUIT_BREAKER_THRESHOLD opens the breaker.
  // A successful query resets that path's counter; closing the breaker
  // (half-open probe succeeded) resets both so the path that didn't probe
  // can't immediately re-open the breaker on its first attempt.
  private consecutiveFailuresSingle = 0;
  private consecutiveFailuresBulk = 0;
  private circuitOpen = false;
  private circuitOpenedAt = 0;

  private maybeOpenCircuit(): void {
    if (this.circuitOpen) return;
    if (this.consecutiveFailuresSingle < CIRCUIT_BREAKER_THRESHOLD
        && this.consecutiveFailuresBulk < CIRCUIT_BREAKER_THRESHOLD) return;
    this.circuitOpen = true;
    this.circuitOpenedAt = Date.now();
    const warn = this.config.warnLogger ?? this.config.logger;
    const worst = Math.max(this.consecutiveFailuresSingle, this.consecutiveFailuresBulk);
    warn?.(
      `Alexa polling paused after ${worst} consecutive failures — will probe every 5 minutes`,
    );
    this.isAuthenticated().then(
      (authed) => {
        if (!authed) {
          warn?.('Alexa authentication appears invalid — re-login required via proxy');
        }
      },
      () => { /* ignore auth check errors */ },
    );
  }

  private onSuccessfulQuery(): void {
    // If we were open, this is the half-open probe succeeding — close the
    // breaker AND reset both counters so the path that didn't probe can't
    // immediately re-open the breaker. If we weren't open, just clear noise.
    if (this.circuitOpen) {
      this.circuitOpen = false;
      this.consecutiveFailuresSingle = 0;
      this.consecutiveFailuresBulk = 0;
      const warn = this.config.warnLogger ?? this.config.logger;
      warn?.('Alexa connection recovered — resuming polls');
    }
  }

  constructor(config: AlexaClientConfig) {
    this.config = config;
    this.remote = new AlexaRemote();
  }

  async init(storedCookie?: CookieData): Promise<void> {
    const hasCookie = !!(storedCookie?.localCookie ?? storedCookie?.cookie);
    if (!hasCookie) {
      throw new Error(
        'Alexa cookie missing. Run `node scripts/alexa-login-proxy.cjs` from the ' +
        'plugin directory, open the URL it prints, sign in with Amazon, then ' +
        'restart Homebridge.',
      );
    }

    const serviceHost = ALEXA_SERVICE_HOSTS[this.config.amazonDomain] ?? 'pitangui.amazon.com';

    return new Promise<void>((resolve, reject) => {
      this.remote.init(
        {
          acceptLanguage: 'en-US',
          amazonPage: this.config.amazonDomain,
          baseAmazonPage: this.config.amazonDomain,
          amazonPageProxyLanguage: 'en_US',
          alexaServiceHost: serviceHost,
          cookie: storedCookie!.localCookie ?? storedCookie!.cookie,
          formerRegistrationData: storedCookie as any,
          macDms: storedCookie!.macDms as any,
          cookieRefreshInterval: this.config.cookieRefreshDays * ONE_DAY_MS,
          usePushConnection: false,
          useWsMqtt: false,
          logger: this.config.logger,
          // When the stored cookie is too stale to refresh, alexa-remote2 asks
          // alexa-cookie2 to mint a new one. With no email/password that lands
          // in a branch (alexa-cookie.js ~L378) which starts an interactive
          // Amazon-login proxy *unconditionally* — `setupProxy: false` does not
          // reach it. Worse, proxyListenBind is only defaulted inside the
          // skipped setupProxy branch, so it arrives at proxy.js's
          // `app.listen(port, undefined)` and binds every interface. Pinning it
          // to loopback means the window is at least not LAN-reachable; the
          // error path below then tears the server down. Do not remove either
          // half without re-checking those upstream lines.
          proxyOwnIp: '127.0.0.1',
          proxyListenBind: '127.0.0.1',
        },
        (err: Error | null) => {
          if (err) {
            // Tear down any proxy the failed init left listening. Without this
            // it survives for the life of the Homebridge process, and a new
            // pair leaks on every restart.
            this.stopProxyServerSafely();
            reject(new Error(this.describeInitError(err)));
          } else {
            this.initialized = true;
            resolve();
          }
        },
      );
    });
  }

  /** alexa-remote2's "please open http://…" prompt assumes a human watching a
   *  terminal. In Homebridge it's noise pointing at a port we just closed —
   *  replace it with the step that actually fixes things. */
  private describeInitError(err: Error): string {
    const raw = err.message ?? '';
    if (/Please open http/i.test(raw)) {
      return 'Alexa cookie is expired or was rejected by Amazon. Re-run '
        + '`node scripts/alexa-login-proxy.cjs` on the Homebridge host to capture '
        + 'a fresh one, then restart Homebridge.';
    }
    return `Alexa auth failed: ${raw}`;
  }

  private stopProxyServerSafely(): void {
    try {
      this.remote.stopProxyServer?.(() => { /* best effort */ });
    } catch {
      // Older alexa-remote2 builds may not expose it — nothing to clean up.
    }
  }

  getCookieData(): CookieData | null {
    if (!this.remote.cookieData) return null;
    return this.remote.cookieData as CookieData;
  }

  onCookieRefresh(callback: (cookie: CookieData) => void): void {
    this.remote.on('cookie', () => {
      // Save the full cookieData from the remote — includes deviceSerial and other
      // fields needed for cookie refresh on next startup
      if (this.remote.cookieData) {
        callback(this.remote.cookieData as CookieData);
      }
    });
  }

  async isAuthenticated(): Promise<boolean> {
    return new Promise((resolve) => {
      this.remote.checkAuthentication((err: Error | null, result: any) => {
        if (err || !result?.authenticated) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  async discoverDevices(): Promise<AlexaDevice[]> {
    return new Promise((resolve, reject) => {
      this.remote.getSmarthomeDevicesV2((err: Error | null, result: any) => {
        if (err) return reject(new Error(`Discovery failed: ${err.message}`));
        resolve(Array.isArray(result) ? result : []);
      });
    });
  }

  isHealthy(): boolean {
    return !this.circuitOpen;
  }

  async queryDeviceState(applianceId: string): Promise<AlexaDeviceState> {
    // Circuit breaker: reject immediately if circuit is open and not time to probe
    if (this.circuitOpen) {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < CIRCUIT_PROBE_INTERVAL_MS) {
        throw new Error('Alexa circuit open — skipping query');
      }
      // Half-open: allow one probe query through
    }

    try {
      const state = await this.queryDeviceStateInternal(applianceId);
      this.consecutiveFailuresSingle = 0;
      this.onSuccessfulQuery();
      return state;
    } catch (err) {
      this.consecutiveFailuresSingle++;
      this.maybeOpenCircuit();
      throw err;
    }
  }

  async queryDeviceStates(applianceIds: string[]): Promise<Map<string, AlexaDeviceState>> {
    if (applianceIds.length === 0) return new Map();

    // Circuit breaker applies to bulk queries too
    if (this.circuitOpen) {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < CIRCUIT_PROBE_INTERVAL_MS) {
        throw new Error('Alexa circuit open — skipping query');
      }
    }

    try {
      const result = await this.queryDeviceStatesInternal(applianceIds);
      this.consecutiveFailuresBulk = 0;
      this.onSuccessfulQuery();
      return result;
    } catch (err) {
      this.consecutiveFailuresBulk++;
      this.maybeOpenCircuit();
      throw err;
    }
  }

  private queryDeviceStateInternal(applianceId: string): Promise<AlexaDeviceState> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Alexa state query timed out'));
      }, 30_000);

      this.remote.querySmarthomeDevices(
        [applianceId],
        'APPLIANCE',
        30000,
        (err: Error | null, result: any) => {
          clearTimeout(timer);
          if (err) return reject(new Error(`State query failed: ${err.message}`));

          const state: AlexaDeviceState = {};
          const deviceState = result?.deviceStates?.[0];
          if (!deviceState?.capabilityStates) return resolve(state);

          for (const raw of deviceState.capabilityStates) {
            try {
              const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              const ns = parsed.namespace as string | undefined;
              if (ns) {
                if (!state[ns]) state[ns] = {};
                state[ns][parsed.name as string] = parsed.value;
              }
            } catch {
              // Skip malformed capability state
            }
          }
          resolve(state);
        },
      );
    });
  }

  private queryDeviceStatesInternal(applianceIds: string[]): Promise<Map<string, AlexaDeviceState>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Alexa state query timed out'));
      }, 30_000);

      this.remote.querySmarthomeDevices(
        applianceIds,
        'APPLIANCE',
        30000,
        (err: Error | null, result: any) => {
          clearTimeout(timer);
          if (err) return reject(new Error(`State query failed: ${err.message}`));

          const states = new Map<string, AlexaDeviceState>();
          for (const deviceState of result?.deviceStates ?? []) {
            const entityId = deviceState?.entity?.entityId as string | undefined;
            if (!entityId || !deviceState?.capabilityStates) continue;

            const state: AlexaDeviceState = {};
            for (const raw of deviceState.capabilityStates) {
              try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const ns = parsed.namespace as string | undefined;
                if (ns) {
                  if (!state[ns]) state[ns] = {};
                  state[ns][parsed.name as string] = parsed.value;
                }
              } catch {
                // Skip malformed capability state
              }
            }
            states.set(entityId, state);
          }

          // Alexa returns a parallel `errors` array for endpoints that failed
          // to report — most commonly ENDPOINT_UNREACHABLE when a device is
          // exposed via a custom skill whose backend doesn't answer state
          // queries. Those are expected (not transient network failures) and
          // we already covered the device via discover-time dedup if a working
          // path existed. Logging them at debug avoids flooding warn while
          // still leaving a breadcrumb.
          if (Array.isArray(result?.errors) && result.errors.length > 0 && this.config.logger) {
            const counts: Record<string, number> = {};
            for (const e of result.errors) {
              const code = (e?.code as string) ?? 'UNKNOWN';
              counts[code] = (counts[code] ?? 0) + 1;
            }
            const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
            this.config.logger(`partial state query: ${summary} of ${applianceIds.length}`);
          }

          resolve(states);
        },
      );
    });
  }

  async executeAction(applianceId: string, params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.remote.executeSmarthomeDeviceAction(
        [applianceId],
        params,
        'APPLIANCE',
        (err: Error | null, result: any) => {
          if (err) return reject(new Error(`Action failed: ${err.message}`));
          if (result?.errors?.length > 0) {
            const errMsg = (result.errors as any[]).map((e: any) => e.code).join(', ');
            return reject(new Error(`Device error: ${errMsg}`));
          }
          resolve();
        },
      );
    });
  }

  dispose(): void {
    this.stopProxyServerSafely();
    this.remote.removeAllListeners?.();
    this.initialized = false;
  }

  static __createForTest(mockRemote: AlexaRemoteInstance): AlexaClient {
    const client = Object.create(AlexaClient.prototype) as AlexaClient;
    (client as any).remote = mockRemote;
    (client as any).initialized = true;
    (client as any).consecutiveFailuresSingle = 0;
    (client as any).consecutiveFailuresBulk = 0;
    (client as any).circuitOpen = false;
    (client as any).circuitOpenedAt = 0;
    (client as any).config = {
      amazonDomain: 'amazon.com',
      cookieRefreshDays: 4,
      persistPath: '/tmp',
    };
    return client;
  }
}
