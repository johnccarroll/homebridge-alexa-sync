import { describe, it, expect, vi } from 'vitest';
import { loadSupporterState } from '../../src/supporter/index.js';

function mockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  } as const;
}

describe('loadSupporterState', () => {
  it('returns inactive when no config provided', () => {
    const log = mockLogger();
    const s = loadSupporterState(undefined, log as unknown as any);
    expect(s.active).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns inactive when token is empty string', () => {
    const log = mockLogger();
    const s = loadSupporterState({ token: '' }, log as unknown as any);
    expect(s.active).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns + stays inactive when token is malformed', () => {
    const log = mockLogger();
    const s = loadSupporterState({ token: 'garbage' }, log as unknown as any);
    expect(s.active).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).toMatch(/Supporter token rejected/);
  });

  it('never throws — all failures fall back to free mode', () => {
    const log = mockLogger();
    for (const bogus of [
      'x.y.z',
      'eyJ.eyJ.badsig',
      '....',
      'not a jwt at all',
    ]) {
      expect(() =>
        loadSupporterState({ token: bogus }, log as unknown as any),
      ).not.toThrow();
    }
  });
});
