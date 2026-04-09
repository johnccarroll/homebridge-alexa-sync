import type { DeviceProvider } from '../provider.js';
import type { BridgeDevice, DeviceState } from '../../types.js';
import { ResideoApi } from './api.js';
import type { ResideoApiConfig } from './api.js';
import { resideoToBridgeDevice, resideoToState, stateToResideoChanges, type ResideoDeviceInfo } from './mapper.js';

export class ResideoProvider implements DeviceProvider {
  readonly id = 'resideo';
  private readonly api: ResideoApi;
  private readonly deviceInfo = new Map<string, ResideoDeviceInfo>();
  private onRefreshToken?: (token: string) => void;

  constructor(apiOrConfig: ResideoApi | ResideoApiConfig) {
    if ('getLocations' in apiOrConfig && typeof (apiOrConfig as ResideoApi).getLocations === 'function') {
      this.api = apiOrConfig as ResideoApi;
    } else {
      this.api = new ResideoApi(apiOrConfig as ResideoApiConfig);
    }
  }

  /** Register callback for when refresh token changes (for persistence) */
  onTokenRefresh(callback: (token: string) => void): void {
    this.onRefreshToken = callback;
  }

  async discover(): Promise<BridgeDevice[]> {
    const locations = await this.api.getLocations();
    const devices: BridgeDevice[] = [];

    for (const location of locations) {
      if (!location.devices) continue;
      for (const thermostat of location.devices) {
        const info: ResideoDeviceInfo = { thermostat, locationId: location.locationID };
        this.deviceInfo.set(thermostat.deviceID, info);
        devices.push(resideoToBridgeDevice(info));
      }
    }

    return devices;
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const info = this.deviceInfo.get(deviceId);
    if (!info) throw new Error(`Unknown Resideo device: ${deviceId}`);

    const thermostat = await this.api.getThermostat(deviceId, info.locationId);
    // Update cached info with fresh data
    info.thermostat = thermostat;
    return resideoToState(thermostat);
  }

  async setState(deviceId: string, state: Partial<DeviceState>): Promise<void> {
    const info = this.deviceInfo.get(deviceId);
    if (!info) throw new Error(`Unknown Resideo device: ${deviceId}`);

    const changes = stateToResideoChanges(state, info.thermostat.units);
    if (Object.keys(changes).length > 0) {
      await this.api.setThermostat(deviceId, info.locationId, changes);
    }
  }

  dispose(): void {
    // No persistent connections
  }
}
