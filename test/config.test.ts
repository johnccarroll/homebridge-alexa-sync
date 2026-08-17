import { describe, it, expect } from 'vitest';
import { describeRemovedKeys, validateConfig } from '../src/config.js';

describe('validateConfig', () => {
  it('requires a name', () => {
    expect(validateConfig({})).toBe(false);
    expect(validateConfig({ name: 'Alexa Sync' })).toBe(true);
  });

  it('rejects a non-numeric pollInterval', () => {
    expect(validateConfig({
      name: 'x', providers: { alexa: { pollInterval: '60' } },
    })).toBe(false);
  });

  // The managed cloud was retired in 0.3.0. Anyone who had it configured is
  // losing a feature, so the key must produce a warning rather than being
  // ignored in silence — that's the difference between "this changed" and
  // "voice control mysteriously stopped working".
  it('warns about the retired cloud keys under both names', () => {
    for (const key of ['cloud', 'supporter']) {
      const warnings = describeRemovedKeys({ name: 'x', [key]: { token: 'abc' } });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`\`${key}\``);
      expect(warnings[0]).toMatch(/retired/);
      // Must reassure that the main feature is unaffected.
      expect(warnings[0]).toMatch(/unaffected/);
    }
  });

  it('still warns about the 0.2.0 removals', () => {
    expect(describeRemovedKeys({ name: 'x', alexaSkill: {} })[0]).toMatch(/alexaSkill/);
    expect(describeRemovedKeys({ name: 'x', providers: { tuya: {} } })[0]).toMatch(/tuya/);
  });

  it('says nothing for a clean config', () => {
    expect(describeRemovedKeys({
      name: 'x', providers: { alexa: { pollInterval: 60 } },
    })).toEqual([]);
  });
});
