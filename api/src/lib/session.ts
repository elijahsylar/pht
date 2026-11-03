import jwt from 'jsonwebtoken';

// Browser sessions: the full JWT issued after the two-step login.
//
// - Lives 30 days, and slides: any authenticated request in the last 7 days of
//   a token's life is answered with a fresh 30-day token in the X-PHT-Token
//   response header, which the page stores in place of the old one. A phone
//   used at least once a week stays logged in; one left alone for 30 days does
//   not.
// - Revocable as a group: POST /auth/logout (and a password change) stores
//   `sessions_valid_after`, and any browser token issued at or before that
//   instant is refused. The API token is a different credential and is not
//   affected.
//
// The header is read by same-origin code only. No CORS headers are sent, so no
// other origin can read it (and Access-Control-Expose-Headers is never set).

export const SESSION_TTL_SECONDS = 30 * 86_400;
export const RENEW_WINDOW_SECONDS = 7 * 86_400;
export const SESSIONS_VALID_AFTER_KEY = 'sessions_valid_after';
export const RENEW_HEADER = 'X-PHT-Token';

export interface SessionPayload {
  username: string;
  stage?: string; // 'partial' = password only; 'full'/undefined = fully authed
  iat?: number; // seconds, set by jsonwebtoken
  exp?: number; // seconds
  // Milliseconds. `iat` is whole seconds, too coarse to tell a token issued
  // just after a logout from one issued just before it.
  iatMs?: number;
}

export function issueSessionToken(username: string): string {
  return jwt.sign({ username, stage: 'full', iatMs: Date.now() }, process.env.JWT_SECRET as string, {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

// Tokens minted before `iatMs` existed fall back to their whole-second `iat`.
export function issuedAtMs(p: SessionPayload): number {
  if (typeof p.iatMs === 'number') return p.iatMs;
  return typeof p.iat === 'number' ? p.iat * 1000 : 0;
}

export function needsRenewal(p: SessionPayload, nowMs: number = Date.now()): boolean {
  return typeof p.exp === 'number' && p.exp * 1000 - nowMs <= RENEW_WINDOW_SECONDS * 1000;
}
