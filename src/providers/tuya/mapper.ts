import type { TuyaCommand, TuyaDevice } from './api.js';
import type { BridgeDevice, Capability, DeviceState } from '../../types.js';

const LIGHT_CATEGORIES = new Set(['dj', 'dd', 'fwd', 'dc', 'xdd', 'fsd', 'tgq']);
const TUYA_BRIGHTNESS_MIN = 10;
const TUYA_BRIGHTNESS_MAX = 1000;
const KELVIN_MIN = 2700;
const KELVIN_MAX = 6500;

export function tuyaDeviceToBridgeDevice(tuya: TuyaDevice): BridgeDevice | null {
  if (!LIGHT_CATEGORIES.has(tuya.category)) return null;

  const dpCodes = new Set(tuya.status.map(s => s.code));
  const capabilities: Capability[] = [];

  if (dpCodes.has('switch_led')) {
    capabilities.push({ type: 'on-off' });
  }
  if (dpCodes.has('bright_value_v2')) {
    capabilities.push({ type: 'brightness', range: [0, 100] });
  }
  if (dpCodes.has('colour_data_v2')) {
    capabilities.push({ type: 'color' });
  }
  if (dpCodes.has('temp_value_v2')) {
    capabilities.push({ type: 'color-temperature', range: [KELVIN_MIN, KELVIN_MAX] });
  }

  if (capabilities.length === 0) return null;

  return {
    id: `tuya:${tuya.id}`,
    name: tuya.name,
    type: 'light',
    provider: 'tuya',
    capabilities,
    manufacturer: 'Tuya',
    model: tuya.product_id,
  };
}

export function tuyaStatusToState(status: Array<{ code: string; value: boolean | number | string }>): DeviceState {
  const state: DeviceState = {};
  const map = new Map(status.map(s => [s.code, s.value]));

  if (map.has('switch_led')) {
    state.on = map.get('switch_led') as boolean;
  }

  if (map.has('bright_value_v2')) {
    const raw = map.get('bright_value_v2') as number;
    state.brightness = Math.round((raw / TUYA_BRIGHTNESS_MAX) * 100);
  }

  if (map.has('temp_value_v2')) {
    const raw = map.get('temp_value_v2') as number;
    state.colorTemperature = Math.round(KELVIN_MIN + (raw / 1000) * (KELVIN_MAX - KELVIN_MIN));
  }

  if (map.has('colour_data_v2')) {
    const raw = map.get('colour_data_v2') as string;
    try {
      const { h, s } = JSON.parse(raw) as { h: number; s: number; v: number };
      state.hue = h;
      state.saturation = Math.round((s / 1000) * 100);
    } catch {
      // Ignore malformed color data
    }
  }

  return state;
}

export function stateToTuyaCommands(state: Partial<DeviceState>): TuyaCommand[] {
  const commands: TuyaCommand[] = [];

  if (state.on !== undefined) {
    commands.push({ code: 'switch_led', value: state.on });
  }

  if (state.brightness !== undefined) {
    commands.push({ code: 'work_mode', value: 'white' });
    const scaled = Math.round((state.brightness / 100) * TUYA_BRIGHTNESS_MAX);
    commands.push({ code: 'bright_value_v2', value: Math.max(TUYA_BRIGHTNESS_MIN, scaled) });
  }

  if (state.hue !== undefined || state.saturation !== undefined) {
    commands.push({ code: 'work_mode', value: 'colour' });
    const h = state.hue ?? 0;
    const s = Math.round((state.saturation ?? 100) / 100 * 1000);
    commands.push({
      code: 'colour_data_v2',
      value: JSON.stringify({ h, s, v: 1000 }),
    });
  }

  if (state.colorTemperature !== undefined) {
    commands.push({ code: 'work_mode', value: 'white' });
    const scaled = Math.round(((state.colorTemperature - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN)) * 1000);
    commands.push({ code: 'temp_value_v2', value: Math.max(0, Math.min(1000, scaled)) });
  }

  return commands;
}
