import { pool } from '../db/pool';

// Key-value settings store, grouped (e.g. group 'quickbooks', key 'access_token').

export async function getSetting(group: string, key: string): Promise<string | null> {
  const r = await pool.query('SELECT value FROM settings WHERE "group"=$1 AND key=$2 LIMIT 1', [group, key]);
  return r.rows.length ? r.rows[0].value : null;
}

export async function getGroup(group: string): Promise<Record<string, string>> {
  const r = await pool.query('SELECT key, value FROM settings WHERE "group"=$1', [group]);
  const out: Record<string, string> = {};
  for (const row of r.rows) if (row.value !== null) out[row.key] = row.value;
  return out;
}

export async function setSetting(group: string, key: string, value: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO settings ("group", key, value, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT ("group", key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [group, key, value]
  );
}
