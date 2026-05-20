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
import { validateConfig, describeRemovedKeys } from './config.js';
import { DeviceManager } from './device-manager.js';
import type { DeviceProvider } from './providers/provider.js';
import { AlexaProvider } from './providers/alexa/index.js';
import { AlexaClient } from './providers/alexa/client.js';
import { readFileSync } from 'node:fs';
import { atomicWrite } from './util/atomic-write.js';
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
  private rediscoveryTimer?: ReturnType<typeof setInterval>;
  private readonly lastPollTime = new Map<string, number>();
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

    const rawConfig = config as unknown as Record<string, unknown>;
    if (!validateConfig(rawConfig)) {
      this.log.error('Invalid plugin configuration');
      return;
    }
    for (const warning of describeRemovedKeys(rawConfig)) {
      this.log.warn(warning);
    }

    this.api.on('didFinishLaunching', () => {
      this.init().catch(err => this.log.error('Initialization failed:', err));
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.rediscoveryTimer) clearInterval(this.rediscoveryTimer);
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
    // Warm the cache before iOS Home opens onGet handlers — otherwise the
    // first color/brightness/etc onGet hits an empty cache and HAP shows
    // defaults (off, 0%, no color). Also avoids the "M1" edge: AlexaProvider
    // setColor sending brightness:100 because target.brightness was
    // undefined on a fresh boot.
    try {
      await this.pollAllAlexaDevicesOnce();
    } catch (err) {
      this.log.debug('Initial cache warm-up failed:', err instanceof Error ? err.message : err);
    }
    this.startPolling(pluginConfig);
    this.startPeriodicRediscovery();

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
            // 0o600: cookie holds Amazon session + macDms (controls the
            // account's smart home). World-readable on multi-user hosts
            // would let any local user impersonate the Amazon account.
            atomicWrite(cookiePath, JSON.stringify(toSave), { mode: 0o600 });
          } catch (err) {
            this.log.warn('Failed to save refreshed Alexa cookie:', err);
          }
        });

        try {
          await alexaClient.init(storedCookie);
          this.log.info('Alexa authenticated');

          const cookieData = alexaClient.getCookieData();
          if (cookieData) {
            try { atomicWrite(cookiePath, JSON.stringify(cookieData), { mode: 0o600 }); } catch { /* ignore */ }
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

    // Never nuke every cached accessory on a transient empty discovery. A
    // brief Amazon outage or rate-limit can make discoverAll return 0; if we
    // unregister everything, iOS Home loses room assignments / scene
    // memberships / automations, and they don't come back on re-register
    // because UUIDs are recomputed from device.id (which is stable, but the
    // HomeKit-side metadata isn't).
    if (devices.length === 0 && this.cachedAccessories.size > 0) {
      this.log.warn(
        `Discovery returned 0 devices but ${this.cachedAccessories.size} ` +
        'are cached — keeping cached accessories rather than unregistering. ' +
        'If this was a real removal, restart Homebridge after confirming the ' +
        'devices are actually gone from your Alexa account.',
      );
      return;
    }

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

  /**
   * Re-run discovery on a long interval so newly-added Alexa devices show up
   * in HomeKit without requiring a Homebridge restart. Runs every 6h by
   * default; on success, prunes lastPollTime entries for devices that
   * disappeared so the map can't grow unbounded.
   *
   * If the re-run discovery returns 0 devices but we have cached accessories,
   * discoverAndRegister bails out (the transient-empty guard) — so a brief
   * Amazon hiccup during the periodic refresh won't nuke iOS Home memberships.
   */
  private startPeriodicRediscovery(): void {
    const REDISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;
    this.rediscoveryTimer = setInterval(() => {
      this.discoverAndRegister()
        .then(() => this.pruneStaleLastPollTime())
        .catch(err => this.log.warn('Periodic rediscovery failed:', err instanceof Error ? err.message : err));
    }, REDISCOVERY_INTERVAL_MS);
  }

  /**
   * One-shot bulk poll for every Alexa device. Used to warm the cache at
   * startup so the very first iOS Home open doesn't hit cold-cache defaults.
   * Same body as the polling tick; throws on Alexa failure (caller decides
   * whether that's fatal).
   */
  private async pollAllAlexaDevicesOnce(): Promise<void> {
    if (!this.deviceManager) return;
    const devices = this.deviceManager.getAllDevices().filter(d => d.provider === 'alexa');
    if (devices.length === 0) return;
    const alexaProvider = this.deviceManager.getProvider('alexa') as AlexaProvider | undefined;
    if (!alexaProvider) return;

    const now = Date.now();
    const deviceIds = devices.map(d => d.id.slice('alexa:'.length));
    const states = await alexaProvider.getStates(deviceIds);
    for (const device of devices) {
      this.lastPollTime.set(device.id, now);
      const localId = device.id.slice('alexa:'.length);
      if (!states.has(localId)) continue;
      this.deviceManager.updateCache(device.id, states.get(localId)!);
    }
  }

  private pruneStaleLastPollTime(): void {
    if (!this.deviceManager) return;
    const live = new Set(this.deviceManager.getAllDevices().map(d => d.id));
    for (const id of this.lastPollTime.keys()) {
      if (!live.has(id)) this.lastPollTime.delete(id);
    }
  }

  private startPolling(config: PluginConfig): void {
    // Alexa-only polling. The cookie API supports bulk queries, so we batch
    // every Alexa device into a single request per tick. Other-provider polling
    // (Tuya, Resideo) was removed in the 0.2 trim — those paths are gone.
    const intervalMs = (config.providers?.alexa?.pollInterval ?? 60) * 1000;
    const tickInterval = 15_000;
    // Dedupe error logs by message so a sustained failure (expired cookie,
    // network blip) only logs once per distinct cause, but a NEW error
    // class is still visible. The inner AlexaClient circuit breaker handles
    // backoff itself.
    let lastLoggedErr: string | null = null;

    this.pollTimer = setInterval(async () => {
      if (!this.deviceManager) return;

      const now = Date.now();
      const devices = this.deviceManager.getAllDevices()
        .filter(d => d.provider === 'alexa');
      const toPoll = devices.filter(d => now - (this.lastPollTime.get(d.id) ?? 0) >= intervalMs);
      if (toPoll.length === 0) return;

      const alexaProvider = this.deviceManager.getProvider('alexa') as AlexaProvider | undefined;
      if (!alexaProvider) return;

      try {
        const deviceIds = toPoll.map(d => d.id.slice('alexa:'.length));
        const states = await alexaProvider.getStates(deviceIds);

        for (const device of toPoll) {
          this.lastPollTime.set(device.id, now);
          const localId = device.id.slice('alexa:'.length);
          // Alexa returns a parallel errors array for endpoints that couldn't
          // respond (ENDPOINT_UNREACHABLE). For those, `states.get(localId)`
          // is undefined — overwriting the cache with `{}` would make the
          // next onGet return defaults (off, 0% brightness) and the Home app
          // would flip the device to off every poll. Keep the last known
          // state instead; let HAP show stale until the device recovers.
          if (!states.has(localId)) continue;
          this.deviceManager.invalidateCache(device.id);
          const state = states.get(localId)!;
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
        if (lastLoggedErr !== null) {
          this.log.info('alexa provider: recovered');
          lastLoggedErr = null;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastLoggedErr) {
          this.log.warn(`Alexa poll failed: ${msg}`);
          lastLoggedErr = msg;
        }
      }
    }, tickInterval);
  }
}
