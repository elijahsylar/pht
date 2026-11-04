import { Router, type Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { loginSchema, securityVerifySchema } from '../schemas.js';
import { requireAuth, requirePartial, type AuthedRequest } from '../middleware/auth.js';
import { getAdminPasswordHash, verifySecurityAnswer } from '../db/settings.js';
import type { SettingsStore } from '../db/store.js';
import { RENEW_HEADER, SESSIONS_VALID_AFTER_KEY, issueSessionToken } from '../lib/session.js';
import { type AttemptLimiter, createAttemptLimiter, tooManyAttempts } from '../lib/attemptLimiter.js';

// The browser login: password, then security answer, then a 30-day sliding
// JWT (lib/session.ts). The API token plays no part here and is rejected by
// /verify and /logout.
//
// Both steps are attempt-limited per client IP and per account
// (lib/attemptLimiter.ts). A refused attempt is a 429 with Retry-After, sent
// before any credential is checked.
export function authRouter(store: SettingsStore, limiter: AttemptLimiter = createAttemptLimiter()): Router {
  const router = Router();

  // req.ip is the client's address: app.ts trusts X-Forwarded-For from the
  // loopback proxy (nginx) only.
  const clientIp = (req: { ip?: string }) => req.ip ?? 'unknown';
  const refuse = (res: Response, retryAfterMs: number) => {
    const r = tooManyAttempts(retryAfterMs);
    res.setHeader('Retry-After', String(r.seconds));
    return res.status(429).json(r.body);
  };

  // Step 1 — password. On success issues only a short-lived PARTIAL token; the
  // security answer (step 2) is still required before a full token is granted.
  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = loginSchema.parse(req.body);
      // Only the real account gets an account counter, so made-up user names
      // cannot fill memory; they still count against the IP.
      const account = username === process.env.ADMIN_USERNAME ? username : null;
      const ip = clientIp(req);
      const gate = limiter.begin('login', ip, account);
      if (!gate.allowed) return refuse(res, gate.retryAfterMs);
      if (username !== process.env.ADMIN_USERNAME) {
        return res.status(401).json({ error: 'invalid credentials' });
      }
      // DB-stored hash wins; ADMIN_PASSWORD_HASH is the fallback until the
      // password is changed once from Settings.
      const hash = await getAdminPasswordHash(store);
      if (!hash) {
        return res.status(500).json({ error: 'no password configured' });
      }
      const ok = await bcrypt.compare(password, hash);
      if (!ok) {
        return res.status(401).json({ error: 'invalid credentials' });
      }
      limiter.success('login', ip, account);
      const partialToken = jwt.sign(
        // iatMs: revocation compares in milliseconds (see requirePartial)
        { username, stage: 'partial', iatMs: Date.now() },
        process.env.JWT_SECRET as string,
        { expiresIn: '10m' },
      );
      res.json({ partialToken });
    } catch (err) {
      next(err);
    }
  });

  // Step 2 — security answer. Requires the partial token from step 1. On a
  // case-insensitive match against the stored answer, issues the full token.
  router.post('/verify-security', requirePartial(store), async (req: AuthedRequest, res, next) => {
    try {
      const { answer } = securityVerifySchema.parse(req.body);
      const username = req.user?.username ?? (process.env.ADMIN_USERNAME as string);
      const ip = clientIp(req);
      // Always the account counter: a new partial token does not reset it.
      const gate = limiter.begin('security', ip, username);
      if (!gate.allowed) return refuse(res, gate.retryAfterMs);
      if (!(await verifySecurityAnswer(store, answer))) {
        return res.status(401).json({ error: 'incorrect answer' });
      }
      limiter.success('security', ip, username);
      res.json({ token: issueSessionToken(username) });
    } catch (err) {
      next(err);
    }
  });

  const session = requireAuth(store);

  router.get('/verify', session, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Ends every browser session: any JWT issued up to now is refused from here
  // on, on every device. The API token keeps working.
  router.post('/logout', session, async (_req, res, next) => {
    try {
      await store.setSetting(SESSIONS_VALID_AFTER_KEY, String(Date.now()));
      // requireAuth may have attached a renewal; it would be dead on arrival.
      res.removeHeader(RENEW_HEADER);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
