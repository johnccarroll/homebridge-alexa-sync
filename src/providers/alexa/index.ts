import type { DeviceProvider } from '../provider.js';
import type { BridgeDevice, DeviceState } from '../../types.js';
import type { AlexaClient, FeatureRequest } from './client.js';
import type { AlexaConfig } from '../../config.js';
import {
  alexaDeviceToBridgeDevice,
  alexaStateToDeviceState,
} from './mapper.js';

export class AlexaProvider implements DeviceProvider {
  readonly id = 'alexa';
  private readonly client: AlexaClient;
  private readonly config: Partial<AlexaConfig>;
  // Endpoint ids of the devices we exposed. Reads and writes both address
  // endpoints directly through Amazon's GraphQL API.
  private readonly known = new Set<string>();

  constructor(client: AlexaClient, config: Partial<AlexaConfig>) {
    this.client = client;
    this.config = config;
  }

  async discover(): Promise<BridgeDevice[]> {
    const alexaDevices = await this.client.discoverDevices();

    // Smart-home devices commonly surface several times under one name: the
    // native graph (`AAA_…` applianceId), the vendor's skill, and stale or
    // retired custom skills (`SKILL_…`, often a development-stage skill whose
    // backend is gone). Prefer whichever endpoint actually reports state, then
    // native over skill. A failed state fetch just falls back to the prefix rank.
    const states = await this.client.queryAllStates().catch(() => new Map());
    const score = (ad: typeof alexaDevices[number]) => {
      const live = Object.keys(states.get(ad.id) ?? {}).length > 0 ? 10 : 0;
      const aid = ad.legacyAppliance?.applianceId ?? ad.id;
      return live + (aid.startsWith('AAA_') ? 2 : aid.startsWith('SKILL_') ? 0 : 1);
    };
    const byName = new Map<string, typeof alexaDevices[number]>();
    for (const ad of alexaDevices) {
      const existing = byName.get(ad.friendlyName);
      if (!existing || score(ad) > score(existing)) byName.set(ad.friendlyName, ad);
    }

    // Rebuilt from scratch (rediscovery runs every 6h) so a device deleted
    // from the account fails fast as unknown instead of lingering. Cleared only
    // after discovery succeeded, so a failed pass keeps the previous set.
    this.known.clear();
    const devices: BridgeDevice[] = [];
    for (const ad of byName.values()) {
      const device = alexaDeviceToBridgeDevice(ad, this.config.deviceTypes);
      if (device) {
        devices.push(device);
        this.known.add(ad.id);
      }
    }
    return devices;
  }

  async getState(deviceId: string): Promise<DeviceState> {
    if (!this.known.has(deviceId)) throw new Error(`Unknown Alexa device: ${deviceId}`);
    return alexaStateToDeviceState(await this.client.queryDeviceState(deviceId));
  }

  async getStates(deviceIds: string[]): Promise<Map<string, DeviceState>> {
    const ids = deviceIds.filter(id => this.known.has(id));
    if (ids.length === 0) return new Map();

    const result = new Map<string, DeviceState>();
    for (const [id, alexaState] of await this.client.queryDeviceStates(ids)) {
      result.set(id, alexaStateToDeviceState(alexaState));
    }
    return result;
  }

  async setState(deviceId: string, state: Partial<DeviceState>, target?: DeviceState): Promise<void> {
    if (!this.known.has(deviceId)) throw new Error(`Unknown Alexa device: ${deviceId}`);

    const requests: FeatureRequest[] = [];
    if (state.on !== undefined) {
      requests.push({ featureName: 'power', featureOperationName: state.on ? 'turnOn' : 'turnOff' });
    }
    if (state.brightness !== undefined) {
      requests.push({
        featureName: 'brightness', featureOperationName: 'setBrightness',
        payload: { brightness: state.brightness },
      });
    }
    if (state.hue !== undefined || state.saturation !== undefined) {
      // setColor takes a full HSB and *replaces* the bulb's color, so fill the
      // axes the caller didn't change from the merged target: a hue-only nudge
      // from iOS Home must not snap saturation or brightness to defaults.
      const hue = state.hue ?? target?.hue ?? 0;
      const saturationPct = state.saturation ?? target?.saturation ?? 100;
      const brightnessPct = target?.brightness ?? state.brightness ?? 100;
      requests.push({
        featureName: 'color', featureOperationName: 'setColor',
        payload: { color: { hue, saturation: saturationPct / 100, brightness: brightnessPct / 100 } },
      });
    }
    if (state.colorTemperature !== undefined) {
      requests.push({
        featureName: 'colorTemperature', featureOperationName: 'setColorTemperature',
        payload: { colorTemperatureInKelvin: state.colorTemperature },
      });
    }
    if (state.locked !== undefined) {
      requests.push({ featureName: 'lock', featureOperationName: state.locked ? 'lock' : 'unlock' });
    }
    if (state.targetTemperature !== undefined) {
      requests.push({
        featureName: 'thermostat', featureOperationName: 'setTargetSetpoint',
        payload: { targetSetpoint: { value: state.targetTemperature, scale: 'CELSIUS' } },
      });
    }
    if (state.thermostatMode !== undefined) {
      requests.push({
        featureName: 'thermostat', featureOperationName: 'setThermostatMode',
        payload: { thermostatMode: { value: state.thermostatMode.toUpperCase() } },
      });
    }

    await this.client.executeActions(deviceId, requests);
  }

  dispose(): void {
    this.client.dispose();
  }
}
