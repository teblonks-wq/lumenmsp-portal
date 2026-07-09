import { pool } from '../db/pool';
import { config } from '../config';
import { sendTeamsNotice } from './teams';
import { sendMail } from './mailer';
import { notifyAgents } from './callhub';
import { nextTicketNumber } from '../routes/tickets';

// Central alert pipeline. Every external monitor (Giacom status, UniFi) calls raiseAlert(); it
// dedupes, then for a NEW alert: opens a ticket, pings the support group on Teams, and pops a
// real-time toast to logged-in staff. resolveAlert() closes one when the source clears it.

export async function ensureAlertsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id          BIGSERIAL PRIMARY KEY,
      source      TEXT NOT NULL,
      external_id TEXT,
      severity    TEXT DEFAULT 'warning',
      title       TEXT,
      body        TEXT,
      url         TEXT,
      status      TEXT DEFAULT 'open',
      ticket_id   INTEGER,
      raw         JSONB,
      started_at  TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_ext ON alerts (source, external_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, created_at DESC);
  `);
}

export interface AlertInput {
  source: 'giacom' | 'unifi' | string;
  externalId?: string | null;
  severity?: 'info' | 'warning' | 'critical' | string;
  title: string;
  body?: string;
  url?: string;
  raw?: any;
  autoTicket?: boolean;   // default true; set false to raise the alert WITHOUT opening a ticket
}

const SEV_LABEL: Record<string, string> = { critical: '🔴', warning: '🟠', info: '🔵' };

async function createAlertTicket(a: AlertInput): Promise<number | null> {
  try {
    const tn = await nextTicketNumber();
    const subject = (`[${a.source.toUpperCase()}] ` + a.title).slice(0, 160);
    const desc = '<div style="white-space:pre-wrap;">' + String(a.body || a.title).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c])
      + (a.url ? '\n\n' + a.url : '') + '</div>';
    const r = await pool.query(
      `INSERT INTO inbox_tickets (ticket_number, source, status, department, category, subject, description, activity_status, stage, updated_at)
       VALUES ($1,'alert','new','support','incident',$2,$3,'unread','awaiting_triage',NOW()) RETURNING id`,
      [tn, subject, desc]
    );
    return r.rows[0].id;
  } catch (e) { console.error('[alerts] ticket create failed:', (e as Error).message); return null; }
}

async function teamsNotifyAlert(a: AlertInput, ticketId: number | null): Promise<void> {
  try {
    const staff = await pool.query("SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL");
    const link = (config.APP_URL || 'https://portal.lumenmsp.co.uk') + (ticketId ? '/tickets/' + ticketId : '/alerts');
    const title = `${SEV_LABEL[a.severity || 'warning'] || '🟠'} ${a.source === 'giacom' ? 'Giacom' : a.source === 'unifi' ? 'UniFi' : a.source} alert`;
    const text = a.title + (a.url ? `\nSite: ${a.url}` : '');
    await Promise.allSettled(staff.rows.map((s: any) => sendTeamsNotice({ toEmail: s.email, title, text, link })));
  } catch (e) { console.error('[alerts] teams notify failed:', (e as Error).message); }
}

// Primary alert channel: email the support group. Teams is the fallback (some people miss Teams).
async function emailNotifyAlert(a: AlertInput, ticketId: number | null): Promise<void> {
  try {
    const staff = await pool.query("SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL");
    if (!staff.rows.length) return;
    const link = (config.APP_URL || 'https://portal.lumenmsp.co.uk') + (ticketId ? '/tickets/' + ticketId : '/alerts');
    const sev = SEV_LABEL[a.severity || 'warning'] || '🟠';
    const src = a.source === 'giacom' ? 'Giacom' : a.source === 'unifi' ? 'UniFi' : a.source;
    const esc = (s: string) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
    const subject = `${sev} ${src} alert: ${a.title}`.slice(0, 180);
    const html = `<p style="font-size:15px;"><strong>${esc(a.title)}</strong></p>`
      + (a.body ? `<p style="color:#374151;">${esc(a.body).replace(/\n/g, '<br>')}</p>` : '')
      + `<p style="margin:16px 0;">`
      + `<a href="${link}" style="display:inline-block;background:#0ea5b7;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-weight:600;margin-right:8px;">Open in the portal</a>`
      + (a.url ? `<a href="${esc(a.url)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-weight:600;">Open the site ↗</a>` : '')
      + `</p>`;
    await Promise.allSettled(staff.rows.map((s: any) => sendMail({ to: s.email, subject, html }).catch(() => {})));
  } catch (e) { console.error('[alerts] email notify failed:', (e as Error).message); }
}

export async function raiseAlert(a: AlertInput): Promise<{ id: number; isNew: boolean }> {
  // De-dup so we alert ONCE when something goes on the board, stay quiet while it's open, and only
  // fire a fresh alert for a genuinely new outage (recovered-and-stayed-recovered, then down again).
  if (a.externalId) {
    // (1) Already open → same ongoing event: never re-notify.
    const open = await pool.query("SELECT id FROM alerts WHERE source=$1 AND external_id=$2 AND status='open'", [a.source, a.externalId]);
    if (open.rows.length) return { id: open.rows[0].id, isNew: false };
    // (2) Resolved only moments ago → this is flapping, not a new outage. Silently reopen the same
    //     alert (back on the board) without a fresh notification — kills the duplicate-report flood.
    const recent = await pool.query(
      "SELECT id FROM alerts WHERE source=$1 AND external_id=$2 AND status='resolved' AND resolved_at > NOW() - INTERVAL '30 minutes' ORDER BY resolved_at DESC LIMIT 1",
      [a.source, a.externalId]);
    if (recent.rows.length) {
      await pool.query("UPDATE alerts SET status='open', resolved_at=NULL WHERE id=$1", [recent.rows[0].id]).catch(() => {});
      return { id: recent.rows[0].id, isNew: false };
    }
    // (3) Otherwise it's a genuinely new event → fall through and raise + notify.
  }
  const r = await pool.query(
    `INSERT INTO alerts (source, external_id, severity, title, body, url, raw) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [a.source, a.externalId || null, a.severity || 'warning', a.title.slice(0, 200), (a.body || '').slice(0, 4000), a.url || null, a.raw ? JSON.stringify(a.raw) : null]
  );
  const id = r.rows[0].id;
  // Open a ticket automatically unless the caller opted out (e.g. UniFi — operator decides).
  const ticketId = a.autoTicket === false ? null : await createAlertTicket(a);
  if (ticketId) { try { await pool.query('UPDATE alerts SET ticket_id=$1 WHERE id=$2', [ticketId, id]); } catch { /* ignore */ } }
  try { notifyAgents({ type: 'alert', alertId: id, source: a.source, severity: a.severity || 'warning', title: a.title, body: (a.body || '').slice(0, 160), ticketId }); } catch { /* ignore */ }
  await emailNotifyAlert(a, ticketId);   // primary
  await teamsNotifyAlert(a, ticketId);   // fallback
  return { id, isNew: true };
}

