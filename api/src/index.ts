import 'dotenv/config';
import { createApp } from './app.js';
import { createMysqlStore } from './db/mysqlStore.js';
import { pool } from './db/pool.js';
import { startListening } from './lib/listen.js';
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

const store = createMysqlStore(pool);
const wire = createWireService(store);

startListening(createApp(store, { wire }), process.env, ({ address, port }) => {
  console.log(`pht-api listening on ${address}:${port}`);
  // AI Wire's daily pick at 03:30 app_timezone (see startWireSchedule).
  startWireSchedule(store, wire);
});
