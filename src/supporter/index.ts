import type { Logger } from 'homebridge';
import type { SupporterConfig } from '../config.js';
import { loadTrialState, TRIAL_DAYS_CONST } from './trial.js';
import { verifySupporterToken, type SupporterClaims } from './verify.js';

export type SupporterMode = 'supporter' | 'trial' | 'expired';

export interface SupporterState {
  mode: SupporterMode;
  /** When true, the plugin is allowed to register + control devices. */
  devicesAllowed: boolean;
  daysRemaining?: number;
  claims?: SupporterClaims;
}

const SPONSOR_URL = 'https://github.com/sponsors/johnccarroll';
const LICENSE_URL = 'https://hb.johncarroll.dev/';

/** Determine whether the user is a supporter, on free trial, or expired,
 *  and whether devices should be registered. Non-blocking: every failure
 *  falls back to the safest mode for the user + logs a clear CTA.
 *
 *  - Valid supporter JWT → `supporter` mode, devices allowed forever.
 *  - No JWT, trial day 1–14 → `trial` mode, devices allowed.
 *  - No JWT, trial day 15+ → `expired` mode, devices NOT allowed.
 */
export function loadSupporterState(
  config: SupporterConfig | undefined,
  storagePath: string,
  pluginVersion: string,
  log: Logger,
): SupporterState {
  // 1. Try supporter JWT first — always valid if present.
  if (config?.token) {
    const result = verifySupporterToken(config.token);
    if (result.ok) {
      const { sub, tier, exp } = result.claims;
      const daysLeft = Math.max(0, Math.floor((exp - Date.now() / 1000) / 86400));
      log.info(
        `Supporter mode enabled — thanks, ${sub.replace(/^github:/, '@')}! ` +
          `Tier $${tier}/mo, ${daysLeft} days until token refresh.`,
      );
      return { mode: 'supporter', devicesAllowed: true, claims: result.claims };
    }
    log.warn(
      `Supporter token rejected (${result.reason}). Falling back to trial/free mode. ` +
        `Get a fresh token at ${LICENSE_URL}`,
    );
  }

  // 2. Fall back to trial state.
  const trial = loadTrialState(storagePath, pluginVersion);
  if (!trial.expired) {
    log.info(
      `Free trial: ${trial.daysRemaining} day(s) remaining ` +
        `(of ${TRIAL_DAYS_CONST}). Sponsor at ${SPONSOR_URL} before ` +
        `trial ends to keep controlling devices.`,
    );
    return { mode: 'trial', devicesAllowed: true, daysRemaining: trial.daysRemaining };
  }

  // 3. Expired.
  log.warn('========================================================');
  log.warn(`  Free trial expired (${trial.daysElapsed} days elapsed).`);
  log.warn('  Devices will not be registered until a supporter token is provided.');
  log.warn('');
  log.warn(`  1. Sponsor at ${SPONSOR_URL} ($3/mo, cancel anytime)`);
  log.warn(`  2. Get your token at ${LICENSE_URL}`);
  log.warn('  3. Paste into your Homebridge config.json under');
  log.warn('       "supporter": { "token": "eyJ..." }');
  log.warn('  4. Restart Homebridge.');
  log.warn('');
  log.warn('  Plugin is MIT-licensed — free to fork if the trial model');
  log.warn('  does not work for you.');
  log.warn('========================================================');
  return { mode: 'expired', devicesAllowed: false };
}
