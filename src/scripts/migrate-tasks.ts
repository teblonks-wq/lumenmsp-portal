import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';

// Data migration: legacy MySQL tasks → Postgres. Preserves IDs, idempotent. Drops tenant_id.

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const b = (v: unknown): boolean => v === 1 || v === true || v === '1';
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  if (!process.env.LEGACY_MYSQL_USER) throw new Error('LEGACY_MYSQL_USER not set');

  const my = await mysql.createConnection({
    host:     process.env.LEGACY_MYSQL_HOST || 'localhost',
    port:     Number(process.env.LEGACY_MYSQL_PORT || 3306),
    user:     process.env.LEGACY_MYSQL_USER,
    password: process.env.LEGACY_MYSQL_PASSWORD || '',
    database: process.env.LEGACY_MYSQL_DATABASE || 'lumenmsp',
  });
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pg.connect();

  try {
    const [tasks] = await my.query('SELECT * FROM tasks') as [any[], any];
    for (const t of tasks) {
      await client.query(
        `INSERT INTO tasks
          (id, title, description, assigned_to_user_id, assignment_scope, assigned_to_team_id, created_by_user_id,
           priority, status, due_date, due_time, deadline, recurrence, recurrence_end_date, reminder_sent,
           completed_at, completed_by_user_id, created_at, updated_at, related_ticket_id, related_customer_id, related_contact_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, COALESCE($18, NOW()), COALESCE($19, NOW()),$20,$21,$22)
         ON CONFLICT (id) DO UPDATE SET
           title=EXCLUDED.title, description=EXCLUDED.description, assigned_to_user_id=EXCLUDED.assigned_to_user_id,
           assignment_scope=EXCLUDED.assignment_scope, assigned_to_team_id=EXCLUDED.assigned_to_team_id,
           priority=EXCLUDED.priority, status=EXCLUDED.status, due_date=EXCLUDED.due_date, due_time=EXCLUDED.due_time,
           deadline=EXCLUDED.deadline, recurrence=EXCLUDED.recurrence, recurrence_end_date=EXCLUDED.recurrence_end_date,
           reminder_sent=EXCLUDED.reminder_sent, completed_at=EXCLUDED.completed_at, completed_by_user_id=EXCLUDED.completed_by_user_id,
           updated_at=EXCLUDED.updated_at, related_ticket_id=EXCLUDED.related_ticket_id,
           related_customer_id=EXCLUDED.related_customer_id, related_contact_id=EXCLUDED.related_contact_id`,
        [
          n(t.id), t.title, t.description, n(t.assigned_to_user_id), t.assignment_scope || 'user', n(t.assigned_to_team_id),
          n(t.created_by_user_id) ?? 1, t.priority || 'medium', t.status || 'open', t.due_date, s(t.due_time), t.deadline,
          t.recurrence || 'none', t.recurrence_end_date, b(t.reminder_sent), t.completed_at, n(t.completed_by_user_id),
          t.created_at, t.updated_at, n(t.related_ticket_id), n(t.related_customer_id), n(t.related_contact_id),
        ]
      );
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('tasks', 'id'), COALESCE((SELECT MAX(id) FROM tasks), 1))`);
    console.log('✓ Tasks migration complete:', { tasks: tasks.length });
  } finally {
    client.release();
    await pg.end();
    await my.end();
  }
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
