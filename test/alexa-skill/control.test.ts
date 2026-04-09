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
    expect(response.context.properties[0].value).toBe('OFF');
  });
});
