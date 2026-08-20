import { pool } from '../db/pool';

// ─────────────────────────────────────────────────────────────────────────────────
// Web Push — the one real piece of infrastructure in mobile phase 1.
//
// Everything signature about the mobile app (the Pulse, the push covenant) sits on
// this file. It deliberately does three small things and nothing else:
//
//   1. Store per-user/per-device push subscriptions (a phone's endpoint + keys).
//   2. Send a payload to a user, honouring their mutes and quiet hours.
//   3. Throw dead subscriptions away the moment the push service says 404/410 —
//      a subscription that has stopped existing is not an error, it is a phone that
//      uninstalled the app, and retrying it forever is how push senders rot.
//
// The `web-push` library does the heavy lifting (VAPID JWTs + RFC 8291 payload
// encryption). It is REQUIRED LAZILY so the Portal still boots — and tsc still
// compiles — when the package is not installed yet; push is then simply "not
// configured", loudly, once, in the log.
//
// VAPID keys come from the server .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT). Generate once with `npx web-push generate-vapid-keys` ON THE
// SERVER and never rotate casually: rotating invalidates every subscription.
// ─────────────────────────────────────────────────────────────────────────────────

let webpushLib: any = null;
let initTried = false;

function lib(): any | null {
  if (initTried) return webpushLib;
  initTried = true;
  const pub = process.env.VAPID_PUBLIC_KEY || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  if (!pub || !priv) {
    console.log('[webpush] VAPID keys not set - push disabled (npx web-push generate-vapid-keys, then .env)');
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    webpushLib = require('web-push');
    webpushLib.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@lumenmsp.co.uk', pub, priv);
  } catch (e: any) {
    console.error('[webpush] web-push not installed - run `npm i web-push` in the Portal folder:', e.message);
    webpushLib = null;
  }
  return webpushLib;
}

export function pushConfigured(): boolean { return !!lib(); }
export function vapidPublicKey(): string { return process.env.VAPID_PUBLIC_KEY || ''; }

export async function ensurePushTables(): Promise<void> {
  const run = (sql: string) => pool.query(sql).catch((e) => console.error('[webpush] ensure:', e.message));
  await run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id serial PRIMARY KEY,
    user_id int NOT NULL,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    ua text,
    created_at timestamp(3) NOT NULL DEFAULT NOW(),
    last_ok_at timestamp(3),
    failures int NOT NULL DEFAULT 0
  )`);
  await run('CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id)');
  // Per-user notification preferences ride on users: { muted: [kinds], quiet: {start,end} }.
  // In schema.prisma too, or db push drops it on the next deploy.
  await run('ALTER TABLE users ADD COLUMN IF NOT EXISTS push_prefs jsonb');
}

/** A phone registered (or re-registered - endpoints rotate, so upsert). */
export async function saveSubscription(userId: number, sub: any, ua?: string): Promise<boolean> {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!endpoint.startsWith('https://') || !p256dh || !auth) return false;
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh,
       auth=EXCLUDED.auth, ua=EXCLUDED.ua, failures=0`,
    [userId, endpoint, p256dh, auth, (ua || '').slice(0, 300) || null]);
  return true;
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [String(endpoint || '')]);
}

export interface PushPrefs { muted: string[]; quiet: { start: string; end: string } | null }

export function parsePrefs(raw: any): PushPrefs {
  const p = (raw && typeof raw === 'object') ? raw : {};
  const muted = Array.isArray(p.muted) ? p.muted.map(String) : [];
  const q = p.quiet && typeof p.quiet === 'object' && p.quiet.start && p.quiet.end
    ? { start: String(p.quiet.start), end: String(p.quiet.end) } : null;
  return { muted, quiet: q };
}

/**
 * Is it quiet hours for this person right now, in the timezone their rota lives in?
 *
 * A window like 22:00-07:00 crosses midnight; one like 12:00-14:00 does not. Both are
 * supported by comparing minutes-of-day. `now` is injectable so the tests do not have
 * to wait for bedtime.
 */
export function inQuietHours(prefs: PushPrefs, now: Date = new Date()): boolean {
  if (!prefs.quiet) return false;
  const mins = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim()); return m ? (Number(m[1]) * 60 + Number(m[2])) : NaN; };
  const start = mins(prefs.quiet.start), end = mins(prefs.quiet.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) return false;
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.format(now).split(':');
  const cur = Number(parts[0]) * 60 + Number(parts[1]);
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

export interface PushMessage { title: string; body?: string; url?: string; tag?: string }

/**
 * Send to every device a user has registered. Dead endpoints (404/410) are deleted on
 * the spot; other failures increment a counter and give up for good at five straight -
 * a push endpoint that errors five sends running is not coming back.
 */
export async function sendToUser(userId: number, msg: PushMessage): Promise<number> {
  const wp = lib();
  if (!wp) return 0;
  const subs = (await pool.query('SELECT * FROM push_subscriptions WHERE user_id=$1', [userId])).rows;
  let sent = 0;
  const payload = JSON.stringify({ title: msg.title.slice(0, 120), body: (msg.body || '').slice(0, 240), url: msg.url || '/m', tag: msg.tag || 'lumen-pulse' });
  for (const s of subs) {
    try {
      await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
      sent++;
      await pool.query('UPDATE push_subscriptions SET last_ok_at=NOW(), failures=0 WHERE id=$1', [s.id]).catch(() => {});
    } catch (e: any) {
      const code = Number(e?.statusCode || 0);
      if (code === 404 || code === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]).catch(() => {});
      } else {
        await pool.query('DELETE FROM push_subscriptions WHERE id=$1 AND failures >= 4', [s.id]).catch(() => {});
        await pool.query('UPDATE push_subscriptions SET failures=failures+1 WHERE id=$1', [s.id]).catch(() => {});
        console.error('[webpush] send failed (' + (code || 'no status') + '):', (e?.message || e || '').toString().slice(0, 120));
      }
    }
  }
  return sent;
}

/**
 * The covenant delivery: push to every SUPPORT-group member whose preferences allow it.
 * `kind` is what mutes are keyed on. Quiet hours silence the phone, not the Pulse - the
 * card still appears in the feed; only the interruption is withheld.
 */
export async function sendToSupport(kind: string, msg: PushMessage, now: Date = new Date()): Promise<number> {
  if (!lib()) return 0;
  const staff = (await pool.query(
    `SELECT id, push_prefs FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true`)).rows;
  let sent = 0;
  for (const s of staff) {
    const prefs = parsePrefs(s.push_prefs);
    if (prefs.muted.includes(kind)) continue;
    if (inQuietHours(prefs, now)) continue;
    sent += await sendToUser(Number(s.id), msg);
  }
  return sent;
}
