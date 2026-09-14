// ── Send Credentials: one-time, passcode-gated credential handover ───────────────
//
// The problem this replaces: pasting a username and password into an email. The email
// then lives forever, in their inbox, in ours, in whatever backup both mail systems keep,
// and anyone who ever gets into either mailbox gets the password too.
//
// What happens instead. We put the credentials in an encrypted row, email a link, and
// tell the customer the PASSCODE down a different pipe — read it out on the phone, text
// it, WhatsApp it. Two channels, so a single compromised mailbox is not enough. The link
// opens a page that asks for the passcode; enter it right and the page shows the details
// once, with a Copy button on every field, and the ciphertext is destroyed on the way out.
//
// Burn-on-REVEAL, never burn-on-open. Mail scanners (Mimecast, Defender, Proofpoint) click
// every link in every email before the human ever sees it. If loading the page burnt the
// secret, the scanner would burn it, the customer would find a dead link, and we would be
// on the phone reissuing every single time. The scanner cannot answer the passcode prompt,
// so the secret survives it. This is the whole reason the passcode is not optional.
import * as crypto from 'crypto';
import { pool } from '../db/pool';
import { encryptSecret, decryptSecret, vaultConfigured } from './vault';

export interface CredItem {
  label: string;              // "Microsoft 365 sign-in"
  url?: string | null;        // where they use it
  username?: string | null;
  password?: string | null;   // may be blank — a link-only row is legitimate
  note?: string | null;
}

export interface CredSend {
  id: number; token: string; customer_id: number | null; ticket_id: number | null;
  to_email: string | null; title: string | null; created_by: number | null;
  created_at: Date; expires_at: Date; revealed_at: Date | null; revoked_at: Date | null;
  attempts: number; locked_at: Date | null; item_count: number;
  payload_encrypted: string | null;
  // Only ever read inside revealCredentials — the passcode itself is never stored.
  passcode_salt: string; passcode_hash: string;
}

// Backstop only. A link is meant to be used within minutes of the phone call; the window
// exists so an unclaimed one dies on its own rather than sitting live forever.
export const DEFAULT_TTL_HOURS = 168; // 7 days
export const MAX_ATTEMPTS = 5;

// No O/0, no I/1/l. Every one of these gets read down a phone line to somebody who is
// writing it on a Post-it, and "is that an oh or a zero" is a support call we can delete
// by never printing either character.
const PASSCODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newPasscode(len = 6): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PASSCODE_ALPHABET[bytes[i] % PASSCODE_ALPHABET.length];
  return out;
}

