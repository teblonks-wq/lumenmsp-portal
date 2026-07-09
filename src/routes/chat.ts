import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { listSessions, sessionById, getMessages, addMessage, assignSession, closeSession, transcript, liveVisitors, autoAskInfo } from '../lib/chat';
import { nextTicketNumber } from './tickets';
import { notifyAgents } from '../lib/callhub';
import { sendWhatsAppText, sendWhatsAppTemplate, whatsappConfig } from '../lib/whatsapp';
import { sendTeamsReply } from '../lib/teams';
import { logChannel } from '../lib/commslog';
import { setSetting } from '../lib/settings';
import { WA_TEMPLATES, listMetaTemplates, pushTemplateToMeta, renderTemplateBody } from '../lib/wa-templates';
import { aiClassifyTicketCategory, aiTicketCategoryEnabled } from '../lib/ai-compose';

const router = Router();

// Console — list of chats (active by default, ?status=closed for history).
router.get('/chat', requireAuth, async (req: Request, res: Response) => {
  const status = req.query.status === 'closed' ? 'closed' : 'active';
  const sessions = await listSessions(status);
  const visitors = await liveVisitors().catch(() => []);
  res.render('chat/console', { user: req.session.user!, sessions, visitors, status, notice: req.query.msg || null, qerr: req.query.err || null });
});

// Live website visitors (JSON) — polled by the console for the "on the site now" panel.
router.get('/chat/live', requireAuth, async (_req: Request, res: Response) => {
  try { res.json(await liveVisitors()); } catch { res.json([]); }
});

// Active chats (JSON) — polled by the agent "Lumen Chat" widget.
router.get('/chat/list.json', requireAuth, async (_req: Request, res: Response) => {
  try { res.json(await listSessions('active')); } catch { res.json([]); }
});

// Claim a chat from the agent widget (assign to me + dismiss the pop-up on other agents).
router.post('/chat/:id/claim', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const s = await sessionById(id);
  if (s && s.status !== 'closed' && !s.assigned_user_id) {
    const u = req.session.user!;
    await assignSession(id, u.id);
    try { notifyAgents({ type: 'chat-taken', sessionId: id }); } catch { /* ignore */ }
    try { await autoAskInfo(id, u.id, u.displayName); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

// One chat thread.
router.get('/chat/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const s = await sessionById(id);
  if (!s) { res.status(404).render('error', { message: 'Chat not found.' }); return; }
  // First agent to open it claims it — dismiss the pop-up on every other agent's screen, and
  // auto-ask the visitor for their details under this engineer's name.
  if (s.status !== 'closed' && !s.assigned_user_id) {
    const u = req.session.user!;
    await assignSession(id, u.id);
    s.assigned_user_id = u.id;
    try { notifyAgents({ type: 'chat-taken', sessionId: id }); } catch { /* ignore */ }
    try { await autoAskInfo(id, u.id, u.displayName); } catch { /* ignore */ }
  }
  const messages = await getMessages(id);
  res.render('chat/thread', { user: req.session.user!, s, messages, notice: req.query.msg || null, qerr: req.query.err || null });
});

// Live poll for the agent (new messages since id).
router.get('/chat/:id/poll', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const since = parseInt(String(req.query.since || '0'), 10) || 0;
  const rows = await getMessages(id, since);
  const s = await sessionById(id);
  res.json({ status: s ? s.status : 'closed', messages: rows });
});

// Agent reply.
router.post('/chat/:id/reply', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const body = String((req.body || {}).body || '').trim();
  if (body) { await assignSession(id, user.id); await addMessage(id, 'agent', body.slice(0, 4000), user.id); }
  if (req.headers['x-requested-with'] === 'fetch') { res.json({ ok: true }); return; }
  res.redirect('/chat/' + id);
});

router.post('/chat/:id/close', requireAuth, async (req: Request, res: Response) => {
  await closeSession(parseInt(String(req.params.id), 10));
  res.redirect('/chat?msg=' + encodeURIComponent('Chat closed'));
});

