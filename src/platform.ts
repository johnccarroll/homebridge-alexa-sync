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
import { AlexaClient } from './providers/alexa/client.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { configureAccessory, updateAccessoryState } from './accessory.js';

export class AlexaBridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private deviceManager?: DeviceManager;
  private pollTimer?: ReturnType<typeof setInterval>;

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
        proxyPort: config.providers.alexa.proxyPort ?? 3456,
        cookieRefreshDays: config.providers.alexa.cookieRefreshDays ?? 4,
        persistPath: this.api.user.storagePath(),
        logger: (msg: string) => this.log.debug('[Alexa]', msg),
      });

      const cookiePath = `${this.api.user.storagePath()}/.alexa-bridge-cookie.json`;
      let storedCookie: any;
      try {
        const data = readFileSync(cookiePath, 'utf8');
        storedCookie = JSON.parse(data);
      } catch {
        this.log.info('No stored Alexa cookie — proxy login required at http://127.0.0.1:' + (config.providers.alexa.proxyPort ?? 3456));
      }

      try {
        await alexaClient.init(storedCookie);
        this.log.info('Alexa authenticated');

        alexaClient.onCookieRefresh((cookie) => {
          try {
            writeFileSync(cookiePath, JSON.stringify(cookie));
            this.log.info('Alexa cookie refreshed and saved');
          } catch (err) {
            this.log.warn('Failed to save Alexa cookie:', err);
          }
        });

        const cookieData = alexaClient.getCookieData();
        if (cookieData) {
          try {
            writeFileSync(cookiePath, JSON.stringify(cookieData));
          } catch { /* ignore */ }
        }

        providers.push(new AlexaProvider(alexaClient, config.providers.alexa));
      } catch (err) {
        this.log.error('Alexa initialization failed:', err);
        this.log.warn('Alexa devices will not be available. Check proxy login.');
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
        this.log.info(`Adding new accessory: ${device.name}`);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
      }
    }

    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!activeUUIDs.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
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

      for (const device of this.deviceManager.getAllDevices()) {
        try {
          this.deviceManager.invalidateCache(device.id);
          const state = await this.deviceManager.getState(device.id);
          const uuid = this.api.hap.uuid.generate(device.id);
          const accessory = this.cachedAccessories.get(uuid);
          if (accessory) {
            updateAccessoryState(
              accessory,
              device,
              state,
              { Service: this.Service, Characteristic: this.Characteristic },
            );
          }
        } catch (err) {
          this.log.warn(`Failed to poll ${device.name}:`, err);
        }
      }
    }, interval);
  }
}
