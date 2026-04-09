import { createHmac, createHash } from 'node:crypto';

export interface TuyaCommand {
  code: string;
  value: boolean | number | string;
}

export interface TuyaDevice {
  id: string;
  name: string;
  category: string;
  online: boolean;
  product_id: string;
  status: Array<{ code: string; value: boolean | number | string }>;
}

interface TuyaApiConfig {
  accessId: string;
  accessKey: string;
  region: 'us' | 'eu' | 'cn' | 'in';
}

const REGION_URLS: Record<string, string> = {
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

export class TuyaApi {
  public readonly baseUrl: string;
  public accessToken = '';
  public uid = '';
  private refreshToken = '';
  private tokenExpiry = 0;
  private readonly accessId: string;
  private readonly accessKey: string;

  constructor(config: TuyaApiConfig) {
    this.accessId = config.accessId;
    this.accessKey = config.accessKey;
    this.baseUrl = REGION_URLS[config.region];
  }

  async getToken(): Promise<void> {
    const result = await this.request<{
      access_token: string;
      expire_time: number;
      refresh_token: string;
      uid: string;
    }>('GET', '/v1.0/token?grant_type=1', '', false);

    this.accessToken = result.access_token;
    this.refreshToken = result.refresh_token;
    this.uid = result.uid;
    this.tokenExpiry = Date.now() + result.expire_time * 1000;
  }

  async getDevices(): Promise<TuyaDevice[]> {
    await this.ensureToken();

    // v2.0 cloud API — works with Smart Home project permissions
    // v1.0 user devices endpoint is restricted on many project types
    interface CloudDevice {
      id: string;
      name: string;
      customName?: string;
      category: string;
      isOnline: boolean;
      productId: string;
    }
    const cloudDevices = await this.request<CloudDevice[]>(
      'GET', '/v2.0/cloud/thing/device?page_size=20',
    );

    // v2.0 doesn't include status, so fetch each device's status
    const devices: TuyaDevice[] = [];
    for (const d of cloudDevices) {
      let status: Array<{ code: string; value: boolean | number | string }> = [];
      try {
        status = await this.getDeviceStatus(d.id);
      } catch {
        // Device may be offline or inaccessible
      }
      devices.push({
        id: d.id,
        name: d.customName || d.name,
        category: d.category,
        online: d.isOnline,
        product_id: d.productId,
        status,
      });
    }
    return devices;
  }

  async getDeviceStatus(deviceId: string): Promise<Array<{ code: string; value: boolean | number | string }>> {
    await this.ensureToken();
    return this.request('GET', `/v1.0/devices/${deviceId}/status`);
  }

  async sendCommands(deviceId: string, commands: TuyaCommand[]): Promise<void> {
    await this.ensureToken();
    await this.request('POST', `/v1.0/devices/${deviceId}/commands`, JSON.stringify({ commands }));
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || (this.tokenExpiry > 0 && Date.now() >= this.tokenExpiry - 60_000)) {
      if (this.refreshToken) {
        try {
          const result = await this.request<{
            access_token: string;
            expire_time: number;
            refresh_token: string;
            uid: string;
          }>('GET', `/v1.0/token/${this.refreshToken}`, '', false);
          this.accessToken = result.access_token;
          this.refreshToken = result.refresh_token;
          this.uid = result.uid;
          this.tokenExpiry = Date.now() + result.expire_time * 1000;
          return;
        } catch {
          // Refresh failed, get new token
        }
      }
      await this.getToken();
    }
  }

  private async request<T>(method: string, path: string, body = '', authenticated = true): Promise<T> {
    const t = Date.now().toString();
    const sign = this.sign(t, method, path, body, authenticated);

    const headers: Record<string, string> = {
      client_id: this.accessId,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
    };
    if (authenticated) {
      headers.access_token = this.accessToken;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body || undefined,
    });

    const json = await response.json() as { success: boolean; result: T; code?: number; msg?: string };
    if (!json.success) {
      throw new Error(json.msg || `Tuya API error ${json.code}`);
    }
    return json.result;
  }

  private sign(t: string, method: string, path: string, body: string, authenticated: boolean): string {
    const contentHash = createHash('sha256').update(body).digest('hex');
    const stringToSign = `${method}\n${contentHash}\n\n${path}`;
    const signStr = authenticated
      ? `${this.accessId}${this.accessToken}${t}${stringToSign}`
      : `${this.accessId}${t}${stringToSign}`;
    return createHmac('sha256', this.accessKey)
      .update(signStr)
      .digest('hex')
      .toUpperCase();
  }
}