// Find the chat's customer/contact, creating a prospect customer + contact if needed.
async function ensureCustomerContact(s: any): Promise<{ customerId: number; contactId: number | null }> {
  if (s.customer_id) return { customerId: s.customer_id, contactId: s.contact_id || null };
  const name = (s.name && s.name.trim()) || (s.email ? s.email.split('@')[0] : 'Website enquiry');
  const c = await pool.query(
    `INSERT INTO customers (name, status, email, phone) VALUES ($1,'lead',$2,$3) RETURNING id`,
    [name.slice(0, 120), s.email || null, s.phone || null]
  );
  const customerId = c.rows[0].id;
  let contactId: number | null = null;
  if (s.name || s.email || s.phone) {
    const ct = await pool.query(
      `INSERT INTO customer_contacts (customer_id, full_name, email, mobile_phone, is_primary) VALUES ($1,$2,$3,$4,true) RETURNING id`,
      [customerId, (s.name || s.email || 'Contact').slice(0, 120), s.email || null, s.phone || null]
    );
    contactId = ct.rows[0].id;
  }
  await pool.query('UPDATE chat_sessions SET customer_id=$1, contact_id=$2 WHERE id=$3', [customerId, contactId, s.id]);
  return { customerId, contactId };
}

// Create a ticket from the chat (no customer required — links one if known).
router.post('/chat/:id/create-ticket', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const s = await sessionById(id);
  if (!s) { res.redirect('/chat?err=Chat+not+found'); return; }
  try {
    const tn = await nextTicketNumber();
    const firstMsg = (await pool.query("SELECT body FROM chat_messages WHERE session_id=$1 AND sender='visitor' ORDER BY id LIMIT 1", [id])).rows[0];
    const subject = (firstMsg?.body || ('Website chat — ' + (s.name || 'visitor'))).slice(0, 120);
    const desc = '<div style="white-space:pre-wrap;">Website chat with ' + (s.name || '') + ' (' + (s.email || '') + ' · ' + (s.phone || '') + ')\n\n' + (await transcript(id)) + '</div>';
    const dept = s.department === 'sales' ? 'sales' : 'support';
    const t = await pool.query(
      `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, status, department, category, subject, description, activity_status, stage, assigned_user_id, updated_at)
       VALUES ($1,'chat',$2,$3,'new',$4,'incident',$5,$6,'unread','awaiting_triage',$7,NOW()) RETURNING id`,
      [tn, s.customer_id, s.contact_id, dept, subject, desc, user.id]
    );
    await pool.query('UPDATE chat_sessions SET created_ticket_id=$1 WHERE id=$2', [t.rows[0].id, id]);
    res.redirect('/tickets/' + t.rows[0].id);
  } catch (e: any) { res.redirect('/chat/' + id + '?err=' + encodeURIComponent('Ticket failed: ' + (e.message || '').slice(0, 80))); }
});

// Create a lead (needs a customer — creates a prospect from the chat details).
router.post('/chat/:id/create-lead', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const s = await sessionById(id);
  if (!s) { res.redirect('/chat?err=Chat+not+found'); return; }
  try {
    const { customerId } = await ensureCustomerContact(s);
    const details = 'From website chat (' + (s.email || '') + ' · ' + (s.phone || '') + ')\n\n' + (await transcript(id));
    const lead = await pool.query(
      `INSERT INTO leads (customer_id, status, source, details, owner_user_id, created_by) VALUES ($1,'new','website_chat',$2,$3,$4) RETURNING id`,
      [customerId, details.slice(0, 4000), user.id, user.id]
    );
    await pool.query('UPDATE chat_sessions SET created_lead_id=$1 WHERE id=$2', [lead.rows[0].id, id]);
    res.redirect('/leads/' + lead.rows[0].id);
  } catch (e: any) { res.redirect('/chat/' + id + '?err=' + encodeURIComponent('Lead failed: ' + (e.message || '').slice(0, 80))); }
});

// Create a quote — ensure a customer, then open the new-quote form for them.
router.post('/chat/:id/create-quote', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const s = await sessionById(id);
  if (!s) { res.redirect('/chat?err=Chat+not+found'); return; }
  try {
    const { customerId } = await ensureCustomerContact(s);
    res.redirect('/quotes/new?customer_id=' + customerId);
  } catch (e: any) { res.redirect('/chat/' + id + '?err=' + encodeURIComponent('Quote failed: ' + (e.message || '').slice(0, 80))); }
});

