import type { Connection } from 'mysql2/promise';

// The pre-rebuild schema, as the tag `legacy-v1` left it in production: the
// five tables ops/pht-drop-legacy.sql removes, with every column the old
// migrate.ts had added over time, plus a row or two in each so the drop is
// tested against tables that hold data and a live foreign key.
//
// `settings` is created by applySchema (it survives the rebuild), so only its
// legacy coach rows are added here.
export const LEGACY_TABLES = [
  'protocols',
  'entries',
  'journal_entries',
  'gratitude_entries',
  'coach_conversations',
] as const;

export const COACH_SETTING_KEYS = [
  'coach_system_prompt',
  'coach_temperature',
  'coach_max_tokens',
  'coach_model',
] as const;

const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export async function createLegacySchema(conn: Connection): Promise<void> {
  await conn.query(`
    CREATE TABLE protocols (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      start_date DATE NOT NULL,
      phases JSON NOT NULL,
      metrics JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      end_date DATE NULL,
      kind VARCHAR(32) NOT NULL DEFAULT 'phased',
      is_template TINYINT(1) NOT NULL DEFAULT 0,
      categories JSON NULL,
      coach_config JSON NULL
    ) ${TAIL}`);
  await conn.query(`
    CREATE TABLE entries (
      protocol_id VARCHAR(64) NOT NULL,
      date DATE NOT NULL,
      \`values\` JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (protocol_id, date),
      CONSTRAINT fk_entries_protocol
        FOREIGN KEY (protocol_id) REFERENCES protocols(id) ON DELETE CASCADE
    ) ${TAIL}`);
  await conn.query(`
    CREATE TABLE journal_entries (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      content LONGTEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      mood INT NULL,
      energy INT NULL
    ) ${TAIL}`);
  await conn.query(`
    CREATE TABLE gratitude_entries (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      entry_date DATE NOT NULL,
      content VARCHAR(500) NOT NULL,
      content_norm VARCHAR(500) NOT NULL,
      content_stem VARCHAR(500) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_gratitude_date (entry_date),
      UNIQUE KEY uq_gratitude_norm (content_norm),
      KEY ix_gratitude_stem (content_stem)
    ) ${TAIL}`);
  await conn.query(`
    CREATE TABLE coach_conversations (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      context VARCHAR(32) NOT NULL,
      context_id VARCHAR(64) NULL,
      messages JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_context (context, context_id, updated_at)
    ) ${TAIL}`);

  await conn.query(
    `INSERT INTO protocols (id, name, start_date, phases, metrics, coach_config)
     VALUES ('p1', 'Example Plan', '2026-06-01', '[]', '[]', '{"model_key":"llama3.1:latest"}')`,
  );
  await conn.query(
    `INSERT INTO entries (protocol_id, date, \`values\`)
     VALUES ('p1', '2026-06-01', '{"m1":true}'), ('p1', '2026-06-02', '{"m1":false}')`,
  );
  await conn.query(
    "INSERT INTO journal_entries (date, content, mood) VALUES ('2026-06-01', 'day one', 7)",
  );
  await conn.query(
    `INSERT INTO gratitude_entries (entry_date, content, content_norm, content_stem)
     VALUES ('2026-06-01', 'A quiet morning', 'a quiet morning', 'quiet morn')`,
  );
  await conn.query(
    `INSERT INTO coach_conversations (context, context_id, messages)
     VALUES ('protocol', 'p1', '[]')`,
  );
}
