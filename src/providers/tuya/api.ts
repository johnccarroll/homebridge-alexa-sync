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

export interface MqConfig {
  url: string;
  client_id: string;
  username: string;
  password: string;
  expire_time: number;
  source_topic: { device: string };
  sink_topic?: { device: string };
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

    interface CloudDevice {
      id: string;
      name: string;
      customName?: string;
      category: string;
      isOnline: boolean;
      productId: string;
    }

    const allCloudDevices: CloudDevice[] = [];
    let lastId: string | undefined;

    while (true) {
      const path = lastId
        ? `/v2.0/cloud/thing/device?page_size=20&last_id=${lastId}`
        : '/v2.0/cloud/thing/device?page_size=20';
      const page = await this.request<CloudDevice[]>('GET', path);
      if (!page || page.length === 0) break;
      allCloudDevices.push(...page);
      if (page.length < 20) break;
      lastId = page[page.length - 1].id;
    }

    // Fetch status in parallel batches of 5
    const CONCURRENCY = 5;
    const devices: TuyaDevice[] = [];
    for (let i = 0; i < allCloudDevices.length; i += CONCURRENCY) {
      const batch = allCloudDevices.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (d) => {
          let status: Array<{ code: string; value: boolean | number | string }> = [];
          try {
            status = await this.getDeviceStatus(d.id);
          } catch { /* offline */ }
          return {
            id: d.id,
            name: d.customName || d.name,
            category: d.category,
            online: d.isOnline,
            product_id: d.productId,
            status,
          };
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') devices.push(r.value);
      }
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

  /**
   * Factory-info bulk fetch — returns the per-device `local_key` plus
   * identifiers (uuid, sn, mac). The local key is required to talk to a
   * device on the LAN without going through the cloud. Pulled once during
   * a working cloud trial; persisted thereafter so cloud expiry doesn't
   * matter.
   */
  async getFactoryInfos(deviceIds: string[]): Promise<Array<{ id: string; local_key: string; uuid?: string; sn?: string; mac?: string }>> {
    await this.ensureToken();
    return this.request(
      'GET',
      `/v1.0/iot-03/devices/factory-infos?device_ids=${deviceIds.join(',')}`,
    );
  }

  /**
   * Fetch ephemeral MQTT broker credentials for push-based state updates.
   * Same open-hub pattern used by tuya-homebridge + Home Assistant's Tuya
   * integration. Credentials expire every ~2 hours; caller must reconnect
   * on `expire_time - 60` seconds.
   */
  async getMessageQueueConfig(linkId: string, msgEncryptedVersion: '1.0' | '2.0' = '2.0'): Promise<MqConfig> {
    await this.ensureToken();
    return this.request('POST', '/v1.0/iot-03/open-hub/access-config',
      JSON.stringify({
        uid: this.uid,
        link_id: linkId,
        link_type: 'mqtt',
        topics: 'device',
        msg_encrypted_version: msgEncryptedVersion,
      }),
    );
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
      signal: AbortSignal.timeout(5000),
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
