import { Router } from 'express';
import { writableDay } from '../db/settings.js';
import type { DayNote, Store } from '../db/store.js';
import { isoDate, noteSchema } from '../schemas.js';

function noteJson(n: DayNote) {
  return { date: n.date, line: n.line, updatedAt: n.updatedAt.toISOString() };
}

// /api/notes — the optional one-line note for a day.
export function notesRouter(store: Store): Router {
  const router = Router();

  // GET /?from=&to= — inclusive, either bound optional, oldest first.
  router.get('/', async (req, res, next) => {
    try {
      const from = req.query.from === undefined ? undefined : isoDate.parse(req.query.from);
      const to = req.query.to === undefined ? undefined : isoDate.parse(req.query.to);
      res.json((await store.listNotes({ from, to })).map(noteJson));
    } catch (err) {
      next(err);
    }
  });

  // PUT /:date { line } — set the day's note. An empty line deletes it, so the
  // client needs no separate DELETE and a cleared field cannot leave '' behind.
  // Same window as checks: the last 30 days up to tomorrow; older is 403.
  router.put('/:date', async (req, res, next) => {
    try {
      const date = isoDate.parse(req.params.date);
      const { line } = noteSchema.parse(req.body);
      const refused = await writableDay(store, date);
      if (refused) return res.status(refused.status).json({ error: refused.error });
      if (!line) {
        await store.deleteNote(date);
        return res.json({ date, line: null });
      }
      res.json(noteJson(await store.putNote(date, line)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