// ── Unified message inbox (WhatsApp / Teams) ─────────────────────────────────────
// Website chats stay on the console at /chat; these tabs surface WhatsApp & Teams messages
// from inbox_messages. Messages arrive UNTAGGED (no case) and are tagged to a case by hand.
const CHANNEL_LABELS: Record<string, string> = { whatsapp: 'WhatsApp', teams: 'Teams' };

async function channelCounts(): Promise<Record<string, { untagged: number; total: number }>> {
  const r = await pool.query(
    `SELECT channel, COUNT(*) FILTER (WHERE ticket_id IS NULL)::int AS untagged, COUNT(*)::int AS total
       FROM inbox_messages WHERE channel IN ('whatsapp','teams') GROUP BY channel`
  );
  const out: Record<string, { untagged: number; total: number }> = { whatsapp: { untagged: 0, total: 0 }, teams: { untagged: 0, total: 0 } };
  for (const row of r.rows) out[row.channel] = { untagged: row.untagged, total: row.total };
  return out;
}

// Total untagged across WhatsApp + Teams — polled by the sidebar badge.
router.get('/chat/msg/untagged-count', requireAuth, async (_req: Request, res: Response) => {
  try {
    const n = (await pool.query("SELECT COUNT(*)::int n FROM inbox_messages WHERE channel IN ('whatsapp','teams') AND ticket_id IS NULL")).rows[0].n;
    res.json({ n });
  } catch { res.json({ n: 0 }); }
});

router.get('/chat/channel/:ch', requireAuth, async (req: Request, res: Response) => {
  const ch = req.params.ch === 'teams' ? 'teams' : 'whatsapp';
  const attOnly = req.query.att === '1';
  const rows = (await pool.query(
    `SELECT m.id, m.message_direction, m.from_name, m.from_email, m.body_text, m.body_html,
            COALESCE(m.received_at, m.created_at) AS at, m.ticket_id, t.ticket_number, t.subject AS ticket_subject
       FROM inbox_messages m LEFT JOIN inbox_tickets t ON t.id = m.ticket_id
      WHERE m.channel = $1
      ORDER BY (m.ticket_id IS NULL) DESC, COALESCE(m.received_at, m.created_at) DESC
      LIMIT 300`, [ch]
  )).rows;
  const msgs = rows
    .map((m: any) => ({ ...m, hasAttachment: /<img|href=|attachment|cid:/i.test(m.body_html || '') }))
    .filter((m: any) => !attOnly || m.hasAttachment);
  const counts = await channelCounts();
  res.render('chat/inbox', { user: req.session.user!, channel: ch, label: CHANNEL_LABELS[ch], msgs, counts, attOnly });
});

// Search cases for the tag picker — by case number, subject, customer or contact name.
router.get('/chat/msg/case-search', requireAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) { res.json([]); return; }
  const like = '%' + q + '%';
  const rows = (await pool.query(
    `SELECT t.id, t.ticket_number, t.subject, c.name AS customer_name
       FROM inbox_tickets t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN customer_contacts co ON co.id = t.contact_id
      WHERE t.deleted_at IS NULL AND COALESCE(t.is_spam,false)=false AND (
            t.ticket_number ILIKE $1 OR t.subject ILIKE $1 OR c.name ILIKE $1 OR co.full_name ILIKE $1)
      ORDER BY t.updated_at DESC NULLS LAST LIMIT 20`, [like]
  )).rows;
  res.json(rows);
});

