import { Router } from 'express';
import bcrypt from 'bcrypt';
import { securityUpdateSchema, passwordUpdateSchema, timezoneUpdateSchema } from '../schemas.js';
import {
  getAdminPasswordHash,
  setSecurityAnswer,
  verifySecurityAnswer,
  BCRYPT_ROUNDS,
  ADMIN_PASSWORD_HASH_KEY,
  APP_TIMEZONE_KEY,
} from '../db/settings.js';
import type { SettingsStore } from '../db/store.js';
import { isValidTimeZone, todayInZone } from '../lib/dates.js';
import { RENEW_HEADER, SESSIONS_VALID_AFTER_KEY } from '../lib/session.js';

// Mounted under requireAuth in app.ts: JWT only, never the API token.
export function settingsRouter(store: SettingsStore): Router {
  const router = Router();

  // PUT /api/settings/security-answer — change the security answer. Requires the
  // current answer (case-insensitive) to match before updating.
  router.put('/security-answer', async (req, res, next) => {
    try {
      const { currentAnswer, newAnswer } = securityUpdateSchema.parse(req.body);
      if (!(await verifySecurityAnswer(store, currentAnswer))) {
        return res.status(401).json({ error: 'current answer is incorrect' });
      }
      await setSecurityAnswer(store, newAnswer);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/settings/password — change the login password. Requires the current
  // password, so a stolen token alone can't lock the owner out. Stores only the
  // bcrypt hash; the plaintext is never logged or persisted.
  router.put('/password', async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = passwordUpdateSchema.parse(req.body);
      const hash = await getAdminPasswordHash(store);
      if (!hash) {
        return res.status(500).json({ error: 'no password configured' });
      }
      if (!(await bcrypt.compare(currentPassword, hash))) {
        return res.status(401).json({ error: 'current password is incorrect' });
      }
      if (newPassword.trim().length < 8) {
        return res.status(400).json({ error: 'new password must be at least 8 characters' });
      }
      await store.setSetting(
        ADMIN_PASSWORD_HASH_KEY,
        await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
      );
      // A new password ends every browser session, including this one, so a
      // token taken with the old password is useless. The API token is a
      // separate credential and is rotated separately.
      await store.setSetting(SESSIONS_VALID_AFTER_KEY, String(Date.now()));
      res.removeHeader(RENEW_HEADER);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/settings/timezone — the IANA zone defining the user's day boundary.
  // `timezone` is null when never set; the client then falls back to the
  // browser's own zone and persists it.
  router.get('/timezone', async (_req, res, next) => {
    try {
      const tz = await store.getSetting(APP_TIMEZONE_KEY);
      const valid = tz && isValidTimeZone(tz) ? tz : null;
      res.json({ timezone: valid, serverToday: valid ? todayInZone(valid) : null });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/settings/timezone — change the day boundary. Rejects zones the
  // server's ICU data doesn't recognise, so a typo can't silently shift days.
  router.put('/timezone', async (req, res, next) => {
    try {
      const { timezone } = timezoneUpdateSchema.parse(req.body);
      if (!isValidTimeZone(timezone)) {
        return res.status(400).json({ error: `unknown timezone: ${timezone}` });
      }
      await store.setSetting(APP_TIMEZONE_KEY, timezone);
      res.json({ ok: true, timezone, serverToday: todayInZone(timezone) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
