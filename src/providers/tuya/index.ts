import type { DeviceProvider } from '../provider.js';
import type { BridgeDevice, DeviceState } from '../../types.js';
import { TuyaApi } from './api.js';
import { tuyaDeviceToBridgeDevice, tuyaStatusToState, stateToTuyaCommands } from './mapper.js';
import type { TuyaConfig } from '../../config.js';

export class TuyaProvider implements DeviceProvider {
  readonly id = 'tuya';
  private readonly api: TuyaApi;

  constructor(apiOrConfig: TuyaApi | TuyaConfig) {
    if ('getDevices' in apiOrConfig && typeof (apiOrConfig as TuyaApi).getDevices === 'function') {
      this.api = apiOrConfig as TuyaApi;
    } else {
      this.api = new TuyaApi(apiOrConfig as TuyaConfig);
    }
  }

  async discover(): Promise<BridgeDevice[]> {
    const devices = await this.api.getDevices();
    return devices
      .map(tuyaDeviceToBridgeDevice)
      .filter((d): d is BridgeDevice => d !== null);
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const status = await this.api.getDeviceStatus(deviceId);
    return tuyaStatusToState(status);
  }

  async setState(deviceId: string, state: Partial<DeviceState>): Promise<void> {
    const commands = stateToTuyaCommands(state);
    if (commands.length > 0) {
      await this.api.sendCommands(deviceId, commands);
    }
  }

  dispose(): void {
    // No persistent connections to clean up
  }
}
