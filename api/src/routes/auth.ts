import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { loginSchema, securityVerifySchema } from '../schemas.js';
import { requireAuth, requirePartial, type AuthedRequest } from '../middleware/auth.js';
import { getAdminPasswordHash, verifySecurityAnswer } from '../db/settings.js';
import type { SettingsStore } from '../db/store.js';
import { RENEW_HEADER, SESSIONS_VALID_AFTER_KEY, issueSessionToken } from '../lib/session.js';

// The browser login: password, then security answer, then a 30-day sliding
// JWT (lib/session.ts). The API token plays no part here and is rejected by
// /verify and /logout.
export function authRouter(store: SettingsStore): Router {
  const router = Router();

  // Step 1 — password. On success issues only a short-lived PARTIAL token; the
  // security answer (step 2) is still required before a full token is granted.
  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = loginSchema.parse(req.body);
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
      const partialToken = jwt.sign(
        { username, stage: 'partial' },
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
  router.post('/verify-security', requirePartial, async (req: AuthedRequest, res, next) => {
    try {
      const { answer } = securityVerifySchema.parse(req.body);
      if (!(await verifySecurityAnswer(store, answer))) {
        return res.status(401).json({ error: 'incorrect answer' });
      }
      const username = req.user?.username ?? (process.env.ADMIN_USERNAME as string);
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
