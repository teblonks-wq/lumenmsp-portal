import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({ connectionString: config.DATABASE_URL });

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// Second pool → the Insights analytics DB (lumenmsp_insights). Null until INSIGHTS_DATABASE_URL
// is set, so the /insights section can show "not connected" rather than crash the app.
export const insightsPool: Pool | null = config.INSIGHTS_DATABASE_URL
  ? new Pool({ connectionString: config.INSIGHTS_DATABASE_URL })
  : null;
if (insightsPool) {
  insightsPool.on('error', (err) => { console.error('Insights PG pool error:', err); });
}
