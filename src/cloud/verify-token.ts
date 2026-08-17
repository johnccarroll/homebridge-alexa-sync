// Offline verification of the cloud link token.
//
// This token is the OAuth access token minted during Alexa account linking:
// the cloud's `alexa-token` endpoint issues it, and its `alexa-skill` endpoint
// verifies it on every inbound directive. The plugin verifies it locally too,
// so a malformed or expired token is reported at startup instead of failing
// silently the first time someone speaks to Alexa.
//
// It is a standard EdDSA-signed JWT (alg = "EdDSA"). Claims:
//   iss      issuer origin
//   project  "switchboard"
//   sub      "github:<login>"  — identity, from the GitHub OAuth login
//   iat, exp standard timestamps
//
// Verification is entirely offline against an embedded public key: no network
// call, and nothing about the user or their devices leaves the network.
//
// Historically this file also enforced a `tier` claim, which gated the cloud
// behind a GitHub Sponsors subscription. That gate is gone — the tier claim is
// still issued for older tokens but is no longer read.

import { createPublicKey, verify as verifyRaw } from 'node:crypto';

// Ed25519 public key paired with the issuer's signing key. Safe to publish.
const ISSUER_PUBLIC_KEY_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'SdFPD9o7GOGJKR0feuj3bMzxuJvUcN7elXSS5DvonAk',
} as const;

const EXPECTED_ISSUER = 'https://cloud.johncarroll.dev';
const EXPECTED_PROJECT = 'switchboard';

export interface LinkClaims {
  iss: string;
  project: string;
  sub: string;
  iat: number;
  exp: number;
}

export type VerifyResult =
  | { ok: true; claims: LinkClaims }
  | { ok: false; reason: string };

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function verifyLinkToken(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token (expected 3 parts)' };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; typ?: string };
  let claims: LinkClaims;
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
  if (claims.project !== EXPECTED_PROJECT) {
    return { ok: false, reason: `wrong project: ${claims.project}` };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) {
    return { ok: false, reason: 'token issued in the future (clock skew?)' };
  }
  if (typeof claims.sub !== 'string' || !claims.sub.startsWith('github:')) {
    return { ok: false, reason: 'invalid sub claim' };
  }

  return { ok: true, claims };
}
