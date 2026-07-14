import crypto from 'crypto';
import { pool } from '../db/pool';
import { getGroup } from './settings';

// Chat-bot availability (Marketing → Chat Bot). Disabled by default; when enabled it's "online"
// only within the configured hours (default 09:00–17:00 Mon–Fri, UK time).
export async function chatbotConfig(): Promise<{ enabled: boolean; online: boolean; open: string; close: string; days: string[] }> {
  const g = await getGroup('chatbot').catch(() => ({} as Record<string, string>));
  const enabled = g.enabled === 'true';
  const open = g.open_time || '09:00';
  const close = g.close_time || '17:00';
  const days = (g.days || 'mon,tue,wed,thu,fri').split(',').map((d) => d.trim()).filter(Boolean);
  const now = new Date();
  const ukOffset = ([4, 5, 6, 7, 8, 9, 10].includes(now.getUTCMonth() + 1)) ? 60 : 0; // approx BST
  const uk = new Date(now.getTime() + ukOffset * 60000);
  const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][uk.getUTCDay()];
  const hhmm = ('0' + uk.getUTCHours()).slice(-2) + ':' + ('0' + uk.getUTCMinutes()).slice(-2);
  const online = enabled && days.indexOf(dayKey) >= 0 && hhmm >= open && hhmm < close;
  return { enabled, online, open, close, days };
}

// Website live-chat: a visitor opens the widget, the bot collects Name/Email/Phone + department,
// then it becomes a live conversation handled by staff in the portal Chat console.

