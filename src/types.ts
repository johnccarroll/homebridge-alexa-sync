export type DeviceType = 'light' | 'thermostat' | 'switch' | 'lock' | 'fan' | 'outlet';

export type Capability =
  | { type: 'on-off' }
  | { type: 'brightness'; range: [number, number] }
  | { type: 'color' }
  | { type: 'color-temperature'; range: [number, number] }
  | { type: 'temperature'; unit: 'celsius' | 'fahrenheit' }
  | { type: 'target-temperature'; range: [number, number] }
  | { type: 'thermostat-mode'; modes: string[] }
  | { type: 'lock' };

export interface BridgeDevice {
  id: string;
  name: string;
  type: DeviceType;
  provider: string;
  capabilities: Capability[];
  manufacturer?: string;
  model?: string;
  firmware?: string;
}

export interface DeviceState {
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
  colorTemperature?: number;
  temperature?: number;
  targetTemperature?: number;
  thermostatMode?: string;
  locked?: boolean;
}
