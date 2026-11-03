import { Router } from 'express';
import { resolveToday } from '../db/settings.js';
import type { Store } from '../db/store.js';
import { summarize } from '../lib/streak.js';
import { isoDate } from '../schemas.js';

// GET /api/today?date=YYYY-MM-DD — everything the checklist page and the
// widget need in one request: the active habits in order, each with today's
// state and its streak numbers, plus the day's note and what was learned.
//
// `date` is the client's today. Omitted, it falls back to the app timezone.
export function todayRouter(store: Store): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const date =
        req.query.date === undefined
          ? await resolveToday(store)
          : isoDate.parse(req.query.date);

      const habits = await store.listHabits({ includeRetired: false });
      const [checks, note, learned] = await Promise.all([
        store.checkDates(habits.map((h) => h.id)),
        store.getNote(date),
        store.getLearned(date),
      ]);

      const rows = habits.map((h) => {
        const s = summarize(checks.get(h.id) ?? [], date, h.schedules);
        return {
          id: h.id,
          slug: h.slug,
          label: h.label,
          done: s.done,
          // False on a rest day: shown dimmed, still checkable, and a check
          // there leaves the streak alone.
          due: s.due,
          schedule: h.schedule,
          streak: s.streak,
          best: s.best,
          totalDone: s.totalDone,
          rampText: h.rampText,
          milestone: s.milestone,
        };
      });

      const due = rows.filter((r) => r.due);
      res.json({
        date,
        doneCount: rows.filter((r) => r.done).length,
        total: rows.length,
        // The habits due on `date`, and how many of those are done: what
        // "all done" means on a day with rest days in it.
        dueCount: due.length,
        dueDone: due.filter((r) => r.done).length,
        note: note ? note.line : null,
        learned: learned ? learned.text : null,
        habits: rows,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
