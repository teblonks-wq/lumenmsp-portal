import { pool } from '../db/pool';
import { sendToSupport, PushMessage } from './webpush';

// ─────────────────────────────────────────────────────────────────────────────────
// The Pulse — the mobile app's home screen is a BRIEFING, not a menu.
//
// From the design brief (agreed 16 Aug 2026): "a live, ranked feed of what deserves
// attention right now, written like a colleague would say it". The Portal already
// KNOWS everything that belongs on it - the watchdog, the security judge, SLA clocks,
// GoCardless - the Pulse is the first place those converge, ranked by "does this need
// a human in the next hour".
//
// THE PUSH COVENANT, which is the part that must never erode: a push notification
// means A HUMAN SHOULD ACT WITHIN THE HOUR. Kinds carry `push: true` only when they
// meet that bar. Everything else waits in the feed for the next glance. The moment a
// chatty kind gets promoted to push "just this once", people mute the app, and then
// the site-dark push at 2am reaches nobody - which is the whole ballgame lost.
//
// Publishing is deliberately idempotent: every card has a dedupe_key, and an OPEN card
// with the same key is UPDATED, not duplicated - and crucially NOT re-pushed. The
// flap-damping in alerts.ts and the dedupe here are two layers of the same promise:
// one event, one interruption.
// ─────────────────────────────────────────────────────────────────────────────────

export interface PulseKind {
  rank: number;          // higher = closer to the top of the feed
  push: boolean;         // covenant: does this interrupt a phone?
  icon: string;          // one emoji, rendered on the card
  label: string;         // for the settings screen's mute list
}

/**
 * The registry. Adding a kind is a DECISION about the covenant, not a config tweak -
 * which is why it lives in code where a diff shows it, not in a settings table where
 * it would drift.
 */
export const PULSE_KINDS: Record<string, PulseKind> = {
  site_dark:     { rank: 100, push: true,  icon: '⚡', label: 'Site dark / power' },
  agents_quiet:  { rank: 95,  push: true,  icon: '🔌', label: 'Agents gone quiet' },
  security_flip: { rank: 90,  push: true,  icon: '🔴', label: 'Security detection' },
  sla_risk:      { rank: 80,  push: true,  icon: '⏱',  label: 'SLA at risk' },
  dd_failed:     { rank: 70,  push: true,  icon: '💷', label: 'Direct Debit failed' },
  vip_case:      { rank: 65,  push: true,  icon: '⭐', label: 'VIP customer case' },
  alert:         { rank: 60,  push: false, icon: '🚨', label: 'System alerts' },        // generic raiseAlert bridge; critical ones push via publishAlert
  lead_new:      { rank: 40,  push: false, icon: '📥', label: 'New lead' },
  team:          { rank: 30,  push: false, icon: '📣', label: 'Team notices' },
};

export async function ensurePulseTables(): Promise<void> {
  const run = (sql: string) => pool.query(sql).catch((e) => console.error('[pulse] ensure:', e.message));
  await run(`CREATE TABLE IF NOT EXISTS pulse_events (
    id serial PRIMARY KEY,
    kind text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    title text NOT NULL,
    body text,
    link text,
    customer_id int,
    device_id int,
    rank int NOT NULL DEFAULT 50,
    pushed boolean NOT NULL DEFAULT false,
    created_at timestamp(3) NOT NULL DEFAULT NOW(),
    updated_at timestamp(3) NOT NULL DEFAULT NOW(),
    expires_at timestamp(3),
    resolved_at timestamp(3)
  )`);
  await run('CREATE INDEX IF NOT EXISTS pulse_events_feed_idx ON pulse_events (resolved_at, expires_at, rank)');
}

export interface PublishInput {
  kind: keyof typeof PULSE_KINDS | string;
  /** The sentence. Written like a colleague would say it - the fact, not a chart. */
  title: string;
  body?: string;
  /** Where the actions live. Every card must go SOMEWHERE actionable. */
  link: string;
  customerId?: number | null;
  deviceId?: number | null;
  /** One event, one card. Defaults to kind+link, which is right for most publishers. */
  dedupeKey?: string;
  /** How long the card stays in the feed unresolved. Default 24h. */
  ttlHours?: number;
  /** Force/deny the push regardless of the kind's default (e.g. critical alerts). */
  push?: boolean;
}

export interface PublishResult { id: number; isNew: boolean; pushedTo: number }

/**
 * Put a card in the Pulse; interrupt phones only when the covenant says so.
 *
 * Never throws - a briefing must not take down the thing it is briefing about. The
 * publishers (watchdog, GravityZone sync, webhooks) treat this as fire-and-forget.
 */
