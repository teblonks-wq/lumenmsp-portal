import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendMail, customerEmailHtml } from '../lib/mailer';
import { sendTicketStatusEmail } from '../lib/emails';
import { cleanHtml } from '../lib/sanitize';
import { attachmentUpload, processAttachments } from '../lib/attachments';
import { logActivity } from '../lib/activity';
import { notify } from '../lib/notifications';
import { sendTeamsNotice, sendTeamsReply } from '../lib/teams';
import { teamsGraphConnected, sendTeamsChatMessage } from '../lib/teamsgraph';
import { syncInbox } from '../lib/mailsync';
import { blockSender, emailDomain } from '../lib/spam';
import { sendWhatsAppText, htmlToPlain, normaliseWaNumber } from '../lib/whatsapp';
import { logChannel } from '../lib/commslog';
import { aiTicketCategoryEnabled } from '../lib/ai-compose';
import { ensureReplyTemplates, listReplyTemplates, saveReplyTemplate, deleteReplyTemplate } from '../lib/reply-templates';
import { syncBookingsTemplates } from '../lib/bookings';
import { config } from '../config';

const router = Router();

// ── Reply templates — manage page + composer source (path avoids /tickets/:id) ────
router.get('/ticket-templates', requireAuth, async (req: Request, res: Response) => {
  await ensureReplyTemplates().catch(() => {});
  const templates = await listReplyTemplates(false);
  res.render('tickets/templates', { user: req.session.user, templates, saved: req.query.saved === '1', notice: req.query.msg || null, err: req.query.err || null });
});

// Sync Microsoft Bookings services → one template per service (with the booking link).
router.post('/ticket-templates/sync-bookings', requireAuth, async (req: Request, res: Response) => {
  try {
    const r = await syncBookingsTemplates();
    res.redirect('/ticket-templates?msg=' + encodeURIComponent(`Bookings sync: ${r.services} service(s) across ${r.businesses} booking page(s) — ${r.created} template(s) created, ${r.updated} updated.`));
  } catch (e: any) {
    res.redirect('/ticket-templates?err=' + encodeURIComponent((e.message || 'Bookings sync failed').slice(0, 160)));
  }
});
router.post('/ticket-templates', requireAuth, async (req: Request, res: Response) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  if (name) {
    await saveReplyTemplate({
      id: b.id ? parseInt(String(b.id), 10) : null,
      name,
      body_html: cleanHtml(String(b.body_html || '')),
      sort: parseInt(String(b.sort || '0'), 10) || 0,
      is_active: b.is_active === 'on' || b.is_active === 'true',
    });
  }
  res.redirect('/ticket-templates?saved=1');
});
router.post('/ticket-templates/:id/delete', requireAuth, async (req: Request, res: Response) => {
  await deleteReplyTemplate(parseInt(String(req.params.id), 10));
  res.redirect('/ticket-templates');
});

// Pull the support mailbox into tickets on demand (also runs automatically every 2 min).
router.post('/tickets/pickup-mail', requireAuth, async (_req: Request, res: Response) => {
  try { await syncInbox(); } catch (e) { console.error('[tickets] manual mail pickup failed:', (e as Error).message); }
  res.redirect('/tickets');
});
const STATUSES = ['new', 'open', 'awaiting_customer', 'awaiting_3rd_party', 'awaiting_engineer', 'awaiting_installation', 'postponed', 'resolved', 'closed'];

const AUTO_RETURN_HOURS = 24;
// 'postponed' keeps its explicit return date. Parking on the customer or a third party starts a 24h
// timer (stored in the same postponed_until column) — the sweep flips it back to Awaiting engineer
// if nothing comes back. Any other status clears the timer.
function autoReturnAt(status: string, manualPostpone: Date | null): Date | null {
  // Postponed AND Awaiting installation both carry an explicit user-chosen date (installation date).
  if (status === 'postponed' || status === 'awaiting_installation') return manualPostpone && !isNaN(manualPostpone.getTime()) ? manualPostpone : null;
  if (status === 'awaiting_customer' || status === 'awaiting_3rd_party') return new Date(Date.now() + AUTO_RETURN_HOURS * 3600 * 1000);
  return null;
}

