import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import { config } from '../config';
import { sendMail } from './mailer';
import { alertGroup } from './notifications';

// ─────────────────────────────────────────────────────────────────────────────────
// Public self-registration — someone with a problem, no account, and no patience.
//
// Terry, 2026-08-19: "allow people to log support tickets by creating an account on
// portal home page pre-login… sign up via MS or email and password… we will get them
// to write company name but make NO MATCH using our internal data."
//
// THE NO-MATCH RULE IS A SECURITY CONTROL, NOT A SHORTCUT. Portal access level is
// derived in my.ts by matching the login's email to a `customer_contacts` row of the
// customer they are attached to. If signup matched a self-declared company name — or,
// worse, the email domain — against `customers`, then anyone who could receive mail at
// a customer's domain could self-register and inherit that contact's tier, up to and
// including every ticket the company has ever raised. The company name they type is
// therefore stored as FREE TEXT on their own account and compared to nothing.
//
// Where they land: a placeholder customer. `customers.is_placeholder` already exists for
// system catch-alls, and every estate-facing query in the Portal already excludes it
// (mass mailer, Giacom sync, GravityZone, the admin customer pickers), so these accounts
// cannot leak into billing, marketing or security screens by being here. It also means
// /my needs no new access model: its scoping is `session.customerId`, which is simply
// this placeholder, and every permission derives to false because the account is not a
// key contact of it.
//
// What they get: raise a ticket, see their own tickets, reply. Nothing else. Linking the
// account to the real customer stays a deliberate act by a human who has checked who
// they are.
// ─────────────────────────────────────────────────────────────────────────────────

/** Stable handle for the catch-all company. `account_number` is UNIQUE, so this cannot double-create. */
const SELF_REG_ACCOUNT = 'self-registered';
const SELF_REG_NAME = 'Self-registered (unverified)';

/** How long a verification link is good for. */
const VERIFY_HOURS = 24;
/** Signups allowed from one IP per hour before we stop taking them. */
const SIGNUPS_PER_IP_PER_HOUR = 3;
/** Shortest password we will accept. Length beats punctuation rules. */
export const MIN_PASSWORD = 10;

/**
 * Columns this feature owns. Idempotent, called at startup like ensureCustomerPortalColumn.
 * They are ALSO in schema.prisma — `prisma db push` runs on every deploy and drops any column
 * it does not know about, which has already cost this Portal 51 rows of social_posts once.
 */
export async function ensureSignupColumns(): Promise<void> {
  const add = (sql: string) => pool.query(sql).catch((e) => console.error('ensureSignupColumns:', e.message));
  await add("ALTER TABLE users ADD COLUMN IF NOT EXISTS company_claimed text");
  await add("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false");
  await add("ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_hash text");
  await add("ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_sent_at timestamp(3)");
  await add("ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source text");
  await add("ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ip text");
  await add("ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_at timestamp(3)");
}

/**
 * The placeholder company every self-registered account hangs off.
 *
 * `portal_enabled` must be true or attachPerms refuses the whole /my area — that switch is
 * about the COMPANY being allowed in, and for this company the answer is yes; what each
 * person may do is settled by their (absent) key-contact role, which is the tighter gate.
 */
export async function ensureSelfSignupCustomer(): Promise<number> {
  const found = (await pool.query(
    'SELECT id FROM customers WHERE account_number=$1 LIMIT 1', [SELF_REG_ACCOUNT])).rows[0];
  if (found) return Number(found.id);
  const ins = (await pool.query(
    `INSERT INTO customers (account_number, name, status, is_placeholder, portal_enabled)
     VALUES ($1,$2,'lead',true,true)
     ON CONFLICT (account_number) DO UPDATE SET portal_enabled=true
     RETURNING id`, [SELF_REG_ACCOUNT, SELF_REG_NAME])).rows[0];
  return Number(ins.id);
}

/** Tokens are stored hashed. A database copy should not be a working set of login links. */
const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export interface SignupInput {
  email: string;
  displayName: string;
  companyClaimed: string;
  password?: string;      // email+password signup
  entraOid?: string;      // Microsoft signup — already proven by Microsoft
  ip: string;
}

