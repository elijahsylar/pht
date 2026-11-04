import { Router } from 'express';
import type { Store } from '../db/store.js';
import { importMiniSchema } from '../schemas.js';
import { latestWritableDate } from '../db/settings.js';

// POST /api/import/mini-pht { log: { "YYYY-MM-DD": [slug, ...] } }
//
// One-way import of the iPhone Scriptable widget's own log, so the history
// kept there before this API existed is not lost. JWT only; run it with
// ops/pht-import-mini.sh.
//
// - Matched by slug. A slug with no habit is ignored and listed in the report.
// - One transaction: a failure leaves nothing half-imported.
// - Idempotent: a second run inserts nothing and reports it all as present.
// - Additive only. It never removes a check that is missing from the log.
// - Bypasses the 30-day backfill window that PUT /checks applies — writing
//   history older than that is the whole point — but not the future guard:
//   nothing after tomorrow, and nothing before 1970. A check in year 9999 made
//   GET /api/today fail for good, and could not be deleted through the API.
const EARLIEST_IMPORT_DATE = '1970-01-01';
export function importMiniRouter(store: Store): Router {
  const router = Router();

  router.post('/mini-pht', async (req, res, next) => {
    try {
      const { log } = importMiniSchema.parse(req.body);
      const latest = await latestWritableDate(store);
      const bad = Object.keys(log).filter((d) => d > latest || d < EARLIEST_IMPORT_DATE).sort();
      if (bad.length) {
        res.status(400).json({ error: `dates outside ${EARLIEST_IMPORT_DATE}..${latest}: ${bad.slice(0, 5).join(', ')}` });
        return;
      }
      const report = await store.importChecks(log);
      res.json({ days: Object.keys(log).length, ...report });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
