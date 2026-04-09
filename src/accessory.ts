import type { PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import type { BridgeDevice, DeviceState } from './types.js';

interface HapTypes {
  Service: typeof Service;
  Characteristic: typeof Characteristic;
}

type GetState = (deviceId: string) => Promise<DeviceState>;
type SetState = (deviceId: string, state: Partial<DeviceState>) => Promise<void>;

/** Wraps a promise with a timeout to prevent Homebridge handler hangs */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const GET_TIMEOUT_MS = 8000; // Homebridge times out at 10s, give ourselves 8s

function kelvinToMired(kelvin: number): number {
  return Math.round(1_000_000 / kelvin);
}

function miredToKelvin(mired: number): number {
  return Math.round(1_000_000 / mired);
}

export function configureAccessory(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  hap: HapTypes,
  getState: GetState,
  setState: SetState,
): void {
  accessory.context.device = device;

  const infoService = accessory.getService(hap.Service.AccessoryInformation);
  if (infoService) {
    infoService
      .setCharacteristic(hap.Characteristic.Manufacturer, device.manufacturer ?? 'Unknown')
      .setCharacteristic(hap.Characteristic.Model, device.model ?? 'Unknown')
      .setCharacteristic(hap.Characteristic.SerialNumber, device.id);
  }

  if (device.type === 'light') {
    configureLightAccessory(accessory, device, hap, getState, setState);
  }
}

function configureLightAccessory(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  hap: HapTypes,
  getState: GetState,
  setState: SetState,
): void {
  const service = accessory.getService(hap.Service.Lightbulb)
    || accessory.addService(hap.Service.Lightbulb);

  const caps = new Set(device.capabilities.map(c => c.type));

  // Helper to get state with timeout — prevents Homebridge "didn't respond" errors
  const safeGetState = (id: string) => withTimeout(getState(id), GET_TIMEOUT_MS, {} as DeviceState);

  if (caps.has('on-off')) {
    service.getCharacteristic(hap.Characteristic.On)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await safeGetState(device.id);
        return state.on ?? false;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { on: value as boolean });
      });
  }

  if (caps.has('brightness')) {
    service.getCharacteristic(hap.Characteristic.Brightness)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await safeGetState(device.id);
        return state.brightness ?? 100;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { brightness: value as number });
      });
  }

  if (caps.has('color')) {
    service.getCharacteristic(hap.Characteristic.Hue)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await safeGetState(device.id);
        return state.hue ?? 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { hue: value as number });
      });

    service.getCharacteristic(hap.Characteristic.Saturation)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await safeGetState(device.id);
        return state.saturation ?? 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { saturation: value as number });
      });
  }

  if (caps.has('color-temperature')) {
    const ctCap = device.capabilities.find(c => c.type === 'color-temperature');
    const range = ctCap && 'range' in ctCap ? ctCap.range : [2700, 6500];
    const minMired = kelvinToMired(range[1]);
    const maxMired = kelvinToMired(range[0]);

    const defaultMired = kelvinToMired(4000);
    service.getCharacteristic(hap.Characteristic.ColorTemperature)
      .updateValue(Math.max(minMired, Math.min(maxMired, defaultMired)))
      .setProps({ minValue: minMired, maxValue: maxMired })
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await safeGetState(device.id);
        const mired = kelvinToMired(state.colorTemperature ?? 4000);
        return Math.max(minMired, Math.min(maxMired, mired));
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { colorTemperature: miredToKelvin(value as number) });
      });
  }
}

export function updateAccessoryState(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  state: DeviceState,
  hap: HapTypes,
): void {
  if (device.type !== 'light') return;

  const service = accessory.getService(hap.Service.Lightbulb);
  if (!service) return;

  const caps = new Set(device.capabilities.map(c => c.type));

  if (caps.has('on-off') && state.on !== undefined) {
    service.updateCharacteristic(hap.Characteristic.On, state.on);
  }
  if (caps.has('brightness') && state.brightness !== undefined) {
    service.updateCharacteristic(hap.Characteristic.Brightness, state.brightness);
  }
  if (caps.has('color')) {
    if (state.hue !== undefined) {
      service.updateCharacteristic(hap.Characteristic.Hue, state.hue);
    }
    if (state.saturation !== undefined) {
      service.updateCharacteristic(hap.Characteristic.Saturation, state.saturation);
    }
  }
  if (caps.has('color-temperature') && state.colorTemperature !== undefined) {
    service.updateCharacteristic(hap.Characteristic.ColorTemperature, kelvinToMired(state.colorTemperature));
  }
}
