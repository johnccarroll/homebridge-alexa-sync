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
    const providers = this.createProviders(pluginConfig);

    if (providers.length === 0) {
      this.log.warn('No providers configured');
      return;
    }

    this.deviceManager = new DeviceManager(providers);
    await this.discoverAndRegister();
    this.startPolling(pluginConfig);
  }

  private createProviders(config: PluginConfig): DeviceProvider[] {
    const providers: DeviceProvider[] = [];

    if (config.providers?.tuya) {
      this.log.info('Initializing Tuya provider');
      providers.push(new TuyaProvider(config.providers.tuya));
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
    const interval = (config.providers?.tuya?.pollInterval ?? 30) * 1000;

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
