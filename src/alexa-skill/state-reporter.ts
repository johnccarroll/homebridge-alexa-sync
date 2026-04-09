// src/alexa-skill/state-reporter.ts
import { randomUUID } from 'node:crypto';
import type { DeviceState } from '../types.js';

interface LwaTokens {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tokenExpiry: number;
}

const EVENT_GATEWAY_URL = 'https://api.amazonalexa.com/v3/events';
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

export class AlexaStateReporter {
  private tokens: LwaTokens | null = null;
  private onTokensPersist?: (tokens: { accessToken: string; refreshToken: string; tokenExpiry: number }) => void;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  /** Handle AcceptGrant directive — exchange auth code for tokens */
  async handleAcceptGrant(code: string): Promise<void> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`LWA token exchange failed: ${response.status}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      tokenExpiry: Date.now() + data.expires_in * 1000,
    };

    this.onTokensPersist?.({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiry: this.tokens.tokenExpiry,
    });
  }

  /** Restore tokens from persistence */
  restoreTokens(stored: { accessToken: string; refreshToken: string; tokenExpiry: number }): void {
    this.tokens = {
      ...stored,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    };
  }

  /** Register callback to persist tokens when they change */
  onPersist(callback: (tokens: { accessToken: string; refreshToken: string; tokenExpiry: number }) => void): void {
    this.onTokensPersist = callback;
  }

  /** Check if we have valid tokens for reporting */
  get isEnabled(): boolean {
    return this.tokens !== null;
  }

  /** Send a ChangeReport when device state changes */
  async sendChangeReport(endpointId: string, changedState: Partial<DeviceState>, fullState: DeviceState): Promise<void> {
    if (!this.tokens) return;

    await this.ensureToken();

    const now = new Date().toISOString();
    const changedProperties = this.stateToProperties(changedState, now);
    const allProperties = this.stateToProperties(fullState, now);
    // Context = properties NOT in the changed set
    const changedKeys = new Set(changedProperties.map(p => `${p.namespace}.${p.name}`));
    const contextProperties = allProperties.filter(p => !changedKeys.has(`${p.namespace}.${p.name}`));

    const event = {
      context: { properties: contextProperties },
      event: {
        header: {
          namespace: 'Alexa',
          name: 'ChangeReport',
          payloadVersion: '3',
          messageId: randomUUID(),
        },
        endpoint: {
          scope: { type: 'BearerToken', token: this.tokens.accessToken },
          endpointId,
        },
        payload: {
          change: {
            cause: { type: 'APP_INTERACTION' },
            properties: changedProperties,
          },
        },
      },
    };

    const response = await fetch(EVENT_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.tokens.accessToken}`,
      },
      body: JSON.stringify(event),
    });

    if (response.status === 401 || response.status === 403) {
      // Token expired — refresh and retry once
      await this.refreshAccessToken();
      event.event.endpoint.scope.token = this.tokens!.accessToken;
      const retry = await fetch(EVENT_GATEWAY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.tokens!.accessToken}`,
        },
        body: JSON.stringify(event),
      });
      if (!retry.ok) {
        throw new Error(`ChangeReport retry failed: ${retry.status}`);
      }
    } else if (!response.ok) {
      throw new Error(`ChangeReport failed: ${response.status}`);
    }
  }

  private async ensureToken(): Promise<void> {
    if (!this.tokens) return;
    if (Date.now() >= this.tokens.tokenExpiry - 60_000) {
      await this.refreshAccessToken();
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens) return;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
      client_id: this.tokens.clientId,
      client_secret: this.tokens.clientSecret,
    });

    const response = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`LWA token refresh failed: ${response.status}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.tokens.accessToken = data.access_token;
    this.tokens.refreshToken = data.refresh_token;
    this.tokens.tokenExpiry = Date.now() + data.expires_in * 1000;

    this.onTokensPersist?.({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiry: this.tokens.tokenExpiry,
    });
  }

  private stateToProperties(state: Partial<DeviceState>, timeOfSample: string): Array<Record<string, unknown>> {
    const props: Array<Record<string, unknown>> = [];

    if (state.on !== undefined) {
      props.push({ namespace: 'Alexa.PowerController', name: 'powerState', value: state.on ? 'ON' : 'OFF', timeOfSample, uncertaintyInMilliseconds: 0 });
    }
    if (state.brightness !== undefined) {
      props.push({ namespace: 'Alexa.BrightnessController', name: 'brightness', value: state.brightness, timeOfSample, uncertaintyInMilliseconds: 0 });
    }
    if (state.hue !== undefined && state.saturation !== undefined) {
      props.push({ namespace: 'Alexa.ColorController', name: 'color', value: { hue: state.hue, saturation: state.saturation / 100, brightness: 1.0 }, timeOfSample, uncertaintyInMilliseconds: 0 });
    }
    if (state.colorTemperature !== undefined) {
      props.push({ namespace: 'Alexa.ColorTemperatureController', name: 'colorTemperatureInKelvin', value: state.colorTemperature, timeOfSample, uncertaintyInMilliseconds: 0 });
    }

    return props;
  }
}
