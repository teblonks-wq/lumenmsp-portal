import { pool } from '../db/pool';

// Records an audit-trail entry. Never throws (logging must not break the action).
export async function logActivity(
  userId: number | null, action: string, entityType: string | null, entityId: number | null, summary: string | null,
): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO activity_log (user_id, action, entity_type, entity_id, summary) VALUES ($1,$2,$3,$4,$5)',
      [userId, action, entityType, entityId, summary]
    );
  } catch (e) { console.error('[activity] log failed:', (e as Error).message); }
}
