import { Router } from 'express';
import { writableDay } from '../db/settings.js';
import type { Learned, Store } from '../db/store.js';
import { isoDate, learnedQuery, learnedSchema } from '../schemas.js';

export function learnedJson(l: Learned) {
  return { date: l.date, text: l.text, updatedAt: l.updatedAt.toISOString() };
}

// /api/learned — "What new thing did I learn today?", one entry a day.
export function learnedRouter(store: Store): Router {
  const router = Router();

  // GET /?from=&to=&q=&limit=&offset= — newest first, one page. `q` is a
  // case-insensitive search of the text; `total` counts every match.
  router.get('/', async (req, res, next) => {
    try {
      const query = learnedQuery.parse(req.query);
      const { entries, total } = await store.listLearned({ ...query, q: query.q || undefined });
      res.json({ entries: entries.map(learnedJson), total, limit: query.limit, offset: query.offset });
    } catch (err) {
      next(err);
    }
  });

  // PUT /:date { text } — set the day's entry; empty deletes it. The same
  // window and date rules as notes: the last 30 days up to tomorrow.
  router.put('/:date', async (req, res, next) => {
    try {
      const date = isoDate.parse(req.params.date);
      const { text } = learnedSchema.parse(req.body);
      const refused = await writableDay(store, date);
      if (refused) return res.status(refused.status).json({ error: refused.error });
      if (!text) {
        await store.deleteLearned(date);
        return res.json({ date, text: null });
      }
      res.json(learnedJson(await store.putLearned(date, text)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
