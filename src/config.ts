export interface AlexaConfig {
  amazonDomain?: string;
  pollInterval?: number;
  cookieRefreshDays?: number;
  deviceTypes?: string[];
}

export interface PluginConfig {
  name: string;
  providers?: {
    alexa?: AlexaConfig;
  };
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
/** Both names for the managed-cloud voice path, retired in 0.3.0. Anyone who
 *  had one configured loses voice control of Homebridge-only accessories, so
 *  say that outright rather than ignoring the key in silence. */
const REMOVED_CLOUD = ['cloud', 'supporter'] as const;

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
  for (const key of REMOVED_CLOUD) {
    if (config[key] !== undefined) {
      warnings.push(
        `Config key \`${key}\` was removed in 0.3.0 and is now ignored. The `
        + 'managed cloud that provided Alexa voice control for Homebridge-only '
        + 'accessories has been retired. Mirroring your Alexa devices into '
        + 'HomeKit is unaffected and needs no token — you can delete this key.',
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
