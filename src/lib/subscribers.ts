import crypto from 'crypto';
import { pool } from '../db/pool';

// ── Marketing → Subscribers ─────────────────────────────────────────────────────
// People who are NOT customers but have asked to hear from us — today that means someone
// who downloaded a guide and ticked the opt-in box. They cannot live in customer_contacts:
// that table is keyed to a customer, and the Mass Mailer only ever sends to contacts on
// their customer's default domain. This is the other list.
//
// CONSENT IS THE POINT OF THIS TABLE. A row exists only because a person ticked a box that
// was not pre-ticked, and opted_in_at / opt_in_ip / opt_in_note are the evidence of when and
// where. Nothing else may write to it: no importing a list, no "they gave us their card".
//
// Created with raw SQL here AND declared in prisma/schema.prisma (model MarketingSubscriber)
// so `prisma db push --accept-data-loss` cannot drop it on deploy.

export interface SubscriberRow {
  id: number; email: string; full_name: string | null; company: string | null; phone: string | null;
  source: string | null; source_detail: string | null; unsub_token: string;
  opted_in: boolean; opted_in_at: string | null; opted_out_at: string | null;
  opt_in_ip: string | null; opt_in_note: string | null; created_at: string;
}

export async function ensureSubscriberTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_subscribers (
      id            BIGSERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      full_name     TEXT,
      company       TEXT,
      phone         TEXT,
      source        TEXT,
      source_detail TEXT,
      unsub_token   TEXT NOT NULL UNIQUE,
      opted_in      BOOLEAN DEFAULT true,
      opted_in_at   TIMESTAMPTZ DEFAULT NOW(),
      opted_out_at  TIMESTAMPTZ,
      opt_in_ip     TEXT,
      opt_in_note   TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_subscribers_optedin ON marketing_subscribers (opted_in);
    -- mail_campaign_recipients is Prisma-managed, but the Mass Mailer writes this column
    -- the moment a subscriber campaign is created, which may be before db push has run.
    ALTER TABLE IF EXISTS mail_campaign_recipients ADD COLUMN IF NOT EXISTS subscriber_id BIGINT;
  `);
}

export interface SubscribeInput {
  email: string; name?: string | null; company?: string | null; phone?: string | null;
  source: string;            // 'guide'
  sourceDetail?: string | null; // which guide
  ip?: string | null;
  note?: string | null;      // the exact promise they agreed to
}

// Upsert on email. Someone who downloads a second guide updates their details rather than
// appearing twice — and an opt-in re-subscribes them if they had previously unsubscribed,
// because they have just asked again.
export async function addSubscriber(input: SubscribeInput): Promise<number> {
  const email = String(input.email || '').trim().toLowerCase();
  if (!email) throw new Error('An email address is required.');
  const token = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO marketing_subscribers
       (email, full_name, company, phone, source, source_detail, unsub_token, opted_in, opted_in_at, opted_out_at, opt_in_ip, opt_in_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,NOW(),NULL,$8,$9)
     ON CONFLICT (email) DO UPDATE SET
       full_name     = COALESCE(NULLIF(EXCLUDED.full_name, ''), marketing_subscribers.full_name),
       company       = COALESCE(NULLIF(EXCLUDED.company, ''), marketing_subscribers.company),
       phone         = COALESCE(NULLIF(EXCLUDED.phone, ''), marketing_subscribers.phone),
       source_detail = EXCLUDED.source_detail,
       opted_in      = true,
       opted_in_at   = NOW(),
       opted_out_at  = NULL,
       opt_in_ip     = EXCLUDED.opt_in_ip,
       opt_in_note   = EXCLUDED.opt_in_note
     RETURNING id`,
    [email, (input.name || '').trim() || null, (input.company || '').trim() || null,
      (input.phone || '').trim() || null, input.source, input.sourceDetail || null, token,
      (input.ip || '').slice(0, 60) || null, (input.note || '').slice(0, 300) || null]);
  return Number(rows[0].id);
}

export async function listSubscribers(includeOptedOut = true): Promise<SubscriberRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM marketing_subscribers ${includeOptedOut ? '' : 'WHERE opted_in = true'}
      ORDER BY opted_in DESC, created_at DESC`);
  return rows;
}

export async function subscriberCounts(): Promise<{ total: number; optedIn: number; optedOut: number }> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE opted_in)::int AS opted_in,
            COUNT(*) FILTER (WHERE NOT opted_in)::int AS opted_out
       FROM marketing_subscribers`);
  const r = rows[0] || {};
  return { total: r.total || 0, optedIn: r.opted_in || 0, optedOut: r.opted_out || 0 };
}

export async function setSubscriberOptOut(id: number, out: boolean): Promise<void> {
  await pool.query(
    `UPDATE marketing_subscribers SET opted_in = $2, opted_out_at = CASE WHEN $2 THEN NULL ELSE NOW() END WHERE id = $1`,
    [id, !out]);
}

export async function removeSubscriber(id: number): Promise<void> {
  await pool.query('DELETE FROM marketing_subscribers WHERE id=$1', [id]);
}

// Used by the public /unsubscribe/:token page, which tries customer contacts first.
export async function subscriberForUnsubToken(token: string): Promise<{ id: number; email: string; full_name: string | null; opted_out: boolean } | null> {
  const { rows } = await pool.query(
    'SELECT id, email, full_name, NOT COALESCE(opted_in, true) AS opted_out FROM marketing_subscribers WHERE unsub_token=$1',
    [String(token || '')]);
  return rows[0] || null;
}

export async function optOutSubscriberByToken(token: string): Promise<boolean> {
  const { rows } = await pool.query(
    'UPDATE marketing_subscribers SET opted_in=false, opted_out_at=NOW() WHERE unsub_token=$1 RETURNING id',
    [String(token || '')]);
  return rows.length > 0;
}

export async function subscriberUnsubToken(id: number): Promise<string> {
  const { rows } = await pool.query('SELECT unsub_token FROM marketing_subscribers WHERE id=$1', [id]);
  if (rows.length && rows[0].unsub_token) return rows[0].unsub_token;
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE marketing_subscribers SET unsub_token=$1 WHERE id=$2', [token, id]);
  return token;
}

export function subscribersCsv(rows: SubscriberRow[]): string {
  const q = (v: any) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['Email', 'Name', 'Company', 'Phone', 'Source', 'From', 'Status', 'Opted in', 'Opted out'];
  const body = rows.map((r) => [
    r.email, r.full_name, r.company, r.phone, r.source, r.source_detail,
    r.opted_in ? 'Subscribed' : 'Unsubscribed',
    r.opted_in_at ? new Date(r.opted_in_at).toISOString().slice(0, 10) : '',
    r.opted_out_at ? new Date(r.opted_out_at).toISOString().slice(0, 10) : '',
  ].map(q).join(','));
  return [head.map(q).join(','), ...body].join('\r\n');
}
