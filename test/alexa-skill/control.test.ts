import { describe, it, expect } from 'vitest';
import {
  buildControlResponse,
  buildStateReportResponse,
  extractStateFromDirective,
} from '../../src/alexa-skill/control.js';
import type { DeviceState } from '../../src/types.js';

describe('extractStateFromDirective', () => {
  it('extracts TurnOn', () => {
    const directive = {
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn' },
      endpoint: { endpointId: 'dev_001' },
    };
    expect(extractStateFromDirective(directive)).toEqual({ on: true });
  });

  it('extracts TurnOff', () => {
    const directive = {
      header: { namespace: 'Alexa.PowerController', name: 'TurnOff' },
      endpoint: { endpointId: 'dev_001' },
    };
    expect(extractStateFromDirective(directive)).toEqual({ on: false });
  });

  it('extracts SetBrightness', () => {
    const directive = {
      header: { namespace: 'Alexa.BrightnessController', name: 'SetBrightness' },
      endpoint: { endpointId: 'dev_001' },
      payload: { brightness: 50 },
    };
    expect(extractStateFromDirective(directive)).toEqual({ brightness: 50 });
  });

  it('extracts SetColor', () => {
    const directive = {
      header: { namespace: 'Alexa.ColorController', name: 'SetColor' },
      endpoint: { endpointId: 'dev_001' },
      payload: { color: { hue: 120, saturation: 0.8, brightness: 1.0 } },
    };
    expect(extractStateFromDirective(directive)).toEqual({ hue: 120, saturation: 80 });
  });

  it('extracts SetColorTemperature', () => {
    const directive = {
      header: { namespace: 'Alexa.ColorTemperatureController', name: 'SetColorTemperature' },
      endpoint: { endpointId: 'dev_001' },
      payload: { colorTemperatureInKelvin: 4000 },
    };
    expect(extractStateFromDirective(directive)).toEqual({ colorTemperature: 4000 });
  });

  it('extracts Lock', () => {
    const directive = {
      header: { namespace: 'Alexa.LockController', name: 'Lock' },
      endpoint: { endpointId: 'dev_001' },
    };
    expect(extractStateFromDirective(directive)).toEqual({ locked: true });
  });

  it('extracts Unlock', () => {
    const directive = {
      header: { namespace: 'Alexa.LockController', name: 'Unlock' },
      endpoint: { endpointId: 'dev_001' },
    };
    expect(extractStateFromDirective(directive)).toEqual({ locked: false });
  });

  it('extracts SetTargetTemperature (Celsius)', () => {
    const directive = {
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature' },
      endpoint: { endpointId: 'dev_001' },
      payload: { targetSetpoint: { value: 22, scale: 'CELSIUS' } },
    };
    expect(extractStateFromDirective(directive)).toEqual({ targetTemperature: 22 });
  });

  it('extracts SetTargetTemperature (Fahrenheit converts to Celsius)', () => {
    const directive = {
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature' },
      endpoint: { endpointId: 'dev_001' },
      payload: { targetSetpoint: { value: 72, scale: 'FAHRENHEIT' } },
    };
    const result = extractStateFromDirective(directive);
    expect(result.targetTemperature).toBeCloseTo(22.2, 1);
  });

  it('extracts SetThermostatMode', () => {
    const directive = {
      header: { namespace: 'Alexa.ThermostatController', name: 'SetThermostatMode' },
      endpoint: { endpointId: 'dev_001' },
      payload: { thermostatMode: { value: 'HEAT' } },
    };
    expect(extractStateFromDirective(directive)).toEqual({ thermostatMode: 'heat' });
  });

  it('returns empty on malformed color payload (defensive — caller catches)', () => {
    const directive = {
      header: { namespace: 'Alexa.ColorController', name: 'SetColor' },
      endpoint: { endpointId: 'dev_001' },
      payload: {},  // missing `color`
    };
    // Should not throw; returning {} lets the upstream handler send a clean
    // ErrorResponse rather than a stack trace bubbling out.
    expect(() => extractStateFromDirective(directive)).not.toThrow();
    expect(extractStateFromDirective(directive)).toEqual({});
  });
});

describe('buildControlResponse', () => {
  it('builds valid Alexa.Response with context properties', () => {
    const state: DeviceState = { on: true, brightness: 75, colorTemperature: 4000 };
    const response = buildControlResponse('dev_001', 'corr-123', state);
    expect(response.event.header.namespace).toBe('Alexa');
    expect(response.event.header.name).toBe('Response');
    expect(response.event.header.correlationToken).toBe('corr-123');
    expect(response.event.endpoint.endpointId).toBe('dev_001');
    const propNames = response.context.properties.map((p: any) => `${p.namespace}.${p.name}`);
    expect(propNames).toContain('Alexa.PowerController.powerState');
    expect(propNames).toContain('Alexa.BrightnessController.brightness');
    expect(propNames).toContain('Alexa.ColorTemperatureController.colorTemperatureInKelvin');
  });
});

describe('buildStateReportResponse', () => {
  it('builds valid Alexa.StateReport', () => {
    const state: DeviceState = { on: false };
    const response = buildStateReportResponse('dev_001', 'corr-456', state);
    expect(response.event.header.name).toBe('StateReport');
    expect(response.event.endpoint.endpointId).toBe('dev_001');
    const connectivity = response.context.properties.find((p: any) => p.namespace === 'Alexa.EndpointHealth');
    expect(connectivity.value).toEqual({ value: 'OK' });
    const power = response.context.properties.find((p: any) => p.namespace === 'Alexa.PowerController');
    expect(power.value).toBe('OFF');
  });

  it('reports lockState when state.locked is set', () => {
    const response = buildStateReportResponse('dev_001', 'corr', { locked: true } as DeviceState);
    const lock = response.context.properties.find((p: any) => p.namespace === 'Alexa.LockController');
    expect(lock).toBeDefined();
    expect(lock.value).toBe('LOCKED');
  });

  it('reports thermostatMode + targetSetpoint when set', () => {
    const state: DeviceState = { thermostatMode: 'heat', targetTemperature: 21.5 };
    const response = buildStateReportResponse('dev_001', 'corr', state);
    const propsByNs = Object.fromEntries(
      response.context.properties.map((p: any) => [`${p.namespace}.${p.name}`, p]),
    );
    expect(propsByNs['Alexa.ThermostatController.thermostatMode'].value).toBe('HEAT');
    expect(propsByNs['Alexa.ThermostatController.targetSetpoint'].value).toEqual({ value: 21.5, scale: 'CELSIUS' });
  });
});
