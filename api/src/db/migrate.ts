import 'dotenv/config';
import { pool } from './pool.js';
import { applySchema } from './schema.js';

// CLI entry point: `npm run migrate` locally, `node dist/db/migrate.js` on the
// server. The schema itself lives in schema.ts so tests can apply it to a
// throwaway database without this file's process.exit and pool teardown.
async function migrate() {
  const conn = await pool.getConnection();
  try {
    await applySchema(conn);
    console.log('Migration complete.');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
