import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// The one long-lived credential: a bearer token for the iPhone widget and the
// server-side mail proxy, neither of which can do the interactive two-step login.
//
// Only its SHA-256 is ever stored (settings.api_token_hash). A fast unsalted
// hash is the right tool here, unlike for the password: the token is 256 random
// bits, so there is nothing to brute-force, and the hash only has to make a
// leaked database row useless as a credential.
//
// There is exactly one token. Rotating it (ops/pht-rotate-token.sh) overwrites
// the hash, which is also the only way to revoke it.

export const API_TOKEN_PREFIX = 'pht_';
export const API_TOKEN_HASH_KEY = 'api_token_hash';

// pht_ + base64url of at least 32 bytes (43 characters unpadded).
const TOKEN_RE = /^pht_[A-Za-z0-9_-]{43,128}$/;

export function looksLikeApiToken(s: string): boolean {
  return s.startsWith(API_TOKEN_PREFIX);
}

export function generateApiToken(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Constant-time comparison of the presented token's hash with the stored one.
// A missing or malformed stored hash matches nothing.
export function apiTokenMatches(presented: string, storedHashHex: string | null): boolean {
  if (!storedHashHex || !/^[0-9a-f]{64}$/.test(storedHashHex)) return false;
  if (!TOKEN_RE.test(presented)) return false;
  const a = Buffer.from(hashApiToken(presented), 'hex');
  const b = Buffer.from(storedHashHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