// Resolve the customer-facing recipient for a ticket (contact first, else customer).
async function ticketRecipient(ticketId: number): Promise<{ email: string; name: string; ticketNumber: string; subject: string } | null> {
  const r = await pool.query(
    `SELECT t.ticket_number, t.subject, co.email AS c_email, co.full_name AS c_name, cu.email AS cust_email, cu.name AS cust_name
     FROM inbox_tickets t
     LEFT JOIN customer_contacts co ON co.id = t.contact_id
     LEFT JOIN customers cu ON cu.id = t.customer_id
     WHERE t.id = $1`, [ticketId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const email = row.c_email || row.cust_email;
  if (!email) return null;
  return { email, name: row.c_name || row.cust_name || 'there', ticketNumber: row.ticket_number, subject: row.subject || '' };
}
// Send a Teams message the best available way: Graph (delegated as sp@) into the stored chat id
// when connected, else the Power Automate relay. Returns a common {ok,id,error} shape.
async function sendTeamsBest(conv: string | null, text: string, email: string | null): Promise<{ ok: boolean; id?: string; error?: string }> {
  let chatId = '';
  if (conv) { try { const o = JSON.parse(conv); chatId = o.chatId || o.id || ''; } catch { /* not JSON */ } }
  if (chatId && await teamsGraphConnected()) return await sendTeamsChatMessage(chatId, text);
  return await sendTeamsReply(conv, text, email);
}

// Plain-text status message for the non-email channels (WhatsApp/Teams).
function statusMsgText(status: string, name: string, ticketNumber: string, agent: string): string {
  const first = (name && !String(name).startsWith('+')) ? String(name).split(/\s+/)[0] : 'there';
  if (status === 'resolved') {
    return `Hi ${first}, good news — your case ${ticketNumber} has been resolved${agent ? ` by ${agent}` : ''}. `
      + `If anything's still not right, just reply here and it'll reopen the case.\n\n— Lumen IT Support`;
  }
  return `Hi ${first}, an update on your case ${ticketNumber}: it's now ${String(status).replace(/_/g, ' ')}.\n\n— Lumen IT Support`;
}

// Send a customer status update on the case's ORIGIN channel: WhatsApp/Teams cases get it on that
// channel; everything else falls back to the status email. Records the outbound on the case + log.
async function notifyTicketStatus(ticketId: number, status: string, agentName: string): Promise<void> {
  const t = (await pool.query(
    `SELECT t.source, t.ticket_number, t.teams_conversation, cc.full_name, cc.email
       FROM inbox_tickets t LEFT JOIN customer_contacts cc ON cc.id = t.contact_id WHERE t.id=$1`, [ticketId]
  )).rows[0];
  if (!t) return;
  const name = t.full_name || 'there';
  const tn = t.ticket_number;
  const escHtml = (s: string) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
  const recordNote = async (channel: string, text: string) => {
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, channel, body) VALUES ($1, NULL, 'public_reply', $2, $3)`,
      [ticketId, channel, '<div style="white-space:pre-wrap;">' + escHtml(text) + '</div>']);
  };
  if (t.source === 'whatsapp') {
    const lm = (await pool.query("SELECT from_email FROM inbox_messages WHERE ticket_id=$1 AND channel='whatsapp' AND message_direction='inbound' AND from_email IS NOT NULL ORDER BY received_at DESC LIMIT 1", [ticketId])).rows[0];
    const num = lm?.from_email || '';
    const text = statusMsgText(status, name, tn, agentName);
    if (!num) { await logChannel({ channel: 'whatsapp', direction: 'outbound', status: 'failed', ticketId, preview: text, error: 'No WhatsApp number on case' }); return; }
    const r = await sendWhatsAppText(num, text);
    await recordNote('whatsapp', text);
    await logChannel({ channel: 'whatsapp', direction: 'outbound', status: r.ok ? 'sent' : 'failed', ticketId, peer: num, peerName: name, preview: text, externalId: r.id || null, error: r.ok ? null : r.error });
    return;
  }
  if (t.source === 'teams') {
    const text = statusMsgText(status, name, tn, agentName);
    const r = await sendTeamsBest(t.teams_conversation || null, text, t.email || null);
    await recordNote('teams', text);
    await logChannel({ channel: 'teams', direction: 'outbound', status: r.ok ? 'sent' : 'failed', ticketId, peer: t.email || null, peerName: name, preview: text, error: r.ok ? null : r.error });
    return;
  }
  // Email-origin (or manual) cases → status email as before.
  const rcpt = await ticketRecipient(ticketId);
  if (rcpt) await sendTicketStatusEmail(status, rcpt.email, rcpt.name, rcpt.ticketNumber, agentName, rcpt.subject);
}

const DEPARTMENTS = ['support', 'sales', 'repair_center', 'comms', 'quotes', 'invoices', 'leads', 'general'];
const CATEGORIES = ['incident', 'problem', 'service_request', 'change_request', 'enquiry', 'order', 'repair', 'warranty'];

export async function nextTicketNumber(): Promise<string> {
  const { rows } = await pool.query('SELECT ticket_number FROM inbox_tickets');
  let max = 100000;
  for (const r of rows) { const m = String(r.ticket_number).match(/(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  return 'LITS-' + (max + 1);
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/tickets', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const view = ((req.query.view as string) || '').trim();
  const status = ((req.query.status as string) || '').trim();
  const search = ((req.query.search as string) || '').trim();

  const stat = await pool.query(
    `SELECT status, COUNT(*)::int n FROM inbox_tickets WHERE deleted_at IS NULL AND is_spam=false GROUP BY status`
  );
  const statusCounts: Record<string, number> = {};
  stat.rows.forEach((r: any) => { statusCounts[r.status] = r.n; });

  // Engineers for the inline assignee dropdown (internal users only, login admin hidden).
  const engineers = (await pool.query(
    `SELECT id, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND hidden_from_lookups=false ORDER BY display_name`
  )).rows;
  const common = { engineers, statusList: STATUSES, currentUrl: req.originalUrl, error: req.query.err || null };

  const SELECT = `SELECT t.id, t.ticket_number, t.subject, t.status, t.department, t.category, t.activity_status,
            t.assigned_user_id, t.updated_at, t.created_at, c.name AS customer_name, c.id AS customer_id,
            u.display_name AS assigned_name,
            ct.id AS requester_contact_id,
            ct.full_name AS requester_name,
            COALESCE(ct.email, lm.from_email) AS requester_email
     FROM inbox_tickets t
     LEFT JOIN customers c ON c.id = t.customer_id
     LEFT JOIN users u ON u.id = t.assigned_user_id
     LEFT JOIN customer_contacts ct ON ct.id = t.contact_id
     LEFT JOIN LATERAL (
       SELECT from_email FROM inbox_messages
        WHERE ticket_id = t.id AND message_direction='inbound' AND from_email IS NOT NULL
        ORDER BY received_at DESC LIMIT 1
     ) lm ON true`;

  // Helpdesk view is the default: prioritised buckets, oldest first.
  if (!status && view !== 'all' && !search) {
    const grp = async (cond: string) =>
      (await pool.query(`${SELECT} WHERE t.deleted_at IS NULL AND t.is_spam=false AND ${cond} ORDER BY t.created_at ASC LIMIT 200`)).rows;
    const groups = [
      { key: 'unassigned',        label: 'New',                                 rows: await grp("(t.status='new' OR t.assigned_user_id IS NULL) AND t.status NOT IN ('resolved','closed')") },
      { key: 'awaiting_engineer', label: 'Awaiting engineer (customer replied)', rows: await grp("t.status='awaiting_engineer' AND t.assigned_user_id IS NOT NULL") },
      { key: 'open',              label: 'Open — assigned to me',               rows: await grp("t.status='open' AND t.assigned_user_id = " + parseInt(String(user.id), 10)) },
    ];
    res.render('tickets/list', { user, mode: 'helpdesk', groups, tickets: [], status: '', view: 'helpdesk', search: '', statusCounts, ...common });
    return;
  }

  // Flat list: a specific status tab, or the ALL view, or a search.
  const where: string[] = ['t.deleted_at IS NULL', 't.is_spam = false'];
  const params: any[] = [];
  if (status && STATUSES.includes(status)) { params.push(status); where.push('t.status = $' + params.length); }
  // The "All" view shows active cases only (no resolved/closed). A search, however, looks
  // across everything (so you can still find an old resolved/closed ticket by searching).
  else if (!search) where.push("t.status NOT IN ('resolved','closed')");
  if (search) { params.push('%' + search + '%'); where.push(`(t.ticket_number ILIKE $${params.length} OR t.subject ILIKE $${params.length} OR c.name ILIKE $${params.length})`); }

  // Filters (used on the All tab): by customer and by engineer (assignee). 'unassigned' = no engineer.
  const fc = parseInt(String(req.query.fc || ''), 10) || 0;
  const fe = String(req.query.fe || '').trim();
  if (fc) { params.push(fc); where.push('t.customer_id = $' + params.length); }
  if (fe === 'unassigned') { where.push('t.assigned_user_id IS NULL'); }
  else if (fe) { const feId = parseInt(fe, 10); if (feId) { params.push(feId); where.push('t.assigned_user_id = $' + params.length); } }

  // The "All" tab defaults to oldest first by ticket number (smallest LITS- number at top, so the
  // longest-waiting case leads); status tabs and search stay newest-activity first. Users can then
  // click any column header to re-sort.
  const isAll = view === 'all' && !status && !search;
  const orderBy = isAll ? 'ORDER BY t.created_at ASC' : 'ORDER BY t.updated_at DESC';
  const { rows } = await pool.query(`${SELECT} WHERE ${where.join(' AND ')} ${orderBy} LIMIT 300`, params);
  const customersList = (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL AND is_placeholder=false ORDER BY name")).rows;
  res.render('tickets/list', { user, mode: 'flat', groups: [], tickets: rows, status, view: status ? 'status' : 'all', search, statusCounts, customersList, fc, fe, ...common });
});

// ── New ──────────────────────────────────────────────────────────────────────────
router.get('/tickets/new', requireAuth, async (req: Request, res: Response) => {
  let preselect: any = null;
  if (req.query.customer) {
    const r = await pool.query('SELECT id, name FROM customers WHERE id=$1', [parseInt(String(req.query.customer), 10)]);
    if (r.rows.length) preselect = r.rows[0];
  }
  const usersList = await pool.query(`SELECT id, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND hidden_from_lookups=false ORDER BY display_name`);
  res.render('tickets/form', { user: req.session.user!, preselect, error: null, users: usersList.rows });
});

router.post('/tickets', requireAuth, attachmentUpload.array('attachments', 5), async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b = req.body;
  const subject = (b.subject || '').trim();
  const ownerId = b.assigned_user_id ? parseInt(b.assigned_user_id, 10) : null;

  // Description now comes from the rich editor; sanitise it and append any attachment links.
  const { stored } = processAttachments((req as any).files || []);
  let descRaw = b.description || '';
  if (stored.length) {
    descRaw += '<div style="margin-top:8px;">' + stored.map((a) => `<a href="${a.url}" target="_blank">&#128206; ${a.name}</a>`).join(' &middot; ') + '</div>';
  }
  const description = (descRaw.replace(/<[^>]+>/g, '').trim() || stored.length) ? cleanHtml(descRaw) : '';

  const renderErr = async (msg: string) => {
    let preselect: any = null;
    if (b.customer_id) { const r = await pool.query('SELECT id, name FROM customers WHERE id=$1', [parseInt(b.customer_id, 10)]); if (r.rows.length) preselect = r.rows[0]; }
    const usersList = await pool.query(`SELECT id, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND hidden_from_lookups=false ORDER BY display_name`);
    res.render('tickets/form', { user, preselect, error: msg, users: usersList.rows });
  };

  if (!subject) { await renderErr('Subject is required.'); return; }
  if (!ownerId)  { await renderErr('A case owner is required.'); return; }

  const tn = await nextTicketNumber();
  const { rows } = await pool.query(
    `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, assigned_user_id, assigned_at, status, department, category, subject, description, activity_status, stage, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW(),'new','support',$6,$7,$8,'read','awaiting_triage', NOW()) RETURNING id`,
    [
      tn,
      ['email', 'manual', 'phone', 'whatsapp', 'teams'].includes(b.source) ? b.source : 'manual',
      b.customer_id ? parseInt(b.customer_id, 10) : null,
      b.contact_id ? parseInt(b.contact_id, 10) : null,
      ownerId,
      CATEGORIES.includes(b.category) ? b.category : 'incident',
      subject, description,
    ]
  );
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [rows[0].id, user.id, `Ticket created by ${user.displayName}`]);
  // Acknowledgement email to the customer + "new case waiting" Teams ping to all staff.
  try {
    const rcpt = await ticketRecipient(rows[0].id);
    await notifyTicketStatus(rows[0].id, 'new', user.displayName);
    const reporter = rcpt ? `${rcpt.name} · ${rcpt.email}` : 'No contact';
    const staff = await pool.query("SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL");
    await Promise.allSettled(staff.rows.map((s: any) => sendTeamsNotice({
      toEmail: s.email,
      title: 'New case waiting — ' + tn,
      text: subject + ' — ' + reporter,
      link: config.APP_URL + '/tickets/' + rows[0].id,
    })));
  } catch (e) { console.error('New-ticket notifications failed:', e); }
  res.redirect('/tickets/' + rows[0].id);
});

