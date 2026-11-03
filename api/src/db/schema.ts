import bcrypt from 'bcrypt';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  BCRYPT_ROUNDS,
  DEFAULT_SECURITY_ANSWER,
  SECURITY_ANSWER_HASH_KEY,
  SECURITY_ANSWER_KEY,
  normalizeAnswer,
} from './settings.js';

// The whole schema, idempotent: safe to run on an empty database, on a current
// one, and on one that still holds the legacy tables. It only ever adds.
//
// It deliberately never mentions protocols, entries, journal_entries,
// gratitude_entries or coach_conversations. Those are removed by hand with
// ops/pht-drop-legacy.sql, and a statement here that touched one would fail on
// every run after that.

interface CountRow extends RowDataPacket {
  c: number;
}

// For columns added to an existing table later. MySQL has no
// ADD COLUMN IF NOT EXISTS before 8.0.29, so check INFORMATION_SCHEMA first.
export async function addColumnIfMissing(
  conn: Connection,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const [rows] = await conn.query<CountRow[]>(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (rows[0].c === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`  + added column ${table}.${column}`);
  }
}

// A generic demo set, seeded on first migrate. POST /import/mini-pht matches a
// widget log by these slugs; habits can be renamed, added or retired in Setup.
export const SEED_HABITS: readonly { slug: string; label: string }[] = [
  { slug: 'stretch', label: 'Stretch' },
  { slug: 'read', label: 'Read 20 minutes' },
  { slug: 'water', label: 'Drink water' },
  { slug: 'journal', label: 'Journal' },
  { slug: 'plan', label: 'Plan tomorrow' },
  { slug: 'tidy', label: 'Tidy up' },
];

