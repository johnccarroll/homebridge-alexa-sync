import type { PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import type { BridgeDevice, DeviceState } from './types.js';

interface HapTypes {
  Service: typeof Service;
  Characteristic: typeof Characteristic;
}

type GetState = (deviceId: string) => Promise<DeviceState>;
type GetCachedState = (deviceId: string) => DeviceState | undefined;
type SetState = (deviceId: string, state: Partial<DeviceState>) => Promise<void>;

const FAST_GET_TIMEOUT_MS = 3500;

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
  getCachedState?: GetCachedState,
): void {
  accessory.context.device = device;

  const infoService = accessory.getService(hap.Service.AccessoryInformation);
  if (infoService) {
    infoService
      .setCharacteristic(hap.Characteristic.Manufacturer, device.manufacturer ?? 'Unknown')
      .setCharacteristic(hap.Characteristic.Model, device.model ?? 'Unknown')
      .setCharacteristic(hap.Characteristic.SerialNumber, device.id);
  }

  // Prefer cached state (instant) over live API calls to avoid "slow to respond" warnings.
  // The polling loop keeps the cache warm; onGet handlers return cached values immediately.
  // Falls back to a live API call only if cache is empty (e.g. first read before first poll).
  // HAP soft-warns at 3s and cancels at 9s — bound below the cancel deadline so a hung
  // provider can't produce "didn't respond at all". A "slow to respond" warning on the cold
  // fallback path is acceptable; the alternative (returning defaults sooner) would hide real
  // device data when the live call would have eventually succeeded.
  const fastGetState = (id: string): Promise<DeviceState> => {
    const cached = getCachedState?.(id);
    if (cached) return Promise.resolve(cached);
    const live = getState(id).catch(() => ({} as DeviceState));
    return Promise.race([
      live,
      new Promise<DeviceState>(resolve =>
        setTimeout(() => resolve({} as DeviceState), FAST_GET_TIMEOUT_MS),
      ),
    ]);
  };

  if (device.type === 'light') {
    configureLightAccessory(accessory, device, hap, fastGetState, setState);
  }

  if (device.type === 'thermostat') {
    configureThermostatAccessory(accessory, device, hap, fastGetState, setState);
  }

  // switch / outlet / fan are all "on-off plus maybe a level" in HAP terms.
  // Alexa surfaces fan speed through the same `brightness` feature it uses for
  // lights, so RotationSpeed rides on the brightness capability when present.
  if (device.type === 'switch' || device.type === 'outlet' || device.type === 'fan') {
    configureOnOffAccessory(accessory, device, hap, fastGetState, setState);
  }

  if (device.type === 'lock') {
    configureLockAccessory(accessory, device, hap, fastGetState, setState);
  }
}

/** HAP LockCurrentState / LockTargetState values. */
const LOCK_UNSECURED = 0;
const LOCK_SECURED = 1;
const LOCK_UNKNOWN = 3;

function onOffServiceFor(device: BridgeDevice, hap: HapTypes) {
  switch (device.type) {
    case 'outlet': return hap.Service.Outlet;
    case 'fan': return hap.Service.Fan;
    default: return hap.Service.Switch;
  }
}

function configureOnOffAccessory(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  hap: HapTypes,
  getState: GetState,
  setState: SetState,
): void {
  const serviceType = onOffServiceFor(device, hap);
  const service = accessory.getService(serviceType) || accessory.addService(serviceType);

  service.getCharacteristic(hap.Characteristic.On)
    .onGet(async (): Promise<CharacteristicValue> => {
      const state = await getState(device.id);
      return state.on ?? false;
    })
    .onSet(async (value: CharacteristicValue) => {
      await setState(device.id, { on: value as boolean });
    });

  // OutletInUse is required on the Outlet service. We have no real power
  // metering from Alexa, so mirror On rather than hardcoding true — an outlet
  // that reads "in use" while off is worse than a slightly loose reading.
  if (device.type === 'outlet') {
    service.getCharacteristic(hap.Characteristic.OutletInUse)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.on ?? false;
      });
  }

  if (device.type === 'fan' && device.capabilities.some(c => c.type === 'brightness')) {
    service.getCharacteristic(hap.Characteristic.RotationSpeed)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.brightness ?? 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { brightness: value as number });
      });
  }
}

function configureLockAccessory(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  hap: HapTypes,
  getState: GetState,
  setState: SetState,
): void {
  const service = accessory.getService(hap.Service.LockMechanism)
    || accessory.addService(hap.Service.LockMechanism);

  // `locked` undefined means we've never successfully read the lock. Reporting
  // UNSECURED there would tell the user their door is open; UNKNOWN is the
  // honest answer and HomeKit renders it as unavailable.
  const toCurrent = (locked: boolean | undefined): number =>
    locked === undefined ? LOCK_UNKNOWN : locked ? LOCK_SECURED : LOCK_UNSECURED;

  service.getCharacteristic(hap.Characteristic.LockCurrentState)
    .onGet(async (): Promise<CharacteristicValue> => toCurrent((await getState(device.id)).locked));

  service.getCharacteristic(hap.Characteristic.LockTargetState)
    .onGet(async (): Promise<CharacteristicValue> => {
      // Target has no UNKNOWN member — fall back to SECURED so the tile isn't
      // stuck mid-animation before the first read lands.
      const { locked } = await getState(device.id);
      return locked === false ? LOCK_UNSECURED : LOCK_SECURED;
    })
    .onSet(async (value: CharacteristicValue) => {
      await setState(device.id, { locked: value === LOCK_SECURED });
    });
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

  if (caps.has('on-off')) {
    service.getCharacteristic(hap.Characteristic.On)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.on ?? false;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { on: value as boolean });
      });
  }

  if (caps.has('brightness')) {
    service.getCharacteristic(hap.Characteristic.Brightness)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.brightness ?? 100;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { brightness: value as number });
      });
  }

  if (caps.has('color')) {
    service.getCharacteristic(hap.Characteristic.Hue)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
        return state.hue ?? 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { hue: value as number });
      });

    service.getCharacteristic(hap.Characteristic.Saturation)
      .onGet(async (): Promise<CharacteristicValue> => {
        const state = await getState(device.id);
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
        const state = await getState(device.id);
        const mired = kelvinToMired(state.colorTemperature ?? 4000);
        return Math.max(minMired, Math.min(maxMired, mired));
      })
      .onSet(async (value: CharacteristicValue) => {
        await setState(device.id, { colorTemperature: miredToKelvin(value as number) });
      });
  }
}