// Search tickets (for merge) — by number, subject, customer or contact name.
router.get('/tickets/search.json', requireAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) { res.json([]); return; }
  const like = '%' + q + '%';
  const exclude = parseInt(String(req.query.exclude || '0'), 10) || 0;
  const { rows } = await pool.query(
    `SELECT t.id, t.ticket_number, t.subject, t.status, c.name AS customer_name
     FROM inbox_tickets t
     LEFT JOIN customers c ON c.id = t.customer_id
     LEFT JOIN customer_contacts ct ON ct.id = t.contact_id
     WHERE t.deleted_at IS NULL AND t.is_spam = false AND t.status NOT IN ('resolved','closed') AND t.id <> $2
       AND (t.ticket_number ILIKE $1 OR t.subject ILIKE $1 OR c.name ILIKE $1 OR ct.full_name ILIKE $1)
     ORDER BY t.updated_at DESC LIMIT 15`, [like, exclude]
  );
  res.json(rows);
});

// A customer's tickets (for the new-ticket screen, to avoid duplicates).
router.get('/customers/:id/tickets.json', requireAuth, async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.id), 10);
  const { rows } = await pool.query(
    `SELECT id, ticket_number, subject, status, created_at FROM inbox_tickets
     WHERE customer_id=$1 AND deleted_at IS NULL
     ORDER BY (status NOT IN ('resolved','closed')) DESC, created_at DESC LIMIT 25`, [cid]
  );
  res.json(rows);
});

// ── Detail ────────────────────────────────────────────────────────────────────
router.get('/tickets/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Ticket not found.' }); return; }
  const r = await pool.query(
    `SELECT t.*, c.name AS customer_name, u.display_name AS assigned_name,
            ct.full_name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone, ct.mobile_phone AS contact_mobile
     FROM inbox_tickets t
     LEFT JOIN customers c ON c.id=t.customer_id
     LEFT JOIN users u ON u.id=t.assigned_user_id
     LEFT JOIN customer_contacts ct ON ct.id=t.contact_id
     WHERE t.id=$1 AND t.deleted_at IS NULL LIMIT 1`, [id]
  );
  if (!r.rows.length) { res.status(404).render('error', { message: 'Ticket not found.' }); return; }

  const [msgs, notes, users, quotesRes] = await Promise.all([
    pool.query('SELECT id, message_direction, channel, from_name, from_email, to_raw, cc_raw, subject, body_html, body_text, received_at, created_at FROM inbox_messages WHERE ticket_id=$1 ORDER BY COALESCE(received_at, created_at)', [id]),
    pool.query(`SELECT nt.id, nt.note_type, nt.channel, nt.body, nt.to_raw, nt.cc_raw, nt.created_at, u.display_name AS author FROM inbox_notes nt LEFT JOIN users u ON u.id=nt.user_id WHERE nt.ticket_id=$1 ORDER BY nt.created_at`, [id]),
    pool.query(`SELECT id, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND hidden_from_lookups=false ORDER BY display_name`),
    pool.query(`SELECT id, quote_number, title, status, total FROM quotes WHERE inbox_ticket_id=$1 AND deleted_at IS NULL ORDER BY id DESC`, [id]),
  ]);

  // Merge into one timeline
  const timeline: any[] = [];
  for (const m of msgs.rows) timeline.push({ kind: 'message', id: m.id, direction: m.message_direction, channel: m.channel || 'email', author: m.from_name || m.from_email || 'Email', fromEmail: m.from_email || '', to: m.to_raw || '', cc: m.cc_raw || '', body: m.body_html || m.body_text || '', at: m.received_at || m.created_at });
  for (const nt of notes.rows) timeline.push({ kind: 'note', id: nt.id, noteType: nt.note_type, channel: nt.channel || '', author: nt.author || 'System', to: nt.to_raw || '', cc: nt.cc_raw || '', body: nt.body, at: nt.created_at });
  // Newest on top, always. Tiebreak on id so items sharing a timestamp (e.g. an auto-assign note
  // stamped the same instant as its reply) still order deterministically, latest first.
  timeline.sort((a, b) => {
    const d = new Date(b.at).getTime() - new Date(a.at).getTime();
    return d !== 0 ? d : (b.id || 0) - (a.id || 0);
  });

  // Case log = the system events (created, status changes, closed/resolved) for the right column — newest first too.
  const caseLog = notes.rows.filter((n: any) => n.note_type === 'system_log').reverse();

  // Recipient lookup: the customer's contacts + the customer domain (for the mismatch warning).
  const cid = r.rows[0].customer_id;
  const contacts = cid ? (await pool.query("SELECT full_name AS name, email FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email<>'' ORDER BY is_primary DESC, full_name", [cid]).catch(() => ({ rows: [] }))).rows : [];
  const customerDomain = cid ? ((await pool.query("SELECT domain FROM customers WHERE id=$1", [cid]).catch(() => ({ rows: [] }))).rows[0]?.domain || '') : '';

  // Sender of the original/most recent inbound email — used for the "unknown sender" panel
  // when the ticket isn't linked to a customer yet.
  let requesterEmail = r.rows[0].contact_email || '';
  let requesterName = r.rows[0].contact_name || '';
  if (!requesterEmail) {
    const inb = (await pool.query("SELECT from_name, from_email FROM inbox_messages WHERE ticket_id=$1 AND message_direction='inbound' AND from_email IS NOT NULL ORDER BY received_at ASC LIMIT 1", [r.rows[0].id]).catch(() => ({ rows: [] }))).rows[0];
    if (inb) { requesterEmail = inb.from_email || ''; requesterName = requesterName || inb.from_name || ''; }
  }

  // Default the composer to the channel the requester last used.
  const lastCh = (await pool.query("SELECT channel FROM inbox_messages WHERE ticket_id=$1 AND message_direction='inbound' ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1", [r.rows[0].id]).catch(() => ({ rows: [] }))).rows[0];
  const lastChannel = (lastCh && lastCh.channel) || 'email';

  // WhatsApp 24h customer-care window: free-form replies only work within 24h of the customer's
  // last inbound WhatsApp. Outside it, Meta requires an approved template — the composer locks.
  const waInb = (await pool.query("SELECT from_email, COALESCE(received_at, created_at) AS at FROM inbox_messages WHERE ticket_id=$1 AND channel='whatsapp' AND message_direction='inbound' ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1", [r.rows[0].id]).catch(() => ({ rows: [] }))).rows[0];
  const waNum = waInb ? String(waInb.from_email || '').replace(/[^\d]/g, '') : '';
  const waName = requesterName || r.rows[0].contact_name || '';
  const waWindowOpen = !!(waInb && (Date.now() - new Date(waInb.at).getTime()) < 24 * 60 * 60 * 1000);
  const aiCatOn = await aiTicketCategoryEnabled();
  await ensureReplyTemplates().catch(() => {});
  const replyTemplates = await listReplyTemplates().catch(() => [] as any[]);

  res.render('tickets/detail', { user, ticket: r.rows[0], timeline, caseLog, quotes: quotesRes.rows, users: users.rows, contacts, customerDomain, requesterEmail, requesterName, lastChannel, waNum, waName, waWindowOpen, aiCatOn, replyTemplates, DEPARTMENTS, STATUSES, CATEGORIES, error: req.query.err || null, notice: req.query.msg || null });
});

