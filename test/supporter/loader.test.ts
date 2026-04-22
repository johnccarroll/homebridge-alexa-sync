import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSupporterState, type SupporterState } from '../../src/supporter/index.js';

function mockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
}

describe('loadSupporterState', () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'hb-trial-'));
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('enters trial mode on first run (no config, no marker file)', () => {
    const log = mockLogger();
    const s: SupporterState = loadSupporterState(
      undefined,
      storagePath,
      '0.1.0',
      log as unknown as any,
    );
    expect(s.mode).toBe('trial');
    expect(s.devicesAllowed).toBe(true);
    expect(s.daysRemaining).toBe(14);
    // Marker file should now exist
    expect(existsSync(join(storagePath, '.alexa-bridge-trial.json'))).toBe(true);
  });

  it('stays in trial mode on second run within the window', () => {
    const log1 = mockLogger();
    loadSupporterState(undefined, storagePath, '0.1.0', log1 as unknown as any);
    const log2 = mockLogger();
    const s = loadSupporterState(undefined, storagePath, '0.1.0', log2 as unknown as any);
    expect(s.mode).toBe('trial');
    expect(s.daysRemaining).toBe(14);
  });

  it('enters expired mode after the 14-day window', () => {
    const oldFirstRun = Math.floor(Date.now() / 1000) - 15 * 86400;
    writeFileSync(
      join(storagePath, '.alexa-bridge-trial.json'),
      JSON.stringify({ firstRunAt: oldFirstRun, pluginVersion: '0.1.0' }),
    );
    const log = mockLogger();
    const s = loadSupporterState(undefined, storagePath, '0.1.0', log as unknown as any);
    expect(s.mode).toBe('expired');
    expect(s.devicesAllowed).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it('warns + stays in trial when supporter token is malformed', () => {
    const log = mockLogger();
    const s = loadSupporterState(
      { token: 'garbage' },
      storagePath,
      '0.1.0',
      log as unknown as any,
    );
    expect(s.mode).toBe('trial');
    expect(log.warn.mock.calls[0][0]).toMatch(/Supporter token rejected/);
  });

  it('empty token is treated as no token', () => {
    const log = mockLogger();
    const s = loadSupporterState({ token: '' }, storagePath, '0.1.0', log as unknown as any);
    expect(s.mode).toBe('trial');
  });

  it('never throws — all failures produce a valid state', () => {
    const log = mockLogger();
    for (const bogus of ['x.y.z', 'eyJ.eyJ.badsig', '....', 'not a jwt']) {
      expect(() =>
        loadSupporterState({ token: bogus }, storagePath, '0.1.0', log as unknown as any),
      ).not.toThrow();
    }
  });

  it('malformed trial marker file is treated as first run', () => {
    writeFileSync(join(storagePath, '.alexa-bridge-trial.json'), 'not json at all');
    const log = mockLogger();
    const s = loadSupporterState(undefined, storagePath, '0.1.0', log as unknown as any);
    expect(s.mode).toBe('trial');
    expect(s.daysRemaining).toBe(14);
    // The malformed file should have been replaced
    const contents = JSON.parse(
      readFileSync(join(storagePath, '.alexa-bridge-trial.json'), 'utf8'),
    );
    expect(typeof contents.firstRunAt).toBe('number');
  });
});
