import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { toIsoDate } from '../lib/dates.js';
import {
  scheduleFromColumns,
  scheduleToColumns,
  withSchedule,
  type ScheduleSpan,
} from '../lib/schedule.js';
import {
  DuplicateSlugError,
  type DayNote,
  type Habit,
  type HabitPatch,
  type DailyArticle,
  type Learned,
  type ImportReport,
  type NewHabit,
  type Store,
  type StoredCandidate,
} from './store.js';

// TIMESTAMP columns are read through UNIX_TIMESTAMP() rather than as Dates.
// mysql2 builds a Date from a TIMESTAMP using the connection's `timezone`
// option, which is only right when it matches the MySQL session zone; epoch
// seconds are the same number whatever either side is set to.
const HABIT_COLS = `id, slug, label, sort, ramp_text,
  UNIX_TIMESTAMP(created_at) AS created_epoch,
  UNIX_TIMESTAMP(retired_at) AS retired_epoch,
  schedule, schedule_anchor, schedule_days, schedule_from`;

interface HabitRow extends RowDataPacket {
  id: number;
  slug: string;
  label: string;
  sort: number;
  ramp_text: string | null;
  created_epoch: number | string;
  retired_epoch: number | string | null;
  schedule: string;
  schedule_anchor: string | Date | null;
  schedule_days: string | null;
  schedule_from: string | Date | null;
}

interface ScheduleHistoryRow extends RowDataPacket {
  habit_id: number;
  from_date: string | Date | null;
  schedule: string;
  schedule_anchor: string | Date | null;
  schedule_days: string | null;
}

const isoOrNull = (d: string | Date | null): string | null => (d === null ? null : toIsoDate(d));

function spanOf(r: {
  schedule: string;
  schedule_anchor: string | Date | null;
  schedule_days: string | null;
}, from: string | Date | null): ScheduleSpan {
  return {
    from: isoOrNull(from),
    schedule: scheduleFromColumns({
      kind: r.schedule,
      anchor: isoOrNull(r.schedule_anchor),
      days: r.schedule_days,
    }),
  };
}

interface NoteRow extends RowDataPacket {
  date: string | Date;
  line: string;
  updated_epoch: number | string;
}

const fromEpoch = (s: number | string): Date => new Date(Number(s) * 1000);

// `past` are the habit's history rows, in seq order.
function toHabit(r: HabitRow, past: ScheduleHistoryRow[]): Habit {
  const current = spanOf(r, r.schedule_from);
  const schedules = [...past.map((p) => spanOf(p, p.from_date)), current];
  // The first span always reaches back to the beginning.
  schedules[0] = { ...schedules[0], from: null };
  return {
    id: r.id,
    slug: r.slug,
    label: r.label,
    sort: r.sort,
    rampText: r.ramp_text,
    createdAt: fromEpoch(r.created_epoch),
    retiredAt: r.retired_epoch === null ? null : fromEpoch(r.retired_epoch),
    schedule: current.schedule,
    schedules,
  };
}

function toNote(r: NoteRow): DayNote {
  return { date: toIsoDate(r.date), line: r.line, updatedAt: fromEpoch(r.updated_epoch) };
}

const NOTE_COLS = 'date, line, UNIX_TIMESTAMP(updated_at) AS updated_epoch';

const LEARNED_COLS = 'date, text, UNIX_TIMESTAMP(created_at) AS created_epoch, UNIX_TIMESTAMP(updated_at) AS updated_epoch';

function toLearned(r: RowDataPacket): Learned {
  return {
    date: toIsoDate(r.date),
    text: r.text,
    createdAt: fromEpoch(r.created_epoch),
    updatedAt: fromEpoch(r.updated_epoch),
  };
}

// A LIKE pattern matching `s` literally anywhere.
const likeAnywhere = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const CAND_COLS = `url_hash, title_hash, canonical_url, url, title, source, source_id,
  UNIX_TIMESTAMP(published_at) AS published_epoch, excerpt, points,
  UNIX_TIMESTAMP(fetched_at) AS fetched_epoch, served_on`;

function toCandidate(r: RowDataPacket): StoredCandidate {
  return {
    urlHash: r.url_hash,
    titleHash: r.title_hash,
    canonicalUrl: r.canonical_url,
    url: r.url,
    title: r.title,
    source: r.source,
    sourceId: r.source_id,
    publishedAt: fromEpoch(r.published_epoch),
    excerpt: r.excerpt,
    points: r.points === null ? null : Number(r.points),
    fetchedAt: fromEpoch(r.fetched_epoch),
    servedOn: r.served_on === null ? null : toIsoDate(r.served_on),
  };
}

