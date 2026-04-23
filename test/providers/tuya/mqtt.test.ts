// Unit test for the Tuya MQTT decrypt routine. Uses a mock payload we
// encrypt with the SAME algorithm the Tuya cloud uses (AES-128-GCM with
// [iv_len(4)][iv][ciphertext][tag(16)] base64 framing + timestamp AAD),
// then feeds it through the decrypter and verifies the round-trip.

import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { TuyaOpenMQ } from '../../../src/providers/tuya/mqtt.js';

/** Encrypt a plaintext message the same way Tuya does — for test fixtures. */
function encryptLikeTuya(plaintext: string, password: string, t: number): string {
  const key = password.substring(8, 24);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-128-gcm', key, iv);
  const aad = Buffer.alloc(6);
  aad.writeUIntBE(t, 0, 6);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ivLen = Buffer.alloc(4);
  ivLen.writeUIntBE(iv.length, 0, 4);
  return Buffer.concat([ivLen, iv, ct, tag]).toString('base64');
}

describe('TuyaOpenMQ decrypt', () => {
  it('round-trips a Tuya-format AES-128-GCM payload', () => {
    const password = 'XXXXXXXX' + 'abcdefghijklmnop' + 'ignored-rest'; // bytes 8-24 = key
    const plaintext = JSON.stringify({
      devId: 'dev_001',
      status: [{ code: 'switch_led', value: true, t: 1234567 }],
    });
    const t = 1776927000000;

    const encrypted = encryptLikeTuya(plaintext, password, t);

    // Access the private decrypt via a test-only handle
    const mq = new TuyaOpenMQ({} as never, password, {
      info: () => {},
      warn: () => {},
    });
    const decrypted = (mq as unknown as {
      decrypt: (b64: string, password: string, t: number) => string;
    }).decrypt(encrypted, password, t);

    expect(decrypted).toBe(plaintext);
    const parsed = JSON.parse(decrypted) as { devId: string };
    expect(parsed.devId).toBe('dev_001');
  });

  it('rejects a payload with wrong AAD (timestamp mismatch)', () => {
    const password = 'XXXXXXXX' + 'abcdefghijklmnop' + 'xxxxxx';
    const encrypted = encryptLikeTuya('{"devId":"x"}', password, 1000);
    const mq = new TuyaOpenMQ({} as never, password, {
      info: () => {},
      warn: () => {},
    });
    expect(() => {
      (mq as unknown as {
        decrypt: (b64: string, password: string, t: number) => string;
      }).decrypt(encrypted, password, 9999);
    }).toThrow();
  });

  it('rejects a payload with tampered ciphertext', () => {
    const password = 'XXXXXXXX' + 'abcdefghijklmnop' + 'xxxxxx';
    const encrypted = encryptLikeTuya('{"devId":"x"}', password, 1000);
    const buf = Buffer.from(encrypted, 'base64');
    buf[20]! ^= 0xff; // flip a byte in the ciphertext
    const tampered = buf.toString('base64');
    const mq = new TuyaOpenMQ({} as never, password, {
      info: () => {},
      warn: () => {},
    });
    expect(() => {
      (mq as unknown as {
        decrypt: (b64: string, password: string, t: number) => string;
      }).decrypt(tampered, password, 1000);
    }).toThrow();
  });
});
