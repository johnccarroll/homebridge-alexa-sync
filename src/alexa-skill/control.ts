import type { DeviceState } from '../types.js';
import { randomUUID } from 'node:crypto';

export function extractStateFromDirective(directive: any): Partial<DeviceState> {
  const { namespace, name } = directive.header;

  switch (namespace) {
    case 'Alexa.PowerController':
      return { on: name === 'TurnOn' };
    case 'Alexa.BrightnessController':
      return { brightness: directive.payload.brightness };
    case 'Alexa.ColorController': {
      const c = directive.payload.color;
      return { hue: c.hue, saturation: Math.round(c.saturation * 100) };
    }
    case 'Alexa.ColorTemperatureController':
      return { colorTemperature: directive.payload.colorTemperatureInKelvin };
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