// ── Update fields ────────────────────────────────────────────────────────────────
router.post('/tickets/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  // Don't swallow literal sibling routes (e.g. /tickets/bulk-delete) — only handle numeric ids.
  if (!Number.isInteger(id)) return next();
  const b = req.body;
  const newStatus = STATUSES.includes(b.status) ? b.status : 'new';

  const prev = await pool.query('SELECT status, contact_id FROM inbox_tickets WHERE id=$1', [id]);
  const prevStatus = prev.rows.length ? prev.rows[0].status : null;
  const hasRequester = !!(prev.rows[0] && prev.rows[0].contact_id);

  // Starting a ticket (moving it into a working status) needs an engineer and a requester.
  // The engineer is satisfied automatically: if no-one's assigned, the person starting it
  // takes the case. Only a missing requester (linked contact) still blocks.
  const WORKING = ['open', 'awaiting_customer', 'awaiting_3rd_party', 'awaiting_engineer', 'awaiting_installation'];
  let resultingAssignee = b.assigned_user_id ? parseInt(b.assigned_user_id, 10) : null;
  const autoAssigned = WORKING.includes(newStatus) && !resultingAssignee;
  if (autoAssigned) resultingAssignee = user.id;
  if (WORKING.includes(newStatus) && !hasRequester) {
    res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('A ticket needs a requester (link/create the contact) before work can start.'));
    return;
  }

  // Assigning a ticket starts it: a 'new' ticket becomes 'open' once it has an engineer.
  const effectiveStatus = (resultingAssignee && newStatus === 'new') ? 'open' : newStatus;

  // Postpone keeps its explicit date; Awaiting customer / 3rd party get a 24h auto-return timer.
  const postponedUntil = autoReturnAt(effectiveStatus, b.postponed_until ? new Date(b.postponed_until) : null);
  await pool.query(
    `UPDATE inbox_tickets SET
       status=$1, department=$2, category=$3,
       assigned_user_id=$4::int, assigned_at=CASE WHEN $4::int IS NOT NULL THEN COALESCE(assigned_at, NOW()) ELSE assigned_at END,
       closed_at=CASE WHEN $1 IN ('resolved','closed') THEN COALESCE(closed_at, NOW()) ELSE NULL END,
       postponed_until=$6,
       updated_at=NOW()
     WHERE id=$5 AND deleted_at IS NULL`,
    [
      effectiveStatus,
      DEPARTMENTS.includes(b.department) ? b.department : null,
      CATEGORIES.includes(b.category) ? b.category : 'incident',
      resultingAssignee, id,
      postponedUntil && !isNaN(postponedUntil.getTime()) ? postponedUntil : null,
    ]
  );
  if (autoAssigned) {
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [id, user.id, `Assigned to ${user.displayName} (took the case)`]);
  }
  if (effectiveStatus !== prevStatus) {
    await logActivity(user.id, 'status_changed', 'tickets', id, `Ticket status: ${prevStatus} → ${effectiveStatus}`);
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [id, user.id, `Status: ${prevStatus} → ${effectiveStatus} (by ${user.displayName})`]);
  }
  // "Good news" message when a ticket first becomes resolved — on the case's origin channel.
  if (effectiveStatus === 'resolved' && prevStatus !== 'resolved') {
    try { await notifyTicketStatus(id, 'resolved', user.displayName); }
    catch (e) { console.error('Resolved notify failed:', e); }
  }
  // Resolving a case sends you back to the helpdesk overview, not the (now-done) ticket.
  res.redirect(effectiveStatus === 'resolved' ? '/tickets' : '/tickets/' + id);
});

// ── Quick inline update from the board (status and/or assignee) ──────────────────
router.post('/tickets/:id/quick', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  // Only return to a local /tickets URL (no open redirects).
  const back = typeof b.return === 'string' && b.return.startsWith('/tickets') ? b.return : '/tickets';
  const fail = (msg: string) => res.redirect(back + (back.includes('?') ? '&' : '?') + 'err=' + encodeURIComponent(msg));

  const cur = (await pool.query('SELECT status, assigned_user_id, contact_id FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!cur) { res.redirect(back); return; }

  const prevStatus = cur.status as string;
  const newStatus = ('status' in b) && STATUSES.includes(b.status) ? b.status : prevStatus;
  const newAssignee = ('assigned_user_id' in b) ? (b.assigned_user_id ? parseInt(b.assigned_user_id, 10) : null) : cur.assigned_user_id;

  // Postpone needs a date/time — only available on the ticket itself.
  if (newStatus === 'postponed') { fail('Open the ticket to postpone — a date & time is required.'); return; }

  const WORKING = ['open', 'awaiting_customer', 'awaiting_3rd_party', 'awaiting_engineer', 'awaiting_installation'];
  // First to start an unowned case takes it; only a missing requester still blocks.
  let effAssignee = newAssignee;
  const qAutoAssigned = WORKING.includes(newStatus) && !effAssignee;
  if (qAutoAssigned) effAssignee = user.id;
  if (WORKING.includes(newStatus) && !cur.contact_id) {
    fail('Open the ticket and link a requester before work can start.');
    return;
  }

  // Assigning a 'new' ticket starts it (→ open).
  const effectiveStatus = (effAssignee && newStatus === 'new') ? 'open' : newStatus;
  const newAssignee2 = effAssignee;

  await pool.query(
    `UPDATE inbox_tickets SET
       status=$1,
       assigned_user_id=$2::int,
       assigned_at=CASE WHEN $2::int IS NOT NULL THEN COALESCE(assigned_at, NOW()) ELSE assigned_at END,
       closed_at=CASE WHEN $1 IN ('resolved','closed') THEN COALESCE(closed_at, NOW()) ELSE NULL END,
       postponed_until=$4,
       updated_at=NOW()
     WHERE id=$3 AND deleted_at IS NULL`,
    [effectiveStatus, newAssignee2, id, autoReturnAt(effectiveStatus, null)]
  );

  if (effectiveStatus !== prevStatus) {
    await logActivity(user.id, 'status_changed', 'tickets', id, `Ticket status: ${prevStatus} → ${effectiveStatus}`);
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [id, user.id, `Status: ${prevStatus} → ${effectiveStatus} (by ${user.displayName})`]);
  }
  if (newAssignee2 !== cur.assigned_user_id) {
    const who = newAssignee2 ? (await pool.query('SELECT display_name FROM users WHERE id=$1', [newAssignee2])).rows[0]?.display_name || 'an engineer' : 'Unassigned';
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [id, user.id, qAutoAssigned ? `Assigned to ${who} (took the case)` : `Assigned to ${who} (by ${user.displayName})`]);
    if (newAssignee2 && newAssignee2 !== user.id) await notify(newAssignee2, 'Assigned to you', { type: 'assigned', body: 'A case was assigned to you.', link: '/tickets/' + id });
  }
  if (effectiveStatus === 'resolved' && prevStatus !== 'resolved') {
    try { await notifyTicketStatus(id, 'resolved', user.displayName); }
    catch (e) { console.error('Resolved notify failed:', e); }
  }
  res.redirect(back);
});

