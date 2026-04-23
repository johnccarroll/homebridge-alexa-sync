import type { DeviceProvider } from '../provider.js';
import type { BridgeDevice, DeviceState } from '../../types.js';
import { TuyaApi } from './api.js';
import { tuyaDeviceToBridgeDevice, tuyaStatusToState, stateToTuyaCommands } from './mapper.js';
import { TuyaPulsarConsumer, type MqMessage, type TuyaMqLogger } from './pulsar.js';
import type { TuyaConfig } from '../../config.js';

export type TuyaStateChangeListener = (deviceId: string, state: DeviceState) => void;

/**
 * Tuya provider. MQTT-push primary transport, REST fallback.
 *
 *  - `discover()`  : REST getDevices (one-shot per plugin startup)
 *  - `getState()`  : returns MQTT-populated cache; REST one-shot on miss
 *  - `setState()`  : REST sendCommands (only control path)
 *  - MQTT messages : update internal cache + fire stateChange listeners
 *
 * MQTT connection starts explicitly via `start()` so tests and CLI tools
 * can skip it. `dispose()` tears it down.
 */
export class TuyaProvider implements DeviceProvider {
  readonly id = 'tuya';
  private readonly api: TuyaApi;
  private readonly mq?: TuyaPulsarConsumer;

  private readonly stateCache = new Map<string, DeviceState>();
  private readonly listeners = new Set<TuyaStateChangeListener>();

  constructor(apiOrConfig: TuyaApi | TuyaConfig, log?: TuyaMqLogger) {
    if ('getDevices' in apiOrConfig && typeof (apiOrConfig as TuyaApi).getDevices === 'function') {
      this.api = apiOrConfig as TuyaApi;
      // Test path: no accessKey, no Pulsar.
    } else {
      const cfg = apiOrConfig as TuyaConfig;
      this.api = new TuyaApi(cfg);
      if (cfg.accessKey && log) {
        this.mq = new TuyaPulsarConsumer(cfg.accessId, cfg.accessKey, cfg.region, log);
      }
    }
  }

  /** Begin MQTT subscription. Safe to call multiple times. */
  start(): void {
    this.mq?.addMessageListener(this.onMqMessage);
    this.mq?.start();
  }

  async discover(): Promise<BridgeDevice[]> {
    const devices = await this.api.getDevices();
    // Seed cache from initial discovery so getState() doesn't need REST
    // until the first MQTT message arrives.
    for (const d of devices) {
      this.stateCache.set(d.id, tuyaStatusToState(d.status));
    }
    return devices
      .map(tuyaDeviceToBridgeDevice)
      .filter((d): d is BridgeDevice => d !== null);
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const cached = this.stateCache.get(deviceId);
    if (cached) return cached;
    // Cache miss — rare (unknown device or cold start before discovery).
    // Fall back to a single REST call and seed the cache.
    const status = await this.api.getDeviceStatus(deviceId);
    const state = tuyaStatusToState(status);
    this.stateCache.set(deviceId, state);
    return state;
  }

  async setState(deviceId: string, state: Partial<DeviceState>): Promise<void> {
    const commands = stateToTuyaCommands(state);
    if (commands.length > 0) {
      await this.api.sendCommands(deviceId, commands);
      // Optimistic cache update; MQTT will echo the real state shortly.
      const current = this.stateCache.get(deviceId) ?? {};
      this.stateCache.set(deviceId, { ...current, ...state });
    }
  }

  dispose(): void {
    this.mq?.removeMessageListener(this.onMqMessage);
    this.mq?.stop();
    this.listeners.clear();
  }

  /** Register a listener fired whenever an MQTT state change arrives.
   *  Returns an unsubscribe function. */
  onStateChange(listener: TuyaStateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readonly onMqMessage = (msg: MqMessage): void => {
    if (!msg.devId || !msg.status?.length) return;
    // Only process devices we discovered — ignore devices in the Tuya
    // account that aren't bridged (fans, sensors, non-light categories).
    if (!this.stateCache.has(msg.devId)) return;

    const delta = tuyaStatusToState(msg.status);
    const prev = this.stateCache.get(msg.devId) ?? {};
    const next: DeviceState = { ...prev, ...delta };
    this.stateCache.set(msg.devId, next);

    for (const listener of this.listeners) {
      try {
        listener(msg.devId, next);
      } catch {
        // Listener bugs must not break the MQTT pipeline.
      }
    }
  };
}