// Mark a source's alert resolved (the monitor saw it clear). No-op if not found / already resolved.
export async function resolveAlert(source: string, externalId: string): Promise<void> {
  await pool.query(
    "UPDATE alerts SET status='resolved', resolved_at=NOW() WHERE source=$1 AND external_id=$2 AND status='open'",
    [source, externalId]
  );
}

export async function resolveAlertById(id: number): Promise<void> {
  await pool.query("UPDATE alerts SET status='resolved', resolved_at=NOW() WHERE id=$1", [id]);
}

// Manually open a ticket for an existing alert (the "Create ticket" button on the N3twrx page).
// Returns the ticket id (existing one if the alert already had a ticket).
export async function createTicketForAlert(alertId: number): Promise<number | null> {
  const a = (await pool.query('SELECT * FROM alerts WHERE id=$1', [alertId])).rows[0];
  if (!a) return null;
  if (a.ticket_id) return a.ticket_id;
  const ticketId = await createAlertTicket({ source: a.source, title: a.title, body: a.body, url: a.url, severity: a.severity });
  if (ticketId) await pool.query('UPDATE alerts SET ticket_id=$1 WHERE id=$2', [ticketId, alertId]);
  return ticketId;
}

export async function listAlerts(status = 'open', limit = 100): Promise<any[]> {
  if (status === 'all') {
    return (await pool.query('SELECT * FROM alerts ORDER BY (status=\'open\') DESC, created_at DESC LIMIT $1', [limit])).rows;
  }
  return (await pool.query('SELECT * FROM alerts WHERE status=$1 ORDER BY created_at DESC LIMIT $2', [status, limit])).rows;
}

export async function openAlertCount(): Promise<number> {
  return (await pool.query("SELECT COUNT(*)::int n FROM alerts WHERE status='open'")).rows[0].n;
}
