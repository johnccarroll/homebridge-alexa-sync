import { describe, it, expect, vi } from 'vitest';
import { configureAccessory, updateAccessoryState } from '../src/accessory.js';
import type { BridgeDevice } from '../src/types.js';

const mockCharacteristic = () => ({
  onGet: vi.fn().mockReturnThis(),
  onSet: vi.fn().mockReturnThis(),
  updateValue: vi.fn().mockReturnThis(),
  setProps: vi.fn().mockReturnThis(),
});

function createMockService(name: string) {
  const chars = new Map<string, ReturnType<typeof mockCharacteristic>>();
  return {
    name,
    getCharacteristic: vi.fn((char: string) => {
      if (!chars.has(char)) chars.set(char, mockCharacteristic());
      return chars.get(char)!;
    }),
    setCharacteristic: vi.fn().mockReturnThis(),
    updateCharacteristic: vi.fn().mockReturnThis(),
  };
}

function createMockAccessory() {
  const services = new Map<string, ReturnType<typeof createMockService>>();
  return {
    getService: vi.fn((name: string) => services.get(name)),
    addService: vi.fn((name: string) => {
      const svc = createMockService(name);
      services.set(name, svc);
      return svc;
    }),
    context: {} as any,
  };
}

const Characteristic = {
  On: 'On',
  Brightness: 'Brightness',
  Hue: 'Hue',
  Saturation: 'Saturation',
  ColorTemperature: 'ColorTemperature',
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  OutletInUse: 'OutletInUse',
  RotationSpeed: 'RotationSpeed',
  LockCurrentState: 'LockCurrentState',
  LockTargetState: 'LockTargetState',
};

const Service = {
  Lightbulb: 'Lightbulb',
  AccessoryInformation: 'AccessoryInformation',
  Switch: 'Switch',
  Outlet: 'Outlet',
  Fan: 'Fan',
  LockMechanism: 'LockMechanism',
};

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