// Create a NEW case from an untagged message and tag it — Claude picks the category (blank if
// unsure, so a human must choose before replying). Contact/customer matched by email if we can.
router.post('/chat/msg/:id/new-case', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const m = (await pool.query('SELECT id, channel, from_name, from_email, body_text FROM inbox_messages WHERE id=$1', [id])).rows[0];
  if (!m) { res.json({ ok: false, error: 'Message not found' }); return; }
  const email = String(m.from_email || '');
  let contactId: number | null = null, custId: number | null = null;
  if (email.includes('@')) {
    const c = (await pool.query("SELECT id, customer_id FROM customer_contacts WHERE email IS NOT NULL AND lower(email)=lower($1) LIMIT 1", [email]).catch(() => ({ rows: [] as any[] }))).rows[0];
    if (c) { contactId = c.id; custId = c.customer_id; }
  }
  const cat = (await aiTicketCategoryEnabled())
    ? await aiClassifyTicketCategory((m.body_text || '').slice(0, 120), m.body_text || '').catch(() => null)
    : 'incident';
  const tn = await nextTicketNumber();
  const subject = (m.body_text || (m.channel + ' message')).slice(0, 120);
  const t = await pool.query(
    `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, status, department, category, subject, description, activity_status, stage, updated_at)
     VALUES ($1,$2,$3,$4,'new','support',$5,$6,$7,'unread','awaiting_triage',NOW()) RETURNING id`,
    [tn, m.channel, custId, contactId, cat, subject, m.body_text || '']
  );
  const tid = t.rows[0].id;
  await pool.query("UPDATE inbox_messages SET ticket_id=$1, processing_status='matched' WHERE id=$2", [tid, id]);
  res.json({ ok: true, ticketId: tid });
});

