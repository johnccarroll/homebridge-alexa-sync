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
    const devices: BridgeDevice[] = [];

    for (const ad of alexaDevices) {
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
