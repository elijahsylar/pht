import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql, { type Connection, type Pool, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createMysqlStore } from '../../src/db/mysqlStore.js';
import { SEED_HABITS, applySchema } from '../../src/db/schema.js';
import { API_TOKEN_HASH_KEY, apiTokenMatches } from '../../src/lib/apiToken.js';
import { storeContract } from '../storeContract.js';
import { COACH_SETTING_KEYS, LEGACY_TABLES, createLegacySchema } from './legacySchema.js';

// Real-MySQL suite. Opt-in: skipped unless PHT_TEST_DB_HOST is set, which
// `npm run test:mysql` does after starting a throwaway mysql:8.4 container.
//
// It drops and recreates databases, so it refuses any database whose name does
// not start with `pht_test` — it can never be aimed at a real one by a stray
// environment variable.

const env = process.env;
const enabled = Boolean(env.PHT_TEST_DB_HOST);
const DB = env.PHT_TEST_DB_NAME ?? 'pht_test';
const REPO = path.resolve(__dirname, '../..');
// Every table applySchema creates, sorted.
const APP_TABLES = [
  'checks',
  'daily_article',
  'day_notes',
  'habit_schedule_history',
  'habits',
  'learned',
  'settings',
  'wire_candidates',
  'wire_duds',
];
const DROP_SQL = path.join(REPO, 'ops/pht-drop-legacy.sql');
const ROTATE_SH = path.join(REPO, 'ops/pht-rotate-token.sh');

const base = {
  host: env.PHT_TEST_DB_HOST,
  port: Number(env.PHT_TEST_DB_PORT ?? 3306),
  user: env.PHT_TEST_DB_USER ?? 'root',
  password: env.PHT_TEST_DB_PASSWORD ?? '',
  charset: 'utf8mb4',
};

async function tables(conn: Connection | Pool): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
  );
  return rows.map((r) => r.t as string);
}

async function settings(conn: Connection | Pool): Promise<Record<string, string>> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT `key`, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key as string, r.value as string]));
}

async function count(conn: Connection | Pool, table: string): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`${table}\``);
  return Number(rows[0].c);
}

