export interface TuyaConfig {
  accessId: string;
  accessKey: string;
  region: 'us' | 'eu' | 'cn' | 'in';
  pollInterval?: number;
  localKeys?: Record<string, string>;
}

export interface AlexaConfig {
  amazonDomain?: string;
  proxyPort?: number;
  pollInterval?: number;
  cookieRefreshDays?: number;
  deviceTypes?: string[];
}

export interface PluginConfig {
  name: string;
  providers?: {
    tuya?: TuyaConfig;
    alexa?: AlexaConfig;
  };
}

const TUYA_REGIONS = new Set(['us', 'eu', 'cn', 'in']);

export function validateConfig(config: Record<string, unknown>): config is PluginConfig & Record<string, unknown> {
  if (!config.name || typeof config.name !== 'string') return false;
  const providers = config.providers as Record<string, unknown> | undefined;
  if (!providers) return true;

  const tuya = providers.tuya as Record<string, unknown> | undefined;
  if (tuya) {
    if (!tuya.accessId || typeof tuya.accessId !== 'string') return false;
    if (!tuya.accessKey || typeof tuya.accessKey !== 'string') return false;
    if (tuya.region && !TUYA_REGIONS.has(tuya.region as string)) return false;
  }

  const alexa = providers.alexa as Record<string, unknown> | undefined;
  if (alexa) {
    if (alexa.proxyPort !== undefined && typeof alexa.proxyPort !== 'number') return false;
    if (alexa.pollInterval !== undefined && typeof alexa.pollInterval !== 'number') return false;
  }
  return true;
}
