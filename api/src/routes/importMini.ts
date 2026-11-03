import { Router } from 'express';
import type { Store } from '../db/store.js';
import { importMiniSchema } from '../schemas.js';

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
// - Bypasses the 30-day backfill window and the future guard that PUT /checks
//   applies — writing history older than that is the whole point.
export function importMiniRouter(store: Store): Router {
  const router = Router();

  router.post('/mini-pht', async (req, res, next) => {
    try {
      const { log } = importMiniSchema.parse(req.body);
      const report = await store.importChecks(log);
      res.json({ days: Object.keys(log).length, ...report });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
