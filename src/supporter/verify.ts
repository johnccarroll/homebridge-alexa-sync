// Offline verification of supporter-license JWTs issued by
// sponsors.hb-alexa.dev. The plugin embeds the issuer's Ed25519 public
// key and verifies the signature + claims with zero network calls —
// this is what keeps the plugin under Homebridge Verified's "no tracking"
// rule (see Ship to npm plan notes).
//
// The JWT is a standard EdDSA-signed JWT (alg = "EdDSA"). Claims:
//   iss   "https://sponsors.hb-alexa.dev"
//   sub   "github:<login>"
//   tier  monthly sponsor tier in US dollars
//   iat, exp  standard timestamps
//
// Key rotation: if the issuer ever rotates the signing key, the plugin
// ships a new version with the new public key. During a rotation window
// we'd support both keys; that's a future concern.

import { createPublicKey, verify as verifyRaw } from 'node:crypto';

// Ed25519 public key paired with the Worker's signing key at
// sponsors.hb-alexa.dev. Safe to publish. Generated 2026-04-21.
const ISSUER_PUBLIC_KEY_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'SdFPD9o7GOGJKR0feuj3bMzxuJvUcN7elXSS5DvonAk',
} as const;

const EXPECTED_ISSUER = 'https://hb.johncarroll.dev';

export interface SupporterClaims {
  iss: string;
  sub: string;
  tier: number;
  iat: number;
  exp: number;
}

export type VerifyResult =
  | { ok: true; claims: SupporterClaims }
  | { ok: false; reason: string };

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function verifySupporterToken(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token (expected 3 parts)' };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; typ?: string };
  let claims: SupporterClaims;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
    claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed token (could not parse JSON)' };
  }

  if (header.alg !== 'EdDSA') return { ok: false, reason: `unsupported alg: ${header.alg}` };

  const sig = b64urlDecode(sigB64);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const key = createPublicKey({ key: ISSUER_PUBLIC_KEY_JWK, format: 'jwk' });

  // crypto.verify with algorithm=null for Ed25519 (signature alg baked into key type)
  const valid = verifyRaw(null, signingInput, key, sig);
  if (!valid) return { ok: false, reason: 'signature verification failed' };

  if (claims.iss !== EXPECTED_ISSUER) {
    return { ok: false, reason: `wrong issuer: ${claims.iss}` };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) {
    // 60s clock skew tolerance — the chrony fix should keep clocks tight
    return { ok: false, reason: 'token issued in the future (clock skew?)' };
  }
  if (typeof claims.sub !== 'string' || !claims.sub.startsWith('github:')) {
    return { ok: false, reason: 'invalid sub claim' };
  }
  if (typeof claims.tier !== 'number' || claims.tier < 1) {
    return { ok: false, reason: 'invalid tier claim' };
  }

  return { ok: true, claims };
}
