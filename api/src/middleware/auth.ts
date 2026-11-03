import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { SettingsStore } from '../db/store.js';
import { API_TOKEN_HASH_KEY, apiTokenMatches, looksLikeApiToken } from '../lib/apiToken.js';
import {
  RENEW_HEADER,
  SESSIONS_VALID_AFTER_KEY,
  issueSessionToken,
  issuedAtMs,
  needsRenewal,
  type SessionPayload,
} from '../lib/session.js';

// Two credentials, both sent as `Authorization: Bearer …`:
//
//   JWT        the browser, after the two-step login. Full access. 30 days,
//              sliding, revocable with POST /auth/logout (see lib/session.ts).
//   API token  `pht_…`, for the widget and the server-side mail proxy. Day-to-day
//              routes only — see requireAuthOrToken. Untouched by logout.
//
// The split is enforced by which middleware a route is mounted behind, so a
// route added without thinking is JWT-only by default.

export interface AuthedRequest extends Request {
  user?: { username: string; stage?: string; via: 'jwt' | 'token' };
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function verifyJwt(token: string | null): { payload: SessionPayload } | { error: string } {
  if (!token) return { error: 'missing token' };
  try {
    return { payload: jwt.verify(token, process.env.JWT_SECRET as string) as SessionPayload };
  } catch {
    return { error: 'invalid token' };
  }
}

// Full access, browser JWT only. Rejects the partial (password-only) token, any
// token issued at or before the last logout, and anything that is not a JWT —
// which is what keeps the API token out of /settings, /auth and /import. In the
// last 7 days of a token's life the response carries a fresh one.
export function requireAuth(store: SettingsStore): RequestHandler {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const r = verifyJwt(bearer(req));
    if ('error' in r) return res.status(401).json({ error: r.error });
    const p = r.payload;
    if (p.stage === 'partial') return res.status(401).json({ error: 'security step required' });
    try {
      const after = Number((await store.getSetting(SESSIONS_VALID_AFTER_KEY)) ?? 0);
      if (after && issuedAtMs(p) <= after) {
        return res.status(401).json({ error: 'session ended' });
      }
    } catch (err) {
      return next(err);
    }
    if (needsRenewal(p)) {
      res.setHeader(RENEW_HEADER, issueSessionToken(p.username));
      // A response carrying a credential must never be stored by a cache.
      res.setHeader('Cache-Control', 'no-store');
    }
    req.user = { username: p.username, stage: p.stage, via: 'jwt' };
    next();
  };
}

// The password step has passed. Used only by /auth/verify-security to gate the
// second factor. Accepts any valid JWT (partial or full); never renews.
export function requirePartial(req: AuthedRequest, res: Response, next: NextFunction) {
  const r = verifyJwt(bearer(req));
  if ('error' in r) return res.status(401).json({ error: r.error });
  req.user = { username: r.payload.username, stage: r.payload.stage, via: 'jwt' };
  next();
}

// A browser JWT or the API token. Mounted only on the routers the token may
// reach: /today, /checks, /notes, /habits; inside /habits the writes add
// jwtOnly. Only the JWT path ever renews.
export function requireAuthOrToken(store: SettingsStore): RequestHandler {
  const jwtAuth = requireAuth(store);
  return async (req: AuthedRequest, res, next) => {
    const token = bearer(req);
    if (!token || !looksLikeApiToken(token)) return jwtAuth(req, res, next);
    try {
      if (!apiTokenMatches(token, await store.getSetting(API_TOKEN_HASH_KEY))) {
        return res.status(401).json({ error: 'invalid token' });
      }
      req.user = { username: 'api-token', via: 'token' };
      next();
    } catch (err) {
      next(err);
    }
  };
}

// For the few routes that sit behind requireAuthOrToken but are not for the
// API token (creating and editing habits).
export function jwtOnly(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.via !== 'jwt') {
    return res.status(403).json({ error: 'not permitted for the api token' });
  }
  next();
}
