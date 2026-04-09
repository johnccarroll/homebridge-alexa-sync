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
import { TuyaProvider } from './providers/tuya/index.js';
import { AlexaProvider } from './providers/alexa/index.js';
import { ResideoProvider } from './providers/resideo/index.js';
import { AlexaClient } from './providers/alexa/client.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { configureAccessory, updateAccessoryState } from './accessory.js';
import { ApiServer } from './api-server.js';

export class AlexaBridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private deviceManager?: DeviceManager;
  private pollTimer?: ReturnType<typeof setInterval>;
  private apiServer?: ApiServer;

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
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async init(): Promise<void> {
    const pluginConfig = this.config as unknown as PluginConfig;
    const providers = await this.createProviders(pluginConfig);

    if (providers.length === 0) {
      this.log.warn('No providers configured');
      return;
    }

    this.deviceManager = new DeviceManager(providers);
    await this.discoverAndRegister();
    this.startPolling(pluginConfig);

    // Start API server for Alexa Smart Home Skill
    if (pluginConfig.alexaSkill?.enabled && pluginConfig.alexaSkill?.apiKey) {
      const port = pluginConfig.alexaSkill.apiPort ?? 9090;
      this.apiServer = new ApiServer(this.deviceManager, {
        port,
        apiKey: pluginConfig.alexaSkill.apiKey,
      });
      await this.apiServer.start();
      this.log.warn('API server bound to all interfaces (0.0.0.0). Ensure your network is trusted.');
      this.log.info(`Alexa Skill API server running on port ${port}`);
    }
  }

  private async createProviders(config: PluginConfig): Promise<DeviceProvider[]> {
    const providers: DeviceProvider[] = [];

    if (config.providers?.tuya) {
      this.log.info('Initializing Tuya provider');
      providers.push(new TuyaProvider(config.providers.tuya));
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
      });

      const cookiePath = `${this.api.user.storagePath()}/.alexa-bridge-cookie.json`;
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
    const tuyaInterval = config.providers?.tuya?.pollInterval ?? 30;
    const alexaInterval = config.providers?.alexa?.pollInterval ?? 60;
    const interval = Math.max(15, Math.min(tuyaInterval, alexaInterval)) * 1000;

    this.pollTimer = setInterval(async () => {
      if (!this.deviceManager) return;

      const devices = this.deviceManager.getAllDevices();
      const results = await Promise.allSettled(
        devices.map(async (device) => {
          this.deviceManager!.invalidateCache(device.id);
          const state = await this.deviceManager!.getState(device.id);
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
      for (const r of results) {
        if (r.status === 'rejected') {
          this.log.warn('Poll failed:', r.reason);
        }
      }
    }, interval);
  }
}