export async function publish(input: PublishInput): Promise<PublishResult> {
  const empty: PublishResult = { id: 0, isNew: false, pushedTo: 0 };
  try {
    const kind = String(input.kind);
    const meta = PULSE_KINDS[kind] || { rank: 50, push: false, icon: '•', label: kind };
    const key = (input.dedupeKey || (kind + ':' + input.link)).slice(0, 300);
    const ttl = Math.max(1, Math.min(24 * 14, input.ttlHours ?? 24));

    // An OPEN card with this key is the same ongoing event: refresh it, do not re-raise
    // and NEVER re-push. A RESOLVED card with this key is history - the event happening
    // again is genuinely new, so clear the old key and insert fresh.
    await pool.query(
      `UPDATE pulse_events SET dedupe_key = dedupe_key || ':closed:' || id
        WHERE dedupe_key=$1 AND resolved_at IS NOT NULL`, [key]);
    const r = await pool.query(
      `INSERT INTO pulse_events (kind, dedupe_key, title, body, link, customer_id, device_id, rank, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + ($9 || ' hours')::interval)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         title=EXCLUDED.title, body=EXCLUDED.body, updated_at=NOW(),
         expires_at=EXCLUDED.expires_at
       RETURNING id, (created_at = updated_at) AS is_new, pushed`,
      [kind, key, input.title.slice(0, 300), (input.body || '').slice(0, 1000) || null, input.link.slice(0, 300),
       input.customerId ?? null, input.deviceId ?? null, meta.rank, String(ttl)]);

    const id = Number(r.rows[0].id);
    const isNew = !!r.rows[0].is_new;
    const alreadyPushed = !!r.rows[0].pushed;

    const wantPush = input.push ?? meta.push;
    let pushedTo = 0;
    if (wantPush && isNew && !alreadyPushed) {
      const msg: PushMessage = { title: meta.icon + ' ' + input.title.slice(0, 110), body: input.body, url: input.link, tag: 'pulse-' + id };
      pushedTo = await sendToSupport(kind, msg);
      await pool.query('UPDATE pulse_events SET pushed=true WHERE id=$1', [id]).catch(() => {});
    }
    return { id, isNew, pushedTo };
  } catch (e: any) {
    console.error('[pulse] publish failed:', e.message);
    return empty;
  }
}

/** The event is over - the card leaves the feed. Keyed the same way it was published. */
export async function resolve(dedupeKey: string): Promise<void> {
  try {
    await pool.query('UPDATE pulse_events SET resolved_at=NOW() WHERE dedupe_key=$1 AND resolved_at IS NULL', [dedupeKey]);
  } catch (e: any) { console.error('[pulse] resolve failed:', e.message); }
}

/** One person read one card and is done with it. Personal dismiss = resolve, phase 1. */
export async function dismiss(id: number): Promise<void> {
  try {
    await pool.query('UPDATE pulse_events SET resolved_at=NOW() WHERE id=$1 AND resolved_at IS NULL', [id]);
  } catch (e: any) { console.error('[pulse] dismiss failed:', e.message); }
}

export interface PulseCard {
  id: number; kind: string; icon: string; title: string; body: string | null;
  link: string; customerId: number | null; deviceId: number | null;
  rank: number; ageMinutes: number; ageLabel: string;
}

/**
 * The briefing, ranked. Severity first, then freshness inside a rank. Ages computed in
 * SQL against the database clock - never Date.now() minus a column (the BST trap).
 */
export async function feed(limit = 40): Promise<PulseCard[]> {
  const rows = (await pool.query(
    `SELECT id, kind, title, body, link, customer_id, device_id, rank,
            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - updated_at)))::bigint AS age_secs
       FROM pulse_events
      WHERE resolved_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY rank DESC, updated_at DESC
      LIMIT $1`, [limit])).rows;
  return rows.map((r: any) => {
    const mins = Math.floor(Number(r.age_secs) / 60);
    const ageLabel = mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago'
      : mins < 60 * 24 ? Math.floor(mins / 60) + 'h ago' : Math.floor(mins / 1440) + 'd ago';
    return {
      id: Number(r.id), kind: String(r.kind),
      icon: (PULSE_KINDS[r.kind] || { icon: '•' }).icon,
      title: String(r.title), body: r.body || null, link: String(r.link),
      customerId: r.customer_id ? Number(r.customer_id) : null,
      deviceId: r.device_id ? Number(r.device_id) : null,
      rank: Number(r.rank), ageMinutes: mins, ageLabel,
    };
  });
}