describe('configureAccessory', () => {
  it('creates Lightbulb service for light device', () => {
    const accessory = createMockAccessory();
    const getState = vi.fn().mockResolvedValue({ on: true });
    const setState = vi.fn().mockResolvedValue(undefined);

    configureAccessory(accessory as any, LIGHT, { Service, Characteristic } as any, getState, setState);
    expect(accessory.addService).toHaveBeenCalledWith('Lightbulb');
  });

  it('registers On, Brightness, Hue, Saturation, ColorTemperature for full light', () => {
    const accessory = createMockAccessory();
    configureAccessory(accessory as any, LIGHT, { Service, Characteristic } as any, vi.fn(), vi.fn());

    const service = accessory.addService.mock.results[0].value;
    const charNames = service.getCharacteristic.mock.calls.map((c: any) => c[0]);
    expect(charNames).toContain('On');
    expect(charNames).toContain('Brightness');
    expect(charNames).toContain('Hue');
    expect(charNames).toContain('Saturation');
    expect(charNames).toContain('ColorTemperature');
  });

  it('skips color characteristics for basic on-off light', () => {
    const basicLight: BridgeDevice = {
      ...LIGHT,
      capabilities: [{ type: 'on-off' }],
    };
    const accessory = createMockAccessory();
    configureAccessory(accessory as any, basicLight, { Service, Characteristic } as any, vi.fn(), vi.fn());

    const service = accessory.addService.mock.results[0].value;
    const charNames = service.getCharacteristic.mock.calls.map((c: any) => c[0]);
    expect(charNames).toContain('On');
    expect(charNames).not.toContain('Brightness');
    expect(charNames).not.toContain('Hue');
  });

  it('onGet resolves before HAP deadline even when getState hangs forever', async () => {
    vi.useFakeTimers();
    try {
      const accessory = createMockAccessory();
      const hung = new Promise<never>(() => { /* never settles */ });
      const getState = vi.fn().mockReturnValue(hung);
      const setState = vi.fn().mockResolvedValue(undefined);

      configureAccessory(
        accessory as any,
        LIGHT,
        { Service, Characteristic } as any,
        getState,
        setState,
        // no getCachedState → forces slow path
      );

      const service = accessory.addService.mock.results[0].value;
      const onGetHandler = service.getCharacteristic('Brightness').onGet.mock.calls[0][0];

      const pending = onGetHandler();
      await vi.advanceTimersByTimeAsync(4000);
      const result = await pending;

      // Falls back to the default in the handler: `state.brightness ?? 100`
      expect(result).toBe(100);
      expect(getState).toHaveBeenCalledWith(LIGHT.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression: SMARTPLUG / SWITCH / SMARTLOCK / FAN are all discovered by the
// mapper and registered as accessories, but before this they got no service at
// all beyond AccessoryInformation — they showed up in iOS Home as dead tiles.
describe('configureAccessory — non-light, non-thermostat types', () => {
  const base = (over: Partial<BridgeDevice>): BridgeDevice => ({
    id: 'alexa:x',
    name: 'Thing',
    type: 'switch',
    provider: 'alexa',
    capabilities: [{ type: 'on-off' }],
    ...over,
  });

  it('creates a Switch service with On for a switch', async () => {
    const accessory = createMockAccessory();
    const getState = vi.fn().mockResolvedValue({ on: true });
    const setState = vi.fn().mockResolvedValue(undefined);
    const device = base({ type: 'switch' });

    configureAccessory(accessory as any, device, { Service, Characteristic } as any,
      getState, setState, () => ({ on: true }));

    expect(accessory.addService).toHaveBeenCalledWith('Switch');
    const svc = accessory.addService.mock.results[0].value;
    expect(svc.getCharacteristic.mock.calls.map((c: any) => c[0])).toContain('On');

    const onGet = svc.getCharacteristic('On').onGet.mock.calls[0][0];
    expect(await onGet()).toBe(true);

    const onSet = svc.getCharacteristic('On').onSet.mock.calls[0][0];
    await onSet(false);
    expect(setState).toHaveBeenCalledWith(device.id, { on: false });
  });

  it('creates an Outlet service with On + OutletInUse for an outlet', () => {
    const accessory = createMockAccessory();
    const device = base({ type: 'outlet' });
    configureAccessory(accessory as any, device, { Service, Characteristic } as any,
      vi.fn().mockResolvedValue({}), vi.fn());

    expect(accessory.addService).toHaveBeenCalledWith('Outlet');
    const names = accessory.addService.mock.results[0].value
      .getCharacteristic.mock.calls.map((c: any) => c[0]);
    expect(names).toContain('On');
    expect(names).toContain('OutletInUse');
  });

  it('creates a Fan service, adding RotationSpeed only when brightness exists', () => {
    const plain = createMockAccessory();
    configureAccessory(plain as any, base({ type: 'fan' }), { Service, Characteristic } as any,
      vi.fn().mockResolvedValue({}), vi.fn());
    expect(plain.addService).toHaveBeenCalledWith('Fan');
    expect(plain.addService.mock.results[0].value.getCharacteristic.mock.calls
      .map((c: any) => c[0])).not.toContain('RotationSpeed');

    const withSpeed = createMockAccessory();
    configureAccessory(
      withSpeed as any,
      base({ type: 'fan', capabilities: [{ type: 'on-off' }, { type: 'brightness', range: [0, 100] }] }),
      { Service, Characteristic } as any, vi.fn().mockResolvedValue({}), vi.fn(),
    );
    expect(withSpeed.addService.mock.results[0].value.getCharacteristic.mock.calls
      .map((c: any) => c[0])).toContain('RotationSpeed');
  });

  it('creates a LockMechanism mapping locked→SECURED(1)/unlocked→UNSECURED(0)', async () => {
    const accessory = createMockAccessory();
    const setState = vi.fn().mockResolvedValue(undefined);
    const device = base({ type: 'lock', capabilities: [{ type: 'lock' }] });

    configureAccessory(accessory as any, device, { Service, Characteristic } as any,
      vi.fn().mockResolvedValue({ locked: true }), setState, () => ({ locked: true }));

    expect(accessory.addService).toHaveBeenCalledWith('LockMechanism');
    const svc = accessory.addService.mock.results[0].value;

    const currentGet = svc.getCharacteristic('LockCurrentState').onGet.mock.calls[0][0];
    expect(await currentGet()).toBe(1);

    const targetSet = svc.getCharacteristic('LockTargetState').onSet.mock.calls[0][0];
    await targetSet(0);
    expect(setState).toHaveBeenCalledWith(device.id, { locked: false });
  });

  it('reports UNKNOWN(3) for a lock whose state has never been read', async () => {
    const accessory = createMockAccessory();
    configureAccessory(
      accessory as any, base({ type: 'lock', capabilities: [{ type: 'lock' }] }),
      { Service, Characteristic } as any, vi.fn().mockResolvedValue({}), vi.fn(), () => ({}),
    );
    const svc = accessory.addService.mock.results[0].value;
    const currentGet = svc.getCharacteristic('LockCurrentState').onGet.mock.calls[0][0];
    expect(await currentGet()).toBe(3);
  });
});

describe('updateAccessoryState — non-light, non-thermostat types', () => {
  it('pushes On to Switch/Outlet/Fan and lock state to LockMechanism', () => {
    const cases: Array<[BridgeDevice['type'], string]> = [
      ['switch', 'Switch'], ['outlet', 'Outlet'], ['fan', 'Fan'],
    ];
    for (const [type, serviceName] of cases) {
      const accessory = createMockAccessory();
      const device: BridgeDevice = {
        id: 'alexa:x', name: 'T', type, provider: 'alexa', capabilities: [{ type: 'on-off' }],
      };
      configureAccessory(accessory as any, device, { Service, Characteristic } as any,
        vi.fn().mockResolvedValue({}), vi.fn());
      const svc = accessory.addService.mock.results[0].value;

      expect(accessory.addService).toHaveBeenCalledWith(serviceName);
      updateAccessoryState(accessory as any, device, { on: true }, { Service, Characteristic } as any);
      expect(svc.updateCharacteristic).toHaveBeenCalledWith('On', true);
    }

    const accessory = createMockAccessory();
    const lock: BridgeDevice = {
      id: 'alexa:l', name: 'L', type: 'lock', provider: 'alexa', capabilities: [{ type: 'lock' }],
    };
    configureAccessory(accessory as any, lock, { Service, Characteristic } as any,
      vi.fn().mockResolvedValue({}), vi.fn());
    const svc = accessory.addService.mock.results[0].value;

    updateAccessoryState(accessory as any, lock, { locked: true }, { Service, Characteristic } as any);
    expect(svc.updateCharacteristic).toHaveBeenCalledWith('LockCurrentState', 1);
    expect(svc.updateCharacteristic).toHaveBeenCalledWith('LockTargetState', 1);
  });
});
