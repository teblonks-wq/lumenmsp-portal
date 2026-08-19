import { Pool } from 'pg';
import { config } from '../config';
import { utcTimestampTypes, withUtcDateParams } from './pg-utc';

// `timestamp` columns in this database hold UTC (Prisma writes them). node-pg would
// otherwise read AND write them as Europe/London wall-clock, which is why case notes
// rendered an hour behind all through BST. See pg-utc.ts for the full argument.
export const pool = withUtcDateParams(
  new Pool({ connectionString: config.DATABASE_URL, types: utcTimestampTypes }));

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
  ? new Pool({ connectionString: config.INSIGHTS_DATABASE_URL })
  : null;
if (insightsPool) {
  insightsPool.on('error', (err) => { console.error('Insights PG pool error:', err); });
}
