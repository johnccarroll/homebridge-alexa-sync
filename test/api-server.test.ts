import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { ApiServer } from '../src/api-server.js';
import type { DeviceManager } from '../src/device-manager.js';
import type { BridgeDevice } from '../src/types.js';

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
  model: 'prod_1',
};

function mockDeviceManager(): DeviceManager {
  return {
    getAllDevices: vi.fn().mockReturnValue([LIGHT]),
    getDevice: vi.fn((id: string) => id === 'tuya:dev_001' ? LIGHT : undefined),
    getState: vi.fn().mockResolvedValue({ on: true, brightness: 75, hue: 0, saturation: 0, colorTemperature: 4000 }),
    setState: vi.fn().mockResolvedValue(undefined),
    discoverAll: vi.fn().mockResolvedValue([LIGHT]),
    invalidateCache: vi.fn(),
    dispose: vi.fn(),
    onStateChange: vi.fn(),
  } as unknown as DeviceManager;
}

describe('ApiServer', () => {
  let server: ApiServer;
  let dm: DeviceManager;
  const PORT = 19090;

  beforeAll(async () => {
    dm = mockDeviceManager();
    server = new ApiServer(dm, { port: PORT, apiKey: 'test-key' });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('rejects requests without API key', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/devices`);
    expect(res.status).toBe(401);
  });

  it('GET /devices returns all devices', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/devices`, {
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tuya:dev_001');
  });

  it('GET /devices/:id/state returns device state', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/devices/tuya:dev_001/state`, {
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.on).toBe(true);
    expect(data.brightness).toBe(75);
  });

  it('PUT /devices/:id/state sets device state', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/devices/tuya:dev_001/state`, {
      method: 'PUT',
      headers: { 'x-api-key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: false }),
    });
    expect(res.status).toBe(200);
    expect(dm.setState).toHaveBeenCalledWith('tuya:dev_001', { on: false });
  });

  it('returns 404 for unknown device', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/devices/unknown:123/state`, {
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.status).toBe(404);
  });
});
