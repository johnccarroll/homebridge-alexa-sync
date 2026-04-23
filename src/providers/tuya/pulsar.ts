// Tuya Pulsar WebSocket consumer — push-based device state updates.
//
// Ports the pattern from tuya/tuya-connector-python/tuya_connector/openpulsar.py
// to TypeScript. Connects directly to Tuya's Pulsar broker over WebSocket
// (bypasses the legacy /iot-03/open-hub/access-config MQTT path, which is
// only available on older / differently-provisioned Tuya projects).
//
// Auth: MD5-derived password in WebSocket upgrade headers, no JWT, no
// rotating credentials. Subscription is <accessId>-sub (auto-created by
// Tuya when Message Service is enabled on the cloud project).
//
// Message envelope (Pulsar WebSocket wire format):
//   { messageId, payload: base64(inner-json) }
// where inner-json is:
//   { data: base64(aes-gcm-encrypted), t: <ms-epoch>, ... }
// Decrypts with accessKey[8:24] as the 16-byte AES key.

import { createDecipheriv, createHash } from 'node:crypto';
import WebSocket from 'ws';

const GCM_TAG_LENGTH = 16;

const PULSAR_ENDPOINTS: Record<string, string> = {
  us: 'wss://mqe.tuyaus.com:8285/',
  eu: 'wss://mqe.tuyaeu.com:8285/',
  cn: 'wss://mqe.tuyacn.com:8285/',
  in: 'wss://mqe.tuyain.com:8285/',
};

export interface MqMessage {
  devId: string;
  status?: Array<{ code: string; value: boolean | number | string; t?: number }>;
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
 * Long-lived Pulsar WebSocket subscriber. `start()` begins the reconnect
 * loop; `stop()` terminates it. Register listeners via addMessageListener;
 * each decoded message is fanned out to every listener. Listener errors
 * are swallowed so one bad handler can't tear down the subscription.
 */
export class TuyaPulsarConsumer {
  private readonly accessId: string;
  private readonly accessKey: string;
  private readonly region: string;
  private readonly log: TuyaMqLogger;
  private readonly listeners = new Set<MessageListener>();

  private running = false;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;

  constructor(accessId: string, accessKey: string, region: string, log: TuyaMqLogger) {
    this.accessId = accessId;
    this.accessKey = accessKey;
    this.region = region;
    this.log = log;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  addMessageListener(listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeMessageListener(listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  /** Build the Pulsar WebSocket consumer URL per Apache Pulsar's WS proxy spec
   *  + Tuya's tenant/namespace/topic/subscription conventions. */
  private buildUrl(): string {
    const endpoint = PULSAR_ENDPOINTS[this.region];
    if (!endpoint) throw new Error(`No Pulsar endpoint for region=${this.region}`);
    return (
      endpoint +
      'ws/v2/consumer/persistent/' +
      this.accessId + '/out/event/' +
      this.accessId + '-sub' +
      '?subscriptionType=Failover&ackTimeoutMillis=3000'
    );
  }

  /** Compute the auth password Tuya expects:
   *    md5(accessId + md5(accessKey))[8:24]
   */
  private derivePassword(): string {
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    return md5(this.accessId + md5(this.accessKey)).substring(8, 24);
  }

  private connect(): void {
    if (!this.running) return;

    let url: string;
    try {
      url = this.buildUrl();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`TuyaPulsar URL build failed: ${msg}`);
      return;
    }

    this.log.info(`TuyaPulsar connecting: ${url.split('?')[0]}`);

    const ws = new WebSocket(url, {
      headers: {
        Connection: 'Upgrade',
        username: this.accessId,
        password: this.derivePassword(),
      },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.log.info('TuyaPulsar connected');
      this.reconnectAttempts = 0;
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.handleMessage(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`TuyaPulsar handle failed: ${msg}`);
      }
    });

    ws.on('error', (err: Error) => {
      this.log.warn(`TuyaPulsar error: ${err.message}`);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.log.debug?.(`TuyaPulsar closed code=${code} reason=${reason.toString()}`);
      this.ws = null;
      if (!this.running) return;

      // Exponential backoff, capped at 2 minutes.
      this.reconnectAttempts++;
      const delayMs = Math.min(2 * 60 * 1000, 1000 * 2 ** Math.min(this.reconnectAttempts, 7));
      setTimeout(() => this.connect(), delayMs);
    });
  }

  /** Parse outer Pulsar envelope, decrypt inner payload, dispatch, ACK. */
  private handleMessage(data: WebSocket.RawData): void {
    const raw = data.toString();
    const env = JSON.parse(raw) as { messageId?: string; payload?: string };
    if (!env.messageId || !env.payload) {
      this.log.debug?.(`TuyaPulsar non-data frame: ${raw.slice(0, 200)}`);
      return;
    }

    const inner = Buffer.from(env.payload, 'base64').toString('utf8');
    const innerObj = JSON.parse(inner) as { data: string; t: number };
    const decrypted = this.decryptGcm(innerObj.data, this.accessKey, innerObj.t);
    const msg = JSON.parse(decrypted) as MqMessage;

    this.log.info(
      `TuyaPulsar decoded: devId=${msg.devId} bizCode=${msg.bizCode ?? '-'} status=${JSON.stringify(msg.status ?? [])}`,
    );

    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (err) {
        const emsg = err instanceof Error ? err.message : String(err);
        this.log.warn(`TuyaPulsar listener threw: ${emsg}`);
      }
    }

    // Ack the message so Pulsar doesn't redeliver.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ messageId: env.messageId }));
    }
  }

  /** AES-128-GCM decrypt; tuya encodes as [iv_len(4)][iv][ciphertext][tag(16)] base64.
   *  Matches the 2.0 message-encryption version. */
  private decryptGcm(b64: string, password: string, t: number): string {
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
}