const ARTICLE_COLS = `date, url, title, source, UNIX_TIMESTAMP(published_at) AS published_epoch,
  excerpt, url_hash, title_hash, topics, source_id, UNIX_TIMESTAMP(read_at) AS read_epoch`;

function parseTopics(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toArticle(r: RowDataPacket): DailyArticle {
  return {
    date: toIsoDate(r.date),
    url: r.url,
    title: r.title,
    source: r.source,
    publishedAt: fromEpoch(r.published_epoch),
    excerpt: r.excerpt,
    urlHash: r.url_hash,
    titleHash: r.title_hash,
    topics: parseTopics(r.topics),
    sourceId: r.source_id ?? null,
    readAt: r.read_epoch === null ? null : fromEpoch(r.read_epoch),
  };
}

// Epoch seconds for FROM_UNIXTIME, which reads them in the session zone and
// UNIX_TIMESTAMP reverses exactly.
const epoch = (d: Date) => d.getTime() / 1000;

export function createMysqlStore(pool: Pool): Store {
  async function withHistory(rows: HabitRow[]): Promise<Habit[]> {
    if (!rows.length) return [];
    const [past] = await pool.query<ScheduleHistoryRow[]>(
      `SELECT habit_id, from_date, schedule, schedule_anchor, schedule_days
       FROM habit_schedule_history WHERE habit_id IN (?) ORDER BY habit_id, seq`,
      [rows.map((r) => r.id)],
    );
    return rows.map((r) => toHabit(r, past.filter((p) => p.habit_id === r.id)));
  }

  async function getHabit(id: number): Promise<Habit | null> {
    const [rows] = await pool.query<HabitRow[]>(
      `SELECT ${HABIT_COLS} FROM habits WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows.length ? (await withHistory(rows))[0] : null;
  }

  async function getLearned(date: string): Promise<Learned | null> {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${LEARNED_COLS} FROM learned WHERE date = ? LIMIT 1`, [date]);
    return rows.length ? toLearned(rows[0]) : null;
  }

  async function getNote(date: string): Promise<DayNote | null> {
    const [rows] = await pool.query<NoteRow[]>(
      `SELECT ${NOTE_COLS} FROM day_notes WHERE date = ? LIMIT 1`,
      [date],
    );
    return rows.length ? toNote(rows[0]) : null;
  }

  return {
    async getSetting(key) {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT value FROM settings WHERE `key` = ? LIMIT 1',
        [key],
      );
      return rows.length ? (rows[0].value as string) : null;
    },

    async setSetting(key, value) {
      await pool.query(
        'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [key, value],
      );
    },

    async deleteSetting(key) {
      await pool.query('DELETE FROM settings WHERE `key` = ?', [key]);
    },

    async listHabits({ includeRetired }) {
      const [rows] = await pool.query<HabitRow[]>(
        `SELECT ${HABIT_COLS} FROM habits
         ${includeRetired ? '' : 'WHERE retired_at IS NULL'}
         ORDER BY sort, id`,
      );
      return withHistory(rows);
    },

    getHabit,

    async createHabit(h: NewHabit) {
      try {
        const [res] = await pool.query<ResultSetHeader>(
          `INSERT INTO habits (slug, label, sort, ramp_text)
           SELECT ?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM habits AS h)), ?`,
          [h.slug, h.label, h.sort ?? null, h.rampText],
        );
        return (await getHabit(res.insertId)) as Habit;
      } catch (err) {
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
          throw new DuplicateSlugError(h.slug);
        }
        throw err;
      }
    },

    async updateHabit(id: number, patch: HabitPatch) {
      const sets: string[] = [];
      const args: unknown[] = [];
      if (patch.label !== undefined) {
        sets.push('label = ?');
        args.push(patch.label);
      }
      if (patch.sort !== undefined) {
        sets.push('sort = ?');
        args.push(patch.sort);
      }
      if (patch.rampText !== undefined) {
        sets.push('ramp_text = ?');
        args.push(patch.rampText);
      }
      // Retiring an already-retired habit keeps its original retired_at.
      if (patch.retired === true) sets.push('retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP)');
      if (patch.retired === false) sets.push('retired_at = NULL');
      if (sets.length) {
        await pool.query(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
      }
      return getHabit(id);
    },

    async setSchedule(id, schedule, from) {
      const habit = await getHabit(id);
      if (!habit) return null;
      const spans = withSchedule(habit.schedules, schedule, from);
      const current = spans[spans.length - 1];
      const cols = scheduleToColumns(current.schedule);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Rewrite the whole timeline: it is a handful of rows at most.
        await conn.query('DELETE FROM habit_schedule_history WHERE habit_id = ?', [id]);
        const past = spans.slice(0, -1);
        if (past.length) {
          await conn.query(
            `INSERT INTO habit_schedule_history
               (habit_id, seq, from_date, schedule, schedule_anchor, schedule_days) VALUES ?`,
            [
              past.map((p, i) => {
                const c = scheduleToColumns(p.schedule);
                return [id, i, p.from, c.kind, c.anchor, c.days];
              }),
            ],
          );
        }
        await conn.query(
          `UPDATE habits SET schedule = ?, schedule_anchor = ?, schedule_days = ?, schedule_from = ?
           WHERE id = ?`,
          [cols.kind, cols.anchor, cols.days, current.from, id],
        );
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      return getHabit(id);
    },

    async addCheck(habitId, date) {
      await pool.query('INSERT IGNORE INTO checks (habit_id, date) VALUES (?, ?)', [habitId, date]);
    },

    async removeCheck(habitId, date) {
      await pool.query('DELETE FROM checks WHERE habit_id = ? AND date = ?', [habitId, date]);
    },

    async checkDates(habitIds) {
      const out = new Map<number, string[]>(habitIds.map((id) => [id, []]));
      if (!habitIds.length) return out;
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT habit_id, date FROM checks WHERE habit_id IN (?) ORDER BY date',
        [habitIds],
      );
      for (const r of rows) out.get(r.habit_id as number)?.push(toIsoDate(r.date));
      return out;
    },

    getNote,

    async listNotes({ from, to }) {
      const where: string[] = [];
      const args: string[] = [];
      if (from) {
        where.push('date >= ?');
        args.push(from);
      }
      if (to) {
        where.push('date <= ?');
        args.push(to);
      }
      const [rows] = await pool.query<NoteRow[]>(
        `SELECT ${NOTE_COLS} FROM day_notes
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY date`,
        args,
      );
      return rows.map(toNote);
    },

    async putNote(date, line) {
      await pool.query(
        'INSERT INTO day_notes (date, line) VALUES (?, ?) ON DUPLICATE KEY UPDATE line = VALUES(line)',
        [date, line],
      );
      return (await getNote(date)) as DayNote;
    },

    async deleteNote(date) {
      await pool.query('DELETE FROM day_notes WHERE date = ?', [date]);
    },

    getLearned,

    async listLearned({ from, to, q, limit, offset }) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (from) {
        where.push('date >= ?');
        args.push(from);
      }
      if (to) {
        where.push('date <= ?');
        args.push(to);
      }
      // The column's collation (utf8mb4_unicode_ci) makes LIKE case-insensitive.
      if (q) {
        where.push('text LIKE ?');
        args.push(likeAnywhere(q));
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [[count], [rows]] = await Promise.all([
        pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM learned ${clause}`, args),
        pool.query<RowDataPacket[]>(`SELECT ${LEARNED_COLS} FROM learned ${clause} ORDER BY date DESC LIMIT ? OFFSET ?`, [
          ...args,
          limit,
          offset,
        ]),
      ]);
      return { entries: rows.map(toLearned), total: Number(count[0].c) };
    },

    async putLearned(date, text) {
      await pool.query('INSERT INTO learned (date, text) VALUES (?, ?) ON DUPLICATE KEY UPDATE text = VALUES(text)', [
        date,
        text,
      ]);
      return (await getLearned(date)) as Learned;
    },

    async deleteLearned(date) {
      await pool.query('DELETE FROM learned WHERE date = ?', [date]);
    },

    async upsertWireCandidates(list, fetchedAt) {
      for (let i = 0; i < list.length; i += 200) {
        const rows = list.slice(i, i + 200).map((c) => [
          c.urlHash, c.titleHash, c.canonicalUrl, c.url, c.title, c.source, c.sourceId,
          epoch(c.publishedAt), c.excerpt, c.points, epoch(fetchedAt),
        ]);
        await pool.query(
          `INSERT INTO wire_candidates
             (url_hash, title_hash, canonical_url, url, title, source, source_id,
              published_at, excerpt, points, fetched_at)
           VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?, FROM_UNIXTIME(?))').join(', ')}
           AS new
           ON DUPLICATE KEY UPDATE
             fetched_at = GREATEST(wire_candidates.fetched_at, new.fetched_at),
             points = CASE
               WHEN new.points IS NULL THEN wire_candidates.points
               WHEN wire_candidates.points IS NULL THEN new.points
               ELSE GREATEST(wire_candidates.points, new.points) END,
             excerpt = COALESCE(wire_candidates.excerpt, new.excerpt)`,
          rows.flat(),
        );
      }
    },

    async wirePool(since) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${CAND_COLS} FROM wire_candidates
         WHERE served_on IS NULL AND fetched_at >= FROM_UNIXTIME(?)`,
        [epoch(since)],
      );
      return rows.map(toCandidate);
    },

    async wireServedTitleHashes() {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT DISTINCT title_hash FROM wire_candidates WHERE served_on IS NOT NULL',
      );
      return new Set(rows.map((r) => r.title_hash as string));
    },

    async markWireServed(urlHash, date) {
      await pool.query(
        'UPDATE wire_candidates SET served_on = COALESCE(served_on, ?) WHERE url_hash = ?',
        [date, urlHash],
      );
    },

    async pruneWireCandidates(before) {
      await pool.query(
        'DELETE FROM wire_candidates WHERE served_on IS NULL AND fetched_at < FROM_UNIXTIME(?)',
        [epoch(before)],
      );
    },

    async getDailyArticle(date) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${ARTICLE_COLS} FROM daily_article WHERE date = ? LIMIT 1`,
        [date],
      );
      return rows.length ? toArticle(rows[0]) : null;
    },

    async listDailyArticles(from, to) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${ARTICLE_COLS} FROM daily_article WHERE date >= ? AND date <= ? ORDER BY date DESC`,
        [from, to],
      );
      return rows.map(toArticle);
    },

    async insertDailyArticle(a) {
      const [res] = await pool.query<ResultSetHeader>(
        `INSERT IGNORE INTO daily_article
           (date, url, title, source, published_at, excerpt, url_hash, title_hash, topics, source_id)
         VALUES (?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?)`,
        [a.date, a.url, a.title, a.source, epoch(a.publishedAt), a.excerpt, a.urlHash, a.titleHash, JSON.stringify(a.topics),
          a.sourceId],
      );
      return res.affectedRows === 1;
    },

    async replaceDailyArticle(expectedUrlHash, a) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE daily_article SET url = ?, title = ?, source = ?, published_at = FROM_UNIXTIME(?),
           excerpt = ?, url_hash = ?, title_hash = ?, topics = ?, source_id = ?, read_at = NULL
         WHERE date = ? AND url_hash = ?`,
        [a.url, a.title, a.source, epoch(a.publishedAt), a.excerpt, a.urlHash, a.titleHash, JSON.stringify(a.topics),
          a.sourceId, a.date, expectedUrlHash],
      );
      return res.affectedRows === 1;
    },

    async markArticleRead(date) {
      await pool.query(
        'UPDATE daily_article SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE date = ?',
        [date],
      );
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${ARTICLE_COLS} FROM daily_article WHERE date = ? LIMIT 1`,
        [date],
      );
      return rows.length ? toArticle(rows[0]) : null;
    },

    async recordWireDud(d) {
      await pool.query(
        'INSERT INTO wire_duds (date, url_hash, title, source_id, source, tier) VALUES (?, ?, ?, ?, ?, ?)',
        [d.date, d.urlHash, d.title, d.sourceId, d.source, d.tier],
      );
    },

    async listWireDuds(since) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT date, url_hash, title, source_id, source, tier, UNIX_TIMESTAMP(created_at) AS created_epoch
         FROM wire_duds WHERE date >= ? ORDER BY date DESC, id DESC`,
        [since],
      );
      return rows.map((r) => ({
        date: toIsoDate(r.date),
        urlHash: r.url_hash,
        title: r.title,
        sourceId: r.source_id,
        source: r.source,
        tier: r.tier,
        createdAt: fromEpoch(r.created_epoch),
      }));
    },

    async importChecks(log) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [habits] = await conn.query<RowDataPacket[]>('SELECT id, slug FROM habits');
        const idBySlug = new Map(habits.map((h) => [h.slug as string, h.id as number]));

        const unknown = new Set<string>();
        // Deduplicated, so the affected-row count below is exactly the number
        // of new checks and the remainder is exactly what was already stored.
        const pairs = new Map<string, [number, string]>();
        for (const [date, slugs] of Object.entries(log)) {
          for (const slug of slugs) {
            const id = idBySlug.get(slug);
            if (id === undefined) unknown.add(slug);
            else pairs.set(`${id}|${date}`, [id, date]);
          }
        }

        let inserted = 0;
        const all = [...pairs.values()];
        for (let i = 0; i < all.length; i += 500) {
          const [res] = await conn.query<ResultSetHeader>(
            'INSERT IGNORE INTO checks (habit_id, date) VALUES ?',
            [all.slice(i, i + 500)],
          );
          inserted += res.affectedRows;
        }
        await conn.commit();
        const report: ImportReport = {
          inserted,
          alreadyPresent: all.length - inserted,
          unknownSlugs: [...unknown].sort(),
        };
        return report;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    },
  };
}
