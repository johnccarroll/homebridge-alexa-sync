import { describe, it, expect } from 'vitest';
import { resideoToBridgeDevice, resideoToState, stateToResideoChanges } from '../../../src/providers/resideo/mapper.js';
import type { ResideoThermostat } from '../../../src/providers/resideo/api.js';

const THERMOSTAT: ResideoThermostat = {
  deviceID: 'LCC-ABC123',
  name: 'Living Room',
  deviceModel: 'T6-T10',
  indoorTemperature: 72,
  indoorHumidity: 45,
  units: 'Fahrenheit',
  changeableValues: {
    mode: 'Heat',
    heatSetpoint: 70,
    coolSetpoint: 78,
    thermostatSetpointStatus: 'PermanentHold',
  },
};

describe('resideoToBridgeDevice', () => {
  it('maps thermostat to BridgeDevice', () => {
    const device = resideoToBridgeDevice({ thermostat: THERMOSTAT, locationId: 12345 });
    expect(device.id).toBe('resideo:LCC-ABC123');
    expect(device.name).toBe('Living Room');
    expect(device.type).toBe('thermostat');
    expect(device.provider).toBe('resideo');
    expect(device.manufacturer).toBe('Honeywell');
    expect(device.capabilities.map(c => c.type)).toEqual(
      expect.arrayContaining(['temperature', 'target-temperature', 'thermostat-mode']),
    );
  });
});

describe('resideoToState', () => {
  it('maps Fahrenheit thermostat to DeviceState in Celsius', () => {
    const state = resideoToState(THERMOSTAT);
    expect(state.temperature).toBeCloseTo(22.2, 1); // 72F = 22.2C
    expect(state.targetTemperature).toBeCloseTo(21.1, 1); // 70F = 21.1C
    expect(state.thermostatMode).toBe('heat');
  });

  it('maps Celsius thermostat directly', () => {
    const celsius: ResideoThermostat = {
      ...THERMOSTAT,
      units: 'Celsius',
      indoorTemperature: 22,
      changeableValues: { ...THERMOSTAT.changeableValues, heatSetpoint: 21 },
    };
    const state = resideoToState(celsius);
    expect(state.temperature).toBe(22);
    expect(state.targetTemperature).toBe(21);
  });
});

describe('stateToResideoChanges', () => {
  it('generates mode change', () => {
    const changes = stateToResideoChanges({ thermostatMode: 'cool' }, 'Fahrenheit');
    expect(changes.mode).toBe('Cool');
  });

  it('generates temperature change in Fahrenheit', () => {
    const changes = stateToResideoChanges({ targetTemperature: 22 }, 'Fahrenheit');
    expect(changes.heatSetpoint).toBe(72); // 22C = 71.6F, rounded to 72
    expect(changes.coolSetpoint).toBe(72);
    expect(changes.thermostatSetpointStatus).toBe('PermanentHold');
  });

  it('generates temperature change in Celsius', () => {
    const changes = stateToResideoChanges({ targetTemperature: 21 }, 'Celsius');
    expect(changes.heatSetpoint).toBe(21);
  });

  it('returns empty for empty state', () => {
    expect(stateToResideoChanges({}, 'Fahrenheit')).toEqual({});
  });
});
