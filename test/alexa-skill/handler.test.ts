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
    getCachedState: vi.fn().mockReturnValue({ on: true, brightness: 75, colorTemperature: 4000 }),
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

  it('ReportState never calls dm.getState — prevents the Alexa-skill query loop', async () => {
    // When the plugin is reached via a self-hosted Alexa Smart Home Skill
    // Lambda, calling dm.getState here would re-query the same Alexa graph
    // that asked us — infinite loop, terminated only by Alexa's 8s deadline
    // as ENDPOINT_UNREACHABLE. The handler must answer from the local cache.
    const dm = mockDM();
    const directive = {
      directive: {
        header: { namespace: 'Alexa', name: 'ReportState', correlationToken: 'corr', messageId: 'msg-loop' },
        endpoint: { endpointId: 'tuya:dev_001' },
      },
    };
    const response = await handleAlexaDirective(directive, dm);
    expect(dm.getState).not.toHaveBeenCalled();
    expect(dm.getCachedState).toHaveBeenCalledWith('tuya:dev_001');
    expect(response.event.header.name).toBe('StateReport');
  });

  it('post-control state read does not call dm.getState — same loop prevention applies', async () => {
    // After a setState the cache has the optimistic merged state. Re-querying
    // the provider risks the same loop on Alexa-discovered devices.
    const dm = mockDM();
    const directive = {
      directive: {
        header: { namespace: 'Alexa.PowerController', name: 'TurnOn', correlationToken: 'corr', messageId: 'msg-loop-2' },
        endpoint: { endpointId: 'tuya:dev_001' },
      },
    };
    await handleAlexaDirective(directive, dm);
    expect(dm.getState).not.toHaveBeenCalled();
  });

  it('ReportState falls back to empty state when cache is cold', async () => {
    const dm = mockDM();
    (dm.getCachedState as any).mockReturnValue(undefined);
    const directive = {
      directive: {
        header: { namespace: 'Alexa', name: 'ReportState', correlationToken: 'corr', messageId: 'msg-cold' },
        endpoint: { endpointId: 'tuya:dev_001' },
      },
    };
    const response = await handleAlexaDirective(directive, dm);
    // Should still respond with a StateReport (Alexa requires *some* response
    // within 8s) — empty properties is honest about the missing data and
    // doesn't trigger ENDPOINT_UNREACHABLE retry storms.
    expect(response.event.header.name).toBe('StateReport');
    expect(dm.getState).not.toHaveBeenCalled();
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
