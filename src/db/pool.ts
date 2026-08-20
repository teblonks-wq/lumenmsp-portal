import { Pool } from 'pg';
import { config } from '../config';
import { utcTimestampTypes, withUtcDateParams } from './pg-utc';

// `timestamp` columns in this database hold UTC (Prisma writes them). node-pg would
// otherwise read AND write them as Europe/London wall-clock, which is why case notes
// rendered an hour behind all through BST. See pg-utc.ts for the full argument.
// Connection budget. node-pg's default is max:10 - for the WHOLE application, shared
// between every logged-in user and ~170 agents checking in. That default is why pressing
// "update all agents" made the Portal feel frozen for everyone: one bulk action drained
// the ten connections and every other request sat waiting for one to come free. It reads
// like a slow server and it is not - the box is idle while requests queue on a semaphore.
// Postgres itself defaults to max_connections=100, so 30 leaves plenty of room for the
// Insights pool, psql, and prisma db push during a deploy.
// connectionTimeoutMillis matters as much as max: without it a starved request waits
// forever and the page just hangs. Ten seconds turns "hung" into an error we can see.
export const pool = withUtcDateParams(
  new Pool({
    connectionString: config.DATABASE_URL,
    types: utcTimestampTypes,
    max: 30,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  }));

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// Second pool → the Insights analytics DB (lumenmsp_insights). Null until INSIGHTS_DATABASE_URL
// is set, so the /insights section can show "not connected" rather than crash the app.
// DELIBERATELY NOT given the UTC treatment above. The Insights schema and the Tollring
// sync are their own argument, and there is already one corrected +1h shift in that
// data (2026-06); moving call timestamps under the journey builder as a side effect of
// a case-page fix is not a trade worth making. Change it on purpose or not at all.
export const insightsPool: Pool | null = config.INSIGHTS_DATABASE_URL
  ? new Pool({ connectionString: config.INSIGHTS_DATABASE_URL, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 })
  : null;
if (insightsPool) {
  insightsPool.on('error', (err) => { console.error('Insights PG pool error:', err); });
}
