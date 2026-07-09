import { Router, Request, Response, NextFunction } from 'express';
import { createSession, addMessage, sessionByToken, getMessages, upsertVisitor, logView, captureContact, chatbotConfig } from '../lib/chat';
import { notifyAgents } from '../lib/callhub';
import { sendTeamsNotice } from '../lib/teams';
import { pool } from '../db/pool';
import { config } from '../config';

// Alert the whole team to a new website chat: real-time pop-up to every open portal tab (over the
// staff WebSocket) + a Teams notification to every active user.
async function notifyNewChat(id: number, name: string, email: string, dept: string): Promise<void> {
  try { notifyAgents({ type: 'chat', sessionId: id, name: name || email || 'Website visitor', department: dept }); } catch { /* ignore */ }
  try {
    const staff = await pool.query("SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL");
    const link = (config.APP_URL || 'https://portal.lumenmsp.co.uk') + '/chat/' + id;
    await Promise.allSettled(staff.rows.map((s: any) => sendTeamsNotice({
      toEmail: s.email, title: 'New website chat — ' + (name || 'visitor'), text: dept + ' · ' + (email || 'no email'), link,
    })));
  } catch (e) { console.error('[chat] team notify failed:', (e as Error).message); }
}

// PUBLIC, unauthenticated chat API for the embeddable website widget. Token-based (the widget
// holds the session token). CORS-open so it works embedded on any site. No cookies/CSRF.
const router = Router();

router.use('/api/chat', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// Strip control characters, trim, and cap length.
const CTRL = new RegExp('[\\x00-\\x1F\\x7F]', 'g');
const clean = (v: any, max = 200): string => String(v == null ? '' : v).replace(CTRL, ' ').trim().slice(0, max);

// Chat-bot availability — the widget calls this on load to decide whether to show + go live.
router.get('/api/chat/config', async (_req: Request, res: Response) => {
  try { const c = await chatbotConfig(); res.json({ enabled: c.enabled, online: c.online, open: c.open, close: c.close }); }
  catch { res.json({ enabled: false, online: false }); }
});

// Presence heartbeat — fires on page load + periodically, even before a chat is opened, so staff
// can see who is on the website right now and which page they're viewing.
router.post('/api/chat/presence', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const vid = clean(b.visitor_id, 64);
    if (!vid) { res.json({ ok: false }); return; }
    await upsertVisitor(vid, {
      page: clean(b.page, 300), title: clean(b.title, 200), referrer: clean(req.headers.referer || b.referrer || '', 300),
      ip: req.ip, userAgent: req.get('user-agent') || '', lang: clean(b.lang, 40), screen: clean(b.screen, 24),
    });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// Page-view log (fires once per page load) → Marketing → Website Stats.
router.post('/api/chat/track', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    await logView(clean(b.visitor_id, 64), clean(b.page, 300), clean(b.title, 200), clean(b.referrer, 300));
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// Start a chat: the bot has already collected name/email/phone + department client-side.
router.post('/api/chat/start', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const name = clean(b.name, 120), email = clean(b.email, 160), phone = clean(b.phone, 40);
    const department = ['support', 'sales'].includes(String(b.department)) ? String(b.department) : 'support';
    const origin = clean(req.headers.referer || req.headers.origin || '', 200);
    const { id, token } = await createSession({ name, email, phone, department, origin, ip: req.ip, userAgent: req.get('user-agent') || '' });
    await addMessage(id, 'system', `New ${department} chat — ${name || 'Unknown'} · ${email || 'no email'} · ${phone || 'no phone'}`);
    await addMessage(id, 'bot', "Thanks! Putting you in touch with a member of our team — they'll be with you shortly. Feel free to start typing your question.");
    notifyNewChat(id, name, email, department).catch(() => {}); // fire-and-forget; don't delay the visitor
    res.json({ token, greeting: "You're connected. A member of our team will reply here shortly." });
  } catch (e: any) { res.status(500).json({ error: 'Could not start chat' }); }
});

// Visitor sends a message.
router.post('/api/chat/:token/msg', async (req: Request, res: Response) => {
  const s = await sessionByToken(clean(req.params.token, 80));
  if (!s || s.status === 'closed') { res.status(404).json({ error: 'Chat not found' }); return; }
  const body = clean((req.body || {}).body, 2000);
  if (!body) { res.json({ ok: true }); return; }
  const m = await addMessage(s.id, 'visitor', body);
  captureContact(s.id, body).catch(() => {}); // auto-fill email/phone if the reply contains them
  // While nobody owns the chat, push each visitor message to all staff so the pop-up shows the
  // actual message and keeps nudging (flashing nav) until someone takes ownership.
  if (!s.assigned_user_id) {
    try { notifyAgents({ type: 'chat', sessionId: s.id, name: s.name, department: s.department, body }); } catch { /* ignore */ }
  }
  res.json({ ok: true, id: m.id });
});

// Visitor polls for new agent/bot messages since the last id they saw.
router.get('/api/chat/:token/poll', async (req: Request, res: Response) => {
  const s = await sessionByToken(clean(req.params.token, 80));
  if (!s) { res.status(404).json({ error: 'Chat not found' }); return; }
  const since = parseInt(String(req.query.since || '0'), 10) || 0;
  const rows = (await getMessages(s.id, since)).filter((m) => m.sender !== 'visitor');
  res.json({ status: s.status, messages: rows.map((m) => ({ id: m.id, sender: m.sender, body: m.body, at: m.created_at })) });
});

export default router;
