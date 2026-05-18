import type { DeviceProvider } from '../provider.js';
import type { BridgeDevice, DeviceState } from '../../types.js';
import type { AlexaClient } from './client.js';
import type { AlexaConfig } from '../../config.js';
import {
  alexaDeviceToBridgeDevice,
  alexaStateToDeviceState,
} from './mapper.js';

export class AlexaProvider implements DeviceProvider {
  readonly id = 'alexa';
  private readonly client: AlexaClient;
  private readonly config: Partial<AlexaConfig>;
  private readonly applianceIds = new Map<string, string>();
  private readonly reverseApplianceIds = new Map<string, string>();

  constructor(client: AlexaClient, config: Partial<AlexaConfig>) {
    this.client = client;
    this.config = config;
  }

  async discover(): Promise<BridgeDevice[]> {
    const alexaDevices = await this.client.discoverDevices();

    // Group raw Alexa entries by friendlyName so we can pick the best
    // applianceId per device. Smart-home devices commonly surface multiple
    // times — once via the native Smart Life skill (applianceId prefixed
    // `AAA_SonarCloudService_…`) and once via a user-installed custom skill
    // (prefixed `SKILL_…`). The custom-skill path frequently returns
    // ENDPOINT_UNREACHABLE on state queries (skill backend only handles
    // directives, not ReportState), so when both exist for the same name we
    // pick the native one.
    const byName = new Map<string, typeof alexaDevices[number]>();
    const applianceScore = (id: string) => {
      if (id.startsWith('AAA_')) return 2;     // native Smart Home graph — best
      if (id.startsWith('SKILL_')) return 0;   // custom skill — often unreachable
      return 1;
    };
    for (const ad of alexaDevices) {
      const aid = ad.legacyAppliance?.applianceId ?? ad.id;
      const existing = byName.get(ad.friendlyName);
      if (!existing) {
        byName.set(ad.friendlyName, ad);
        continue;
      }
      const existingAid = existing.legacyAppliance?.applianceId ?? existing.id;
      if (applianceScore(aid) > applianceScore(existingAid)) {
        byName.set(ad.friendlyName, ad);
      }
    }

    const devices: BridgeDevice[] = [];
    for (const ad of byName.values()) {
      const device = alexaDeviceToBridgeDevice(ad, this.config.deviceTypes);
      if (device) {
        devices.push(device);
        const applianceId = ad.legacyAppliance?.applianceId ?? ad.id;
        this.applianceIds.set(ad.id, applianceId);
        this.reverseApplianceIds.set(applianceId, ad.id);
      }
    }

    return devices;
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const applianceId = this.applianceIds.get(deviceId);
    if (!applianceId) throw new Error(`Unknown Alexa device: ${deviceId}`);

    const alexaState = await this.client.queryDeviceState(applianceId);
    return alexaStateToDeviceState(alexaState);
  }

  async getStates(deviceIds: string[]): Promise<Map<string, DeviceState>> {
    const applianceIdList: string[] = [];
    for (const id of deviceIds) {
      const applianceId = this.applianceIds.get(id);
      if (applianceId) applianceIdList.push(applianceId);
    }
    if (applianceIdList.length === 0) return new Map();

    const alexaStates = await this.client.queryDeviceStates(applianceIdList);
    const result = new Map<string, DeviceState>();
    for (const [applianceId, alexaState] of alexaStates) {
      const deviceId = this.reverseApplianceIds.get(applianceId);
      if (deviceId) {
        result.set(deviceId, alexaStateToDeviceState(alexaState));
      }
    }
    return result;
  }

  async setState(deviceId: string, state: Partial<DeviceState>): Promise<void> {
    const applianceId = this.applianceIds.get(deviceId);
    if (!applianceId) throw new Error(`Unknown Alexa device: ${deviceId}`);

    const actions: Array<Record<string, unknown>> = [];

    if (state.on !== undefined) {
      actions.push({ action: state.on ? 'turnOn' : 'turnOff' });
    }
    if (state.brightness !== undefined) {
      actions.push({ action: 'setBrightness', brightness: state.brightness });
    }
    if (state.hue !== undefined || state.saturation !== undefined) {
      actions.push({
        action: 'setColor',
        color: {
          hue: state.hue ?? 0,
          saturation: (state.saturation ?? 100) / 100,
          brightness: 1.0,
        },
      });
    }
    if (state.colorTemperature !== undefined) {
      actions.push({
        action: 'setColorTemperature',
        colorTemperature: { value: state.colorTemperature },
      });
    }

    for (const action of actions) {
      await this.client.executeAction(applianceId, action);
    }
  }

  dispose(): void {
    this.client.dispose();
  }
}
