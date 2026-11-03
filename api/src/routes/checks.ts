import { Router, type Response } from 'express';
import { writableDay } from '../db/settings.js';
import type { Habit, Store } from '../db/store.js';
import { idParam, isoDate } from '../schemas.js';

// PUT and DELETE /api/checks/:habitId/:date — mark a habit done or not done on
// a day. Both are idempotent: repeating either is a 200 with the same body, so
// a widget retrying on a flaky connection can never double-count or error.
//
// Both accept any day in the backfill window: the last 30 days (app timezone)
// up to tomorrow, whatever the habit's created_at. Older is 403 "read-only";
// later is 400. POST /import/mini-pht is the one way to write older history.
export function checksRouter(store: Store): Router {
  const router = Router();

  // The habit must exist (404) and be active (409). A retired habit's history
  // is frozen until it is unretired.
  async function activeHabit(id: number, res: Response): Promise<Habit | null> {
    const habit = await store.getHabit(id);
    if (!habit) {
      res.status(404).json({ error: 'no such habit' });
      return null;
    }
    if (habit.retiredAt) {
      res.status(409).json({ error: 'habit is retired' });
      return null;
    }
    return habit;
  }

  router.put('/:habitId/:date', async (req, res, next) => {
    try {
      const habitId = idParam.parse(req.params.habitId);
      const date = isoDate.parse(req.params.date);
      if (!(await activeHabit(habitId, res))) return;
      const refused = await writableDay(store, date);
      if (refused) return res.status(refused.status).json({ error: refused.error });
      await store.addCheck(habitId, date);
      res.json({ habitId, date, done: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:habitId/:date', async (req, res, next) => {
    try {
      const habitId = idParam.parse(req.params.habitId);
      const date = isoDate.parse(req.params.date);
      if (!(await activeHabit(habitId, res))) return;
      const refused = await writableDay(store, date);
      if (refused) return res.status(refused.status).json({ error: refused.error });
      await store.removeCheck(habitId, date);
      res.json({ habitId, date, done: false });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
