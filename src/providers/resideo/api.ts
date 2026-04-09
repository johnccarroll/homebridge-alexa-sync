// Resideo (Honeywell Home) Cloud API client
// Base URL: https://api.honeywell.com/v2
// Auth: OAuth 2.0 with access token in Authorization header + apikey query param

export interface ResideoThermostat {
  deviceID: string;
  name: string;
  deviceModel: string;
  indoorTemperature: number;
  indoorHumidity: number;
  units: string; // 'Fahrenheit' or 'Celsius'
  changeableValues: {
    mode: string; // 'Heat', 'Cool', 'Auto', 'Off'
    heatSetpoint: number;
    coolSetpoint: number;
    thermostatSetpointStatus: string;
  };
  settings?: {
    fan?: {
      changeableValues?: {
        mode?: string; // 'Auto', 'On', 'Circulate'
      };
    };
  };
}

export interface ResideoLocation {
  locationID: number;
  name: string;
  devices: ResideoThermostat[];
}

export interface ResideoApiConfig {
  consumerKey: string;
  consumerSecret: string;
  refreshToken: string;
}

export class ResideoApi {
  private readonly baseUrl = 'https://api.honeywell.com/v2';
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private accessToken = '';
  private refreshToken: string;
  private tokenExpiry = 0;

  constructor(config: ResideoApiConfig) {
    this.consumerKey = config.consumerKey;
    this.consumerSecret = config.consumerSecret;
    this.refreshToken = config.refreshToken;
  }

  /** Refresh the access token using the stored refresh token */
  async refreshAccessToken(): Promise<void> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });

    const response = await fetch('https://api.honeywell.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${this.consumerKey}:${this.consumerSecret}`)}`,
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Resideo token refresh failed: ${response.status}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
  }

  /** Get the current refresh token (for persistence) */
  getRefreshToken(): string {
    return this.refreshToken;
  }

  /** Get all locations with their thermostats */
  async getLocations(): Promise<ResideoLocation[]> {
    await this.ensureToken();
    const response = await this.request(`/locations?apikey=${this.consumerKey}`);
    return response as ResideoLocation[];
  }

  /** Get thermostat state */
  async getThermostat(deviceId: string, locationId: number): Promise<ResideoThermostat> {
    await this.ensureToken();
    return this.request(`/devices/thermostats/${deviceId}?apikey=${this.consumerKey}&locationId=${locationId}`) as Promise<ResideoThermostat>;
  }

  /** Set thermostat state */
  async setThermostat(deviceId: string, locationId: number, changes: Record<string, unknown>): Promise<void> {
    await this.ensureToken();
    const response = await fetch(
      `${this.baseUrl}/devices/thermostats/${deviceId}?apikey=${this.consumerKey}&locationId=${locationId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(changes),
      },
    );
    if (!response.ok) {
      throw new Error(`Resideo set failed: ${response.status}`);
    }
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry - 60_000) {
      await this.refreshAccessToken();
    }
  }

  private async request(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Resideo API error: ${response.status}`);
    }
    return response.json();
  }
}
