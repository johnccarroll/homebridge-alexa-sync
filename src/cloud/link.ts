import type { Logger } from 'homebridge';
import type { CloudConfig } from '../config.js';
import { verifyLinkToken, type LinkClaims } from './verify-token.js';

export interface CloudLink {
  enabled: boolean;
  claims?: LinkClaims;
}

const LINK_URL = 'https://cloud.johncarroll.dev/switchboard';

/** Inspect the plugin's `cloud` config block, verify the link token offline,
 *  and log the outcome.
 *
 *  The cloud is entirely optional: it exists so Homebridge accessories that
 *  aren't already in your Alexa account can be voice-controlled. Devices that
 *  are already Alexa-linked are voice-controllable through Alexa's own skill
 *  and need none of this.
 *
 *  Non-blocking by construction: a missing, malformed, or expired token
 *  disables the cloud and nothing else. Must never throw and must never skip
 *  device registration — local mirroring works regardless.
 */
export function loadCloudLink(
  config: CloudConfig | undefined,
  log: Logger,
): CloudLink {
  if (!config?.token) {
    return { enabled: false };
  }

  const result = verifyLinkToken(config.token);
  if (!result.ok) {
    log.warn(
      `Cloud link token rejected (${result.reason}). Continuing with local `
      + `Alexa-to-HomeKit mirroring only. Re-link at ${LINK_URL}`,
    );
    return { enabled: false };
  }

  const { sub, exp } = result.claims;
  const daysLeft = Math.max(0, Math.floor((exp - Date.now() / 1000) / 86400));
  log.info(
    `Cloud link active for ${sub.replace(/^github:/, '@')} — `
    + `${daysLeft} days until the token needs refreshing.`,
  );
  return { enabled: true, claims: result.claims };
}
