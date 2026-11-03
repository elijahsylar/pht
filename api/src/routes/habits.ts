import { Router } from 'express';
import { resolveToday } from '../db/settings.js';
import { DuplicateSlugError, type Habit, type Store } from '../db/store.js';
import { normalizeSchedule } from '../lib/schedule.js';
import { dueFlags, historyFlags } from '../lib/streak.js';
import { jwtOnly } from '../middleware/auth.js';
import { habitCreateSchema, habitPatchSchema, idParam, isoDate } from '../schemas.js';

const HISTORY_DEFAULT_DAYS = 14;
const HISTORY_MAX_DAYS = 366;

function habitJson(h: Habit) {
  return {
    id: h.id,
    slug: h.slug,
    label: h.label,
    sort: h.sort,
    rampText: h.rampText,
    createdAt: h.createdAt.toISOString(),
    retiredAt: h.retiredAt ? h.retiredAt.toISOString() : null,
    schedule: h.schedule,
    // The day the current schedule took effect; null = always.
    scheduleFrom: h.schedules[h.schedules.length - 1].from,
  };
}

// /api/habits — the habit list and its management. Mounted behind
// requireAuthOrToken; the two GETs are open to the API token, the writes add
// jwtOnly. There is no DELETE: a habit is retired, never removed.
export function habitsRouter(store: Store): Router {
  const router = Router();

  // Every habit, retired ones included (retiredAt tells them apart), so the
  // management view can offer to bring one back.
  router.get('/', async (_req, res, next) => {
    try {
      res.json((await store.listHabits({ includeRetired: true })).map(habitJson));
    } catch (err) {
      next(err);
    }
  });

  // GET /:id/history?days=14&date= — one boolean per day, oldest first, ending
  // at `date` (the client's today). Works for a retired habit: its history is
  // kept.
  router.get('/:id/history', async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const end =
        req.query.date === undefined
          ? await resolveToday(store)
          : isoDate.parse(req.query.date);
      const asked = req.query.days === undefined ? HISTORY_DEFAULT_DAYS : Number(req.query.days);
      if (!Number.isInteger(asked)) {
        return res.status(400).json({ error: 'days must be a whole number' });
      }
      const days = Math.min(HISTORY_MAX_DAYS, Math.max(1, asked));

      const habit = await store.getHabit(id);
      if (!habit) return res.status(404).json({ error: 'no such habit' });
      const dates = (await store.checkDates([id])).get(id) ?? [];
      const due = dueFlags(habit.schedules, end, days);
      res.json({
        habitId: id,
        slug: habit.slug,
        days: historyFlags(dates, end, days).map((d, i) => ({ ...d, due: due[i] })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', jwtOnly, async (req, res, next) => {
    try {
      const body = habitCreateSchema.parse(req.body);
      const habit = await store.createHabit({
        slug: body.slug,
        label: body.label,
        sort: body.sort,
        rampText: body.rampText ?? null,
      });
      res.status(201).json(habitJson(habit));
    } catch (err) {
      if (err instanceof DuplicateSlugError) {
        return res.status(409).json({ error: 'slug already exists' });
      }
      next(err);
    }
  });

  // PATCH /:id — label, sort, rampText, `retired: true|false`, and
  // `schedule` (from `scheduleFrom`, the client's today, on).
  router.patch('/:id', jwtOnly, async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const body = habitPatchSchema.parse(req.body);
      if (body.schedule !== undefined) {
        const from = body.scheduleFrom ?? (await resolveToday(store));
        if (!(await store.setSchedule(id, normalizeSchedule(body.schedule), from))) {
          return res.status(404).json({ error: 'no such habit' });
        }
      }
      const habit = await store.updateHabit(id, {
        label: body.label,
        sort: body.sort,
        rampText: body.rampText,
        retired: body.retired,
      });
      if (!habit) return res.status(404).json({ error: 'no such habit' });
      res.json(habitJson(habit));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
