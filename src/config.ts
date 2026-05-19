export interface AlexaConfig {
  amazonDomain?: string;
  pollInterval?: number;
  cookieRefreshDays?: number;
  deviceTypes?: string[];
}

export interface SupporterConfig {
  /** JWT issued by cloud.johncarroll.dev after a GitHub Sponsors check.
   *  Verified offline with an embedded Ed25519 public key — the plugin
   *  makes no network call to verify. Absence of this field (or verification
   *  failure) = free mode with full plugin functionality. */
  token?: string;
}

export interface PluginConfig {
  name: string;
  providers?: {
    alexa?: AlexaConfig;
  };
  supporter?: SupporterConfig;
}

export function validateConfig(config: Record<string, unknown>): config is PluginConfig & Record<string, unknown> {
  if (!config.name || typeof config.name !== 'string') return false;
  const providers = config.providers as Record<string, unknown> | undefined;
  if (!providers) return true;

  const alexa = providers.alexa as Record<string, unknown> | undefined;
  if (alexa) {
    if (alexa.pollInterval !== undefined && typeof alexa.pollInterval !== 'number') return false;
  }
  return true;
}

/**
 * Surface 0.1.x config keys that were removed in 0.2.0 so upgraders don't
 * silently lose functionality. Returns one human-readable warning per stale
 * key found; platform.init() logs each at warn level.
 */
const REMOVED_TOP_LEVEL = ['alexaSkill', 'apiServer'] as const;
const REMOVED_PROVIDERS = ['tuya', 'resideo'] as const;

export function describeRemovedKeys(config: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const key of REMOVED_TOP_LEVEL) {
    if (config[key] !== undefined) {
      warnings.push(
        `Config key \`${key}\` was removed in 0.2.0 and is now ignored. ` +
        'See the README for current setup.',
      );
    }
  }
  const providers = config.providers as Record<string, unknown> | undefined;
  if (providers) {
    for (const key of REMOVED_PROVIDERS) {
      if (providers[key] !== undefined) {
        warnings.push(
          `Provider \`providers.${key}\` was removed in 0.2.0 and is now ignored. ` +
          'If you need those devices in HomeKit, link them to Alexa via their ' +
          'native skill and they will appear through the alexa provider here.',
        );
      }
    }
  }
  return warnings;
}
