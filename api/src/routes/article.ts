import { Router } from 'express';
import { z } from 'zod';
import { resolveToday } from '../db/settings.js';
import type { Store } from '../db/store.js';
import { addDays } from '../lib/dates.js';
import { articleJson, isLiveDate, type WireService } from '../lib/wireService.js';
import { isoDate } from '../schemas.js';

// The past list: the seven days before the one asked for.
export const PAST_DAYS = 7;

const dayBody = z.object({ date: isoDate.optional() }).strict();

// /api/article — AI Wire. GET returns the day's article (choosing it on the
// first request of a day the 03:30 job has not reached yet), the status
// ('ok', or 'no-signal' when nothing qualifies), `queue` (how many qualifying
// stories wait behind it; 0 for a day that is not live), and the last seven
// days' articles with their read flags. POST /skip ("Next") swaps in the next
// best and records the passed one as a dud; POST /read marks it read. Mounted
// for the JWT or the API token.
export function articleRouter(store: Store, wire: WireService): Router {
  const router = Router();

  const dateOf = async (raw: unknown) => (raw === undefined ? resolveToday(store) : isoDate.parse(raw));

  router.get('/', async (req, res, next) => {
    try {
      const date = await dateOf(req.query.date);
      const live = await isLiveDate(store, date);
      if (!live && date > (await resolveToday(store))) {
        return res.status(400).json({ error: 'date is in the future' });
      }
      const article = live ? await wire.ensure(date) : await store.getDailyArticle(date);
      const past = await store.listDailyArticles(addDays(date, -PAST_DAYS), addDays(date, -1));
      res.json({
        date,
        status: article ? 'ok' : 'no-signal',
        article: article ? articleJson(article) : null,
        queue: live && article ? await wire.queue() : 0,
        past: past.map(articleJson),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/skip', async (req, res, next) => {
    try {
      const date = await dateOf(dayBody.parse(req.body ?? {}).date);
      if (!(await isLiveDate(store, date))) {
        return res.status(409).json({ error: "only today's article can be skipped" });
      }
      if (!(await store.getDailyArticle(date))) return res.status(404).json({ error: 'no article for that day' });
      const next = await wire.skip(date);
      if (!next) return res.status(409).json({ error: 'nothing else on the wire today' });
      res.json({ article: articleJson(next), queue: await wire.queue() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/read', async (req, res, next) => {
    try {
      const date = await dateOf(dayBody.parse(req.body ?? {}).date);
      const a = await store.markArticleRead(date);
      if (!a) return res.status(404).json({ error: 'no article for that day' });
      res.json({ article: articleJson(a) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
