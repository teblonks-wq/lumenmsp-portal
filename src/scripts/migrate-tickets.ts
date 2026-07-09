import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';

// Data migration: legacy MySQL inbox_tickets + inbox_messages + inbox_notes → Postgres.
// Preserves IDs, idempotent. Drops tenant_id. Guards customer_id against deleted customers
// (only customer_id has a FK in the new schema; site/contact/user ids are plain columns).
// Reads LEGACY_MYSQL_* from .env.

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const b = (v: unknown): boolean => v === 1 || v === true || v === '1';
const j = (v: unknown): string | null => (v === null || v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v)));

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
  const counts: Record<string, number> = {};

  try {
    const custIds = new Set<number>((await client.query('SELECT id FROM customers')).rows.map((r: any) => r.id));
    const okCust = (v: any) => { const id = n(v); return id !== null && custIds.has(id) ? id : null; };

    const [tickets] = await my.query('SELECT * FROM inbox_tickets') as [any[], any];
    for (const t of tickets) {
      await client.query(
        `INSERT INTO inbox_tickets
          (id, ticket_number, source, customer_id, site_id, contact_id, assigned_user_id, assigned_by_user_id,
           status, stage, activity_status, category, department, subject, description, mailbox,
           last_customer_message_at, last_public_reply_at, assigned_at, closed_at, created_at, updated_at,
           is_spam, deleted_at, atera_ticket_id, deleted_by_user_id, delete_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 COALESCE($21, NOW()), COALESCE($22, NOW()), $23,$24,$25,$26,$27)
         ON CONFLICT (id) DO UPDATE SET
           ticket_number=EXCLUDED.ticket_number, source=EXCLUDED.source, customer_id=EXCLUDED.customer_id,
           site_id=EXCLUDED.site_id, contact_id=EXCLUDED.contact_id, assigned_user_id=EXCLUDED.assigned_user_id,
           assigned_by_user_id=EXCLUDED.assigned_by_user_id, status=EXCLUDED.status, stage=EXCLUDED.stage,
           activity_status=EXCLUDED.activity_status, category=EXCLUDED.category, department=EXCLUDED.department,
           subject=EXCLUDED.subject, description=EXCLUDED.description, mailbox=EXCLUDED.mailbox,
           last_customer_message_at=EXCLUDED.last_customer_message_at, last_public_reply_at=EXCLUDED.last_public_reply_at,
           assigned_at=EXCLUDED.assigned_at, closed_at=EXCLUDED.closed_at, updated_at=EXCLUDED.updated_at,
           is_spam=EXCLUDED.is_spam, deleted_at=EXCLUDED.deleted_at, atera_ticket_id=EXCLUDED.atera_ticket_id,
           deleted_by_user_id=EXCLUDED.deleted_by_user_id, delete_reason=EXCLUDED.delete_reason`,
        [
          n(t.id), t.ticket_number, t.source || 'email', okCust(t.customer_id), n(t.site_id), n(t.contact_id),
          n(t.assigned_user_id), n(t.assigned_by_user_id), t.status || 'new', t.stage || 'awaiting_triage',
          t.activity_status || 'unread', t.category || 'incident', t.department, t.subject, t.description,
          t.mailbox || 'portal@lumenmsp.co.uk', t.last_customer_message_at, t.last_public_reply_at, t.assigned_at,
          t.closed_at, t.created_at, t.updated_at, b(t.is_spam), t.deleted_at, n(t.atera_ticket_id),
          n(t.deleted_by_user_id), t.delete_reason,
        ]
      );
    }
    counts.inbox_tickets = tickets.length;

    const ticketIds = new Set<number>((await client.query('SELECT id FROM inbox_tickets')).rows.map((r: any) => r.id));
    const okTicket = (v: any) => { const id = n(v); return id !== null && ticketIds.has(id) ? id : null; };

    const [messages] = await my.query('SELECT * FROM inbox_messages') as [any[], any];
    for (const m of messages) {
      await client.query(
        `INSERT INTO inbox_messages
          (id, ticket_id, mailbox, graph_message_id, internet_message_id, conversation_id, message_direction,
           processing_status, suppression_reason, auto_reply_score, is_auto_reply, is_unread, has_attachments,
           from_name, from_email, to_raw, cc_raw, bcc_raw, subject, body_html, body_text, headers_json,
           parsed_intelligence, received_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                 COALESCE($25, NOW()), COALESCE($26, NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [
          n(m.id), okTicket(m.ticket_id), m.mailbox, m.graph_message_id, m.internet_message_id, m.conversation_id,
          m.message_direction || 'inbound', m.processing_status || 'new', m.suppression_reason, m.auto_reply_score,
          b(m.is_auto_reply), b(m.is_unread), b(m.has_attachments), m.from_name, m.from_email, m.to_raw, m.cc_raw,
          m.bcc_raw, m.subject, m.body_html, m.body_text, j(m.headers_json), j(m.parsed_intelligence),
          m.received_at, m.created_at, m.updated_at,
        ]
      );
    }
    counts.inbox_messages = messages.length;

    const [notes] = await my.query('SELECT * FROM inbox_notes') as [any[], any];
    for (const nt of notes) {
      if (!ticketIds.has(Number(nt.ticket_id))) continue; // note FK is required + cascade
      await client.query(
        `INSERT INTO inbox_notes (id, ticket_id, user_id, note_type, body, to_raw, cc_raw, bcc_raw, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [n(nt.id), n(nt.ticket_id), n(nt.user_id), nt.note_type || 'private_note', nt.body, nt.to_raw, nt.cc_raw, nt.bcc_raw, nt.created_at]
      );
    }
    counts.inbox_notes = notes.length;

    for (const t of ['inbox_tickets', 'inbox_messages', 'inbox_notes']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
    }
    console.log('✓ Tickets migration complete:', counts);
  } finally {
    client.release();
    await pg.end();
    await my.end();
  }
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
