import mysql from 'mysql2/promise';
import 'dotenv/config';

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  // Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates.
  // mysql2 otherwise materialises a DATE as midnight in the *server's* zone,
  // which invites an off-by-one whenever that zone changes. Dates in this app
  // are calendar days, not instants, so a string is the honest representation.
  // DATETIME/TIMESTAMP are deliberately left as Dates — those are real instants
  // (MySQL stores TIMESTAMP as UTC) and callers convert them to epoch ms.
  dateStrings: ['DATE'],
});