function configureThermostatAccessory(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  hap: HapTypes,
  getState: GetState,
  setState: SetState,
): void {
  const service = accessory.getService(hap.Service.Thermostat)
    || accessory.addService(hap.Service.Thermostat);

  // Current Temperature (read-only)
  service.getCharacteristic(hap.Characteristic.CurrentTemperature)
    .onGet(async (): Promise<CharacteristicValue> => {
      const state = await getState(device.id);
      return state.temperature ?? 20;
    });

  // Target Temperature. Take the bounds from the device's own capability
  // rather than hardcoding HomeKit's 10–37 — the mapper reports 10–35 for
  // Alexa thermostats, and advertising a range wider than the device accepts
  // just lets the user pick a setpoint Alexa will reject.
  const targetCap = device.capabilities.find(c => c.type === 'target-temperature');
  const [minTarget, maxTarget] = targetCap && 'range' in targetCap
    ? targetCap.range
    : [10, 35];

  service.getCharacteristic(hap.Characteristic.TargetTemperature)
    .setProps({ minValue: minTarget, maxValue: maxTarget, minStep: 0.5 })
    .onGet(async (): Promise<CharacteristicValue> => {
      const state = await getState(device.id);
      return state.targetTemperature ?? 20;
    })
    .onSet(async (value: CharacteristicValue) => {
      await setState(device.id, { targetTemperature: value as number });
    });

  // Current Heating/Cooling State (read-only, what it's doing now)
  service.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
    .onGet(async (): Promise<CharacteristicValue> => {
      const state = await getState(device.id);
      switch (state.thermostatMode) {
        case 'heat': return 1; // HEAT
        case 'cool': return 2; // COOL
        default: return 0;     // OFF
      }
    });

  // Target Heating/Cooling State
  service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
    .onGet(async (): Promise<CharacteristicValue> => {
      const state = await getState(device.id);
      switch (state.thermostatMode) {
        case 'heat': return 1;
        case 'cool': return 2;
        case 'auto': return 3;
        default: return 0;
      }
    })
    .onSet(async (value: CharacteristicValue) => {
      const modes = ['off', 'heat', 'cool', 'auto'];
      await setState(device.id, { thermostatMode: modes[value as number] ?? 'off' });
    });

  // Temperature Display Units (read-only, based on device config)
  service.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
    .onGet(async (): Promise<CharacteristicValue> => {
      // 0 = Celsius, 1 = Fahrenheit
      const tempCap = device.capabilities.find(c => c.type === 'temperature');
      return tempCap && 'unit' in tempCap && tempCap.unit === 'fahrenheit' ? 1 : 0;
    });
}

export function updateAccessoryState(
  accessory: PlatformAccessory,
  device: BridgeDevice,
  state: DeviceState,
  hap: HapTypes,
): void {
  if (device.type === 'light') {
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

  if (device.type === 'switch' || device.type === 'outlet' || device.type === 'fan') {
    const service = accessory.getService(onOffServiceFor(device, hap));
    if (!service) return;

    if (state.on !== undefined) {
      service.updateCharacteristic(hap.Characteristic.On, state.on);
      if (device.type === 'outlet') {
        service.updateCharacteristic(hap.Characteristic.OutletInUse, state.on);
      }
    }
    if (device.type === 'fan'
      && state.brightness !== undefined
      && device.capabilities.some(c => c.type === 'brightness')) {
      service.updateCharacteristic(hap.Characteristic.RotationSpeed, state.brightness);
    }
  }

  if (device.type === 'lock') {
    const service = accessory.getService(hap.Service.LockMechanism);
    if (!service) return;

    if (state.locked !== undefined) {
      const value = state.locked ? LOCK_SECURED : LOCK_UNSECURED;
      service.updateCharacteristic(hap.Characteristic.LockCurrentState, value);
      service.updateCharacteristic(hap.Characteristic.LockTargetState, value);
    }
  }

  if (device.type === 'thermostat') {
    const service = accessory.getService(hap.Service.Thermostat);
    if (!service) return;

    if (state.temperature !== undefined) {
      service.updateCharacteristic(hap.Characteristic.CurrentTemperature, state.temperature);
    }
    if (state.targetTemperature !== undefined) {
      service.updateCharacteristic(hap.Characteristic.TargetTemperature, state.targetTemperature);
    }
    if (state.thermostatMode !== undefined) {
      const targetMap: Record<string, number> = { off: 0, heat: 1, cool: 2, auto: 3 };
      const currentMap: Record<string, number> = { off: 0, heat: 1, cool: 2, auto: 0 };
      service.updateCharacteristic(hap.Characteristic.TargetHeatingCoolingState, targetMap[state.thermostatMode] ?? 0);
      service.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, currentMap[state.thermostatMode] ?? 0);
    }
  }
}