export async function ensureChatTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id               BIGSERIAL PRIMARY KEY,
      token            TEXT UNIQUE NOT NULL,
      name             TEXT,
      email            TEXT,
      phone            TEXT,
      department       TEXT,
      status           TEXT DEFAULT 'active',
      origin           TEXT,
      assigned_user_id INTEGER,
      contact_id       INTEGER,
      customer_id      INTEGER,
      created_ticket_id  INTEGER,
      created_lead_id    INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      last_visitor_at  TIMESTAMPTZ,
      last_agent_at    TIMESTAMPTZ,
      info_prompted    BOOLEAN DEFAULT false
    );
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS info_prompted BOOLEAN DEFAULT false;
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      sender     TEXT NOT NULL,
      body       TEXT,
      user_id    INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_msg_session ON chat_messages (session_id, id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions (status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS chat_visitors (
      visitor_id    TEXT PRIMARY KEY,
      page          TEXT,
      title         TEXT,
      referrer      TEXT,
      session_token TEXT,
      first_seen    TIMESTAMPTZ DEFAULT NOW(),
      last_seen     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_visitors_seen ON chat_visitors (last_seen DESC);
    CREATE TABLE IF NOT EXISTS web_views (
      id         BIGSERIAL PRIMARY KEY,
      visitor_id TEXT,
      page       TEXT,
      title      TEXT,
      referrer   TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_web_views_created ON web_views (created_at DESC);
    ALTER TABLE chat_visitors ADD COLUMN IF NOT EXISTS ip TEXT;
    ALTER TABLE chat_visitors ADD COLUMN IF NOT EXISTS user_agent TEXT;
    ALTER TABLE chat_visitors ADD COLUMN IF NOT EXISTS browser TEXT;
    ALTER TABLE chat_visitors ADD COLUMN IF NOT EXISTS os TEXT;
    ALTER TABLE chat_visitors ADD COLUMN IF NOT EXISTS device TEXT;
    ALTER TABLE chat_visitors ADD COLUMN IF NOT EXISTS lang TEXT;
    ALTER TABLE chat_visitors ADD COLUMN IF NOT EXISTS screen TEXT;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS ip TEXT;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS browser TEXT;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS os TEXT;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
  `);
}

// Lightweight User-Agent parser (no dependency) → browser, OS, device class.
export function parseUA(ua: string): { browser: string; os: string; device: string } {
  ua = String(ua || '');
  let browser = 'Unknown', os = 'Unknown', device = 'Desktop';
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Version\/.*Safari/.test(ua)) browser = 'Safari';
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) device = 'Tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile/.test(ua)) device = 'Mobile';
  return { browser, os, device };
}

// One row per page view (logged on page load) — feeds Marketing → Website Stats.
export async function logView(visitorId: string, page: string, title: string, referrer: string): Promise<void> {
  await pool.query(
    `INSERT INTO web_views (visitor_id, page, title, referrer) VALUES ($1,$2,$3,$4)`,
    [visitorId.slice(0, 64), page || null, title || null, referrer || null]
  );
}

export async function websiteStats(): Promise<any> {
  const [tot, uniq, pages, refs, days, live] = await Promise.all([
    pool.query(`SELECT
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS today,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS last30,
        COUNT(*)::int AS total FROM web_views`),
    pool.query(`SELECT COUNT(DISTINCT visitor_id)::int AS n FROM web_views WHERE created_at > NOW() - INTERVAL '30 days'`),
    pool.query(`SELECT COALESCE(page,'(unknown)') AS page, COUNT(*)::int AS n FROM web_views
                 WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY page ORDER BY n DESC LIMIT 12`),
    pool.query(`SELECT COALESCE(NULLIF(referrer,''),'(direct)') AS referrer, COUNT(*)::int AS n FROM web_views
                 WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY n DESC LIMIT 12`),
    pool.query(`SELECT to_char(d.day,'DD Mon') AS label, COALESCE(v.n,0)::int AS n
                  FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d(day)
                  LEFT JOIN (SELECT created_at::date AS day, COUNT(*) n FROM web_views GROUP BY 1) v ON v.day = d.day::date
                 ORDER BY d.day`),
    pool.query(`SELECT COUNT(*)::int AS n FROM chat_visitors WHERE last_seen > NOW() - INTERVAL '40 seconds'`),
  ]);
  return {
    today: tot.rows[0].today, last7: tot.rows[0].last7, last30: tot.rows[0].last30, total: tot.rows[0].total,
    uniques30: uniq.rows[0].n, topPages: pages.rows, topReferrers: refs.rows, byDay: days.rows, liveNow: live.rows[0].n,
  };
}

// Unique visitors for a period (today | week | month) with their device profile + pages visited.
export async function visitorList(period: string): Promise<any[]> {
  const intervals: Record<string, string> = { week: '7 days', month: '30 days' };
  const wherePeriod = period === 'today'
    ? 'wv.created_at::date = CURRENT_DATE'
    : `wv.created_at > NOW() - INTERVAL '${intervals[period] || '7 days'}'`;
  return (await pool.query(
    `SELECT wv.visitor_id, COUNT(*)::int AS views,
            MIN(wv.created_at) AS first_seen, MAX(wv.created_at) AS last_seen,
            MAX(v.browser) AS browser, MAX(v.os) AS os, MAX(v.device) AS device, MAX(v.ip) AS ip, MAX(v.lang) AS lang,
            (array_agg(DISTINCT wv.page))[1:6] AS pages,
            EXTRACT(EPOCH FROM (MAX(wv.created_at) - MIN(wv.created_at)))::int AS span_secs
       FROM web_views wv LEFT JOIN chat_visitors v ON v.visitor_id = wv.visitor_id
      WHERE ${wherePeriod}
      GROUP BY wv.visitor_id
      ORDER BY MAX(wv.created_at) DESC LIMIT 200`
  )).rows;
}

// Live website presence — a heartbeat from the widget records the page a visitor is on, even
// before they open the chat, so staff can see who's on the site right now.
export interface PresenceInfo { page?: string; title?: string; referrer?: string; ip?: string; userAgent?: string; lang?: string; screen?: string; }
export async function upsertVisitor(visitorId: string, f: PresenceInfo): Promise<void> {
  const ua = parseUA(f.userAgent || '');
  await pool.query(
    `INSERT INTO chat_visitors (visitor_id, page, title, referrer, ip, user_agent, browser, os, device, lang, screen, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (visitor_id) DO UPDATE SET page=EXCLUDED.page, title=EXCLUDED.title, ip=EXCLUDED.ip,
       user_agent=EXCLUDED.user_agent, browser=EXCLUDED.browser, os=EXCLUDED.os, device=EXCLUDED.device,
       lang=EXCLUDED.lang, screen=EXCLUDED.screen, last_seen=NOW()`,
    [visitorId.slice(0, 64), f.page || null, f.title || null, f.referrer || null, f.ip || null,
     (f.userAgent || '').slice(0, 400), ua.browser, ua.os, ua.device, f.lang || null, f.screen || null]
  );
}

// Visitors seen in the last 40s = "on the site now". Flags any who have an open chat.
export async function liveVisitors(): Promise<any[]> {
  return (await pool.query(
    `SELECT v.visitor_id, v.page, v.title, v.referrer, v.first_seen, v.last_seen,
            v.ip, v.browser, v.os, v.device, v.lang,
            EXTRACT(EPOCH FROM (NOW() - v.first_seen))::int AS on_site_secs
       FROM chat_visitors v WHERE v.last_seen > NOW() - INTERVAL '40 seconds'
      ORDER BY v.last_seen DESC LIMIT 50`
  )).rows;
}

export interface NewSession { name?: string; email?: string; phone?: string; department?: string; origin?: string; ip?: string; userAgent?: string; }

export async function createSession(s: NewSession): Promise<{ id: number; token: string }> {
  const token = crypto.randomBytes(18).toString('hex');
  // Tie to a known contact/customer if the email matches one on file.
  let contactId: number | null = null, customerId: number | null = null;
  if (s.email && s.email.includes('@')) {
    const m = await pool.query(
      `SELECT cc.id, cc.customer_id FROM customer_contacts cc JOIN customers c ON c.id=cc.customer_id
        WHERE c.deleted_at IS NULL AND LOWER(cc.email)=LOWER($1) ORDER BY cc.is_primary DESC LIMIT 1`, [s.email]
    );
    if (m.rows[0]) { contactId = m.rows[0].id; customerId = m.rows[0].customer_id; }
  }
  const ua = parseUA(s.userAgent || '');
  const r = await pool.query(
    `INSERT INTO chat_sessions (token, name, email, phone, department, origin, contact_id, customer_id, ip, user_agent, browser, os, last_visitor_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW()) RETURNING id`,
    [token, s.name || null, s.email || null, s.phone || null, s.department || null, s.origin || null, contactId, customerId,
     s.ip || null, (s.userAgent || '').slice(0, 400), ua.browser, ua.os]
  );
  return { id: r.rows[0].id, token };
}

export async function addMessage(sessionId: number, sender: string, body: string, userId?: number | null): Promise<any> {
  const r = await pool.query(
    `INSERT INTO chat_messages (session_id, sender, body, user_id) VALUES ($1,$2,$3,$4) RETURNING id, sender, body, user_id, created_at`,
    [sessionId, sender, body, userId ?? null]
  );
  const col = sender === 'agent' ? 'last_agent_at' : 'last_visitor_at';
  await pool.query(`UPDATE chat_sessions SET updated_at=NOW(), ${col}=NOW() WHERE id=$1`, [sessionId]);
  return r.rows[0];
}

export async function sessionByToken(token: string): Promise<any> {
  return (await pool.query('SELECT * FROM chat_sessions WHERE token=$1', [token])).rows[0] || null;
}
export async function sessionById(id: number): Promise<any> {
  return (await pool.query('SELECT * FROM chat_sessions WHERE id=$1', [id])).rows[0] || null;
}

export async function getMessages(sessionId: number, sinceId = 0): Promise<any[]> {
  return (await pool.query(
    'SELECT id, sender, body, user_id, created_at FROM chat_messages WHERE session_id=$1 AND id>$2 ORDER BY id', [sessionId, sinceId]
  )).rows;
}

// Active sessions for the console, with a snippet + unread (visitor msgs newer than last agent msg).
export async function listSessions(status = 'active'): Promise<any[]> {
  return (await pool.query(
    `SELECT s.*,
            (SELECT body FROM chat_messages m WHERE m.session_id=s.id ORDER BY id DESC LIMIT 1) AS last_body,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.id AND m.sender='visitor'
               AND m.created_at > COALESCE(s.last_agent_at, s.created_at))::int AS unread
       FROM chat_sessions s WHERE s.status=$1 AND s.deleted_at IS NULL ORDER BY s.updated_at DESC LIMIT 100`, [status]
  )).rows;
}

export async function assignSession(id: number, userId: number): Promise<void> {
  await pool.query('UPDATE chat_sessions SET assigned_user_id=$1, updated_at=NOW() WHERE id=$2 AND assigned_user_id IS NULL', [userId, id]);
}
export async function closeSession(id: number): Promise<void> {
  await pool.query("UPDATE chat_sessions SET status='closed', updated_at=NOW() WHERE id=$1", [id]);
}

// Soft delete -> recycle bin ("Website chats" section). Also closes the chat so the visitor's
// widget stops feeding it; restoring from the bin clears deleted_at (the chat stays closed).
export async function deleteSession(id: number, userId: number): Promise<void> {
  await pool.query(
    "UPDATE chat_sessions SET status='closed', deleted_at=NOW(), deleted_by_user_id=$2, updated_at=NOW() WHERE id=$1",
    [id, userId]
  );
}

// When an engineer picks up a chat, auto-send the basic-info request UNDER THEIR NAME (reads as a
// real person, not a bot). Atomic flip of info_prompted so it only ever fires once per chat.
export async function autoAskInfo(sessionId: number, agentUserId: number, agentName: string): Promise<void> {
  const r = await pool.query(
    'UPDATE chat_sessions SET info_prompted=true WHERE id=$1 AND info_prompted=false RETURNING id', [sessionId]
  );
  if (!r.rows.length) return; // already asked by an earlier pickup
  const first = String(agentName || '').trim().split(/\s+/)[0] || 'the team';
  const msg = `Hi, ${first} here from Lumen IT 👋 So I can help properly and follow up if we get cut off, could you pop your name, email and best contact number in for me?`;
  await addMessage(sessionId, 'agent', msg, agentUserId);
}

// Pull an email/phone out of a visitor's reply and fill the session if those fields are still empty.
export async function captureContact(sessionId: number, body: string): Promise<void> {
  const email = (String(body).match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || null;
  const phone = (String(body).replace(/[^\d+]/g, ' ').match(/\+?\d[\d ]{8,}\d/) || [])[0] || null;
  if (!email && !phone) return;
  await pool.query(
    `UPDATE chat_sessions SET
       email = COALESCE(NULLIF(email,''), $2),
       phone = COALESCE(NULLIF(phone,''), $3),
       updated_at = NOW()
     WHERE id = $1`,
    [sessionId, email, phone ? phone.replace(/\s+/g, '') : null]
  );
}

export async function transcript(sessionId: number): Promise<string> {
  const rows = await getMessages(sessionId);
  return rows.map((m) => {
    const who = m.sender === 'agent' ? 'Agent' : m.sender === 'visitor' ? 'Customer' : (m.sender === 'bot' ? 'Bot' : 'System');
    return `${who}: ${m.body}`;
  }).join('\n');
}

export async function countWaiting(): Promise<number> {
  return (await pool.query(
    "SELECT COUNT(*)::int n FROM chat_sessions WHERE status='active' AND assigned_user_id IS NULL AND deleted_at IS NULL"
  )).rows[0].n;
}
