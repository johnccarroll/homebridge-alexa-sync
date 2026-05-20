import type { DeviceState } from '../types.js';
import { randomUUID } from 'node:crypto';

export function extractStateFromDirective(directive: any): Partial<DeviceState> {
  const { namespace, name } = directive.header;
  const payload = directive.payload;

  switch (namespace) {
    case 'Alexa.PowerController':
      return { on: name === 'TurnOn' };

    case 'Alexa.BrightnessController':
      if (typeof payload?.brightness !== 'number') return {};
      return { brightness: payload.brightness };

    case 'Alexa.ColorController': {
      const c = payload?.color;
      if (!c || typeof c.hue !== 'number' || typeof c.saturation !== 'number') return {};
      return { hue: c.hue, saturation: Math.round(c.saturation * 100) };
    }

    case 'Alexa.ColorTemperatureController':
      if (typeof payload?.colorTemperatureInKelvin !== 'number') return {};
      return { colorTemperature: payload.colorTemperatureInKelvin };

    case 'Alexa.LockController':
      // name is "Lock" or "Unlock"
      return { locked: name === 'Lock' };

    case 'Alexa.ThermostatController': {
      const result: Partial<DeviceState> = {};
      if (name === 'SetTargetTemperature' || name === 'AdjustTargetTemperature') {
        const sp = payload?.targetSetpoint ?? payload?.targetSetpointDelta;
        if (sp && typeof sp.value === 'number') {
          const scale = (sp.scale as string)?.toUpperCase();
          const celsius = scale === 'FAHRENHEIT' ? (sp.value - 32) * 5 / 9 : sp.value;
          result.targetTemperature = Math.round(celsius * 10) / 10;
        }
      }
      if (name === 'SetThermostatMode') {
        const mode = (payload?.thermostatMode?.value as string)?.toLowerCase();
        if (mode === 'heat' || mode === 'cool' || mode === 'auto' || mode === 'off') {
          result.thermostatMode = mode;
        }
      }
      return result;
    }

    default:
      return {};
  }
}

function stateToProperties(state: DeviceState): object[] {
  const now = new Date().toISOString();
  const props: object[] = [];

  props.push({
    namespace: 'Alexa.EndpointHealth',
    name: 'connectivity',
    value: { value: 'OK' },
    timeOfSample: now,
    uncertaintyInMilliseconds: 0,
  });

  if (state.on !== undefined) {
    props.push({
      namespace: 'Alexa.PowerController', name: 'powerState',
      value: state.on ? 'ON' : 'OFF', timeOfSample: now, uncertaintyInMilliseconds: 500,
    });
  }
  if (state.brightness !== undefined) {
    props.push({
      namespace: 'Alexa.BrightnessController', name: 'brightness',
      value: state.brightness, timeOfSample: now, uncertaintyInMilliseconds: 500,
    });
  }
  if (state.hue !== undefined && state.saturation !== undefined) {
    props.push({
      namespace: 'Alexa.ColorController', name: 'color',
      value: { hue: state.hue, saturation: state.saturation / 100, brightness: 1.0 },
      timeOfSample: now, uncertaintyInMilliseconds: 500,
    });
  }
  if (state.colorTemperature !== undefined) {
    props.push({
      namespace: 'Alexa.ColorTemperatureController', name: 'colorTemperatureInKelvin',
      value: state.colorTemperature, timeOfSample: now, uncertaintyInMilliseconds: 500,
    });
  }
  if (state.locked !== undefined) {
    props.push({
      namespace: 'Alexa.LockController', name: 'lockState',
      value: state.locked ? 'LOCKED' : 'UNLOCKED', timeOfSample: now, uncertaintyInMilliseconds: 500,
    });
  }
  if (state.targetTemperature !== undefined) {
    props.push({
      namespace: 'Alexa.ThermostatController', name: 'targetSetpoint',
      value: { value: state.targetTemperature, scale: 'CELSIUS' },
      timeOfSample: now, uncertaintyInMilliseconds: 500,
    });
  }
  if (state.thermostatMode !== undefined) {
    props.push({
      namespace: 'Alexa.ThermostatController', name: 'thermostatMode',
      value: state.thermostatMode.toUpperCase(),
      timeOfSample: now, uncertaintyInMilliseconds: 500,
    });
  }
  if (state.temperature !== undefined) {
    props.push({
      namespace: 'Alexa.TemperatureSensor', name: 'temperature',
      value: { value: state.temperature, scale: 'CELSIUS' },
      timeOfSample: now, uncertaintyInMilliseconds: 500,
    });
  }

  return props;
}

export function buildControlResponse(endpointId: string, correlationToken: string, state: DeviceState): any {
  return {
    context: { properties: stateToProperties(state) },
    event: {
      header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: randomUUID(), correlationToken },
      endpoint: { endpointId },
      payload: {},
    },
  };
}

export function buildStateReportResponse(endpointId: string, correlationToken: string, state: DeviceState): any {
  return {
    context: { properties: stateToProperties(state) },
    event: {
      header: { namespace: 'Alexa', name: 'StateReport', payloadVersion: '3', messageId: randomUUID(), correlationToken },
      endpoint: { endpointId },
      payload: {},
    },
  };
}
