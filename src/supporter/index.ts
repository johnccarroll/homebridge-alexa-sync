import type { Logger } from 'homebridge';
import type { SupporterConfig } from '../config.js';
import { verifySupporterToken, type SupporterClaims } from './verify.js';

export interface SupporterState {
  active: boolean;
  claims?: SupporterClaims;
}

/** Inspect the plugin's `supporter` config block, verify the JWT offline,
 *  and log the outcome. Returns a small state object that other parts of
 *  the plugin can consult to gate supporter-only features.
 *
 *  Behavior is intentionally non-blocking: malformed / expired / missing
 *  tokens fall back to free mode silently (with a warn log). The plugin
 *  must NEVER crash because of a supporter-config issue.
 */
export function loadSupporterState(
  config: SupporterConfig | undefined,
  log: Logger,
): SupporterState {
  if (!config || !config.token) {
    return { active: false };
  }

  const result = verifySupporterToken(config.token);
  if (!result.ok) {
    log.warn(
      `Supporter token rejected (${result.reason}). Running in free mode. ` +
        `Get a fresh token at https://sponsors.hb-alexa.dev/`,
    );
    return { active: false };
  }

  const { sub, tier, exp } = result.claims;
  const daysLeft = Math.max(0, Math.floor((exp - Date.now() / 1000) / 86400));
  log.info(
    `Supporter mode enabled — thanks, ${sub.replace(/^github:/, '@')}! ` +
      `Tier $${tier}/mo, ${daysLeft} days until token refresh.`,
  );
  return { active: true, claims: result.claims };
}