/** Uppercase, strip spaces and dashes — people write "K7F-Q2M" and type "k7f q2m". */
export function normalisePasscode(s: string): string {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashPasscode(passcode: string, salt: string): string {
  return crypto.scryptSync(normalisePasscode(passcode), salt, 32).toString('hex');
}

export function newToken(): string { return crypto.randomBytes(24).toString('base64url'); }

export async function ensureCredentialSendTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credential_sends (
      id                SERIAL PRIMARY KEY,
      token             TEXT NOT NULL UNIQUE,
      passcode_salt     TEXT NOT NULL,
      passcode_hash     TEXT NOT NULL,
      payload_encrypted TEXT,
      item_count        INTEGER NOT NULL DEFAULT 0,
      title             TEXT,
      customer_id       INTEGER,
      ticket_id         INTEGER,
      to_email          TEXT,
      created_by        INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      revealed_at       TIMESTAMPTZ,
      revoked_at        TIMESTAMPTZ,
      attempts          INTEGER NOT NULL DEFAULT 0,
      locked_at         TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cred_sends_customer ON credential_sends (customer_id, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cred_sends_ticket ON credential_sends (ticket_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credential_send_events (
      id         BIGSERIAL PRIMARY KEY,
      send_id    INTEGER NOT NULL REFERENCES credential_sends(id) ON DELETE CASCADE,
      event      TEXT NOT NULL,
      ip         TEXT,
      user_agent TEXT,
      meta       JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cred_send_events ON credential_send_events (send_id, created_at DESC);`);
}

export type CredEvent =
  | 'created' | 'link_opened' | 'passcode_failed' | 'revealed'
  | 'opened_after_burn' | 'opened_expired' | 'opened_revoked' | 'locked' | 'revoked';

export function clientIp(req: any): string {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req?.ip || req?.socket?.remoteAddress || '';
}
export function userAgent(req: any): string {
  return String(req?.headers?.['user-agent'] || '').slice(0, 400);
}

// Never let the audit trail break the thing it is auditing: a customer must still get
// their password if the logging insert fails.
export async function logCredEvent(
  sendId: number, event: CredEvent,
  opts: { ip?: string | null; userAgent?: string | null; meta?: Record<string, any> | null } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO credential_send_events (send_id, event, ip, user_agent, meta)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [sendId, event, opts.ip || null, opts.userAgent || null, opts.meta ? JSON.stringify(opts.meta) : null]);
  } catch (e) { console.error('[cred-send] event log failed:', (e as Error).message); }
}

// ── "and from where" ────────────────────────────────────────────────────────────
// Best effort, and labelled as such on screen. An IP tells you the network the request
// came out of, which for a customer on a phone is a mobile carrier two counties away.
// It is enough to answer "did this open somewhere I did not expect", which is the actual
// question, and not enough to claim more than that. Fails silently and fast: a geo
// lookup must never hold up handing somebody their password.
export async function lookupGeo(ip: string): Promise<{ city?: string; region?: string; country?: string; isp?: string } | null> {
  const clean = (ip || '').replace(/^::ffff:/, '');
  if (!clean || /^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(clean)) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,country,regionName,city,isp`,
      { signal: ctrl.signal });
    clearTimeout(t);
    const d: any = await r.json();
    if (!d || d.status !== 'success') return null;
    return { city: d.city, region: d.regionName, country: d.country, isp: d.isp };
  } catch { return null; }
}

/** Human-readable one-liner for an event row: "Swindon, England (BT) · 82.10.4.7". */
export function whereFrom(meta: any, ip: string | null): string {
  const g = meta && meta.geo ? meta.geo : null;
  const place = g ? [g.city, g.region, g.country].filter(Boolean).join(', ') : '';
  const isp = g && g.isp ? ` (${g.isp})` : '';
  const addr = ip ? (place ? ' · ' + ip : ip) : '';
  return (place + isp + addr) || 'unknown';
}

// ── Minting ─────────────────────────────────────────────────────────────────────

export interface MintResult { send: CredSend; passcode: string; url: string }

export async function mintCredentialSend(opts: {
  items: CredItem[]; appUrl: string; title?: string | null;
  customerId?: number | null; ticketId?: number | null; toEmail?: string | null;
  createdBy: number; ttlHours?: number;
}): Promise<MintResult> {
  if (!vaultConfigured()) throw new Error('Password vault key not configured on the server — cannot send credentials.');
  const items = (opts.items || [])
    .map((i) => ({
      label: String(i.label || '').trim() || 'Login',
      url: (i.url || '').toString().trim() || null,
      username: (i.username || '').toString().trim() || null,
      password: (i.password || '').toString() || null,
      note: (i.note || '').toString().trim() || null,
    }))
    .filter((i) => i.url || i.username || i.password || i.note);
  if (!items.length) throw new Error('Nothing to send — add at least one credential or link.');

  const token = newToken();
  const passcode = newPasscode();
  const salt = crypto.randomBytes(16).toString('hex');
  const ttl = Math.max(1, Math.min(24 * 30, opts.ttlHours || DEFAULT_TTL_HOURS));

  const { rows } = await pool.query(
    `INSERT INTO credential_sends
       (token, passcode_salt, passcode_hash, payload_encrypted, item_count, title,
        customer_id, ticket_id, to_email, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + ($11 || ' hours')::interval)
     RETURNING *`,
    [token, salt, hashPasscode(passcode, salt), encryptSecret(JSON.stringify(items)), items.length,
     opts.title || null, opts.customerId || null, opts.ticketId || null, opts.toEmail || null,
     opts.createdBy, String(ttl)]);

  const send = rows[0] as CredSend;
  await logCredEvent(send.id, 'created', { meta: { items: items.length, ttlHours: ttl, to: opts.toEmail || null } });
  return { send, passcode, url: opts.appUrl.replace(/\/$/, '') + '/c/' + token };
}

// ── Opening ─────────────────────────────────────────────────────────────────────

export type OpenState = 'ask' | 'burnt' | 'expired' | 'revoked' | 'locked' | 'missing';

export async function findByToken(token: string): Promise<CredSend | null> {
  const r = await pool.query('SELECT * FROM credential_sends WHERE token=$1 LIMIT 1', [token]);
  return r.rows[0] || null;
}

export function stateOf(s: CredSend | null): OpenState {
  if (!s) return 'missing';
  if (s.revoked_at) return 'revoked';
  if (s.revealed_at) return 'burnt';
  if (s.locked_at) return 'locked';
  if (new Date(s.expires_at).getTime() < Date.now()) return 'expired';
  return 'ask';
}

export interface RevealResult {
  ok: boolean;
  items?: CredItem[];
  state?: OpenState;
  attemptsLeft?: number;
}

/**
 * Check the passcode and, if it is right, hand back the credentials and destroy them.
 *
 * The destroy is a real one: payload_encrypted is set to NULL in the same statement that
 * stamps revealed_at, so even with the database in front of you there is nothing left to
 * decrypt. There is no "show it to me again" — that is the promise the feature makes.
 */
export async function revealCredentials(
  s: CredSend, passcodeGiven: string, ctx: { ip?: string | null; userAgent?: string | null },
): Promise<RevealResult> {
  const state = stateOf(s);
  if (state !== 'ask') return { ok: false, state };

  const given = normalisePasscode(passcodeGiven);
  const expected = Buffer.from(s.passcode_hash, 'hex');
  const actual = Buffer.from(hashPasscode(given, s.passcode_salt), 'hex');
  const good = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!good) {
    const r = await pool.query(
      `UPDATE credential_sends SET attempts = attempts + 1,
         locked_at = CASE WHEN attempts + 1 >= $2 THEN NOW() ELSE locked_at END
       WHERE id=$1 RETURNING attempts, locked_at`, [s.id, MAX_ATTEMPTS]);
    const attempts = r.rows[0]?.attempts ?? 0;
    const geo = await lookupGeo(ctx.ip || '');
    await logCredEvent(s.id, 'passcode_failed', { ip: ctx.ip, userAgent: ctx.userAgent, meta: { attempts, geo } });
    if (r.rows[0]?.locked_at) {
      await logCredEvent(s.id, 'locked', { ip: ctx.ip, userAgent: ctx.userAgent, meta: { attempts, geo } });
      return { ok: false, state: 'locked', attemptsLeft: 0 };
    }
    return { ok: false, state: 'ask', attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) };
  }

  // Right passcode. Burn and hand over — the UPDATE is the lock: two simultaneous
  // requests cannot both come back with a row, so the secret is handed over once.
  const burn = await pool.query(
    `UPDATE credential_sends SET revealed_at = NOW(), payload_encrypted = NULL
      WHERE id=$1 AND revealed_at IS NULL RETURNING $2::text AS blob`,
    [s.id, s.payload_encrypted]);
  if (!burn.rows.length) return { ok: false, state: 'burnt' };

  let items: CredItem[] = [];
  try { items = JSON.parse(decryptSecret(burn.rows[0].blob)); }
  catch (e) { console.error('[cred-send] decrypt failed:', (e as Error).message); return { ok: false, state: 'missing' }; }

  const geo = await lookupGeo(ctx.ip || '');
  await logCredEvent(s.id, 'revealed', { ip: ctx.ip, userAgent: ctx.userAgent, meta: { geo, items: items.length } });
  return { ok: true, items };
}

