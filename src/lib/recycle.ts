import { pool } from '../db/pool';

// Snapshot-and-remove recycle store. Use for rows in churny/synced tables (e.g. service_items, which
// the nightly Giacom import wipes + re-inserts) where an in-place deleted_at flag would be resurrected
// by the next sync and would mean filtering deleted rows out of dozens of billing queries.
//
// IMPORTANT: `table` is interpolated into SQL, so only ever call this with a hard-coded table name
// from trusted server code — never with a value derived from user input.
export interface RecycleMeta { entityType: string; label?: string | null; sublabel?: string | null; reason?: string | null; userId?: number | null }

export async function recycleRow(table: string, id: number, meta: RecycleMeta): Promise<boolean> {
  const row = (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
  if (!row) return false;
  await pool.query(
    `INSERT INTO recycle_items (entity_type, source_table, label, sublabel, snapshot, reason, deleted_by_user_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [meta.entityType, table, meta.label || null, meta.sublabel || null, JSON.stringify(row), meta.reason || null, meta.userId ?? null]
  );
  await pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
  return true;
}

// Re-insert a snapshotted row back into its source table. The original id is dropped so the DB assigns
// a fresh one (avoids clashing with rows the nightly sync re-created); service_items isn't referenced
// by foreign keys so this is safe.
export async function restoreRow(recycleId: number): Promise<boolean> {
  const rec = (await pool.query('SELECT * FROM recycle_items WHERE id=$1 AND restored_at IS NULL', [recycleId])).rows[0];
  if (!rec) return false;
  const snap = typeof rec.snapshot === 'string' ? JSON.parse(rec.snapshot) : rec.snapshot;
  const cols = Object.keys(snap).filter((k) => k !== 'id');
  if (cols.length) {
    const colList = cols.map((c) => '"' + c.replace(/[^a-zA-Z0-9_]/g, '') + '"').join(',');
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(',');
    await pool.query(`INSERT INTO ${rec.source_table} (${colList}) VALUES (${placeholders})`, cols.map((c) => snap[c]));
  }
  await pool.query('UPDATE recycle_items SET restored_at=NOW() WHERE id=$1', [recycleId]);
  return true;
}
