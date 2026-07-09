import { pool } from '../db/pool';

// Pull the bare domain out of an email address ("a.b@Foo.COM" → "foo.com").
export function emailDomain(addr: string): string {
  const at = (addr || '').toLowerCase().trim().lastIndexOf('@');
  return at >= 0 ? (addr || '').toLowerCase().trim().slice(at + 1) : '';
}

// True if this sender (exact address OR its domain) is on the spam block-list.
export async function isSpamSender(fromEmail: string): Promise<boolean> {
  const email = (fromEmail || '').toLowerCase().trim();
  if (!email) return false;
  const domain = emailDomain(email);
  try {
    const r = await pool.query(
      `SELECT 1 FROM spam_senders
        WHERE (kind='email'  AND value=$1)
           OR (kind='domain' AND value=$2)
        LIMIT 1`,
      [email, domain]
    );
    return r.rows.length > 0;
  } catch {
    return false; // table may not exist yet during early scaffolding
  }
}

// Add a sender (email or domain) to the block-list. Returns false if it was already there.
export async function blockSender(value: string, kind: 'email' | 'domain', userId: number | null, reason?: string): Promise<boolean> {
  const v = (value || '').toLowerCase().trim();
  if (!v) return false;
  const r = await pool.query(
    `INSERT INTO spam_senders (value, kind, created_by_id, reason)
     VALUES ($1,$2,$3,$4) ON CONFLICT (value) DO NOTHING RETURNING id`,
    [v, kind, userId, reason || null]
  );
  return (r.rowCount || 0) > 0;
}
