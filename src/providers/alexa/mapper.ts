import type { BridgeDevice, Capability, DeviceState, DeviceType } from '../../types.js';

interface AlexaDeviceFeature {
  name: string;
  operations: Array<{ name: string }>;
}

export interface AlexaDevice {
  id: string;
  friendlyName: string;
  displayCategories: { primary: { value: string } };
  features: AlexaDeviceFeature[];
  manufacturer?: string;
  model?: string;
  legacyAppliance?: { applianceId: string };
}

export interface AlexaDeviceState {
  [namespace: string]: Record<string, unknown>;
}

const CATEGORY_MAP: Record<string, DeviceType> = {
  LIGHT: 'light',
  SWITCH: 'switch',
  SMARTPLUG: 'outlet',
  SMARTLOCK: 'lock',
  FAN: 'fan',
  THERMOSTAT: 'thermostat',
};

const DEFAULT_DEVICE_TYPES = ['LIGHT', 'SWITCH', 'SMARTPLUG', 'SMARTLOCK', 'FAN', 'THERMOSTAT'];

export function alexaDeviceToBridgeDevice(
  device: AlexaDevice,
  allowedTypes?: string[],
): BridgeDevice | null {
  const category = device.displayCategories?.primary?.value;
  if (!category) return null;

  const allowed = allowedTypes ?? DEFAULT_DEVICE_TYPES;
  if (!allowed.includes(category)) return null;

  const deviceType = CATEGORY_MAP[category];
  if (!deviceType) return null;

  const featureNames = new Set(device.features.map(f => f.name));
  const capabilities: Capability[] = [];

  if (featureNames.has('power')) {
    capabilities.push({ type: 'on-off' });
  }
  if (featureNames.has('brightness')) {
    capabilities.push({ type: 'brightness', range: [0, 100] });
  }
  if (featureNames.has('color')) {
    capabilities.push({ type: 'color' });
  }
  if (featureNames.has('colorTemperature')) {
    capabilities.push({ type: 'color-temperature', range: [2200, 6500] });
  }
  if (featureNames.has('temperatureSensor')) {
    capabilities.push({ type: 'temperature', unit: 'celsius' });
  }
  if (featureNames.has('thermostat')) {
    capabilities.push({ type: 'target-temperature', range: [10, 35] });
    capabilities.push({ type: 'thermostat-mode', modes: ['heat', 'cool', 'auto', 'off'] });
  }
  if (featureNames.has('lock')) {
    capabilities.push({ type: 'lock' });
  }

  if (capabilities.length === 0) return null;

  return {
    id: `alexa:${device.id}`,
    name: device.friendlyName,
    type: deviceType,
    provider: 'alexa',
    capabilities,
    manufacturer: device.manufacturer,
    model: device.model,
  };
}

export function alexaStateToDeviceState(state: AlexaDeviceState): DeviceState {
  const result: DeviceState = {};

  const power = state['Alexa.PowerController'];
  if (power?.powerState !== undefined) {
    result.on = power.powerState === 'ON';
  }

  const brightness = state['Alexa.BrightnessController'];
  if (brightness?.brightness !== undefined) {
    result.brightness = brightness.brightness as number;
  }

  const color = state['Alexa.ColorController'];
  if (color?.color) {
    const c = color.color as { hue: number; saturation: number; brightness: number };
    result.hue = c.hue;
    result.saturation = Math.round(c.saturation * 100);
  }

  const colorTemp = state['Alexa.ColorTemperatureController'];
  if (colorTemp?.colorTemperatureInKelvin !== undefined) {
    result.colorTemperature = colorTemp.colorTemperatureInKelvin as number;
  }

  const temp = state['Alexa.TemperatureSensor'];
  if (temp?.temperature) {
    const t = temp.temperature as { value: number; scale: string };
    result.temperature = t.value;
  }

  return result;
}