export interface SignupResult {
  /** False when we declined to create anything. The caller still shows the same page — see below. */
  created: boolean;
  userId?: number;
  /** Set only for password signups that need to confirm their address. */
  verifyToken?: string;
  /** For the log, never for the screen. */
  reason?: string;
}

/** Too many accounts from one address in an hour is a script, not a rush of new customers. */
export async function tooManySignups(ip: string): Promise<boolean> {
  const r = await pool.query(
    "SELECT COUNT(*)::int n FROM users WHERE signup_ip=$1 AND signup_at > NOW() - INTERVAL '1 hour'",
    [ip]).catch(() => ({ rows: [{ n: 0 }] }));
  return Number(r.rows[0]?.n || 0) >= SIGNUPS_PER_IP_PER_HOUR;
}

/**
 * Create the account, the contact row behind it, and (for passwords) a verification token.
 *
 * The contact row is not decoration. `/my` scopes "your own tickets" by `contact_id`, and a
 * user with no contact resolves that to NULL — which matches nothing, so they would raise a
 * ticket and then be unable to see it. Creating the contact against the PLACEHOLDER customer
 * gives them ownership of their own tickets and nothing else.
 *
 * Returns `created: false` for an address we already hold. The caller must show the SAME
 * screen either way: telling a stranger "that email already has an account" turns this form
 * into a way to test whether any given person is a customer of ours.
 */
export async function createSelfSignup(input: SignupInput): Promise<SignupResult> {
  const email = String(input.email || '').toLowerCase().trim();
  const name = String(input.displayName || '').trim().slice(0, 120) || email;
  const company = String(input.companyClaimed || '').trim().slice(0, 200);

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { created: false, reason: 'bad email' };
  if (input.password && input.password.length < MIN_PASSWORD) return { created: false, reason: 'short password' };

  const existing = (await pool.query('SELECT id FROM users WHERE lower(email)=$1 LIMIT 1', [email])).rows[0];
  if (existing) return { created: false, reason: 'email already registered' };

  const customerId = await ensureSelfSignupCustomer();
  const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : null;

  // Microsoft has already proved the address; a password signup has proved nothing yet.
  const verified = !!input.entraOid;
  const token = verified ? null : crypto.randomBytes(32).toString('hex');

  const user = (await pool.query(
    `INSERT INTO users (email, display_name, role, is_active, customer_id, password_hash, entra_oid,
                        company_claimed, email_verified, verify_token_hash, verify_sent_at,
                        signup_source, signup_ip, signup_at, hidden_from_lookups)
     VALUES ($1,$2,'customer',true,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),true)
     RETURNING id`,
    [email, name, customerId, passwordHash, input.entraOid || null, company || null,
     verified, token ? hashToken(token) : null, token ? new Date() : null,
     input.entraOid ? 'microsoft' : 'password', input.ip || null])).rows[0];

  // The contact row that makes "your own tickets" work. Marked with the claimed company so a
  // triaging engineer can see who they SAY they are without it meaning anything to the system.
  // `marketing_opt_out` is set even though placeholder customers are already excluded from
  // the Mass Mailer: a stranger who wanted help must not end up on a marketing list because
  // somebody later relaxes that exclusion.
  await pool.query(
    `INSERT INTO customer_contacts (customer_id, full_name, email, job_title, portal_access_level, marketing_opt_out)
     VALUES ($1,$2,$3,$4,'tickets',true)`,
    [customerId, name, email, company ? ('Self-registered — claims: ' + company).slice(0, 120) : 'Self-registered'],
  ).catch((e) => console.error('self-signup contact create failed:', e.message));

  return { created: true, userId: Number(user.id), verifyToken: token || undefined };
}

