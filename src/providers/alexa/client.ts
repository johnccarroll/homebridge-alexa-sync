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
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private circuitOpenedAt = 0;

  constructor(config: AlexaClientConfig) {
    this.config = config;
    this.remote = new AlexaRemote();
  }

  async init(storedCookie?: CookieData): Promise<void> {
    const hasCookie = !!(storedCookie?.localCookie ?? storedCookie?.cookie);
    if (!hasCookie) {
      throw new Error(
        'Alexa cookie missing. Build one from a logged-in Chrome session via ' +
        '`scripts/build-alexa-cookie.mjs` and drop the JSON at ' +
        '<homebridge-storage>/.alexa-sync-cookie.json. See README for the walkthrough.',
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
        },
        (err: Error | null) => {
          if (err) {
            reject(new Error(`Alexa auth failed: ${err.message ?? ''}`));
          } else {
            this.initialized = true;
            resolve();
          }
        },
      );
    });
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
      if (this.circuitOpen) {
        const warn = this.config.warnLogger ?? this.config.logger;
        warn?.('Alexa connection recovered — resuming polls');
      }
      this.consecutiveFailures = 0;
      this.circuitOpen = false;
      return state;
    } catch (err) {
      this.consecutiveFailures++;
      if (!this.circuitOpen && this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpen = true;
        this.circuitOpenedAt = Date.now();
        const warn = this.config.warnLogger ?? this.config.logger;
        warn?.(
          `Alexa polling paused after ${this.consecutiveFailures} consecutive failures — will probe every 5 minutes`,
        );
        // Check auth status to give the user actionable info
        this.isAuthenticated().then(
          (authed) => {
            if (!authed) {
              warn?.(
                'Alexa authentication appears invalid — re-login required via proxy',
              );
            }
          },
          () => { /* ignore auth check errors */ },
        );
      }
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
      if (this.circuitOpen) {
        const warn = this.config.warnLogger ?? this.config.logger;
        warn?.('Alexa connection recovered — resuming polls');
      }
      this.consecutiveFailures = 0;
      this.circuitOpen = false;
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      if (!this.circuitOpen && this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpen = true;
        this.circuitOpenedAt = Date.now();
        const warn = this.config.warnLogger ?? this.config.logger;
        warn?.(
          `Alexa polling paused after ${this.consecutiveFailures} consecutive failures — will probe every 5 minutes`,
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
    this.remote.removeAllListeners?.();
    this.initialized = false;
  }

  static __createForTest(mockRemote: AlexaRemoteInstance): AlexaClient {
    const client = Object.create(AlexaClient.prototype) as AlexaClient;
    (client as any).remote = mockRemote;
    (client as any).initialized = true;
    (client as any).consecutiveFailures = 0;
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
