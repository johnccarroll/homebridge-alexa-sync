import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceManager } from '../src/device-manager.js';
import type { DeviceProvider } from '../src/providers/provider.js';
import type { BridgeDevice, DeviceState } from '../src/types.js';

function mockProvider(id: string, devices: BridgeDevice[]): DeviceProvider {
  return {
    id,
    discover: vi.fn().mockResolvedValue(devices),
    getState: vi.fn().mockResolvedValue({ on: true, brightness: 50 }),
    setState: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

const LIGHT: BridgeDevice = {
  id: 'tuya:dev_001',
  name: 'Kitchen Light',
  type: 'light',
  provider: 'tuya',
  capabilities: [{ type: 'on-off' }, { type: 'brightness', range: [0, 100] }],
};

describe('DeviceManager', () => {
  describe('discoverAll', () => {
    it('aggregates devices from all providers', async () => {
      const p1 = mockProvider('tuya', [LIGHT]);
      const p2 = mockProvider('resideo', [{
        ...LIGHT,
        id: 'resideo:therm_001',
        name: 'Thermostat',
        type: 'thermostat',
        provider: 'resideo',
      }]);

      const manager = new DeviceManager([p1, p2]);
      const devices = await manager.discoverAll();
      expect(devices).toHaveLength(2);
      expect(devices.map(d => d.provider)).toEqual(['tuya', 'resideo']);
    });

    // Replaces an older test that asserted cross-provider name dedupe with
    // tuya/resideo winning over alexa. Those providers were removed in 0.2, and
    // the surviving name dedupe silently merged distinct Alexa devices that
    // share a friendly name — Alexa permits "Lamp" in two different rooms.
    it('keeps distinct devices that share a friendly name', async () => {
      const lampA: BridgeDevice = {
        ...LIGHT, id: 'alexa:amzn1.endpoint.aaa', name: 'Lamp', provider: 'alexa',
      };
      const lampB: BridgeDevice = {
        ...LIGHT, id: 'alexa:amzn1.endpoint.bbb', name: 'Lamp', provider: 'alexa',
      };

      const manager = new DeviceManager([mockProvider('alexa', [lampA, lampB])]);
      const devices = await manager.discoverAll();

      expect(devices).toHaveLength(2);
      expect(devices.map(d => d.id).sort()).toEqual([
        'alexa:amzn1.endpoint.aaa',
        'alexa:amzn1.endpoint.bbb',
      ]);
    });

    it('collapses genuine duplicates that share a device id', async () => {
      const dupe: BridgeDevice = {
        ...LIGHT, id: 'alexa:amzn1.endpoint.aaa', name: 'Lamp', provider: 'alexa',
      };

      const manager = new DeviceManager([mockProvider('alexa', [dupe, { ...dupe }])]);
      expect(await manager.discoverAll()).toHaveLength(1);
    });

    it('handles provider discovery failure gracefully', async () => {
      const p1 = mockProvider('tuya', [LIGHT]);
      const p2: DeviceProvider = {
        id: 'broken',
        discover: vi.fn().mockRejectedValue(new Error('auth failed')),
        getState: vi.fn(),
        setState: vi.fn(),
        dispose: vi.fn(),
      };

      const manager = new DeviceManager([p1, p2]);
      const devices = await manager.discoverAll();
      expect(devices).toHaveLength(1);
    });

    it('logs provider discovery rejections via injected logger', async () => {
      const broken: DeviceProvider = {
        id: 'tuya',
        discover: vi.fn().mockRejectedValue(
          new Error('Your subscription to cloud development plan has expired.'),
        ),
        getState: vi.fn(),
        setState: vi.fn(),
        dispose: vi.fn(),
      };
      const warn = vi.fn();

      const manager = new DeviceManager([broken], 30_000, { warn });
      const devices = await manager.discoverAll();

      expect(devices).toHaveLength(0);
      expect(warn).toHaveBeenCalledOnce();
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('tuya');
      expect(msg).toContain('subscription');
    });
  });

  describe('getState', () => {
    it('routes to correct provider and caches result', async () => {
      const provider = mockProvider('tuya', [LIGHT]);
      const manager = new DeviceManager([provider]);
      await manager.discoverAll();

      const state = await manager.getState('tuya:dev_001');
      expect(state).toEqual({ on: true, brightness: 50 });
      expect(provider.getState).toHaveBeenCalledWith('dev_001');

      // Second call within cache TTL returns cached
      await manager.getState('tuya:dev_001');
      expect(provider.getState).toHaveBeenCalledTimes(1);
    });

    it('throws for unknown device', async () => {
      const manager = new DeviceManager([]);
      await expect(manager.getState('unknown:123')).rejects.toThrow('Unknown device');
    });
  });

  describe('setState', () => {
    it('routes to correct provider and updates cache', async () => {
      const provider = mockProvider('tuya', [LIGHT]);
      const manager = new DeviceManager([provider]);
      await manager.discoverAll();

      await manager.setState('tuya:dev_001', { on: false });
      // Provider receives the partial diff + the merged target so APIs that
      // replace state (Alexa setColor) can fill unchanged axes from the target.
      expect(provider.setState).toHaveBeenCalledWith(
        'dev_001',
        { on: false },
        expect.objectContaining({ on: false }),
      );
    });
  });

  describe('dispose', () => {
    it('disposes all providers', () => {
      const p1 = mockProvider('tuya', []);
      const p2 = mockProvider('resideo', []);
      const manager = new DeviceManager([p1, p2]);
      manager.dispose();
      expect(p1.dispose).toHaveBeenCalled();
      expect(p2.dispose).toHaveBeenCalled();
    });
  });
});
