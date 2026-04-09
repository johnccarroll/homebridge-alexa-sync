import type { BridgeDevice, DeviceState } from '../../types.js';
import type { ResideoThermostat } from './api.js';

export interface ResideoDeviceInfo {
  thermostat: ResideoThermostat;
  locationId: number;
}

const MODE_MAP: Record<string, string> = {
  'Heat': 'heat',
  'Cool': 'cool',
  'Auto': 'auto',
  'Off': 'off',
};

const REVERSE_MODE_MAP: Record<string, string> = {
  'heat': 'Heat',
  'cool': 'Cool',
  'auto': 'Auto',
  'off': 'Off',
};

export function resideoToBridgeDevice(info: ResideoDeviceInfo): BridgeDevice {
  const { thermostat } = info;
  const modes = Object.values(MODE_MAP);

  return {
    id: `resideo:${thermostat.deviceID}`,
    name: thermostat.name,
    type: 'thermostat',
    provider: 'resideo',
    capabilities: [
      { type: 'temperature', unit: thermostat.units === 'Celsius' ? 'celsius' : 'fahrenheit' },
      { type: 'target-temperature', range: [10, 37] },
      { type: 'thermostat-mode', modes },
    ],
    manufacturer: 'Honeywell',
    model: thermostat.deviceModel,
  };
}

export function resideoToState(thermostat: ResideoThermostat): DeviceState {
  const isCelsius = thermostat.units === 'Celsius';
  const currentTemp = isCelsius
    ? thermostat.indoorTemperature
    : fahrenheitToCelsius(thermostat.indoorTemperature);

  const mode = MODE_MAP[thermostat.changeableValues.mode] ?? 'off';
  const targetTemp = mode === 'cool'
    ? thermostat.changeableValues.coolSetpoint
    : thermostat.changeableValues.heatSetpoint;
  const targetCelsius = isCelsius ? targetTemp : fahrenheitToCelsius(targetTemp);

  return {
    temperature: Math.round(currentTemp * 10) / 10,
    targetTemperature: Math.round(targetCelsius * 10) / 10,
    thermostatMode: mode,
  };
}

export function stateToResideoChanges(
  state: Partial<DeviceState>,
  currentUnit: string,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const isCelsius = currentUnit === 'Celsius';

  if (state.thermostatMode !== undefined) {
    changes.mode = REVERSE_MODE_MAP[state.thermostatMode] ?? 'Off';
  }

  if (state.targetTemperature !== undefined) {
    const temp = isCelsius
      ? state.targetTemperature
      : celsiusToFahrenheit(state.targetTemperature);
    const rounded = Math.round(temp);
    changes.heatSetpoint = rounded;
    changes.coolSetpoint = rounded;
    changes.thermostatSetpointStatus = 'PermanentHold';
  }

  return changes;
}

function fahrenheitToCelsius(f: number): number {
  return (f - 32) * 5 / 9;
}

function celsiusToFahrenheit(c: number): number {
  return c * 9 / 5 + 32;
}
