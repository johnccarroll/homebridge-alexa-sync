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
  proxyPort: number;
  cookieRefreshDays: number;
  persistPath: string;
  logger?: (msg: string) => void;
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

export class AlexaClient {
  private remote: AlexaRemoteInstance;
  private initialized = false;
  private readonly config: AlexaClientConfig;

  constructor(config: AlexaClientConfig) {
    this.config = config;
    this.remote = new AlexaRemote();
  }

  async init(storedCookie?: CookieData): Promise<void> {
    const serviceHost = ALEXA_SERVICE_HOSTS[this.config.amazonDomain] ?? 'pitangui.amazon.com';

    return new Promise<void>((resolve, reject) => {
      this.remote.init(
        {
          acceptLanguage: 'en-US',
          amazonPage: this.config.amazonDomain,
          alexaServiceHost: serviceHost,
          cookie: storedCookie?.localCookie ?? storedCookie?.cookie,
          formerRegistrationData: storedCookie as any,
          macDms: storedCookie?.macDms as any,
          proxyOwnIp: '127.0.0.1',
          proxyPort: this.config.proxyPort,
          cookieRefreshInterval: this.config.cookieRefreshDays * ONE_DAY_MS,
          usePushConnection: false,
          useWsMqtt: false,
          logger: this.config.logger,
        },
        (err: Error | null) => {
          if (err) {
            reject(new Error(`Alexa auth failed: ${err.message}`));
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
    this.remote.on('cookie', (cookie: string, csrf: string, macDms: any) => {
      callback({ cookie, csrf, macDms, localCookie: cookie });
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

  async queryDeviceState(applianceId: string): Promise<AlexaDeviceState> {
    return new Promise((resolve, reject) => {
      this.remote.querySmarthomeDevices(
        [applianceId],
        'APPLIANCE',
        15000,
        (err: Error | null, result: any) => {
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
    (client as any).config = {
      amazonDomain: 'amazon.com',
      proxyPort: 3456,
      cookieRefreshDays: 4,
      persistPath: '/tmp',
    };
    return client;
  }
}
