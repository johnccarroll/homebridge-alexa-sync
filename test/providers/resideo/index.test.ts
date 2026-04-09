import { describe, it, expect, vi } from 'vitest';
import { ResideoProvider } from '../../../src/providers/resideo/index.js';
import type { ResideoApi } from '../../../src/providers/resideo/api.js';

function mockApi(): ResideoApi {
  return {
    getLocations: vi.fn().mockResolvedValue([{
      locationID: 12345,
      name: 'Home',
      devices: [{
        deviceID: 'LCC-ABC123',
        name: 'Living Room',
        deviceModel: 'T6',
        indoorTemperature: 72,
        indoorHumidity: 45,
        units: 'Fahrenheit',
        changeableValues: {
          mode: 'Heat',
          heatSetpoint: 70,
          coolSetpoint: 78,
          thermostatSetpointStatus: 'PermanentHold',
        },
      }],
    }]),
    getThermostat: vi.fn().mockResolvedValue({
      deviceID: 'LCC-ABC123',
      name: 'Living Room',
      deviceModel: 'T6',
      indoorTemperature: 72,
      indoorHumidity: 45,
      units: 'Fahrenheit',
      changeableValues: {
        mode: 'Heat',
        heatSetpoint: 70,
        coolSetpoint: 78,
        thermostatSetpointStatus: 'PermanentHold',
      },
    }),
    setThermostat: vi.fn().mockResolvedValue(undefined),
    refreshAccessToken: vi.fn(),
    getRefreshToken: vi.fn().mockReturnValue('tok'),
  } as unknown as ResideoApi;
}

describe('ResideoProvider', () => {
  it('has id "resideo"', () => {
    const provider = new ResideoProvider(mockApi());
    expect(provider.id).toBe('resideo');
  });

  it('discovers thermostats from locations', async () => {
    const provider = new ResideoProvider(mockApi());
    const devices = await provider.discover();
    expect(devices).toHaveLength(1);
    expect(devices[0].type).toBe('thermostat');
    expect(devices[0].name).toBe('Living Room');
  });

  it('gets thermostat state', async () => {
    const api = mockApi();
    const provider = new ResideoProvider(api);
    await provider.discover();
    const state = await provider.getState('LCC-ABC123');
    expect(state.thermostatMode).toBe('heat');
    expect(state.temperature).toBeCloseTo(22.2, 1);
  });

  it('sets thermostat state', async () => {
    const api = mockApi();
    const provider = new ResideoProvider(api);
    await provider.discover();
    await provider.setState('LCC-ABC123', { thermostatMode: 'cool' });
    expect(api.setThermostat).toHaveBeenCalledWith('LCC-ABC123', 12345, { mode: 'Cool' });
  });
});
