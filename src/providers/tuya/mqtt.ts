// Tuya MQTT broker client — push-based device state updates.
//
// Ports the pattern from tuya-homebridge's lib/tuyamqttapi.js (MIT) + the
// Home Assistant tuya-device-sharing-sdk pattern. Both use the same
// /v1.0/iot-03/open-hub/access-config endpoint to get ephemeral broker
// credentials. Connection must be refreshed every ~2 hours (credential
// TTL). Messages are AES-GCM encrypted; we decrypt with bytes 8-24 of
// the account's accessKey.
//
// Replaces 30s REST polling. Message cost is orders of magnitude lower
// (68K msgs/mo quota vs 26K REST calls/mo, and MQTT only emits on actual
// state change).

import { randomUUID, createDecipheriv } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';

import type { MqConfig, TuyaApi } from './api.js';

const GCM_TAG_LENGTH = 16;

export interface MqMessage {
  /** Tuya device ID */
  devId: string;
  /** Status array — same shape as getDeviceStatus() REST response */
  status?: Array<{ code: string; value: boolean | number | string; t?: number }>;
  /** Lifecycle event code (online, offline, rename, delete, etc.) */
  bizCode?: string;
  bizData?: Record<string, unknown>;
  productKey?: string;
  dataId?: string;
}

type MessageListener = (msg: MqMessage) => void;

export interface TuyaMqLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
}

/**
 * Long-lived MQTT subscriber. `start()` begins the connect-refresh loop;
 * `stop()` terminates it. Register listeners via `addMessageListener`;
 * each decoded message is fanned out to every listener. Listeners MUST
 * NOT throw — errors are swallowed to protect the connection.
 */
export class TuyaOpenMQ {
  private readonly api: TuyaApi;
  private readonly accessKey: string;
  private readonly log: TuyaMqLogger;
  private readonly listeners = new Set<MessageListener>();
  private readonly linkId = randomUUID();

  private running = false;
  private client: MqttClient | null = null;
  private deviceTopic = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(api: TuyaApi, accessKey: string, log: TuyaMqLogger) {
    this.api = api;
    this.accessKey = accessKey;
    this.log = log;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loopStart();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
  }

  addMessageListener(listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeMessageListener(listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  /** Reconnect loop — credentials expire every ~2h, reconnect is unavoidable. */
  private async loopStart(): Promise<void> {
    while (this.running) {
      let config: MqConfig;
      try {
        config = await this.api.getMessageQueueConfig(this.linkId, '2.0');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`TuyaMQ config fetch failed: ${msg}. Retrying in 60s.`);
        await this.sleep(60_000);
        continue;
      }

      this.deviceTopic = config.source_topic.device;
      this.log.info(`TuyaMQ connecting to ${config.url} (topic=${this.deviceTopic})`);

      await new Promise<void>((resolve) => {
        const client = mqtt.connect(config.url, {
          clientId: config.client_id,
          username: config.username,
          password: config.password,
          reconnectPeriod: 0, // we handle reconnect via the outer loop
        });

        let resolved = false;
        const done = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };

        client.on('connect', () => {
          this.log.info('TuyaMQ connected');
          client.subscribe(this.deviceTopic, (err) => {
            if (err) this.log.warn(`TuyaMQ subscribe failed: ${err.message}`);
          });
        });
        client.on('error', (err) => {
          this.log.warn(`TuyaMQ error: ${err.message}`);
        });
        client.on('close', () => {
          this.log.debug?.('TuyaMQ connection closed');
          done();
        });
        client.on('end', () => {
          this.log.debug?.('TuyaMQ ended');
          done();
        });
        client.on('message', (topic, payload) => {
          if (topic !== this.deviceTopic) return;
          try {
            this.handleMessage(payload, config.password);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(`TuyaMQ decode failed: ${msg}`);
          }
        });

        if (this.client) this.client.end(true);
        this.client = client;

        // Reconnect 60s before credentials expire
        const nextInSec = Math.max(60, config.expire_time - 60);
        this.reconnectTimer = setTimeout(() => {
          this.log.debug?.(`TuyaMQ cycling credentials after ${nextInSec}s`);
          client.end(true);
        }, nextInSec * 1000);
      });

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      if (this.running) {
        await this.sleep(2_000);
      }
    }
  }

  private handleMessage(payload: Buffer, password: string): void {
    const envelope = JSON.parse(payload.toString()) as { data: string; t: number };
    const decrypted = this.decrypt(envelope.data, password, envelope.t);
    const msg = JSON.parse(decrypted) as MqMessage;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (err) {
        const emsg = err instanceof Error ? err.message : String(err);
        this.log.warn(`TuyaMQ listener threw: ${emsg}`);
      }
    }
  }

  /** AES-128-GCM decrypt; tuya encodes as: [iv_len(4)][iv][ciphertext][tag(16)] base64. */
  private decrypt(b64: string, password: string, t: number): string {
    const buf = Buffer.from(b64, 'base64');
    const key = password.substring(8, 24);
    const ivLen = buf.readUIntBE(0, 4);
    const iv = buf.subarray(4, 4 + ivLen);
    const ct = buf.subarray(4 + ivLen, buf.length - GCM_TAG_LENGTH);
    const tag = buf.subarray(buf.length - GCM_TAG_LENGTH);
    const decipher = createDecipheriv('aes-128-gcm', key, iv);
    decipher.setAuthTag(tag);
    const aad = Buffer.alloc(6);
    aad.writeUIntBE(t, 0, 6);
    decipher.setAAD(aad);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
