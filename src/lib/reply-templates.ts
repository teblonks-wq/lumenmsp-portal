import { pool } from '../db/pool';

// ── Reply templates ──────────────────────────────────────────────────────────────
// Canned messages staff can insert into the ticket composer ("Insert template…").
// DB-backed so new templates are added from the manage page (/ticket-templates)
// without a deploy. Raw-SQL managed; mirrored in prisma/schema.prisma (keep in sync
// or `prisma db push` drops the table — the social_posts lesson).

export interface ReplyTemplate {
  id: number; name: string; body_html: string; sort: number; is_active: boolean;
}

const BOOKING_URL = 'https://outlook.office.com/book/LumenITSolutionsCustomerSuccessTeam@r3vosolutions.co.uk/s/oUtrTCqFWU-qZP63xk_MPg2?ismsaljsauthenabled';

const SEED_REMOTE_SERVICE = `<p>Dear Team,</p>
<p>We need to remotely service your device to ensure its readiness. During the appointment we will check your antivirus protection, Windows updates and drivers.</p>
<p>You may be needed at the start of the two-hour appointment, so please book a slot that suits you using the link below:</p>
<p><a href="${BOOKING_URL}">Book your remote service appointment</a></p>
<p>Kind regards,<br>Lumen IT Solutions — Customer Success Team</p>`;

export async function ensureReplyTemplates(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reply_templates (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      body_html  TEXT NOT NULL DEFAULT '',
      sort       INTEGER DEFAULT 0,
      is_active  BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Seed the first template once (only when the table is completely empty).
  const n = (await pool.query('SELECT COUNT(*)::int AS n FROM reply_templates')).rows[0].n;
  if (!n) {
    await pool.query('INSERT INTO reply_templates (name, body_html, sort) VALUES ($1, $2, 0)',
      ['Remote device service — booking link', SEED_REMOTE_SERVICE]);
  }
}

export async function listReplyTemplates(activeOnly = true): Promise<ReplyTemplate[]> {
  const r = await pool.query(
    `SELECT id, name, body_html, sort, is_active FROM reply_templates
      ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY sort, name`);
  return r.rows;
}

export async function saveReplyTemplate(t: { id?: number | null; name: string; body_html: string; sort?: number; is_active?: boolean }): Promise<void> {
  if (t.id) {
    await pool.query(
      'UPDATE reply_templates SET name=$2, body_html=$3, sort=$4, is_active=$5, updated_at=NOW() WHERE id=$1',
      [t.id, t.name, t.body_html, t.sort || 0, t.is_active !== false]);
  } else {
    await pool.query('INSERT INTO reply_templates (name, body_html, sort, is_active) VALUES ($1,$2,$3,$4)',
      [t.name, t.body_html, t.sort || 0, t.is_active !== false]);
  }
}

export async function deleteReplyTemplate(id: number): Promise<void> {
  await pool.query('DELETE FROM reply_templates WHERE id=$1', [id]);
}