describe.skipIf(!enabled)('MySQL 8.4', () => {
  let admin: Connection;
  let pool: Pool;

  // A brand-new empty database, and a pool on it configured like src/db/pool.ts.
  async function freshDb(): Promise<Pool> {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await admin.query(
      `CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    pool = mysql.createPool({ ...base, database: DB, connectionLimit: 4, dateStrings: ['DATE'] });
    return pool;
  }

  async function migrate(p: Pool): Promise<void> {
    const conn = await p.getConnection();
    try {
      await applySchema(conn);
    } finally {
      conn.release();
    }
  }

  // Run a .sql file the way `mysql < file` does: as one multi-statement script.
  async function runSqlFile(file: string): Promise<void> {
    const conn = await mysql.createConnection({ ...base, database: DB, multipleStatements: true });
    try {
      await conn.query(readFileSync(file, 'utf8'));
    } finally {
      await conn.end();
    }
  }

  beforeAll(async () => {
    if (!DB.startsWith('pht_test')) {
      throw new Error(`refusing to run against database "${DB}": name must start with pht_test`);
    }
    admin = await mysql.createConnection(base);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
      await admin.end();
    }
  });

  describe('applySchema', () => {
    it('builds the schema and the seed on an empty database', async () => {
      const p = await freshDb();
      expect(await tables(p)).toEqual([]);
      await migrate(p);

      expect(await tables(p)).toEqual(APP_TABLES);

      const [habits] = await p.query<RowDataPacket[]>(
        'SELECT slug, label, sort, ramp_text, retired_at FROM habits ORDER BY sort',
      );
      expect(habits.map((h) => ({ slug: h.slug, label: h.label }))).toEqual([...SEED_HABITS]);
      expect(habits.map((h) => h.sort)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(habits.every((h) => h.ramp_text === null && h.retired_at === null)).toBe(true);

      expect(await count(p, 'checks')).toBe(0);
      expect(await count(p, 'day_notes')).toBe(0);
      // Only the seeded security-answer hash; no API token until one is rotated in.
      const s = await settings(p);
      expect(Object.keys(s)).toEqual(['security_answer_hash']);
      expect(s.security_answer_hash).toMatch(/^\$2[aby]\$12\$/);
    });

    it('has the column types, keys and foreign key the spec asks for', async () => {
      const p = await freshDb();
      await migrate(p);
      const [cols] = await p.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, IS_NULLABLE AS n, COLUMN_KEY AS k
         FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN ('habits', 'checks', 'day_notes')
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      );
      const shape = cols.map((r) => `${r.t}.${r.c} ${r.ty} ${r.n === 'YES' ? 'null' : 'notnull'} ${r.k}`.trim());
      expect(shape).toEqual([
        'checks.habit_id int notnull PRI',
        'checks.date date notnull PRI',
        'checks.created_at timestamp notnull',
        'day_notes.date date notnull PRI',
        'day_notes.line varchar(280) notnull',
        'day_notes.updated_at timestamp notnull',
        'habits.id int notnull PRI',
        'habits.slug varchar(40) notnull UNI',
        'habits.label varchar(80) notnull',
        'habits.sort int notnull',
        'habits.ramp_text varchar(120) null',
        'habits.created_at timestamp notnull',
        'habits.retired_at timestamp null',
        "habits.schedule varchar(16) notnull",
        'habits.schedule_anchor date null',
        'habits.schedule_days varchar(16) null',
        'habits.schedule_from date null',
      ]);
      // Existing habits read as daily.
      const [sched] = await p.query<RowDataPacket[]>('SELECT DISTINCT schedule FROM habits');
      expect(sched.map((r) => r.schedule)).toEqual(['daily']);

      // The FK is real: a check for a habit that does not exist is refused, and
      // a habit with checks cannot be hard-deleted.
      await expect(
        p.query("INSERT INTO checks (habit_id, date) VALUES (9999, '2026-10-13')"),
      ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
      await p.query("INSERT INTO checks (habit_id, date) VALUES (1, '2026-10-13')");
      await expect(p.query('DELETE FROM habits WHERE id = 1')).rejects.toMatchObject({
        code: 'ER_ROW_IS_REFERENCED_2',
      });
      // MySQL itself refuses an impossible date, so the API must (and does) first.
      await expect(
        p.query("INSERT INTO checks (habit_id, date) VALUES (1, '2026-02-31')"),
      ).rejects.toBeTruthy();
    });

    it('is idempotent: a second and third run change nothing', async () => {
      const p = await freshDb();
      await migrate(p);
      await p.query("INSERT INTO checks (habit_id, date) VALUES (1, '2026-10-13')");
      await p.query("INSERT INTO day_notes (date, line) VALUES ('2026-10-13', 'kept')");
      await p.query("UPDATE habits SET label = 'Walk 20 min', retired_at = NOW() WHERE slug = 'stretch'");
      await p.query("INSERT INTO settings (`key`, value) VALUES ('app_timezone', 'Pacific/Tahiti')");
      const before = {
        tables: await tables(p),
        settings: await settings(p),
        habits: (await p.query<RowDataPacket[]>('SELECT * FROM habits ORDER BY id'))[0],
      };

      await migrate(p);
      await migrate(p);

      expect(await tables(p)).toEqual(before.tables);
      expect(await settings(p)).toEqual(before.settings);
      // Not reseeded, and the relabelled + retired habit is left exactly as it was.
      expect((await p.query<RowDataPacket[]>('SELECT * FROM habits ORDER BY id'))[0]).toEqual(
        before.habits,
      );
      expect(await count(p, 'habits')).toBe(6);
      expect(await count(p, 'checks')).toBe(1);
      expect(await count(p, 'day_notes')).toBe(1);
    });

    it('adds daily_article.topics to a table from before it; old rows read as no topics', async () => {
      const p = await freshDb();
      await migrate(p);
      await p.query('ALTER TABLE daily_article DROP COLUMN topics, DROP COLUMN source_id');
      await p.query(
        `INSERT INTO daily_article (date, url, title, source, published_at, url_hash, title_hash)
         VALUES ('2026-10-15', 'https://lab.test/a', 'Before topics', 'Test Lab', NOW(), 'u', 't')`,
      );
      await migrate(p);
      await migrate(p);
      const a = await createMysqlStore(p).getDailyArticle('2026-10-15');
      expect(a).toMatchObject({ title: 'Before topics', topics: [], sourceId: null });
    });

    it('does not reseed a table that merely has every habit retired', async () => {
      const p = await freshDb();
      await migrate(p);
      await p.query('UPDATE habits SET retired_at = NOW()');
      await migrate(p);
      expect(await count(p, 'habits')).toBe(6);
    });

    it('converts a legacy plaintext security answer and removes it', async () => {
      const p = await freshDb();
      await p.query(
        `CREATE TABLE settings (\`key\` VARCHAR(255) NOT NULL PRIMARY KEY, value TEXT NOT NULL)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      );
      await p.query("INSERT INTO settings (`key`, value) VALUES ('security_answer', 'Pochi')");
      await migrate(p);
      const s = await settings(p);
      expect(s.security_answer).toBeUndefined();
      expect(s.security_answer_hash).toMatch(/^\$2[aby]\$12\$/);
    });

    it('adds the new tables beside the legacy ones without touching them', async () => {
      const p = await freshDb();
      await p.query(
        `CREATE TABLE settings (\`key\` VARCHAR(255) NOT NULL PRIMARY KEY, value TEXT NOT NULL)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      );
      const conn = await p.getConnection();
      await createLegacySchema(conn);
      conn.release();

      await migrate(p);
      await migrate(p);

      expect(await tables(p)).toEqual(
        [...LEGACY_TABLES, ...APP_TABLES].sort(),
      );
      expect(await count(p, 'protocols')).toBe(1);
      expect(await count(p, 'entries')).toBe(2);
      expect(await count(p, 'journal_entries')).toBe(1);
      expect(await count(p, 'gratitude_entries')).toBe(1);
      expect(await count(p, 'coach_conversations')).toBe(1);
    });
  });

  describe('ops/pht-drop-legacy.sql', () => {
    // A database shaped like production on the day of the drop: legacy tables
    // with data, the new tables in use, and a settings table holding both
    // kinds of row.
    async function productionLike(): Promise<Pool> {
      const p = await freshDb();
      await p.query(
        `CREATE TABLE settings (\`key\` VARCHAR(255) NOT NULL PRIMARY KEY, value TEXT NOT NULL)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      );
      const conn = await p.getConnection();
      await createLegacySchema(conn);
      conn.release();
      await p.query('INSERT INTO settings (`key`, value) VALUES ?', [
        [
          ...COACH_SETTING_KEYS.map((k) => [k, `legacy ${k}`]),
          ['admin_password_hash', '$2b$12$keepme'],
          ['app_timezone', 'Pacific/Tahiti'],
          [API_TOKEN_HASH_KEY, 'a'.repeat(64)],
          // Starts with "coach" but is not one of the four: must survive.
          ['coaching_note_for_later', 'keep'],
        ],
      ]);
      await migrate(p);
      await p.query("INSERT INTO checks (habit_id, date) VALUES (1, '2026-10-13'), (2, '2026-10-13')");
      await p.query("INSERT INTO day_notes (date, line) VALUES ('2026-10-13', 'still here')");
      return p;
    }

    it('drops the five legacy tables and the coach settings, and nothing else', async () => {
      const p = await productionLike();
      const keep = await settings(p);
      for (const k of COACH_SETTING_KEYS) delete keep[k];
      const habitsBefore = (await p.query<RowDataPacket[]>('SELECT * FROM habits ORDER BY id'))[0];

      await runSqlFile(DROP_SQL);

      expect(await tables(p)).toEqual(APP_TABLES);
      expect(await settings(p)).toEqual(keep);
      expect(Object.keys(keep).sort()).toEqual([
        'admin_password_hash',
        'api_token_hash',
        'app_timezone',
        'coaching_note_for_later',
        'security_answer_hash',
      ]);
      expect((await p.query<RowDataPacket[]>('SELECT * FROM habits ORDER BY id'))[0]).toEqual(
        habitsBefore,
      );
      expect(await count(p, 'checks')).toBe(2);
      expect(await count(p, 'day_notes')).toBe(1);
    });

    it('is safe to run twice, and migrate still works afterwards', async () => {
      const p = await productionLike();
      await runSqlFile(DROP_SQL);
      await runSqlFile(DROP_SQL);
      await migrate(p);
      expect(await tables(p)).toEqual(APP_TABLES);
      expect(await count(p, 'habits')).toBe(6);
      expect(await count(p, 'checks')).toBe(2);
    });

    it('works on a database that never had the legacy tables', async () => {
      const p = await freshDb();
      await migrate(p);
      await runSqlFile(DROP_SQL);
      expect(await tables(p)).toEqual(APP_TABLES);
    });

    it('names only tables that exist in the legacy schema', () => {
      const sql = readFileSync(DROP_SQL, 'utf8');
      const dropped = [...sql.matchAll(/^DROP TABLE IF EXISTS (\w+);/gm)].map((m) => m[1]);
      expect(dropped.sort()).toEqual([...LEGACY_TABLES].sort());
      expect(dropped.indexOf('entries')).toBeLessThan(dropped.indexOf('protocols'));
      for (const t of ['habits', 'checks', 'day_notes', 'settings']) {
        expect(sql).not.toMatch(new RegExp(`DROP TABLE[^;]*\\b${t}\\b`));
      }
    });
  });

  describe('the API over MySQL', () => {
    it('serves /today end to end, with dates and streaks intact', async () => {
      const p = await freshDb();
      await migrate(p);
      const store = createMysqlStore(p);
      await store.importChecks({
        '2026-10-11': ['stretch'],
        '2026-10-12': ['stretch', 'read'],
        '2026-12-31': ['water'],
        '2027-01-01': ['water'],
      });
      await store.putNote('2026-10-13', 'from mysql');

      process.env.JWT_SECRET = 'mysql-suite-secret';
      const jwt = (await import('jsonwebtoken')).default;
      const auth = {
        Authorization: `Bearer ${jwt.sign({ username: 'owner', stage: 'full' }, 'mysql-suite-secret')}`,
      };
      const app = createApp(store, { log: false });

      const res = await request(app).get('/api/today?date=2026-10-13').set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ date: '2026-10-13', doneCount: 0, total: 6, note: 'from mysql' });
      const stretch = res.body.habits.find((h: { slug: string }) => h.slug === 'stretch');
      expect(stretch).toMatchObject({ done: false, streak: 2, best: 2, totalDone: 2 });

      const ny = await request(app).get('/api/today?date=2027-01-01').set(auth);
      const water = ny.body.habits.find((h: { slug: string }) => h.slug === 'water');
      expect(water).toMatchObject({ done: true, streak: 2, best: 2 });

      // created_at comes back as the real instant, so today is on or after it.
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Boise' }).format(new Date());
      const put = await request(app).put(`/api/checks/${stretch.id}/${today}`).set(auth);
      expect(put.status).toBe(200);
      const again = await request(app).put(`/api/checks/${stretch.id}/${today}`).set(auth);
      expect(again.status).toBe(200);
      expect(await count(p, 'checks')).toBe(6);
    });

    // The rotate script's program, lifted out of the heredoc and run against
    // this throwaway database — never over ssh, never against the server.
    it('rotate-token program stores a hash the API then accepts', async () => {
      const p = await freshDb();
      await migrate(p);
      const script = readFileSync(ROTATE_SH, 'utf8');
      const m = /<<'JS'\n([\s\S]*?)\nJS\n/.exec(script);
      expect(m, "heredoc 'JS' not found in pht-rotate-token.sh").not.toBeNull();
      const program = (m as RegExpExecArray)[1];

      // An empty cwd, so dotenv finds no .env and the only credentials in play
      // are the test container's, passed explicitly.
      const cwd = mkdtempSync(path.join(tmpdir(), 'pht-rotate-'));
      const run = () =>
        execFileSync(process.execPath, ['-'], {
          cwd,
          input: program,
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            NODE_PATH: path.join(REPO, 'node_modules'),
            DB_HOST: String(base.host),
            DB_PORT: String(base.port),
            DB_USER: base.user,
            DB_PASSWORD: base.password,
            DB_NAME: DB,
          },
        }).trim();
      try {
        const first = run();
        expect(first).toMatch(/^pht_[A-Za-z0-9_-]{43}$/);
        const stored = (await settings(p))[API_TOKEN_HASH_KEY];
        expect(stored).toMatch(/^[0-9a-f]{64}$/);
        expect(stored).not.toContain(first);
        expect(apiTokenMatches(first, stored)).toBe(true);

        const app = createApp(createMysqlStore(p), { log: false });
        const ok = await request(app).get('/api/today?date=2026-10-13').set('Authorization', `Bearer ${first}`);
        expect(ok.status).toBe(200);

        const second = run();
        expect(second).not.toBe(first);
        const oldOne = await request(app).get('/api/today?date=2026-10-13').set('Authorization', `Bearer ${first}`);
        expect(oldOne.status).toBe(401);
        const newOne = await request(app).get('/api/today?date=2026-10-13').set('Authorization', `Bearer ${second}`);
        expect(newOne.status).toBe(200);
        expect(await count(p, 'settings')).toBe(2); // answer hash + one token hash
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  // The same suite the in-memory fake passes in `npm test`.
  let contractPool: Pool | undefined;
  storeContract('MySQL 8.4', async () => {
    if (!contractPool) {
      contractPool = await freshDb();
      await migrate(contractPool);
    } else {
      await contractPool.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of ['checks', 'day_notes', 'habits']) {
        await contractPool.query(`TRUNCATE TABLE \`${t}\``);
      }
      await contractPool.query('SET FOREIGN_KEY_CHECKS = 1');
      await contractPool.query("DELETE FROM settings WHERE `key` = 'contract_probe'");
      await migrate(contractPool); // empty habits table → reseeds
    }
    return createMysqlStore(contractPool);
  });
});