export async function applySchema(conn: Connection): Promise<void> {
  // Key/value settings store: credentials, app_timezone, api_token_hash.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(255) NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // The security answer is stored as a bcrypt hash of its normalized form.
  // Older installs kept it in plaintext under `security_answer`; convert that
  // row in place and drop it. Idempotent: after the first run there is no
  // plaintext row left to convert.
  {
    const [hashRows] = await conn.query<RowDataPacket[]>(
      'SELECT value FROM settings WHERE `key` = ? LIMIT 1',
      [SECURITY_ANSWER_HASH_KEY],
    );
    if (hashRows.length === 0) {
      const [plainRows] = await conn.query<RowDataPacket[]>(
        'SELECT value FROM settings WHERE `key` = ? LIMIT 1',
        [SECURITY_ANSWER_KEY],
      );
      const plaintext = plainRows.length ? plainRows[0].value : DEFAULT_SECURITY_ANSWER;
      const hash = await bcrypt.hash(normalizeAnswer(plaintext), BCRYPT_ROUNDS);
      await conn.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', [
        SECURITY_ANSWER_HASH_KEY,
        hash,
      ]);
      console.log(
        plainRows.length
          ? 'migrated security_answer -> security_answer_hash'
          : 'seeded default security_answer_hash',
      );
    }
    const [del] = await conn.query<ResultSetHeader>('DELETE FROM settings WHERE `key` = ?', [
      SECURITY_ANSWER_KEY,
    ]);
    if (del.affectedRows > 0) console.log('removed plaintext security_answer row');
  }

  // A habit is never deleted, only retired: its checks are history worth
  // keeping, and the FK below would refuse the delete anyway.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS habits (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(40) NOT NULL,
      label VARCHAR(80) NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      ramp_text VARCHAR(120) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      retired_at TIMESTAMP NULL DEFAULT NULL,
      UNIQUE KEY uq_habits_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // The schedule in force now (see src/lib/schedule.ts). Every existing habit
  // becomes daily, which is what it always was. `schedule_anchor` is set only
  // for every_other_day, `schedule_days` ("1,3,5", 0 = Sunday) only for
  // weekdays, `schedule_from` is the day it took effect (NULL = always).
  await addColumnIfMissing(conn, 'habits', 'schedule', "VARCHAR(16) NOT NULL DEFAULT 'daily'");
  await addColumnIfMissing(conn, 'habits', 'schedule_anchor', 'DATE NULL DEFAULT NULL');
  await addColumnIfMissing(conn, 'habits', 'schedule_days', 'VARCHAR(16) NULL DEFAULT NULL');
  await addColumnIfMissing(conn, 'habits', 'schedule_from', 'DATE NULL DEFAULT NULL');

  // The schedules a habit had before the current one, in order (`seq`), each
  // from its `from_date` (NULL = since the beginning) until the next one
  // starts. Old days keep the schedule they had, so a change never rewrites
  // past streaks.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS habit_schedule_history (
      habit_id INT NOT NULL,
      seq INT NOT NULL,
      from_date DATE NULL,
      schedule VARCHAR(16) NOT NULL,
      schedule_anchor DATE NULL,
      schedule_days VARCHAR(16) NULL,
      PRIMARY KEY (habit_id, seq),
      CONSTRAINT fk_schedule_history_habit
        FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // One row = that habit was done on that day. Absence is "not done"; there is
  // no false row, which is what makes check and uncheck idempotent.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS checks (
      habit_id INT NOT NULL,
      date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (habit_id, date),
      CONSTRAINT fk_checks_habit
        FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // At most one short line per day. An empty line is a deleted row, not ''.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS day_notes (
      date DATE NOT NULL PRIMARY KEY,
      line VARCHAR(280) NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // "What new thing did I learn today?" — one entry per day.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS learned (
      date DATE NOT NULL PRIMARY KEY,
      text VARCHAR(500) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // AI Wire: every story gathered (src/lib/wire.ts). url_hash is the SHA-256
  // of the canonical URL, title_hash of the normalised title; served_on marks
  // the ones already shown (or skipped), which are never shown again and
  // never pruned.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS wire_candidates (
      url_hash CHAR(64) NOT NULL PRIMARY KEY,
      title_hash CHAR(64) NOT NULL,
      canonical_url VARCHAR(2048) NOT NULL,
      url VARCHAR(2048) NOT NULL,
      title VARCHAR(300) NOT NULL,
      source VARCHAR(160) NOT NULL,
      source_id VARCHAR(40) NOT NULL,
      published_at TIMESTAMP NOT NULL,
      excerpt VARCHAR(400) NULL,
      points INT NULL,
      fetched_at TIMESTAMP NOT NULL,
      served_on DATE NULL,
      KEY idx_wire_title (title_hash),
      KEY idx_wire_fetched (fetched_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // The day's article, one row per date, the same on every device.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS daily_article (
      date DATE NOT NULL PRIMARY KEY,
      url VARCHAR(2048) NOT NULL,
      title VARCHAR(300) NOT NULL,
      source VARCHAR(160) NOT NULL,
      published_at TIMESTAMP NOT NULL,
      excerpt VARCHAR(400) NULL,
      url_hash CHAR(64) NOT NULL,
      title_hash CHAR(64) NOT NULL,
      read_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // The topic tags the article matched, a JSON array, main one first.
  await addColumnIfMissing(conn, 'daily_article', 'topics', 'VARCHAR(400) NULL DEFAULT NULL');
  // The config id of its source, for the dud report.
  await addColumnIfMissing(conn, 'daily_article', 'source_id', 'VARCHAR(40) NULL DEFAULT NULL');

  // Articles passed over with Next ("duds"), for the report that shows which
  // sources keep missing. Read by wireJob --duds; nothing re-weights on them.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS wire_duds (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      url_hash CHAR(64) NOT NULL,
      title VARCHAR(300) NOT NULL,
      source_id VARCHAR(40) NULL,
      source VARCHAR(160) NOT NULL,
      tier VARCHAR(40) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_duds_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Seed only an empty table, so a habit retired or relabelled later is never
  // resurrected or overwritten by a re-run.
  const [count] = await conn.query<CountRow[]>('SELECT COUNT(*) AS c FROM habits');
  if (count[0].c === 0) {
    await conn.query('INSERT INTO habits (slug, label, sort) VALUES ?', [
      SEED_HABITS.map((h, i) => [h.slug, h.label, i + 1]),
    ]);
    console.log(`seeded ${SEED_HABITS.length} habits`);
  }
}
