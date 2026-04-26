import { describe, it, expect } from 'vitest';
import { createPrivateKey, sign as signRaw } from 'node:crypto';
import { verifySupporterToken } from '../../src/supporter/verify.js';

// Matched Ed25519 keypair for tests — NOT the production key. The plugin
// embeds the production public key in src/supporter/verify.ts, so most of
// these tests verify rejection paths. A single "happy path" test uses a
// hand-crafted JWT signed with the PRODUCTION public key's matching
// private key, supplied only as an env var so CI can validate signing
// without the secret being checked in.

function b64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function makeToken(
  claims: Record<string, unknown>,
  privateKeyPem: string,
  alg = 'EdDSA',
): string {
  const headerB64 = b64url(Buffer.from(JSON.stringify({ alg, typ: 'JWT' })));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  const sig = signRaw(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(sig)}`;
}

describe('verifySupporterToken', () => {
  it('rejects a malformed (non-3-part) token', () => {
    expect(verifySupporterToken('not-a-jwt').ok).toBe(false);
    expect(verifySupporterToken('a.b').ok).toBe(false);
    expect(verifySupporterToken('').ok).toBe(false);
  });

  it('rejects a token with non-JSON parts', () => {
    const r = verifySupporterToken('xxx.yyy.zzz');
    expect(r.ok).toBe(false);
  });

  it('rejects a token with alg != EdDSA', () => {
    const t =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ0ZXN0In0.' +
      'aaaabbbbccccdddd';
    const r = verifySupporterToken(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsupported alg/);
  });

  it('rejects a token with a bad signature', () => {
    // claims that look legitimate but signature is garbage
    const headerB64 = b64url(
      Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })),
    );
    const payloadB64 = b64url(
      Buffer.from(
        JSON.stringify({
          iss: 'https://cloud.johncarroll.dev',
          project: 'switchboard',
          sub: 'github:test',
          tier: 5,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    );
    const bogusSig = b64url(Buffer.alloc(64, 0));
    const t = `${headerB64}.${payloadB64}.${bogusSig}`;
    const r = verifySupporterToken(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signature/);
  });

  // Happy path + claim-level validation tests. Skipped unless SUPPORTER_TEST_PRIVATE_KEY
  // (PEM-encoded Ed25519 private key, matched to the embedded public key) is present.
  // Developers running locally can export the key from the sponsors-worker keys/
  // directory to exercise these.
  const testPriv = process.env.SUPPORTER_TEST_PRIVATE_KEY;
  const describeOrSkip = testPriv ? describe : describe.skip;
  describeOrSkip('with matching private key', () => {
    const now = () => Math.floor(Date.now() / 1000);

    it('accepts a valid token', () => {
      const t = makeToken(
        {
          iss: 'https://cloud.johncarroll.dev',
          project: 'switchboard',
          sub: 'github:testuser',
          tier: 5,
          iat: now(),
          exp: now() + 3600,
        },
        testPriv!,
      );
      const r = verifySupporterToken(t);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.claims.sub).toBe('github:testuser');
        expect(r.claims.tier).toBe(5);
      }
    });

    it('rejects an expired token', () => {
      const t = makeToken(
        {
          iss: 'https://cloud.johncarroll.dev',
          project: 'switchboard',
          sub: 'github:testuser',
          tier: 5,
          iat: now() - 7200,
          exp: now() - 3600,
        },
        testPriv!,
      );
      const r = verifySupporterToken(t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/expired/);
    });

    it('rejects a wrong issuer', () => {
      const t = makeToken(
        {
          iss: 'https://evil.example.com',
          project: 'switchboard',
          sub: 'github:testuser',
          tier: 5,
          iat: now(),
          exp: now() + 3600,
        },
        testPriv!,
      );
      const r = verifySupporterToken(t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/issuer/);
    });

    it('rejects an invalid sub claim', () => {
      const t = makeToken(
        {
          iss: 'https://cloud.johncarroll.dev',
          project: 'switchboard',
          sub: 'something:else',
          tier: 5,
          iat: now(),
          exp: now() + 3600,
        },
        testPriv!,
      );
      const r = verifySupporterToken(t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/sub/);
    });
  });
});
