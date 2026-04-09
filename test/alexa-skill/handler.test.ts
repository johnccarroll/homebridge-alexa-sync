import { describe, it, expect, vi } from 'vitest';
import { handleAlexaDirective } from '../../src/alexa-skill/handler.js';
import type { DeviceManager } from '../../src/device-manager.js';
import type { BridgeDevice } from '../../src/types.js';

const LIGHT: BridgeDevice = {
  id: 'tuya:dev_001',
  name: 'Kitchen Light',
  type: 'light',
  provider: 'tuya',
  capabilities: [
    { type: 'on-off' },
    { type: 'brightness', range: [0, 100] },
    { type: 'color' },
    { type: 'color-temperature', range: [2700, 6500] },
  ],
  manufacturer: 'Tuya',
};

function mockDM(): DeviceManager {
  return {
    getAllDevices: vi.fn().mockReturnValue([LIGHT]),
    getDevice: vi.fn().mockReturnValue(LIGHT),
    getState: vi.fn().mockResolvedValue({ on: true, brightness: 75, colorTemperature: 4000 }),
    setState: vi.fn().mockResolvedValue(undefined),
  } as unknown as DeviceManager;
}

describe('handleAlexaDirective', () => {
  it('handles Discovery', async () => {
    const dm = mockDM();
    const directive = {
      directive: {
        header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'msg-1' },
        payload: { scope: { type: 'BearerToken', token: 'tok' } },
      },
    };
    const response = await handleAlexaDirective(directive, dm);
    expect(response.event.header.name).toBe('Discover.Response');
    expect(response.event.payload.endpoints).toHaveLength(1);
  });

  it('handles TurnOn', async () => {
    const dm = mockDM();
    const directive = {
      directive: {
        header: { namespace: 'Alexa.PowerController', name: 'TurnOn', correlationToken: 'corr-1', messageId: 'msg-2' },
        endpoint: { endpointId: 'tuya:dev_001' },
      },
    };
    const response = await handleAlexaDirective(directive, dm);
    expect(response.event.header.name).toBe('Response');
    expect(dm.setState).toHaveBeenCalledWith('tuya:dev_001', { on: true });
  });

  it('handles SetBrightness', async () => {
    const dm = mockDM();
    const directive = {
      directive: {
        header: { namespace: 'Alexa.BrightnessController', name: 'SetBrightness', correlationToken: 'corr-2', messageId: 'msg-3' },
        endpoint: { endpointId: 'tuya:dev_001' },
        payload: { brightness: 50 },
      },
    };
    const response = await handleAlexaDirective(directive, dm);
    expect(dm.setState).toHaveBeenCalledWith('tuya:dev_001', { brightness: 50 });
  });

  it('handles ReportState', async () => {
    const dm = mockDM();
    const directive = {
      directive: {
        header: { namespace: 'Alexa', name: 'ReportState', correlationToken: 'corr-3', messageId: 'msg-4' },
        endpoint: { endpointId: 'tuya:dev_001' },
      },
    };
    const response = await handleAlexaDirective(directive, dm);
    expect(response.event.header.name).toBe('StateReport');
    expect(response.context.properties.length).toBeGreaterThan(0);
  });

  it('returns ErrorResponse for unknown device', async () => {
    const dm = mockDM();
    (dm.getDevice as any).mockReturnValue(undefined);
    (dm.setState as any).mockRejectedValue(new Error('Unknown device'));
    const directive = {
      directive: {
        header: { namespace: 'Alexa.PowerController', name: 'TurnOn', correlationToken: 'corr-4', messageId: 'msg-5' },
        endpoint: { endpointId: 'unknown:123' },
      },
    };
    const response = await handleAlexaDirective(directive, dm);
    expect(response.event.header.name).toBe('ErrorResponse');
  });
});