export async function revokeCredentialSend(id: number, byUserId: number): Promise<void> {
  await pool.query(
    `UPDATE credential_sends SET revoked_at = NOW(), payload_encrypted = NULL
      WHERE id=$1 AND revoked_at IS NULL AND revealed_at IS NULL`, [id]);
  await logCredEvent(id, 'revoked', { meta: { byUserId } });
}

export async function listCredentialSends(filter: { customerId?: number; ticketId?: number; limit?: number } = {}) {
  const where: string[] = []; const args: any[] = [];
  if (filter.customerId) { args.push(filter.customerId); where.push('s.customer_id = $' + args.length); }
  if (filter.ticketId) { args.push(filter.ticketId); where.push('s.ticket_id = $' + args.length); }
  args.push(Math.min(500, filter.limit || 100));
  const { rows } = await pool.query(
    `SELECT s.id, s.token, s.title, s.to_email, s.item_count, s.created_at, s.expires_at,
            s.revealed_at, s.revoked_at, s.attempts, s.locked_at,
            c.name AS customer_name, u.display_name AS created_by_name,
            (SELECT COUNT(*)::int FROM credential_send_events e
              WHERE e.send_id = s.id AND e.event = 'link_opened') AS opens
       FROM credential_sends s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.created_at DESC LIMIT $${args.length}`, args);
  return rows;
}

export async function getCredentialSendEvents(sendId: number) {
  const { rows } = await pool.query(
    `SELECT id, event, ip, user_agent, meta, created_at FROM credential_send_events
      WHERE send_id=$1 ORDER BY created_at DESC, id DESC`, [sendId]);
  return rows;
}

/** Status word for a list row — one place so the list, the case and the customer agree. */
export function statusOf(row: any): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (row.revoked_at) return { label: 'Revoked', tone: 'muted' };
  if (row.revealed_at) return { label: 'Collected', tone: 'ok' };
  if (row.locked_at) return { label: 'Locked out', tone: 'bad' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { label: 'Expired', tone: 'muted' };
  if (row.opens) return { label: 'Opened, not unlocked', tone: 'warn' };
  return { label: 'Waiting', tone: 'warn' };
}