// ── Add note / reply ───────────────────────────────────────────────────────────
router.post('/tickets/:id/note', requireAuth, attachmentUpload.array('attachments', 5), async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const noteType = ['public_reply', 'side_convo', 'private_note'].includes(req.body.note_type) ? req.body.note_type : 'private_note';
  // Can't reply to the customer until a support category is set (only while the AI-category feature
  // is switched on; Claude leaves the category blank when unsure).
  if (noteType === 'public_reply' && await aiTicketCategoryEnabled()) {
    const cat = (await pool.query('SELECT category FROM inbox_tickets WHERE id=$1', [id])).rows[0]?.category;
    if (!cat) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('Set a support category before replying to the customer.')); return; }
  }
  const escHtml = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
  const { stored, graph } = processAttachments((req as any).files || []);

  let raw = req.body.body || '';
  if (stored.length) {
    raw += '<div style="margin-top:8px;">' + stored.map((a) => `<a href="${a.url}" target="_blank">&#128206; ${a.name}</a>`).join(' &middot; ') + '</div>';
  }
  const body = cleanHtml(raw);
  const hasContent = body.replace(/<[^>]+>/g, '').trim() || stored.length;

  // Status change — allowed even with no message (e.g. postpone from the composer).
  const setStatus = STATUSES.includes(req.body.set_status) ? req.body.set_status : null;
  const ppRaw = setStatus === 'postponed' && req.body.postponed_until ? new Date(req.body.postponed_until) : null;
  if (setStatus === 'postponed' && (!ppRaw || isNaN(ppRaw.getTime()))) {
    res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('Pick a date & time to postpone the case.')); return;
  }
  const ppVal = ppRaw && !isNaN(ppRaw.getTime()) ? ppRaw : null;
  const applyStatus = async (s: string | null) => {
    if (!s) return;
    await pool.query('UPDATE inbox_tickets SET status=$2, postponed_until=$3, updated_at=NOW() WHERE id=$1', [id, s, autoReturnAt(s, ppVal)]);
  };

  // A public reply needs a requester (someone to reply to). The engineer requirement is met
  // automatically: replying to a customer means you're taking the case, so an unowned case is
  // assigned to whoever sends the reply. "Requester" is channel-aware — email needs a real
  // address; WhatsApp/Teams just need an inbound from the customer on that channel (or a number).
  if (noteType === 'public_reply' && hasContent) {
    const asg = (await pool.query('SELECT assigned_user_id, contact_id FROM inbox_tickets WHERE id=$1', [id])).rows[0];
    const ch = ['email', 'teams', 'whatsapp'].includes(req.body.channel) ? req.body.channel : 'email';
    const toAddr = String(req.body.to || '').trim();
    let knownRequester = !!(asg && asg.contact_id);
    if (!knownRequester) {
      if (ch === 'email') {
        knownRequester = /\S+@\S+/.test(toAddr);
        if (!knownRequester) { const rc = await ticketRecipient(id); knownRequester = !!(rc && rc.email); }
      } else {
        const inb = await pool.query("SELECT 1 FROM inbox_messages WHERE ticket_id=$1 AND channel=$2 AND message_direction='inbound' LIMIT 1", [id, ch]);
        knownRequester = inb.rows.length > 0 || /\d{7,}/.test(toAddr.replace(/\D/g, ''));
      }
    }
    if (!knownRequester) {
      res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('This case has no-one to reply to yet — link a contact, or open it from an inbound message.')); return;
    }
    // Take ownership on reply if the case is unassigned.
    if (asg && !asg.assigned_user_id) {
      await pool.query("UPDATE inbox_tickets SET assigned_user_id=$1, assigned_at=NOW(), updated_at=NOW() WHERE id=$2 AND assigned_user_id IS NULL", [user.id, id]);
      await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`, [id, user.id, `Assigned to ${user.displayName} (took the case on reply)`]);
    }
  }

  if (hasContent) {
    const toAddr = String(req.body.to || '').trim();
    const cc = String(req.body.cc || '').trim() || undefined;
    const bcc = String(req.body.bcc || '').trim() || undefined;
    // Channel the reply travels on.
    const channel = ['email', 'teams', 'whatsapp'].includes(req.body.channel) ? req.body.channel : 'email';
    // Persist CC/BCC for the case if the engineer ticked "remember" (email replies only — the
    // box reflects current state, so unticking on an email reply clears it).
    if (channel === 'email') {
      const persist = req.body.persist_recipients === '1' || req.body.persist_recipients === 'on';
      if (persist) await pool.query('UPDATE inbox_tickets SET persistent_cc=$1, persistent_bcc=$2 WHERE id=$3', [cc || null, bcc || null, id]);
      else await pool.query('UPDATE inbox_tickets SET persistent_cc=NULL, persistent_bcc=NULL WHERE id=$1', [id]);
    }

    // ── WhatsApp / Teams: SEND FIRST, RECORD ONLY ON SUCCESS ──────────────────────
    // A customer message is never written to the case log until it has actually gone out.
    // If the send fails — Teams 502 (no live conversation to reply into / chat expired),
    // WhatsApp's 24h window closed, or the channel isn't connected — we stop here, write
    // NOTHING to the case, and show the engineer a friendly banner so they can retry or
    // reply another way. (Email keeps its own try/catch in the branches below.)
    const plainForSend = htmlToPlain(body);
    let waNumberSent: string | null = null;
    let waIdSent: string | null = null;
    let teamsPeerSent: string | null = null;
    if (channel === 'whatsapp') {
      const looksLikeNumber = (s: string) => !!s && !s.includes('@') && normaliseWaNumber(s).length >= 10;
      let num = '';
      if (looksLikeNumber(toAddr)) num = toAddr;
      else {
        const lm = await pool.query("SELECT from_email FROM inbox_messages WHERE ticket_id=$1 AND channel='whatsapp' AND message_direction='inbound' AND from_email IS NOT NULL ORDER BY received_at DESC LIMIT 1", [id]);
        if (lm.rows[0]?.from_email) num = lm.rows[0].from_email;
        else { const cn = await pool.query('SELECT cc.mobile_phone, cc.phone FROM inbox_tickets t LEFT JOIN customer_contacts cc ON cc.id=t.contact_id WHERE t.id=$1', [id]); num = cn.rows[0]?.mobile_phone || cn.rows[0]?.phone || ''; }
      }
      if (!num) {
        res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('No WhatsApp number for this contact, so nothing was sent or added to the case. Add a mobile number to the contact, or reply another way.')); return;
      }
      const r = await sendWhatsAppText(num, plainForSend);
      if (!r.ok) {
        await logChannel({ channel: 'whatsapp', direction: 'outbound', status: 'failed', ticketId: id, peer: num, preview: plainForSend, error: r.error || 'send failed', userId: user.id });
        const friendly = r.reEngagement
          ? 'WhatsApp message not sent — you are outside the 24-hour window, so an approved template is required and the customer needs to message us first. Nothing was added to the case.'
          : 'WhatsApp message could not be sent right now, so nothing was added to the case. Try again shortly, or reply by another channel.';
        res.redirect('/tickets/' + id + '?err=' + encodeURIComponent(friendly)); return;
      }
      waNumberSent = num; waIdSent = r.id || null;
    } else if (channel === 'teams') {
      const row = (await pool.query('SELECT t.teams_conversation, cc.email FROM inbox_tickets t LEFT JOIN customer_contacts cc ON cc.id=t.contact_id WHERE t.id=$1', [id])).rows[0];
      const r = await sendTeamsBest(row?.teams_conversation || null, plainForSend, row?.email || null);
      if (!r.ok) {
        await logChannel({ channel: 'teams', direction: 'outbound', status: 'failed', ticketId: id, peer: row?.email || null, preview: plainForSend, error: r.error || 'send failed', userId: user.id });
        const friendly = 'Teams message could not be sent — there is no live Teams conversation with this customer to reply into (they need to message us on Teams first, or the chat has expired). Nothing was added to the case — reply by email if it is urgent.';
        res.redirect('/tickets/' + id + '?err=' + encodeURIComponent(friendly)); return;
      }
      teamsPeerSent = row?.email || null;
    }
    // Side convo: stamp who it went to at the top so the (private) note shows the recipient.
    const storeBody = noteType === 'side_convo'
      ? `<div style="font-size:12px;color:#7c3aed;margin-bottom:6px;">Side conversation → ${escHtml(toAddr)}${cc ? ' · cc ' + escHtml(cc) : ''}</div>` + body
      : body;
    // Record who the email went to so To/CC show on the thread (only for the emailing modes).
    const isEmail = noteType === 'public_reply' || noteType === 'side_convo';
    let noteTo = isEmail ? (toAddr || null) : null;
    if (noteType === 'public_reply' && !noteTo) { const rc = await ticketRecipient(id); noteTo = rc ? rc.email : null; }
    const noteCc = isEmail ? (cc || null) : null;
    const noteBcc = isEmail ? (bcc || null) : null;
    const noteChannel = isEmail ? channel : null;
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, channel, body, to_raw, cc_raw, bcc_raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, user.id, noteType, noteChannel, storeBody, noteTo, noteCc, noteBcc]);
    const sysNote = async (text: string) => {
      await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`, [id, user.id, text]);
    };
    // The WhatsApp/Teams send already happened above (send-first). These just record the
    // confirmed-sent message on the case — they only run on the success path.
    const recordWaSent = async () => {
      await sysNote(`Sent via WhatsApp to ${waNumberSent} (by ${user.displayName})`);
      await logChannel({ channel: 'whatsapp', direction: 'outbound', status: 'sent', ticketId: id, peer: waNumberSent, preview: plainForSend, externalId: waIdSent, userId: user.id });
    };
    const recordTeamsSent = async () => {
      await sysNote(`Sent via Teams (by ${user.displayName})`);
      await logChannel({ channel: 'teams', direction: 'outbound', status: 'sent', ticketId: id, peer: teamsPeerSent, preview: plainForSend, userId: user.id });
    };
    if (noteType === 'side_convo') {
      // Private third-party message — never touches the customer; only moves status if asked.
      await applyStatus(setStatus);
      if (channel === 'email') {
        try {
          const rcpt = await ticketRecipient(id);
          const subj = rcpt ? (rcpt.ticketNumber + (rcpt.subject ? ': ' + rcpt.subject : '')) : 'Lumen IT';
          if (toAddr) await sendMail({ to: toAddr, cc, bcc, subject: subj, html: customerEmailHtml(body), signatureName: user.displayName, attachments: graph });
        } catch (e) { console.error('Side convo email failed:', e); }
      } else if (channel === 'whatsapp') { await recordWaSent(); }
      else if (channel === 'teams') { await recordTeamsSent(); }
    } else if (noteType === 'public_reply') {
      // Emailing the customer from the case → move to the chosen status (default Awaiting customer).
      const newStatus = setStatus || 'awaiting_customer';
      const prev = await pool.query('SELECT status FROM inbox_tickets WHERE id=$1', [id]);
      const prevStatus = prev.rows.length ? prev.rows[0].status : null;
      await pool.query(`UPDATE inbox_tickets SET last_public_reply_at=NOW(), status=$2, postponed_until=$3, updated_at=NOW() WHERE id=$1 AND status NOT IN ('resolved','closed')`, [id, newStatus, autoReturnAt(newStatus, ppVal)]);
      // Record the move in the case log so it's visible (and confirms the auto-status fired).
      if (prevStatus && prevStatus !== newStatus && !['resolved', 'closed'].includes(prevStatus)) {
        await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
          [id, user.id, `Status: ${prevStatus} → ${newStatus} (reply sent by ${user.displayName})`]);
        await logActivity(user.id, 'status_changed', 'tickets', id, `Ticket #${id} → ${newStatus} on reply`);
      }
      if (channel === 'email') {
        try {
          const rcpt = await ticketRecipient(id);
          // To/CC/BCC from the composer; To falls back to the matched contact.
          const finalTo = toAddr || (rcpt ? rcpt.email : '');
          if (finalTo) { const subj = rcpt ? (rcpt.ticketNumber + (rcpt.subject ? ': ' + rcpt.subject : '')) : 'Update on your ticket'; await sendMail({ to: finalTo, cc, bcc, subject: subj, html: customerEmailHtml(body), signatureName: user.displayName, attachments: graph }); }
          else { await sysNote(`No recipient address — reply saved but not emailed (by ${user.displayName})`); res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('No recipient address on this case — the reply was saved but not emailed. Add a "To" address or link a contact.')); return; }
        } catch (e) {
          console.error('Public reply email failed:', e);
          await sysNote(`Email send FAILED — reply saved but not delivered (by ${user.displayName})`);
          res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('The reply was saved but the email failed to send — check mail settings / Graph token.')); return;
        }
      } else if (channel === 'whatsapp') {
        await recordWaSent();
      } else if (channel === 'teams') {
        await recordTeamsSent();
      }
    } else {
      await applyStatus(setStatus);
    }
  } else if (setStatus) {
    // No message — just apply the status change (e.g. postpone from the composer).
    await applyStatus(setStatus);
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [id, user.id, `Status set to ${setStatus.replace(/_/g, ' ')}${setStatus === 'postponed' && ppVal ? ' until ' + ppVal.toLocaleString('en-GB') : ''} (by ${user.displayName})`]);
  }
  // Resolving from the composer returns you to the helpdesk overview.
  res.redirect(setStatus === 'resolved' ? '/tickets' : '/tickets/' + id);
});