// Tag (or re-tag / move) a single message to a case.
router.post('/chat/msg/:id/tag', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const ticketId = parseInt(String((req.body || {}).ticketId), 10);
  if (!ticketId) { res.json({ ok: false, error: 'No case selected' }); return; }
  const t = (await pool.query('SELECT id FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [ticketId])).rows[0];
  if (!t) { res.json({ ok: false, error: 'Case not found' }); return; }
  const m = (await pool.query('SELECT id, channel FROM inbox_messages WHERE id=$1', [id])).rows[0];
  if (!m) { res.json({ ok: false, error: 'Message not found' }); return; }
  await pool.query("UPDATE inbox_messages SET ticket_id=$1, processing_status='matched' WHERE id=$2", [ticketId, id]);
  await pool.query("UPDATE inbox_tickets SET activity_status='unread', updated_at=NOW() WHERE id=$1", [ticketId]).catch(() => {});
  await pool.query(
    `INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [ticketId, req.session.user?.id || null, (m.channel || 'message') + ' message tagged to this case by ' + (req.session.user?.displayName || 'staff')]
  ).catch(() => {});
  res.json({ ok: true });
});

// Full view of a single message — body + attachments (inline in body_html) + the peer's recent
// messages for context, with tag / reply actions.
router.get('/chat/msg/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const m = (await pool.query(
    `SELECT m.id, m.channel, m.message_direction, m.from_name, m.from_email, m.body_text, m.body_html,
            COALESCE(m.received_at, m.created_at) AS at, m.ticket_id, t.ticket_number, t.subject AS ticket_subject
       FROM inbox_messages m LEFT JOIN inbox_tickets t ON t.id = m.ticket_id
      WHERE m.id=$1`, [id]
  )).rows[0];
  if (!m) { res.status(404).render('error', { message: 'Message not found.' }); return; }
  const thread = (await pool.query(
    `SELECT m.id, m.message_direction, m.from_name, m.body_text, COALESCE(m.received_at, m.created_at) AS at, m.ticket_id, t.ticket_number
       FROM inbox_messages m LEFT JOIN inbox_tickets t ON t.id = m.ticket_id
      WHERE m.channel=$1 AND m.from_email=$2 ORDER BY COALESCE(m.received_at, m.created_at) DESC LIMIT 40`,
    [m.channel, m.from_email]
  )).rows;
  res.render('chat/message', { user: req.session.user!, m, thread });
});

// Reply to a message from the inbox — ONLY once it's tagged to a case (so it goes out under the
// right customer). WhatsApp free-form works inside the 24h window; outside it needs a template.
router.post('/chat/msg/:id/reply', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const body = String((req.body || {}).body || '').trim();
  if (!body) { res.json({ ok: false, error: 'Type a message first.' }); return; }
  const m = (await pool.query('SELECT id, channel, from_email, from_name, ticket_id FROM inbox_messages WHERE id=$1', [id])).rows[0];
  if (!m) { res.json({ ok: false, error: 'Message not found' }); return; }
  if (!m.ticket_id) { res.json({ ok: false, error: 'Tag this message to a case before replying.' }); return; }
  const esc = (s: string) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);

  if (m.channel === 'whatsapp') {
    const num = String(m.from_email || '').replace(/[^\d]/g, '');
    const r = await sendWhatsAppText(num, body);
    if (!r.ok) {
      res.json({ ok: false, error: r.reEngagement ? 'Outside the 24-hour window — an approved template is required (coming soon).' : (r.error || 'Send failed') });
      return;
    }
    await pool.query(
      `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, channel, from_name, from_email, body_text, body_html, received_at, graph_message_id, processing_status)
       VALUES ($1,'whatsapp','outbound','whatsapp',$2,$3,$4,$5,NOW(),$6,'matched') ON CONFLICT (graph_message_id) DO NOTHING`,
      [m.ticket_id, req.session.user?.displayName || 'Lumen IT', m.from_email, body, '<div style="white-space:pre-wrap;">' + esc(body) + '</div>', r.id || null]
    );
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, channel, body) VALUES ($1,$2,'public_reply','whatsapp',$3)`,
      [m.ticket_id, req.session.user?.id || null, '<div style="white-space:pre-wrap;">' + esc(body) + '</div>']).catch(() => {});
    await pool.query("UPDATE inbox_tickets SET updated_at=NOW() WHERE id=$1", [m.ticket_id]).catch(() => {});
    await logChannel({ channel: 'whatsapp', direction: 'outbound', status: 'sent', ticketId: m.ticket_id, peer: m.from_email, peerName: m.from_name, preview: body, externalId: r.id || null });
    res.json({ ok: true });
    return;
  }
  if (m.channel === 'teams') {
    const r = await sendTeamsReply(null, body, m.from_email || null);
    if (!r.ok) { res.json({ ok: false, error: r.error || 'Teams send failed' }); return; }
    await pool.query(
      `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, channel, from_name, from_email, body_text, body_html, received_at, processing_status)
       VALUES ($1,'teams','outbound','teams',$2,$3,$4,$5,NOW(),'matched')`,
      [m.ticket_id, req.session.user?.displayName || 'Lumen IT', m.from_email, body, '<div style="white-space:pre-wrap;">' + esc(body) + '</div>']
    );
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, channel, body) VALUES ($1,$2,'public_reply','teams',$3)`,
      [m.ticket_id, req.session.user?.id || null, '<div style="white-space:pre-wrap;">' + esc(body) + '</div>']).catch(() => {});
    await pool.query("UPDATE inbox_tickets SET updated_at=NOW() WHERE id=$1", [m.ticket_id]).catch(() => {});
    await logChannel({ channel: 'teams', direction: 'outbound', status: 'sent', ticketId: m.ticket_id, peer: m.from_email, peerName: m.from_name, preview: body });
    res.json({ ok: true });
    return;
  }
  res.json({ ok: false, error: 'This channel can\'t be replied to here.' });
});

// ── WhatsApp templates: submit to Meta via the Management API + view approval status ─────────
router.get('/chat/wa/templates', requireAuth, async (req: Request, res: Response) => {
  const c = await whatsappConfig();
  const configured = !!(c.wabaId && c.token);
  let meta: Record<string, { status: string }> = {};
  let err: string | null = null;
  if (configured) {
    const r = await listMetaTemplates(c.wabaId, c.token);
    if (r.ok) { for (const row of r.rows) meta[row.name] = { status: row.status }; }
    else err = r.error;
  }
  res.render('chat/templates', {
    user: req.session.user!, templates: WA_TEMPLATES, meta, wabaId: c.wabaId, configured, err,
    pushed: req.query.pushed || null, saved: req.query.saved === '1',
  });
});

router.post('/chat/wa/templates/save-waba', requireAuth, async (req: Request, res: Response) => {
  await setSetting('whatsapp', 'waba_id', String((req.body || {}).waba_id || '').trim());
  res.redirect('/chat/wa/templates?saved=1');
});

// New-message composer — pick contact + approved template, fill fields, send (tagged to a case).
router.get('/chat/wa/new', requireAuth, async (req: Request, res: Response) => {
  const c = await whatsappConfig();
  let approved: typeof WA_TEMPLATES = [];
  let err: string | null = null;
  if (c.wabaId && c.token) {
    const r = await listMetaTemplates(c.wabaId, c.token);
    if (r.ok) {
      const ok = new Set(r.rows.filter((x) => (x.status || '').toUpperCase() === 'APPROVED').map((x) => x.name));
      approved = WA_TEMPLATES.filter((t) => ok.has(t.name));
    } else err = r.error;
  } else err = 'WhatsApp templates are not configured yet.';
  res.render('chat/compose', { user: req.session.user!, templates: approved, err, prefillTo: req.query.to || '', prefillTicket: req.query.ticket || '' });
});

router.post('/chat/wa/send-template', requireAuth, async (req: Request, res: Response) => {
  const b = req.body || {};
  const to = String(b.to || '').trim();
  const ticketId = parseInt(String(b.ticketId), 10);
  const name = String(b.template || '').trim();
  if (!to) { res.json({ ok: false, error: 'Enter a recipient number.' }); return; }
  if (!ticketId) { res.json({ ok: false, error: 'Tag this to a case first.' }); return; }
  const tpl = WA_TEMPLATES.find((t) => t.name === name);
  if (!tpl) { res.json({ ok: false, error: 'Unknown template.' }); return; }
  const params = tpl.vars.map((_v, i) => String(b['p' + (i + 1)] || '').trim());
  if (params.some((p) => !p)) { res.json({ ok: false, error: 'Fill in all the template fields.' }); return; }
  const t = (await pool.query('SELECT id FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [ticketId])).rows[0];
  if (!t) { res.json({ ok: false, error: 'Case not found.' }); return; }
  const r = await sendWhatsAppTemplate(to, tpl.name, tpl.language, params);
  if (!r.ok) { res.json({ ok: false, error: r.error || 'Send failed' }); return; }
  const esc = (s: string) => String(s || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[ch]);
  const rendered = renderTemplateBody(tpl, params);
  const num = '+' + to.replace(/[^\d]/g, '');
  await pool.query(
    `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, channel, from_name, from_email, body_text, body_html, received_at, graph_message_id, processing_status)
     VALUES ($1,'whatsapp','outbound','whatsapp',$2,$3,$4,$5,NOW(),$6,'matched') ON CONFLICT (graph_message_id) DO NOTHING`,
    [ticketId, req.session.user?.displayName || 'Lumen IT', num, rendered, '<div style="white-space:pre-wrap;">' + esc(rendered) + '</div>', r.id || null]
  );
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, channel, body) VALUES ($1,$2,'public_reply','whatsapp',$3)`,
    [ticketId, req.session.user?.id || null, '<div style="white-space:pre-wrap;">' + esc(rendered) + '</div>']).catch(() => {});
  await pool.query("UPDATE inbox_tickets SET updated_at=NOW() WHERE id=$1", [ticketId]).catch(() => {});
  await logChannel({ channel: 'whatsapp', direction: 'outbound', status: 'sent', ticketId, peer: num, preview: rendered, externalId: r.id || null });
  res.json({ ok: true, ticketId });
});

router.post('/chat/wa/templates/push', requireAuth, async (req: Request, res: Response) => {
  const c = await whatsappConfig();
  if (!c.wabaId || !c.token) { res.redirect('/chat/wa/templates?pushed=' + encodeURIComponent('Add the WABA ID first.')); return; }
  // Skip any template Meta already holds, so re-pushing only submits new/fixed ones.
  const existing = await listMetaTemplates(c.wabaId, c.token);
  const have = new Set(existing.ok ? existing.rows.map((r) => r.name) : []);
  let ok = 0, skipped = 0; const fails: string[] = [];
  for (const t of WA_TEMPLATES) {
    if (have.has(t.name)) { skipped++; continue; }
    const r = await pushTemplateToMeta(c.wabaId, c.token, t);
    if (r.ok) ok++; else fails.push(t.name + ': ' + (r.error || 'failed'));
  }
  const msg = `${ok} submitted` + (skipped ? ` · ${skipped} already submitted` : '') + (fails.length ? ` · ${fails.length} failed — ${fails.join('; ').slice(0, 300)}` : '');
  res.redirect('/chat/wa/templates?pushed=' + encodeURIComponent(msg));
});

export default router;
