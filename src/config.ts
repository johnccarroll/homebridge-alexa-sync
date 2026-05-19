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
