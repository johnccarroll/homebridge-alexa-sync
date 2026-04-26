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
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings.js';
import type { PluginConfig } from './config.js';
import type { DeviceState } from './types.js';
import { validateConfig } from './config.js';
import { DeviceManager } from './device-manager.js';
import type { DeviceProvider } from './providers/provider.js';
import { TuyaProvider } from './providers/tuya/index.js';
import { AlexaProvider } from './providers/alexa/index.js';
import { ResideoProvider } from './providers/resideo/index.js';
import { AlexaClient } from './providers/alexa/client.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { configureAccessory, updateAccessoryState } from './accessory.js';
import { ApiServer } from './api-server.js';
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
  private apiServer?: ApiServer;
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
      this.apiServer?.stop();
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

    this.deviceManager = new DeviceManager(providers);
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

    // Start API server for Alexa Smart Home Skill
    if (pluginConfig.alexaSkill?.enabled && pluginConfig.alexaSkill?.apiKey) {
      const port = pluginConfig.alexaSkill.apiPort ?? 9090;

      // Set up proactive state reporter if LWA credentials are available
      let stateReporter: import('./alexa-skill/state-reporter.js').AlexaStateReporter | undefined;
      if (pluginConfig.alexaSkill.lwaClientId && pluginConfig.alexaSkill.lwaClientSecret) {
        const { AlexaStateReporter: Reporter } = await import('./alexa-skill/state-reporter.js');
        stateReporter = new Reporter(
          pluginConfig.alexaSkill.lwaClientId,
          pluginConfig.alexaSkill.lwaClientSecret,
        );

        // Restore tokens from persistence
        const tokenPath = `${this.api.user.storagePath()}/.alexa-sync-lwa-tokens.json`;
        try {
          const data = readFileSync(tokenPath, 'utf8');
          stateReporter.restoreTokens(JSON.parse(data));
          this.log.info('Alexa proactive state reporting enabled');
        } catch {
          this.log.info('Alexa proactive reporting: waiting for AcceptGrant (re-enable skill in Alexa app)');
        }

        // Persist tokens when they change
        stateReporter.onPersist((tokens) => {
          try {
            writeFileSync(tokenPath, JSON.stringify(tokens));
          } catch { /* ignore */ }
        });

        // Wire up state change notifications
        this.deviceManager.onStateChange(async (deviceId, state) => {
          if (!stateReporter?.isEnabled) return;
          try {
            await stateReporter.sendChangeReport(deviceId, state, state);
          } catch (err) {
            this.log.debug('ChangeReport failed:', err);
          }
        });
      }

      this.apiServer = new ApiServer(this.deviceManager, {
        port,
        apiKey: pluginConfig.alexaSkill.apiKey,
        stateReporter,
      });
      await this.apiServer.start();
      this.log.warn('API server bound to all interfaces (0.0.0.0). Ensure your network is trusted.');
      this.log.info(`Alexa Skill API server running on port ${port}`);
    }
  }

  /**
   * Push a state update to HomeKit directly (used by MQTT push path so state
   * changes reach the Home app in real time instead of on the next poll tick).
   */
  private updateHomeKitAccessory(fullId: string, state: DeviceState): void {
    if (!this.deviceManager) return;
    const device = this.deviceManager.getDevice(fullId);
    if (!device) return;
    const uuid = this.api.hap.uuid.generate(fullId);
    const accessory = this.cachedAccessories.get(uuid);
    if (!accessory) return;
    updateAccessoryState(accessory, device, state, {
      Service: this.Service,
      Characteristic: this.Characteristic,
    });
  }

  private async createProviders(config: PluginConfig): Promise<DeviceProvider[]> {
    const providers: DeviceProvider[] = [];

    if (config.providers?.tuya) {
      this.log.info('Initializing Tuya provider');
      const tuya = new TuyaProvider(config.providers.tuya, {
        info: (m: string) => this.log.info(m),
        warn: (m: string) => this.log.warn(m),
        debug: (m: string) => this.log.debug(m),
      });
      // Propagate MQTT-pushed state changes to DeviceManager so accessories
      // and proactive reporters update in real time (no polling lag).
      tuya.onStateChange((deviceId, state) => {
        const fullId = `tuya:${deviceId}`;
        this.deviceManager?.updateCache(fullId, state);
        this.updateHomeKitAccessory(fullId, state);
      });
      tuya.start();
      providers.push(tuya);
    }

    if (config.providers?.alexa) {
      this.log.info('Initializing Alexa provider');
      const alexaClient = new AlexaClient({
        amazonDomain: config.providers.alexa.amazonDomain ?? 'amazon.com',
        proxyHost: config.providers.alexa.proxyHost ?? 'homebridge.local',
        proxyPort: config.providers.alexa.proxyPort ?? 3456,
        cookieRefreshDays: config.providers.alexa.cookieRefreshDays ?? 4,
        persistPath: this.api.user.storagePath(),
        logger: (msg: string) => this.log.debug('[Alexa]', msg),
        warnLogger: (msg: string) => this.log.warn(msg),
      });

      const cookiePath = `${this.api.user.storagePath()}/.alexa-sync-cookie.json`;
      const amazonDomain = config.providers.alexa.amazonDomain ?? 'amazon.com';
      let storedCookie: any;
      try {
        const data = readFileSync(cookiePath, 'utf8');
        storedCookie = JSON.parse(data);
        // Ensure amazonPage is set so alexa-remote2 uses the right domain
        storedCookie.amazonPage = amazonDomain;
      } catch {
        // No stored cookie
      }

      // Always listen for cookie events to persist them
      alexaClient.onCookieRefresh((cookie) => {
        try {
          const toSave = { ...cookie, amazonPage: amazonDomain };
          writeFileSync(cookiePath, JSON.stringify(toSave));
          this.log.info('Alexa cookie saved. Restart Homebridge to discover Alexa devices.');
        } catch (err) {
          this.log.warn('Failed to save Alexa cookie:', err);
        }
      });

      if (storedCookie) {
        // Have a cookie — try to init and connect
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
          this.log.warn('Alexa devices unavailable. Delete cookie and re-authenticate.');
        }
      } else {
        // No cookie — start proxy in background for browser login
        const proxyHost = config.providers.alexa.proxyHost ?? 'homebridge.local';
        const proxyPort = config.providers.alexa.proxyPort ?? 3456;
        this.log.info(`No Alexa cookie. Open http://${proxyHost}:${proxyPort}/ in your browser to log in.`);
        // Fire and forget — init will wait for cookie event, cookie handler saves it
        alexaClient.init().catch(() => {
          // Expected — proxy is running, waiting for login
        });
      }
    }

    if (config.providers?.resideo) {
      this.log.info('Initializing Resideo provider');
      try {
        const resideoProvider = new ResideoProvider({
          consumerKey: config.providers.resideo.consumerKey,
          consumerSecret: config.providers.resideo.consumerSecret,
          refreshToken: config.providers.resideo.refreshToken,
        });
        providers.push(resideoProvider);
      } catch (err) {
        this.log.error('Resideo initialization failed:', err);
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
    const providerIntervals: Record<string, number> = {
      tuya: (config.providers?.tuya?.pollInterval ?? 30) * 1000,
      alexa: (config.providers?.alexa?.pollInterval ?? 60) * 1000,
      resideo: (config.providers?.resideo?.pollInterval ?? 120) * 1000,
    };
    const lastPollTime = new Map<string, number>();
    const tickInterval = 15_000; // Check every 15s
    const suppressedProviders = new Set<string>();

    this.pollTimer = setInterval(async () => {
      if (!this.deviceManager) return;

      const now = Date.now();
      const devices = this.deviceManager.getAllDevices();
      const toPoll = devices.filter(device => {
        const interval = providerIntervals[device.provider] ?? 60_000;
        const lastPoll = lastPollTime.get(device.id) ?? 0;
        return now - lastPoll >= interval;
      });

      if (toPoll.length === 0) return;

      // Batch Alexa devices into a single bulk query instead of N individual calls
      const alexaDevices = toPoll.filter(d => d.provider === 'alexa');
      const otherDevices = toPoll.filter(d => d.provider !== 'alexa');

      // Poll non-Alexa devices individually (Tuya, Resideo have their own batching)
      const otherResults = await Promise.allSettled(
        otherDevices.map(async (device) => {
          lastPollTime.set(device.id, now);
          this.deviceManager!.invalidateCache(device.id);
          const state = await this.deviceManager!.getState(device.id);
          if (suppressedProviders.has(device.provider)) {
            suppressedProviders.delete(device.provider);
            this.log.info(`${device.provider} provider: recovered`);
          }
          const uuid = this.api.hap.uuid.generate(device.id);
          const accessory = this.cachedAccessories.get(uuid);
          if (accessory) {
            updateAccessoryState(accessory, device, state, {
              Service: this.Service,
              Characteristic: this.Characteristic,
            });
          }
        }),
      );

      // Poll Alexa devices in one bulk request
      let alexaBulkResult: PromiseSettledResult<void> | undefined;
      if (alexaDevices.length > 0) {
        const alexaProvider = this.deviceManager!.getProvider('alexa') as AlexaProvider | undefined;
        alexaBulkResult = await Promise.allSettled([
          (async () => {
            if (!alexaProvider) throw new Error('Alexa provider not found');
            const deviceIds = alexaDevices.map(d => d.id.slice('alexa.'.length));
            const states = await alexaProvider.getStates(deviceIds);
            for (const device of alexaDevices) {
              lastPollTime.set(device.id, now);
              this.deviceManager!.invalidateCache(device.id);
              const localId = device.id.slice('alexa.'.length);
              const state = states.get(localId) ?? {};
              this.deviceManager!.updateCache(device.id, state);
              const uuid = this.api.hap.uuid.generate(device.id);
              const accessory = this.cachedAccessories.get(uuid);
              if (accessory) {
                updateAccessoryState(accessory, device, state, {
                  Service: this.Service,
                  Characteristic: this.Characteristic,
                });
              }
            }
            if (suppressedProviders.has('alexa')) {
              suppressedProviders.delete('alexa');
              this.log.info('alexa provider: recovered');
            }
          })(),
        ]).then(r => r[0]);
      }

      // Combine results for error reporting

      // Group failures by provider
      const failedProviders = new Map<string, number>();
      const polledProviders = new Map<string, number>();
      for (const device of otherDevices) {
        polledProviders.set(device.provider, (polledProviders.get(device.provider) ?? 0) + 1);
      }
      for (let i = 0; i < otherResults.length; i++) {
        if (otherResults[i].status === 'rejected') {
          const provider = otherDevices[i].provider;
          failedProviders.set(provider, (failedProviders.get(provider) ?? 0) + 1);
        }
      }
      if (alexaDevices.length > 0 && alexaBulkResult) {
        polledProviders.set('alexa', alexaDevices.length);
        if (alexaBulkResult.status === 'rejected') {
          failedProviders.set('alexa', alexaDevices.length);
        }
      }

      for (const [provider, failCount] of failedProviders) {
        const totalCount = polledProviders.get(provider) ?? 0;
        if (failCount === totalCount && !suppressedProviders.has(provider)) {
          suppressedProviders.add(provider);
          this.log.warn(`${provider} provider: all ${failCount} device(s) failed — suppressing repeat logs`);
        } else if (!suppressedProviders.has(provider)) {
          if (provider === 'alexa' && alexaBulkResult?.status === 'rejected') {
            this.log.warn('Poll failed:', (alexaBulkResult as PromiseRejectedResult).reason);
          } else {
            for (let i = 0; i < otherDevices.length; i++) {
              if (otherDevices[i].provider === provider && otherResults[i].status === 'rejected') {
                this.log.warn('Poll failed:', (otherResults[i] as PromiseRejectedResult).reason);
              }
            }
          }
        }
      }
    }, tickInterval);
  }
}
