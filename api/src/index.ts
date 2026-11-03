import 'dotenv/config';
import { createApp } from './app.js';
import { createMysqlStore } from './db/mysqlStore.js';
import { pool } from './db/pool.js';
import { createWireService, startWireSchedule } from './lib/wireService.js';

const requiredEnv = [
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD_HASH',
];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const port = Number(process.env.PORT ?? 4100);

const store = createMysqlStore(pool);
const wire = createWireService(store);

createApp(store, { wire }).listen(port, () => {
  console.log(`pht-api listening on :${port}`);
  // AI Wire's daily pick at 03:30 app_timezone (see startWireSchedule).
  startWireSchedule(store, wire);
});
