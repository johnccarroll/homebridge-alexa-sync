// src/platform.ts
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { PluginConfig } from './config.js';
import { validateConfig } from './config.js';
import { DeviceManager } from './device-manager.js';
import type { DeviceProvider } from './providers/provider.js';
import { AlexaProvider } from './providers/alexa/index.js';
import { AlexaClient } from './providers/alexa/client.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { configureAccessory, updateAccessoryState } from './accessory.js';
import { loadSupporterState, type SupporterState } from './supporter/index.js';
import { CloudClient } from './cloud/client.js';
import { StateChangePublisher } from './cloud/state-change.js';
import { loadOrCreateInstallId } from './cloud/install-id.js';

export class AlexaSyncPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private deviceManager?: DeviceManager;
  private pollTimer?: ReturnType<typeof setInterval>;
  private supporter: SupporterState = { mode: 'free' };
  private cloudClient?: CloudClient;
  private stateChangePublisher?: StateChangePublisher;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!validateConfig(config as unknown as Record<string, unknown>)) {
      this.log.error('Invalid plugin configuration');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.init().catch(err => this.log.error('Initialization failed:', err));
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.deviceManager?.dispose();
      void this.cloudClient?.stop();
      this.stateChangePublisher?.dispose();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async init(): Promise<void> {
    const pluginConfig = this.config as unknown as PluginConfig;
    this.supporter = loadSupporterState(pluginConfig.supporter, this.log);
    const providers = await this.createProviders(pluginConfig);

    if (providers.length === 0) {
      this.log.warn('No providers configured');
      return;
    }

    this.deviceManager = new DeviceManager(providers, undefined, {
      warn: (msg) => this.log.warn(msg),
    });
    await this.discoverAndRegister();
    this.startPolling(pluginConfig);

    // Supporter tier: connect to the cloud for managed Alexa Smart Home
    // Skill routing. The plugin works fully locally without this; the
    // cloud connection is opt-in via a valid supporter JWT.
    if (this.supporter.mode === 'supporter' && pluginConfig.supporter?.token) {
      try {
        const installId = loadOrCreateInstallId(this.api.user.storagePath());
        this.cloudClient = new CloudClient({
          supporterToken: pluginConfig.supporter.token,
          installId,
          deviceManager: this.deviceManager,
          log: this.log,
        });
        await this.cloudClient.start();
        this.stateChangePublisher = new StateChangePublisher({
          supporterToken: pluginConfig.supporter.token,
          log: this.log,
        });
        this.deviceManager.onStateChange((deviceId, state) => {
          this.stateChangePublisher?.publish(deviceId, state);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`Cloud client failed to start: ${msg}. Running in local-only mode.`);
      }
    }
  }

  private async createProviders(config: PluginConfig): Promise<DeviceProvider[]> {
    const providers: DeviceProvider[] = [];

    if (config.providers?.alexa) {
      this.log.info('Initializing Alexa provider');
      const amazonDomain = config.providers.alexa.amazonDomain ?? 'amazon.com';
      const cookiePath = `${this.api.user.storagePath()}/.alexa-sync-cookie.json`;

      let storedCookie: any;
      try {
        storedCookie = JSON.parse(readFileSync(cookiePath, 'utf8'));
        storedCookie.amazonPage = amazonDomain;
      } catch {
        // No stored cookie — fall through and emit setup guidance below
      }

      if (!storedCookie) {
        this.log.warn(
          `No Alexa cookie at ${cookiePath}. SSH to this host and run ` +
          '`node /var/lib/homebridge/node_modules/homebridge-alexa-sync/scripts/alexa-login-proxy.cjs`. ' +
          'The script prints a URL to open in any browser — sign in with Amazon ' +
          'there and the cookie is captured automatically. Restart Homebridge after.',
        );
      } else {
        const alexaClient = new AlexaClient({
          amazonDomain,
          cookieRefreshDays: config.providers.alexa.cookieRefreshDays ?? 14,
          persistPath: this.api.user.storagePath(),
          logger: (msg: string) => this.log.debug('[Alexa]', msg),
          warnLogger: (msg: string) => this.log.warn(msg),
        });

        alexaClient.onCookieRefresh((cookie) => {
          try {
            const toSave = { ...cookie, amazonPage: amazonDomain };
            writeFileSync(cookiePath, JSON.stringify(toSave));
          } catch (err) {
            this.log.warn('Failed to save refreshed Alexa cookie:', err);
          }
        });

        try {
          await alexaClient.init(storedCookie);
          this.log.info('Alexa authenticated');

          const cookieData = alexaClient.getCookieData();
          if (cookieData) {
            try { writeFileSync(cookiePath, JSON.stringify(cookieData)); } catch { /* ignore */ }
          }

          providers.push(new AlexaProvider(alexaClient, config.providers.alexa));
        } catch (err) {
          this.log.error('Alexa auth failed:', err);
          this.log.warn('Alexa devices unavailable. Re-run scripts/alexa-login-proxy.cjs to refresh the cookie.');
        }
      }
    }

    return providers;
  }

  private async discoverAndRegister(): Promise<void> {
    if (!this.deviceManager) return;

    this.log.info('Discovering devices...');
    const devices = await this.deviceManager.discoverAll();
    this.log.info(`Discovered ${devices.length} device(s)`);

    const activeUUIDs = new Set<string>();

    for (const device of devices) {
      try {
        const uuid = this.api.hap.uuid.generate(device.id);
        activeUUIDs.add(uuid);

        let accessory = this.cachedAccessories.get(uuid);
        const isNew = !accessory;

        if (!accessory) {
          accessory = new this.api.platformAccessory(device.name, uuid);
        }

        configureAccessory(
          accessory,
          device,
          { Service: this.Service, Characteristic: this.Characteristic },
          (id) => this.deviceManager!.getState(id),
          (id, state) => this.deviceManager!.setState(id, state),
          (id) => this.deviceManager!.getCachedState(id),
        );

        if (isNew) {
          this.log.debug(`Registering accessory: ${device.name}`);
          try {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          } catch {
            // Homebridge 2.x alpha auto-bridges on construction — safe to ignore
          }
          this.cachedAccessories.set(uuid, accessory);
        }
      } catch (err) {
        this.log.error(`Failed to register ${device.name}:`, err);
      }
    }

    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!activeUUIDs.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        try {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        } catch {
          // Accessory may already be removed from bridge
        }
        this.cachedAccessories.delete(uuid);
      }
    }
  }

  private startPolling(config: PluginConfig): void {
    // Alexa-only polling. The cookie API supports bulk queries, so we batch
    // every Alexa device into a single request per tick. Other-provider polling
    // (Tuya, Resideo) was removed in the 0.2 trim — those paths are gone.
    const intervalMs = (config.providers?.alexa?.pollInterval ?? 60) * 1000;
    const tickInterval = 15_000;
    const lastPollTime = new Map<string, number>();
    let circuitSuppressed = false;

    this.pollTimer = setInterval(async () => {
      if (!this.deviceManager) return;

      const now = Date.now();
      const devices = this.deviceManager.getAllDevices()
        .filter(d => d.provider === 'alexa');
      const toPoll = devices.filter(d => now - (lastPollTime.get(d.id) ?? 0) >= intervalMs);
      if (toPoll.length === 0) return;

      const alexaProvider = this.deviceManager.getProvider('alexa') as AlexaProvider | undefined;
      if (!alexaProvider) return;

      try {
        const deviceIds = toPoll.map(d => d.id.slice('alexa:'.length));
        const states = await alexaProvider.getStates(deviceIds);

        for (const device of toPoll) {
          lastPollTime.set(device.id, now);
          this.deviceManager.invalidateCache(device.id);
          const localId = device.id.slice('alexa:'.length);
          const state = states.get(localId) ?? {};
          this.deviceManager.updateCache(device.id, state);
          const uuid = this.api.hap.uuid.generate(device.id);
          const accessory = this.cachedAccessories.get(uuid);
          if (accessory) {
            updateAccessoryState(accessory, device, state, {
              Service: this.Service,
              Characteristic: this.Characteristic,
            });
          }
        }
        if (circuitSuppressed) {
          circuitSuppressed = false;
          this.log.info('alexa provider: recovered');
        }
      } catch (err) {
        if (!circuitSuppressed) {
          this.log.warn('Alexa poll failed:', err instanceof Error ? err.message : err);
          circuitSuppressed = true;
        }
      }
    }, tickInterval);
  }
}