// Flip a note between public reply and private note.
router.post('/tickets/:id/note/:noteId/privacy', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const noteId = parseInt(String(req.params.noteId), 10);
  await pool.query(
    `UPDATE inbox_notes SET note_type = CASE WHEN note_type='public_reply' THEN 'private_note' ELSE 'public_reply' END
     WHERE id=$1 AND ticket_id=$2 AND note_type IN ('public_reply','private_note')`, [noteId, id]
  );
  res.redirect('/tickets/' + id);
});

// Move a Teams/WhatsApp message off this case (e.g. one that mis-threaded onto the wrong ticket)
// onto a new or existing case, then restore THIS case to the status it had before that message
// bumped it. For Teams, the ongoing chat is handed to the destination so future replies thread there.
router.post('/tickets/:id/message/:msgId/move', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const msgId = parseInt(String(req.params.msgId), 10);
  if (!id || !msgId) { res.redirect('/tickets/' + id); return; }

  const m = (await pool.query(
    'SELECT id, ticket_id, channel, graph_message_id, from_name, subject, body_text FROM inbox_messages WHERE id=$1', [msgId]
  )).rows[0];
  if (!m || m.ticket_id !== id) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('That message is not on this case.')); return; }
  if (m.channel !== 'teams' && m.channel !== 'whatsapp') { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('Only Teams or WhatsApp messages can be moved.')); return; }
  const chanLabel = m.channel === 'teams' ? 'Teams' : 'WhatsApp';

  const src = (await pool.query(
    'SELECT id, ticket_number, customer_id, contact_id, teams_conversation, prev_status, prev_activity_status FROM inbox_tickets WHERE id=$1', [id]
  )).rows[0];
  if (!src) { res.redirect('/tickets'); return; }

  // Resolve destination — a brand-new case, or an existing one by ticket number.
  let targetId: number; let targetNumber: string; let createdNew = false;
  if (String(req.body.target_type || 'new') === 'existing') {
    const tn = String(req.body.target_ticket || '').trim();
    if (!tn) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('Enter a ticket number to move to.')); return; }
    const tg = (await pool.query('SELECT id, ticket_number FROM inbox_tickets WHERE ticket_number=$1 AND deleted_at IS NULL', [tn])).rows[0];
    if (!tg) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('Ticket ' + tn + ' not found.')); return; }
    if (tg.id === id) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('That message is already on this case.')); return; }
    targetId = tg.id; targetNumber = tg.ticket_number;
  } else {
    createdNew = true;
    targetNumber = await nextTicketNumber();
    const subject = String(m.subject || m.body_text || (chanLabel + ' message')).slice(0, 120);
    const conv = m.channel === 'teams' ? src.teams_conversation : null;
    const t = await pool.query(
      `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, status, department, category, subject, description, activity_status, stage, teams_conversation, updated_at)
       VALUES ($1,$2,$3,$4,'awaiting_engineer','support','incident',$5,$6,'unread','awaiting_triage',$7, NOW()) RETURNING id`,
      [targetNumber, m.channel, src.customer_id, src.contact_id, subject, m.body_text || '', conv]
    );
    targetId = t.rows[0].id;
  }

  // Move the message and its channel-log entry.
  await pool.query('UPDATE inbox_messages SET ticket_id=$1, updated_at=NOW() WHERE id=$2', [targetId, msgId]);
  if (m.graph_message_id) await pool.query('UPDATE channel_log SET ticket_id=$1 WHERE ticket_id=$2 AND external_id=$3', [targetId, id, m.graph_message_id]);

  // Teams: hand the ongoing chat to the destination so the customer's future replies thread there,
  // and stop this case from catching them.
  if (m.channel === 'teams' && src.teams_conversation) {
    if (!createdNew) await pool.query('UPDATE inbox_tickets SET teams_conversation=$1 WHERE id=$2', [src.teams_conversation, targetId]);
    await pool.query('UPDATE inbox_tickets SET teams_conversation=NULL WHERE id=$1', [id]);
  }

  // Restore THIS case: an explicit pick wins, else the snapshot taken when the message bumped it,
  // else fall back to resolved (e.g. older cases with no snapshot). Clear the snapshot afterwards.
  const pick = String(req.body.restore_status || '').trim();
  const restoreTo = (STATUSES.includes(pick) ? pick : '') || src.prev_status || 'resolved';
  const restoreActivity = src.prev_activity_status || 'read';
  await pool.query('UPDATE inbox_tickets SET status=$2, activity_status=$3, prev_status=NULL, prev_activity_status=NULL, updated_at=NOW() WHERE id=$1', [id, restoreTo, restoreActivity]);

  await pool.query("INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)",
    [id, user.id, `${chanLabel} message moved to ${targetNumber} by ${user.displayName}. Case restored to ${restoreTo}.`]);
  await pool.query("INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)",
    [targetId, user.id, `${chanLabel} message moved here from ${src.ticket_number} by ${user.displayName}.`]);
  await logActivity(user.id, 'updated', 'tickets', id, `Moved ${chanLabel} message to ${targetNumber}`);

  res.redirect('/tickets/' + id + '?msg=' + encodeURIComponent(`Message moved to ${targetNumber} · case restored to ${restoreTo}`));
});

