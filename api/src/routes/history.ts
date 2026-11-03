import { Router } from 'express';
import { resolveToday } from '../db/settings.js';
import type { Store } from '../db/store.js';
import { currentStreak, dueFlags, historyFlags, historyStats } from '../lib/streak.js';
import { isoDate } from '../schemas.js';

export const DESKTOP_HISTORY_DEFAULT_DAYS = 30;
export const DESKTOP_HISTORY_MAX_DAYS = 90;

// GET /api/history?days=30&date=YYYY-MM-DD — the desktop's History window and
// the Today meters in one request: the dates (oldest first, ending at `date`,
// the client's today), each ACTIVE habit's done flags over them in habit order,
// and three stats over the same range — or over its last `statsDays` days, so
// the page can draw a column or two beyond the stats' 30 (the read-only day 31).
// Each habit also carries its due flags; rest days count for nothing in the
// stats and the streaks.
// Retired habits are left out, as on /today.
export function historyRouter(store: Store): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const end =
        req.query.date === undefined ? await resolveToday(store) : isoDate.parse(req.query.date);
      const asked =
        req.query.days === undefined ? DESKTOP_HISTORY_DEFAULT_DAYS : Number(req.query.days);
      if (!Number.isInteger(asked)) {
        return res.status(400).json({ error: 'days must be a whole number' });
      }
      const days = Math.min(DESKTOP_HISTORY_MAX_DAYS, Math.max(1, asked));
      const askedStats = req.query.statsDays === undefined ? days : Number(req.query.statsDays);
      if (!Number.isInteger(askedStats)) {
        return res.status(400).json({ error: 'statsDays must be a whole number' });
      }
      const statsDays = Math.min(days, Math.max(1, askedStats));

      const habits = await store.listHabits({ includeRetired: false });
      const checks = await store.checkDates(habits.map((h) => h.id));
      const rows = habits.map((h) => {
        const dates = checks.get(h.id) ?? [];
        return {
          habit: h,
          flags: historyFlags(dates, end, days),
          due: dueFlags(h.schedules, end, days),
          streak: currentStreak(new Set(dates), end, h.schedules),
        };
      });
      const dateList = historyFlags([], end, days).map((d) => d.date);

      res.json({
        start: dateList[0],
        end,
        dates: dateList,
        habits: rows.map((r) => ({
          id: r.habit.id,
          slug: r.habit.slug,
          label: r.habit.label,
          done: r.flags.map((f) => f.done),
          // False on rest days: drawn hatched, never counted as missed.
          due: r.due,
          streak: r.streak,
        })),
        stats: historyStats(
          rows.map((r) => r.flags.slice(-statsDays).map((f) => f.done)),
          rows.map((r) => r.streak),
          rows.map((r) => r.due.slice(-statsDays)),
        ),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
