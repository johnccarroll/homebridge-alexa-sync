import type { Logger } from 'homebridge';
import type { SupporterConfig } from '../config.js';
import { verifySupporterToken, type SupporterClaims } from './verify.js';

export type SupporterMode = 'supporter' | 'free';

export interface SupporterState {
  mode: SupporterMode;
  claims?: SupporterClaims;
}

const LICENSE_URL = 'https://cloud.johncarroll.dev/homebridge-alexa-bridge';

/** Inspect the plugin's `supporter` config block, verify the JWT offline,
 *  and log the outcome. Returns a small state object; the plugin always
 *  registers + controls devices locally regardless of supporter status.
 *
 *  Non-blocking: a missing, malformed, or expired token falls back to
 *  `free` mode silently (with a warn log for expired/malformed). Must
 *  never throw and must never skip device registration.
 */
export function loadSupporterState(
  config: SupporterConfig | undefined,
  log: Logger,
): SupporterState {
  if (!config?.token) {
    return { mode: 'free' };
  }

  const result = verifySupporterToken(config.token);
  if (!result.ok) {
    log.warn(
      `Supporter token rejected (${result.reason}). Running in free mode. ` +
        `Get a fresh token at ${LICENSE_URL}`,
    );
    return { mode: 'free' };
  }

  const { sub, tier, exp } = result.claims;
  const daysLeft = Math.max(0, Math.floor((exp - Date.now() / 1000) / 86400));
  log.info(
    `Supporter mode enabled — thanks, ${sub.replace(/^github:/, '@')}! ` +
      `Tier $${tier}/mo, ${daysLeft} days until token refresh.`,
  );
  return { mode: 'supporter', claims: result.claims };
}