// Escalate a ticket to a senior engineer — assign, log, notify, email + Teams.
router.post('/tickets/:id/escalate', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const toUserId = parseInt(String(req.body.to_user_id), 10);
  if (!toUserId) { res.redirect('/tickets/' + id); return; }
  const eng = await pool.query('SELECT id, display_name, email FROM users WHERE id=$1 AND is_active=true', [toUserId]);
  if (!eng.rows.length) { res.redirect('/tickets/' + id); return; }
  const engineer = eng.rows[0];

  await pool.query(
    `UPDATE inbox_tickets SET escalated_at=NOW(), escalated_to_user_id=$1, assigned_user_id=$1,
       status=CASE WHEN status IN ('resolved','closed') THEN status ELSE 'open' END, updated_at=NOW()
     WHERE id=$2 AND deleted_at IS NULL`, [toUserId, id]
  );
  const tk = (await pool.query('SELECT ticket_number, subject FROM inbox_tickets WHERE id=$1', [id])).rows[0];
  if (!tk) { res.redirect('/tickets'); return; }

  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Escalated to ${engineer.display_name} by ${user.displayName}`]);
  await logActivity(user.id, 'escalated', 'tickets', id, `Escalated ${tk.ticket_number} to ${engineer.display_name}`);
  await notify(toUserId, `Escalated to you — ${tk.ticket_number}`, { type: 'escalation', body: tk.subject || '', link: '/tickets/' + id });

  const first = (engineer.display_name || '').split(' ')[0] || 'there';
  const link = `${config.APP_URL}/tickets/${id}`;
  if (engineer.email) {
    try {
      await sendMail({
        to: engineer.email,
        subject: `Ticket escalated to you — ${tk.ticket_number}`,
        html: `<p>Hi ${first},</p><p><strong>${user.displayName}</strong> has escalated ticket <strong>${tk.ticket_number}</strong> to you.</p><p>${tk.subject || ''}</p><p><a href="${link}">Open the ticket</a></p>`,
        signatureName: user.displayName,
      });
    } catch (e) { console.error('Escalation email failed:', e); }
    await sendTeamsNotice({
      toEmail: engineer.email,
      title: `${user.displayName} escalated ${tk.ticket_number} to you`,
      text: tk.subject || '',
      link,
    });
  }
  res.redirect('/tickets/' + id);
});

// Close a ticket that has no contact to email — straight to closed, no emails.
router.post('/tickets/:id/close-no-contact', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query(`UPDATE inbox_tickets SET status='closed', closed_at=COALESCE(closed_at, NOW()), updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL`, [id]);
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Closed (no contact) by ${user.displayName}`]);
  res.redirect('/tickets/' + id);
});

// Merge this ticket INTO a target ticket: move its notes/messages, then close + bin it.
router.post('/tickets/:id/merge', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const targetId = parseInt(String(req.body.target_id), 10);
  if (!targetId || targetId === id) { res.redirect('/tickets/' + id); return; }
  const src = await pool.query('SELECT ticket_number FROM inbox_tickets WHERE id=$1', [id]);
  const tgt = await pool.query('SELECT ticket_number FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [targetId]);
  if (!src.rows.length || !tgt.rows.length) { res.redirect('/tickets/' + id); return; }
  await pool.query('UPDATE inbox_notes SET ticket_id=$1 WHERE ticket_id=$2', [targetId, id]);
  await pool.query('UPDATE inbox_messages SET ticket_id=$1 WHERE ticket_id=$2', [targetId, id]);
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [targetId, user.id, `Merged in ${src.rows[0].ticket_number} by ${user.displayName}`]);
  await pool.query(`UPDATE inbox_tickets SET status='closed', closed_at=COALESCE(closed_at, NOW()), deleted_at=NOW(), deleted_by_user_id=$1, updated_at=NOW() WHERE id=$2`, [user.id, id]);
  res.redirect('/tickets/' + targetId);
});

router.post('/tickets/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE inbox_tickets SET deleted_at=NOW(), deleted_by_user_id=$1 WHERE id=$2', [user.id, id]);
  await logActivity(user.id, 'deleted', 'tickets', id, 'Deleted ticket #' + id);
  res.redirect('/tickets');
});

// ── Bulk actions from the board (selected ticket ids) ───────────────────────────
function bulkIds(body: any): number[] {
  let ids = body.ids;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  return ids.map((x: any) => parseInt(String(x), 10)).filter((n: number) => Number.isInteger(n) && n > 0);
}
function bulkBack(body: any): string {
  return typeof body.return === 'string' && body.return.startsWith('/tickets') ? body.return : '/tickets';
}

router.post('/tickets/bulk-delete', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const ids = bulkIds(req.body);
  if (ids.length) {
    await pool.query('UPDATE inbox_tickets SET deleted_at=NOW(), deleted_by_user_id=$1 WHERE id = ANY($2::int[]) AND deleted_at IS NULL', [user.id, ids]);
    await logActivity(user.id, 'deleted', 'tickets', 0, `Bulk-deleted ${ids.length} ticket(s)`);
  }
  res.redirect(bulkBack(req.body));
});

router.post('/tickets/bulk-spam', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const ids = bulkIds(req.body);
  for (const id of ids) {
    const t = await pool.query(
      `SELECT COALESCE(c.email, m.from_email) AS email FROM inbox_tickets it
         LEFT JOIN customer_contacts c ON c.id = it.contact_id
         LEFT JOIN LATERAL (SELECT from_email FROM inbox_messages WHERE ticket_id=it.id AND message_direction='inbound' AND from_email IS NOT NULL ORDER BY received_at DESC LIMIT 1) m ON true
        WHERE it.id=$1`, [id]
    );
    const email = (t.rows[0]?.email || '').toLowerCase().trim();
    await pool.query('UPDATE inbox_tickets SET is_spam=true, updated_at=NOW() WHERE id=$1', [id]);
    if (email) await blockSender(email, 'email', user.id, 'Bulk spam from ticket #' + id);
  }
  if (ids.length) await logActivity(user.id, 'updated', 'tickets', 0, `Bulk-marked ${ids.length} ticket(s) as spam`);
  res.redirect(bulkBack(req.body));
});

router.post('/tickets/bulk-merge', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const ids = bulkIds(req.body);
  if (ids.length < 2) { res.redirect(bulkBack(req.body) + (bulkBack(req.body).includes('?') ? '&' : '?') + 'err=' + encodeURIComponent('Pick at least two tickets to merge.')); return; }
  // Master = the oldest selected (lowest id). The rest fold into it and are closed.
  const masterId = Math.min(...ids);
  const tgt = await pool.query('SELECT ticket_number FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [masterId]);
  if (!tgt.rows.length) { res.redirect(bulkBack(req.body)); return; }
  for (const id of ids) {
    if (id === masterId) continue;
    const src = await pool.query('SELECT ticket_number FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!src.rows.length) continue;
    await pool.query('UPDATE inbox_notes SET ticket_id=$1 WHERE ticket_id=$2', [masterId, id]);
    await pool.query('UPDATE inbox_messages SET ticket_id=$1 WHERE ticket_id=$2', [masterId, id]);
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [masterId, user.id, `Merged in ${src.rows[0].ticket_number} by ${user.displayName}`]);
    await pool.query(`UPDATE inbox_tickets SET status='closed', closed_at=COALESCE(closed_at, NOW()), deleted_at=NOW(), deleted_by_user_id=$1, updated_at=NOW() WHERE id=$2`, [user.id, id]);
  }
  await logActivity(user.id, 'updated', 'tickets', masterId, `Bulk-merged ${ids.length - 1} ticket(s) into ${tgt.rows[0].ticket_number}`);
  res.redirect('/tickets/' + masterId);
});

// Set the requester from any contact (the side-panel picker) — updates contact + company.
router.post('/tickets/:id/set-requester', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const contactId = parseInt(String(req.body.contact_id), 10);
  if (!id || !contactId) { res.redirect('/tickets/' + id); return; }
  const c = (await pool.query(
    `SELECT cc.id, cc.full_name, cc.customer_id, cu.name AS customer_name
       FROM customer_contacts cc JOIN customers cu ON cu.id = cc.customer_id
      WHERE cc.id=$1 AND cu.deleted_at IS NULL`, [contactId]
  )).rows[0];
  if (!c) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('Contact not found.')); return; }
  await pool.query('UPDATE inbox_tickets SET contact_id=$1, customer_id=$2, updated_at=NOW() WHERE id=$3 AND deleted_at IS NULL', [c.id, c.customer_id, id]);
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Requester set to ${c.full_name} (${c.customer_name}) by ${user.displayName}`]);
  await logActivity(user.id, 'updated', 'tickets', id, `Requester → ${c.full_name}`);
  res.redirect('/tickets/' + id);
});

// Edit the case title (subject) and description.
router.post('/tickets/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const subject = (req.body.subject || '').trim();
  if (!subject) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('A case title is required.')); return; }
  const description = cleanHtml(req.body.description || '');
  await pool.query('UPDATE inbox_tickets SET subject=$1, description=$2, updated_at=NOW() WHERE id=$3 AND deleted_at IS NULL', [subject, description, id]);
  await logActivity(user.id, 'updated', 'tickets', id, 'Edited case title/description');
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Edited the case title/description (by ${user.displayName})`]);
  res.redirect('/tickets/' + id + '?msg=' + encodeURIComponent('Case updated.'));
});