const esc = (s: string) => String(s || '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

/** The confirmation email. Deliberately plain: no branding claims, no attachments, one link. */
export async function sendVerificationEmail(email: string, name: string, token: string): Promise<void> {
  const link = config.APP_URL + '/signup/verify?token=' + encodeURIComponent(token);
  await sendMail({
    to: email,
    subject: 'Confirm your email address — Lumen IT Solutions support',
    html:
      `<p>Hello ${esc(name)},</p>` +
      `<p>Please confirm this email address so you can raise support requests with Lumen IT Solutions.</p>` +
      `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#0ea5b7;color:#fff;` +
      `border-radius:8px;text-decoration:none;font-weight:600;">Confirm my email address</a></p>` +
      `<p style="color:#64748b;font-size:13px;">Or paste this into your browser:<br>${esc(link)}</p>` +
      `<p style="color:#64748b;font-size:13px;">This link works for ${VERIFY_HOURS} hours. ` +
      `If you did not ask for an account, you can ignore this email and nothing will happen.</p>`,
    autoSubmitted: true,
  });
}

/**
 * Someone clicked the link. Single use, time limited, and it tells the caller which of the
 * three outcomes happened rather than collapsing them into a boolean — "already confirmed"
 * deserves a friendly page, not an error.
 */
export interface VerifyOutcome {
  outcome: 'ok' | 'expired' | 'invalid';
  /** Set on the FIRST successful confirmation only — that is when the helpdesk wants telling. */
  newlyVerifiedUserId?: number;
}

export async function verifyEmailToken(token: string): Promise<VerifyOutcome> {
  const t = String(token || '').trim();
  if (!t) return { outcome: 'invalid' };
  const row = (await pool.query(
    `SELECT id, verify_sent_at, email_verified FROM users WHERE verify_token_hash=$1 LIMIT 1`,
    [hashToken(t)])).rows[0];
  // No row means: never issued, already used (the hash is cleared on success), or forged.
  // They are one message on purpose - distinguishing them would confirm which tokens exist.
  if (!row) return { outcome: 'invalid' };
  // Age is measured in SQL, not against the Node clock: the column is a zone-less timestamp
  // and mixing the two clocks is exactly the trap that made every "x ago" an hour out.
  const fresh = (await pool.query(
    `SELECT (verify_sent_at IS NOT NULL AND verify_sent_at > NOW() - ($2 || ' hours')::interval) AS ok
       FROM users WHERE id=$1`, [row.id, String(VERIFY_HOURS)])).rows[0];
  if (!fresh?.ok) return { outcome: 'expired' };
  await pool.query(
    'UPDATE users SET email_verified=true, verify_token_hash=NULL WHERE id=$1', [row.id]);
  return { outcome: 'ok', newlyVerifiedUserId: Number(row.id) };
}

/** Re-issue a link for an account that has not confirmed yet. Returns the new token, or null. */
export async function reissueVerification(email: string): Promise<{ token: string; name: string } | null> {
  const row = (await pool.query(
    `SELECT id, display_name FROM users WHERE lower(email)=$1 AND role='customer'
       AND email_verified=false AND password_hash IS NOT NULL LIMIT 1`,
    [String(email || '').toLowerCase().trim()])).rows[0];
  if (!row) return null;
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('UPDATE users SET verify_token_hash=$1, verify_sent_at=NOW() WHERE id=$2',
    [hashToken(token), row.id]);
  return { token, name: row.display_name };
}

/** True when this login is one of the self-registered, unaffiliated accounts. */
export async function isSelfRegistered(userId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM users u JOIN customers c ON c.id=u.customer_id
      WHERE u.id=$1 AND c.account_number=$2 LIMIT 1`, [userId, SELF_REG_ACCOUNT]).catch(() => ({ rows: [] as any[] }));
  return r.rows.length > 0;
}

/**
 * Tell the helpdesk a stranger has arrived, once the address is confirmed.
 *
 * Sent on VERIFICATION rather than on signup: an unconfirmed address is not yet a person,
 * and an alert per attempt would make this the noisiest thing in the notifications list
 * within a week of the first bot finding the form.
 */
export async function alertNewSignup(userId: number): Promise<void> {
  const u = (await pool.query(
    'SELECT email, display_name, company_claimed FROM users WHERE id=$1', [userId])).rows[0];
  if (!u) return;
  await alertGroup('support',
    'New self-registered contact — ' + (u.company_claimed || 'no company given'),
    `${u.display_name} <${u.email}> confirmed their email and can now raise tickets. `
    + `They are NOT linked to a customer — check who they are and link them if they are one of ours.`,
    '/admin/self-registered');
}