// ── Unknown sender → link an existing customer, or create a new one ──────────────
// Ensures a contact row for the given email under the customer, returns its id.
async function ensureContact(customerId: number, email: string, name: string, protect = false): Promise<number | null> {
  const e = (email || '').toLowerCase().trim();
  if (!e) return null;
  const found = await pool.query('SELECT id FROM customer_contacts WHERE customer_id=$1 AND lower(email)=lower($2) LIMIT 1', [customerId, e]);
  if (found.rows.length) {
    if (protect) await pool.query('UPDATE customer_contacts SET protected=true WHERE id=$1', [found.rows[0].id]);
    return found.rows[0].id;
  }
  const hasPrimary = await pool.query('SELECT 1 FROM customer_contacts WHERE customer_id=$1 AND is_primary=true LIMIT 1', [customerId]);
  const ins = await pool.query(
    'INSERT INTO customer_contacts (customer_id, full_name, email, is_primary, protected) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [customerId, (name || e).trim().slice(0, 180), e, hasPrimary.rows.length === 0, protect]
  );
  return ins.rows[0].id;
}

router.post('/tickets/:id/link-customer', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const customerId = parseInt(String(req.body.customer_id), 10);
  if (!customerId) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('Pick a customer to link.')); return; }
  const cust = await pool.query('SELECT name FROM customers WHERE id=$1 AND deleted_at IS NULL', [customerId]);
  if (!cust.rows.length) { res.redirect('/tickets/' + id + '?err=' + encodeURIComponent('That customer no longer exists.')); return; }
  const email = String(req.body.requester_email || '').toLowerCase().trim();
  const name = String(req.body.requester_name || '').trim();
  const protect = req.body.protect === 'on' || req.body.protect === 'true';
  const contactId = email ? await ensureContact(customerId, email, name, protect) : null;
  await pool.query('UPDATE inbox_tickets SET customer_id=$1, contact_id=COALESCE($2, contact_id), updated_at=NOW() WHERE id=$3', [customerId, contactId, id]);
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Linked to customer ${cust.rows[0].name} by ${user.displayName}`]);
  await logActivity(user.id, 'updated', 'tickets', id, `Linked ticket to customer ${customerId}`);
  res.redirect('/tickets/' + id + '?msg=' + encodeURIComponent('Linked to ' + cust.rows[0].name + '.'));
});

router.post('/tickets/:id/create-customer', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const email = String(req.body.requester_email || '').toLowerCase().trim();
  const reqName = String(req.body.requester_name || '').trim();
  const name = (String(req.body.name || '').trim()) || reqName || (email ? email.split('@')[1] : '') || 'New customer';
  const domain = email.includes('@') ? email.split('@')[1] : null;
  const ins = await pool.query(
    `INSERT INTO customers (name, status, email, domain, created_by) VALUES ($1,'active',$2,$3,$4) RETURNING id`,
    [name.slice(0, 180), email || null, domain, user.id]
  );
  const customerId = ins.rows[0].id;
  const contactId = email ? await ensureContact(customerId, email, reqName) : null;
  await pool.query('UPDATE inbox_tickets SET customer_id=$1, contact_id=COALESCE($2, contact_id), updated_at=NOW() WHERE id=$3', [customerId, contactId, id]);
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Created customer ${name} and linked the case (by ${user.displayName})`]);
  await logActivity(user.id, 'created', 'customers', customerId, `Created customer ${name} from ticket #${id}`);
  res.redirect('/tickets/' + id + '?msg=' + encodeURIComponent('Created and linked ' + name + '.'));
});

// Mark as spam — hide this ticket and block the sender so their future mail never
// raises a case again. Release them later in Admin → Mail flow → Spam list.
router.post('/tickets/:id/spam', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const blockDomain = req.body.scope === 'domain';
  // Find the sender: prefer the contact, else the most recent inbound message.
  const t = await pool.query(
    `SELECT COALESCE(c.email, m.from_email) AS email
       FROM inbox_tickets it
       LEFT JOIN customer_contacts c ON c.id = it.contact_id
       LEFT JOIN LATERAL (
         SELECT from_email FROM inbox_messages
          WHERE ticket_id = it.id AND message_direction='inbound' AND from_email IS NOT NULL
          ORDER BY received_at DESC LIMIT 1
       ) m ON true
      WHERE it.id = $1`,
    [id]
  );
  const email = (t.rows[0]?.email || '').toLowerCase().trim();
  await pool.query('UPDATE inbox_tickets SET is_spam=true, updated_at=NOW() WHERE id=$1', [id]);
  if (email) {
    if (blockDomain) {
      const dom = emailDomain(email);
      if (dom) await blockSender(dom, 'domain', user.id, 'From ticket #' + id);
    } else {
      await blockSender(email, 'email', user.id, 'From ticket #' + id);
    }
  }
  await logActivity(user.id, 'updated', 'tickets', id, 'Marked ticket #' + id + ' as spam' + (email ? ' (blocked ' + (blockDomain ? emailDomain(email) : email) + ')' : ''));
  res.redirect('/tickets');
});

async function nextQuoteNumber(): Promise<string> {
  const { rows } = await pool.query('SELECT quote_number FROM quotes');
  let max = 0;
  for (const r of rows) { const m = String(r.quote_number).match(/(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  return 'Q-' + String(max + 1).padStart(4, '0');
}

// ── Transfer a support ticket → Draft Lead (sales) ──────────────────────────────
router.post('/tickets/:id/convert-to-lead', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const t = await pool.query('SELECT * FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!t.rows.length) { res.status(404).render('error', { message: 'Ticket not found.' }); return; }
  const ticket = t.rows[0];
  let customerId = ticket.customer_id;
  if (customerId) {
    await pool.query("UPDATE customers SET status='lead', lead_status='new', updated_at=NOW() WHERE id=$1 AND status NOT IN ('active')", [customerId]);
  } else {
    const ins = await pool.query(
      `INSERT INTO customers (name, status, lead_status, lead_source, created_by) VALUES ($1,'lead','new','support_ticket',$2) RETURNING id`,
      [ticket.subject?.slice(0, 180) || ('Lead from ' + ticket.ticket_number), user.id]
    );
    customerId = ins.rows[0].id;
    await pool.query('UPDATE inbox_tickets SET customer_id=$1 WHERE id=$2', [customerId, id]);
  }
  // Create the first-class Lead object pointing at this customer (reuse an open one if present).
  const existing = await pool.query("SELECT id FROM leads WHERE customer_id=$1 AND deleted_at IS NULL AND status NOT IN ('won','lost') ORDER BY id DESC LIMIT 1", [customerId]);
  let leadId: number;
  if (existing.rows.length) {
    leadId = existing.rows[0].id;
  } else {
    const lr = await pool.query(
      `INSERT INTO leads (customer_id, status, source, details, owner_user_id, created_by)
       VALUES ($1,'new','support_ticket',$2,$3,$3) RETURNING id`,
      [customerId, `Created from ticket ${ticket.ticket_number}: ${ticket.subject || ''}`.slice(0, 500), user.id]
    );
    leadId = lr.rows[0].id;
  }
  await pool.query("UPDATE inbox_tickets SET status='resolved', closed_at=NOW(), updated_at=NOW() WHERE id=$1", [id]);
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Transferred to sales as lead #${leadId} by ${user.displayName}`]);
  await logActivity(user.id, 'created', 'lead', leadId, `Lead created from ticket ${ticket.ticket_number}`);
  res.redirect('/leads/' + leadId);
});

// ── Transfer a support ticket → Draft Quote ─────────────────────────────────────
router.post('/tickets/:id/convert-to-quote', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const t = await pool.query('SELECT * FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!t.rows.length) { res.status(404).render('error', { message: 'Ticket not found.' }); return; }
  const ticket = t.rows[0];
  const qn = await nextQuoteNumber();
  const q = await pool.query(
    `INSERT INTO quotes (customer_id, inbox_ticket_id, quote_number, title, status, created_by)
     VALUES ($1,$2,$3,$4,'draft',$5) RETURNING id`,
    [ticket.customer_id, id, qn, ticket.subject?.slice(0, 180) || ('Quote from ' + ticket.ticket_number), user.id]
  );
  await pool.query("UPDATE inbox_tickets SET status='resolved', closed_at=NOW(), updated_at=NOW() WHERE id=$1", [id]);
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Transferred to a draft quote (${qn}) by ${user.displayName}`]);
  res.redirect('/quotes/' + q.rows[0].id + '/edit');
});

// Sidebar badge: number of tickets awaiting an engineer (polled by the Support nav item).
router.get('/tickets/nav/awaiting-count', requireAuth, async (_req: Request, res: Response) => {
  try {
    const n = (await pool.query("SELECT COUNT(*)::int n FROM inbox_tickets WHERE status='awaiting_engineer' AND deleted_at IS NULL AND COALESCE(is_spam,false)=false")).rows[0].n;
    res.json({ n });
  } catch { res.json({ n: 0 }); }
});

export default router;
