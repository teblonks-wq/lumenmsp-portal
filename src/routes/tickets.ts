import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendMail, customerEmailHtml } from '../lib/mailer';
import { sendTicketStatusEmail } from '../lib/emails';
import { cleanHtml } from '../lib/sanitize';
import { attachmentUpload, processAttachments } from '../lib/attachments';
import { logActivity } from '../lib/activity';
import { listThirdParties, parkOnThirdParty, clearThirdParty, chaseByDefault } from '../lib/third-party';
import { notify } from '../lib/notifications';
import { sendTeamsNotice } from '../lib/teams'; // sendTeamsReply (relay) disabled pending Power Automate fix
import { teamsGraphConnected, sendTeamsChatMessage } from '../lib/teamsgraph';
import { syncInbox } from '../lib/mailsync';
import { aiAskText, aiAskCached, cacheNote, parseJsonAnswer, stripTrailingJson } from '../lib/ai-compose';
import { askTickets } from '../lib/ticket-ask';
import { blockSender, emailDomain } from '../lib/spam';
import { sendWhatsAppText, htmlToPlain, normaliseWaNumber } from '../lib/whatsapp';
import { logChannel } from '../lib/commslog';
import { aiTicketCategoryEnabled } from '../lib/ai-compose';
import { ensureReplyTemplates, listReplyTemplates, saveReplyTemplate, deleteReplyTemplate } from '../lib/reply-templates';
import { syncBookingsTemplates } from '../lib/bookings';
import { config } from '../config';
import { maybeInviteCaseFeedback } from '../lib/questionnaires';
import { pollBlockHtml, pollBlockText } from '../lib/questionnaire-email';

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
// 'update_required' is a case that went QUIET. Park it on the customer or a third party, hear
// nothing for 48h, and the sweep moves it here rather than back to awaiting_engineer - so a case
// somebody answered and a case nobody answered stop looking identical in the queue. A reply, from
// either party, goes to awaiting_engineer instead: the ball is genuinely back with us.
// It is an OPEN status - it is simply not in the resolved/closed set that every 'active cases'
// query excludes, so it shows on the helpdesk view by default.
const STATUSES = ['new', 'update_required', 'open', 'awaiting_customer', 'awaiting_3rd_party', 'awaiting_engineer', 'awaiting_installation', 'postponed', 'resolved', 'closed'];

const AUTO_RETURN_HOURS = 48;
// 'postponed' keeps its explicit return date. Parking on the customer or a third party starts a 48h
// timer (stored in the same postponed_until column) — the sweep flips it back to Awaiting engineer
// if nothing comes back. Any other status clears the timer - including update_required, which is
// where that timer already ran out: re-arming it there would loop the case round for ever.
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
  // Power Automate relay DISABLED pending a fix: the 21 Jul 2026 audit showed every relay send
  // since 18 Jun failed (HTTP 502 NoResponse from the flow) — 16/16, nothing ever delivered.
  // Fail fast with a clear reason instead of waiting out the flow timeout. When the flow is
  // fixed and a test send verified, restore: return await sendTeamsReply(conv, text, email);
  return { ok: false, error: 'Teams sending is unavailable on this case (no connected Teams chat; the Power Automate relay is disabled pending a fix). Reply by email instead.' };
}

// Can a Teams send actually work for this ticket right now? (Graph path only — the relay is
// disabled above.) Used to grey out the Teams pill in the composer.
async function teamsSendPossible(conv: string | null): Promise<boolean> {
  let chatId = '';
  if (conv) { try { const o = JSON.parse(conv); chatId = o.chatId || o.id || ''; } catch { /* not JSON */ } }
  return !!chatId && await teamsGraphConnected();
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
// The one-click case feedback block, for a case that has just been resolved. Returns '' for
// every reason not to ask (no contact, muted, asked recently, this case already asked), so
// the caller never has to know the rules — see lib/questionnaires.maybeInviteCaseFeedback.
async function caseFeedbackBlock(ticketId: number, status: string): Promise<{ html: string; text: string }> {
  if (status !== 'resolved') return { html: '', text: '' };
  try {
    const inv = await maybeInviteCaseFeedback(ticketId);
    if (!inv) return { html: '', text: '' };
    const q = inv.questions.find((x) => x.type === 'rating') || inv.questions[0];
    if (!q) return { html: '', text: '' };
    return {
      html: pollBlockHtml(inv.token, q, {
        heading: 'How did we do?',
        footnote: 'One click, nothing to fill in. Your answer is linked to your name so we can come back to you about it.',
        moreLabel: 'add a comment',
      }),
      text: pollBlockText(inv.token, q, 'How did we do? One click:'),
    };
  } catch (e: any) {
    // Feedback is a nicety; the resolution message is not. A failure here must never stop
    // the customer being told their case is closed.
    console.error('[case-feedback] could not raise an invite for ticket ' + ticketId + ':', e.message);
    return { html: '', text: '' };
  }
}

async function notifyTicketStatus(ticketId: number, status: string, agentName: string): Promise<void> {
  const fb = await caseFeedbackBlock(ticketId, status);
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
    const text = statusMsgText(status, name, tn, agentName) + fb.text;
    if (!num) { await logChannel({ channel: 'whatsapp', direction: 'outbound', status: 'failed', ticketId, preview: text, error: 'No WhatsApp number on case' }); return; }
    const r = await sendWhatsAppText(num, text);
    if (r.ok) await recordNote('whatsapp', text);
    await logChannel({ channel: 'whatsapp', direction: 'outbound', status: r.ok ? 'sent' : 'failed', ticketId, peer: num, peerName: name, preview: text, externalId: r.id || null, error: r.ok ? null : r.error });
    // WhatsApp refused (e.g. outside the 24h window) → fall back to the status email.
    if (!r.ok) {
      const rcpt = await ticketRecipient(ticketId);
      if (rcpt) { try { await sendTicketStatusEmail(status, rcpt.email, rcpt.name, rcpt.ticketNumber, agentName, rcpt.subject, fb.html); } catch (e) { console.error('WhatsApp status fallback email failed:', e); } }
    }
    return;
  }
  if (t.source === 'teams') {
    const text = statusMsgText(status, name, tn, agentName) + fb.text;
    const r = await sendTeamsBest(t.teams_conversation || null, text, t.email || null);
    // Only record the message on the case if it actually went out — recording failed sends
    // made cases show updates the customer never received (audit 21 Jul 2026).
    if (r.ok) await recordNote('teams', text);
    await logChannel({ channel: 'teams', direction: 'outbound', status: r.ok ? 'sent' : 'failed', ticketId, peer: t.email || null, peerName: name, preview: text, error: r.ok ? null : r.error });
    // Teams down → make sure the customer still hears: fall back to the status email.
    if (!r.ok) {
      const rcpt = await ticketRecipient(ticketId);
      if (rcpt) { try { await sendTicketStatusEmail(status, rcpt.email, rcpt.name, rcpt.ticketNumber, agentName, rcpt.subject, fb.html); } catch (e) { console.error('Teams status fallback email failed:', e); } }
    }
    return;
  }
  // Email-origin (or manual) cases → status email as before.
  const rcpt = await ticketRecipient(ticketId);
  if (rcpt) await sendTicketStatusEmail(status, rcpt.email, rcpt.name, rcpt.ticketNumber, agentName, rcpt.subject, fb.html);
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
  const common = { engineers, statusList: STATUSES, currentUrl: req.originalUrl, error: req.query.err || null, notice: req.query.msg || null };

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
      { key: 'update_required',   label: 'Update required - no reply in 48h',    rows: await grp("t.status='update_required'") },
      { key: 'unassigned',        label: 'New',                                 rows: await grp("(t.status='new' OR t.assigned_user_id IS NULL) AND t.status NOT IN ('resolved','closed','update_required')") },
      { key: 'awaiting_engineer', label: 'Awaiting engineer - they replied',     rows: await grp("t.status='awaiting_engineer' AND t.assigned_user_id IS NOT NULL") },
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
// ── Ask Claude across every case ────────────────────────────────────────────────
// The old search box matched a ticket number, a subject and a customer name, which is why
// "how many reports have we had from Larkmead about slow printers" was unanswerable - that
// phrase is never in a subject line, it is in the third message down and an engineer's note.
// This reads the actual content. See lib/ticket-ask.ts for the two-pass engine.
router.post('/tickets/ask.json', requireAuth, async (req: Request, res: Response) => {
  const question = String((req.body || {}).question || '').trim().slice(0, 400);
  if (!question) { res.status(400).json({ ok: false, error: 'Ask a question first.' }); return; }
  const started = Date.now();
  try {
    const r = await askTickets(question);
    const u = r.usage;
    res.json({
      ok: true,
      answer: r.answer, count: r.count, cases: r.cases,
      scanned: r.scanned, capped: r.capped,
      searched: r.plan.keywords,
      customer: r.plan.customer,
      monthsBack: r.plan.monthsBack,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      // Making the cache visible keeps a silent regression from costing real money.
      cache: cacheNote(u),
    });
  } catch (e: any) {
    console.error('[ask-tickets] failed:', e?.message || e);
    res.status(400).json({ ok: false, error: e.message || 'Ask failed.' });
  }
});

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

// ── Helpdesk review — walk every open case oldest-first, private note + status, Next ──
// The queue is fixed at entry by created_at (oldest first); the cursor is the case's own
// created_at/id, so resolving a case mid-review never skips or repeats the next one.
const REVIEW_WHERE = "t.deleted_at IS NULL AND t.is_spam=false AND t.status NOT IN ('resolved','closed')";

async function reviewNextId(afterCreated: Date | null, afterId: number): Promise<number | null> {
  const params: any[] = [];
  let cursor = '';
  if (afterCreated) { params.push(afterCreated, afterId); cursor = ' AND (t.created_at > $1 OR (t.created_at = $1 AND t.id > $2))'; }
  const r = await pool.query(`SELECT t.id FROM inbox_tickets t WHERE ${REVIEW_WHERE}${cursor} ORDER BY t.created_at ASC, t.id ASC LIMIT 1`, params);
  return r.rows.length ? r.rows[0].id : null;
}

// ── Official review sessions ────────────────────────────────────────────────────
// Entering the review creates a dated, owned record; every case touched (reply, note,
// status change, skip) is logged against it. Admin → Helpdesk reviews reads these.
// The active session id rides in the login session, so parallel reviewers never mix.
async function ensureReviewSession(req: Request): Promise<number> {
  const sess = req.session as any;
  const userId = req.session.user!.id;
  if (sess.hdReviewId) {
    const open = (await pool.query(
      `SELECT id FROM helpdesk_reviews WHERE id=$1 AND user_id=$2 AND ended_at IS NULL
          AND started_at > NOW() - interval '4 hours'`, [sess.hdReviewId, userId])).rows[0];
    if (open) return open.id;
  }
  // Anything this user left open and stale is closed as abandoned, honestly labelled.
  await pool.query(`UPDATE helpdesk_reviews SET ended_at=NOW(), outcome='abandoned'
                     WHERE user_id=$1 AND ended_at IS NULL`, [userId]);
  const ins = await pool.query(
    'INSERT INTO helpdesk_reviews (user_id) VALUES ($1) RETURNING id', [userId]);
  sess.hdReviewId = ins.rows[0].id;
  await logActivity(userId, 'helpdesk_review', null, ins.rows[0].id, 'Started an official helpdesk review');
  return ins.rows[0].id;
}

/**
 * Remember which case the reviewer is on. Called every time a review case renders,
 * so pulling away — a phone call, jumping into the full case screen, closing the tab —
 * always leaves a bookmark behind.
 */
async function markReviewCase(req: Request, ticketId: number): Promise<void> {
  const sess = req.session as any;
  if (!sess.hdReviewId) return;
  try {
    await pool.query(`UPDATE helpdesk_reviews SET last_ticket_id=$2 WHERE id=$1 AND ended_at IS NULL`,
      [sess.hdReviewId, ticketId]);
  } catch (e: any) {
    // A bookmark is a convenience, never a gate.
    console.error('[review] bookmark failed:', e.message);
  }
}

/**
 * Where an interrupted review should pick up. The bookmarked case if it is still in
 * the queue; the next one after it if it was resolved while we were away (never back
 * to the top — that is the bug this fixes); the oldest case if there is no bookmark.
 * Returns the id plus whether it was a genuine resume, so the page can say so.
 */
async function reviewResumeId(req: Request): Promise<{ id: number | null; resumed: boolean }> {
  const sess = req.session as any;
  const userId = req.session.user!.id;
  let bookmark: number | null = null;
  if (sess.hdReviewId) {
    const row = (await pool.query(
      `SELECT last_ticket_id FROM helpdesk_reviews
        WHERE id=$1 AND user_id=$2 AND ended_at IS NULL AND started_at > NOW() - interval '4 hours'`,
      [sess.hdReviewId, userId]).catch(() => ({ rows: [] as any[] }))).rows[0];
    bookmark = row && row.last_ticket_id ? Number(row.last_ticket_id) : null;
  }
  if (bookmark) {
    const t = (await pool.query(
      `SELECT t.id, t.created_at, (${REVIEW_WHERE}) AS still_open
         FROM inbox_tickets t WHERE t.id=$1 LIMIT 1`, [bookmark])).rows[0];
    if (t && t.still_open) return { id: Number(t.id), resumed: true };
    // Dealt with while we were away — carry on from where it sat in the queue.
    if (t) {
      const next = await reviewNextId(t.created_at, Number(t.id));
      if (next) return { id: next, resumed: true };
      return { id: null, resumed: true };
    }
  }
  return { id: await reviewNextId(null, 0), resumed: false };
}

async function recordReviewItem(req: Request, ticketId: number, action: string, detail: string | null) {
  try {
    const reviewId = await ensureReviewSession(req);
    await pool.query(
      'INSERT INTO helpdesk_review_items (review_id, ticket_id, action, detail) VALUES ($1,$2,$3,$4)',
      [reviewId, ticketId, action, detail ? detail.slice(0, 300) : null]);
  } catch (e: any) {
    // The review log is a record, not a gate — never let it block the work itself.
    console.error('[review] item log failed:', e.message);
  }
}

async function closeReviewSession(req: Request, outcome: string): Promise<string> {
  const sess = req.session as any;
  if (!sess.hdReviewId) return '';
  const id = sess.hdReviewId;
  sess.hdReviewId = null;
  try {
    await pool.query(
      `UPDATE helpdesk_reviews SET ended_at=NOW(), outcome=$2 WHERE id=$1 AND ended_at IS NULL`,
      [id, outcome]);
    const n = (await pool.query(
      'SELECT COUNT(DISTINCT ticket_id)::int AS cases, COUNT(*)::int AS actions FROM helpdesk_review_items WHERE review_id=$1',
      [id])).rows[0];
    await logActivity(req.session.user!.id, 'helpdesk_review', null, id,
      `Helpdesk review ${outcome} — ${n.cases} case(s), ${n.actions} action(s)`);
    return ` This review touched ${n.cases} case${n.cases === 1 ? '' : 's'} (${n.actions} action${n.actions === 1 ? '' : 's'}) — it is recorded under Admin → Helpdesk reviews.`;
  } catch (e: any) {
    console.error('[review] close failed:', e.message);
    return '';
  }
}

/// Everything the composer partial needs — the same lookups the case screen does,
/// kept separate so the hot detail handler stays untouched.
async function composerContext(ticket: any) {
  const cid = ticket.customer_id;
  const contacts = cid ? (await pool.query("SELECT full_name AS name, email FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email<>'' ORDER BY is_primary DESC, full_name", [cid]).catch(() => ({ rows: [] }))).rows : [];
  const customerDomain = cid ? ((await pool.query("SELECT domain FROM customers WHERE id=$1", [cid]).catch(() => ({ rows: [] }))).rows[0]?.domain || '') : '';
  const lastCh = (await pool.query("SELECT channel FROM inbox_messages WHERE ticket_id=$1 AND message_direction='inbound' ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1", [ticket.id]).catch(() => ({ rows: [] }))).rows[0];
  const lastChannel = (lastCh && lastCh.channel) || 'email';
  const waInb = (await pool.query("SELECT from_email, EXTRACT(EPOCH FROM (NOW() - COALESCE(received_at, created_at))) AS age_secs FROM inbox_messages WHERE ticket_id=$1 AND channel='whatsapp' AND message_direction='inbound' ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1", [ticket.id]).catch(() => ({ rows: [] }))).rows[0];
  const waNum = waInb ? String(waInb.from_email || '').replace(/[^\d]/g, '') : '';
  const waWindowOpen = !!(waInb && Number(waInb.age_secs) < 24 * 60 * 60);
  const teamsSendOk = await teamsSendPossible(ticket.teams_conversation || null);
  const agentSendOk = !!ticket.agent_device_id;
  const aiCatOn = await aiTicketCategoryEnabled();
  await ensureReplyTemplates().catch(() => {});
  const replyTemplates = await listReplyTemplates().catch(() => [] as any[]);
  const thirdParties = (await listThirdParties(false).catch(() => [])).map(tp => ({
    id: tp.id, name: tp.name, chaseBy: chaseByDefault(tp.typicalDays) }));
  return { contacts, customerDomain, lastChannel, waNum, waWindowOpen, teamsSendOk, agentSendOk, aiCatOn, replyTemplates, thirdParties };
}

router.get('/tickets/review', requireAuth, async (req: Request, res: Response) => {
  // Clicking Helpdesk Review is the official start: the record exists before the first
  // case opens. ensureReviewSession reuses an open session (< 4h) — which is what makes
  // the bookmark below meaningful, so it must run BEFORE we look one up.
  await ensureReviewSession(req);
  const { id: first, resumed } = await reviewResumeId(req);
  if (!first) {
    const summary = resumed ? await closeReviewSession(req, 'completed') : '';
    res.redirect('/tickets?msg=' + encodeURIComponent('Nothing to review — no open cases.' + summary)); return;
  }
  res.redirect('/tickets/review/' + first + (resumed ? '?msg=' + encodeURIComponent('Picked up where you left off.') : ''));
});

// End the review deliberately — stamped with its end time, kept in the history.
router.get('/tickets/review/exit', requireAuth, async (req: Request, res: Response) => {
  const summary = await closeReviewSession(req, 'exited');
  res.redirect('/tickets?msg=' + encodeURIComponent('Review ended.' + summary));
});

router.get('/tickets/review/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/tickets/review'); return; }
  const r = await pool.query(
    `SELECT t.*, c.name AS customer_name, u.display_name AS assigned_name, ct.full_name AS contact_name
     FROM inbox_tickets t
     LEFT JOIN customers c ON c.id=t.customer_id
     LEFT JOIN users u ON u.id=t.assigned_user_id
     LEFT JOIN customer_contacts ct ON ct.id=t.contact_id
     WHERE t.id=$1 AND t.deleted_at IS NULL LIMIT 1`, [id]
  );
  // Case vanished (deleted/merged) mid-review — quietly move on from the start of the queue.
  if (!r.rows.length) { res.redirect('/tickets/review'); return; }
  const ticket = r.rows[0];
  const [posQ, totQ, msgs, notes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM inbox_tickets t WHERE ${REVIEW_WHERE} AND (t.created_at < $1 OR (t.created_at = $1 AND t.id <= $2))`, [ticket.created_at, id]),
    pool.query(`SELECT COUNT(*)::int AS n FROM inbox_tickets t WHERE ${REVIEW_WHERE}`),
    pool.query('SELECT id, message_direction, channel, from_name, from_email, to_raw, cc_raw, body_html, body_text, received_at, created_at, graph_message_id FROM inbox_messages WHERE ticket_id=$1 ORDER BY COALESCE(received_at, created_at)', [id]),
    pool.query(`SELECT nt.id, nt.note_type, nt.channel, nt.body, nt.to_raw, nt.cc_raw, nt.created_at, u.display_name AS author FROM inbox_notes nt LEFT JOIN users u ON u.id=nt.user_id WHERE nt.ticket_id=$1 ORDER BY nt.created_at`, [id]),
  ]);
  // Same timeline as the case screen: every message and note (system logs included), newest
  // first with the same id tiebreak, so the review reads exactly like the case itself.
  const timeline: any[] = [];
  for (const m of msgs.rows) timeline.push({ kind: 'message', id: m.id, direction: m.message_direction, channel: m.channel || 'email', author: m.from_name || m.from_email || 'Email', fromEmail: m.from_email || '', to: m.to_raw || '', cc: m.cc_raw || '', body: m.body_html || m.body_text || '', at: m.received_at || m.created_at, teamsMessageId: (m.graph_message_id || '').replace(/^teamsg:/, '') || null });
  for (const nt of notes.rows) timeline.push({ kind: 'note', id: nt.id, noteType: nt.note_type, channel: nt.channel || '', author: nt.author || 'System', to: nt.to_raw || '', cc: nt.cc_raw || '', body: nt.body, at: nt.created_at });
  timeline.sort((a, b) => {
    const d = new Date(b.at).getTime() - new Date(a.at).getTime();
    return d !== 0 ? d : (b.id || 0) - (a.id || 0);
  });
  // Chat id for "Open in Teams" deep links, same as the case screen.
  let teamsChatId = '';
  if (ticket.teams_conversation) { try { teamsChatId = JSON.parse(ticket.teams_conversation).chatId || ''; } catch { /* not JSON */ } }
  // The official review record this walk belongs to, plus what the full composer needs.
  const reviewId = await ensureReviewSession(req);
  // Bookmark THIS case so an interrupted review resumes here rather than at the top.
  await markReviewCase(req, id);
  const [sessQ, actQ, ctx] = await Promise.all([
    pool.query('SELECT hr.*, u.display_name AS reviewer_name FROM helpdesk_reviews hr LEFT JOIN users u ON u.id=hr.user_id WHERE hr.id=$1', [reviewId]),
    pool.query('SELECT COUNT(*)::int AS n FROM helpdesk_review_items WHERE review_id=$1', [reviewId]),
    composerContext(ticket),
  ]);
  res.render('tickets/review', {
    user, ticket, timeline, teamsChatId,
    position: posQ.rows[0].n, total: totQ.rows[0].n,
    statusList: STATUSES, STATUSES,
    reviewSession: sessQ.rows[0] || null, reviewActions: actQ.rows[0].n,
    ...ctx,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// Skip — advance the cursor without saving anything (logged: a skipped case is a decision too).
router.get('/tickets/review/:id/next', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cur = (await pool.query('SELECT created_at FROM inbox_tickets WHERE id=$1', [id])).rows[0];
  if (id) await recordReviewItem(req, id, 'skipped', null);
  const next = await reviewNextId(cur ? cur.created_at : null, id || 0);
  if (!next) {
    const summary = await closeReviewSession(req, 'completed');
    res.redirect('/tickets?msg=' + encodeURIComponent('Review complete — end of the open cases.' + summary)); return;
  }
  res.redirect('/tickets/review/' + next);
});

// Save & next — a PRIVATE note (never leaves the building) and/or a status change, then advance.
router.post('/tickets/review/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const cur = (await pool.query('SELECT created_at, status FROM inbox_tickets WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!cur) { res.redirect('/tickets/review'); return; }
  const escHtml = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
  const noteText = String(req.body.body || '').trim();
  const setStatus = STATUSES.includes(req.body.set_status) && req.body.set_status !== cur.status ? String(req.body.set_status) : null;
  // Postponed / awaiting installation carry an explicit return date, same as the case screen.
  const ppRaw = setStatus && (setStatus === 'postponed' || setStatus === 'awaiting_installation') && req.body.postponed_until ? new Date(req.body.postponed_until) : null;
  if (setStatus === 'postponed' && (!ppRaw || isNaN(ppRaw.getTime()))) {
    res.redirect('/tickets/review/' + id + '?err=' + encodeURIComponent('Pick a date & time to postpone the case.')); return;
  }
  const ppVal = ppRaw && !isNaN(ppRaw.getTime()) ? ppRaw : null;
  if (noteText) {
    const body = '<p>' + escHtml(noteText).replace(/\r?\n/g, '<br>') + '</p>';
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'private_note',$3)`, [id, user.id, body]);
  }
  if (setStatus) {
    await pool.query('UPDATE inbox_tickets SET status=$2, postponed_until=$3, updated_at=NOW() WHERE id=$1',
      [id, setStatus, chaseReturn(setStatus, req.body, autoReturnAt(setStatus, ppVal))]);
    const tpNote = await applyThirdParty(id, setStatus, req.body);
    if (tpNote.trim()) {
      await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
        [id, user.id, tpNote.trim()]).catch(() => {});
    }
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [id, user.id, `Status: ${cur.status} → ${setStatus} (helpdesk review by ${user.displayName})`]);
    await logActivity(user.id, 'status_changed', 'tickets', id, `Ticket #${id} → ${setStatus} (helpdesk review)`);
    if (setStatus === 'resolved') {
      try { await notifyTicketStatus(id, 'resolved', user.displayName); }
      catch (e) { console.error('Resolved notify failed:', e); }
    }
  } else if (noteText) {
    await pool.query('UPDATE inbox_tickets SET updated_at=NOW() WHERE id=$1', [id]);
  }
  if (noteText) await recordReviewItem(req, id, 'noted', noteText.slice(0, 120));
  if (setStatus) await recordReviewItem(req, id, 'status', `${cur.status} → ${setStatus}`);
  const next = await reviewNextId(cur.created_at, id);
  if (!next) {
    const summary = await closeReviewSession(req, 'completed');
    res.redirect('/tickets?msg=' + encodeURIComponent('Review complete — end of the open cases.' + summary)); return;
  }
  res.redirect('/tickets/review/' + next + (noteText || setStatus ? '?msg=' + encodeURIComponent('Saved — private note' + (setStatus ? ' + status' : '') + ' added to the previous case.') : ''));
});

// ── Admin: the review history — every official review, newest first ─────────────
router.get('/admin/helpdesk-reviews', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const reviews = (await pool.query(
    `SELECT hr.id, hr.started_at, hr.ended_at, hr.outcome,
            u.display_name AS reviewer_name,
            EXTRACT(EPOCH FROM (COALESCE(hr.ended_at, NOW()) - hr.started_at))::int AS secs,
            COUNT(DISTINCT i.ticket_id)::int AS cases,
            COUNT(i.id) FILTER (WHERE i.action = 'replied')::int AS replies,
            COUNT(i.id) FILTER (WHERE i.action IN ('noted','side_convo'))::int AS notes,
            COUNT(i.id) FILTER (WHERE i.action = 'status')::int AS statuses,
            COUNT(i.id) FILTER (WHERE i.action = 'skipped')::int AS skips
       FROM helpdesk_reviews hr
       LEFT JOIN users u ON u.id = hr.user_id
       LEFT JOIN helpdesk_review_items i ON i.review_id = hr.id
      GROUP BY hr.id, u.display_name
      ORDER BY hr.started_at DESC
      LIMIT 200`)).rows;
  res.render('admin/helpdesk-reviews', { user: req.session.user!, reviews, notice: req.query.msg || null });
});

router.get('/admin/helpdesk-reviews/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const review = (await pool.query(
    `SELECT hr.*, u.display_name AS reviewer_name,
            EXTRACT(EPOCH FROM (COALESCE(hr.ended_at, NOW()) - hr.started_at))::int AS secs
       FROM helpdesk_reviews hr LEFT JOIN users u ON u.id=hr.user_id WHERE hr.id=$1`, [id])).rows[0];
  if (!review) { res.redirect('/admin/helpdesk-reviews'); return; }
  const items = (await pool.query(
    `SELECT i.*, t.ticket_number, t.subject, t.status AS ticket_status, c.name AS customer_name
       FROM helpdesk_review_items i
       LEFT JOIN inbox_tickets t ON t.id = i.ticket_id
       LEFT JOIN customers c ON c.id = t.customer_id
      WHERE i.review_id=$1 ORDER BY i.created_at ASC`, [id])).rows;
  res.render('admin/helpdesk-review-detail', { user: req.session.user!, review, items });
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
    pool.query('SELECT id, message_direction, channel, from_name, from_email, to_raw, cc_raw, subject, body_html, body_text, received_at, created_at, graph_message_id FROM inbox_messages WHERE ticket_id=$1 ORDER BY COALESCE(received_at, created_at)', [id]),
    pool.query(`SELECT nt.id, nt.note_type, nt.channel, nt.body, nt.to_raw, nt.cc_raw, nt.created_at, u.display_name AS author FROM inbox_notes nt LEFT JOIN users u ON u.id=nt.user_id WHERE nt.ticket_id=$1 ORDER BY nt.created_at`, [id]),
    pool.query(`SELECT id, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND hidden_from_lookups=false ORDER BY display_name`),
    pool.query(`SELECT id, quote_number, title, status, total FROM quotes WHERE inbox_ticket_id=$1 AND deleted_at IS NULL ORDER BY id DESC`, [id]),
  ]);

  // Merge into one timeline
  const timeline: any[] = [];
  // Teams messages carry a graph_message_id like 'teamsg:<id>' — strip the prefix so we can build
  // a "Open in Teams" deep link (https://teams.microsoft.com/l/message/{chatId}/{messageId}...).
  for (const m of msgs.rows) timeline.push({ kind: 'message', id: m.id, direction: m.message_direction, channel: m.channel || 'email', author: m.from_name || m.from_email || 'Email', fromEmail: m.from_email || '', to: m.to_raw || '', cc: m.cc_raw || '', body: m.body_html || m.body_text || '', at: m.received_at || m.created_at, teamsMessageId: (m.graph_message_id || '').replace(/^teamsg:/, '') || null });
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
  // age_secs comes from the DATABASE clock. Comparing a db timestamp against the Node
  // clock made this window close an HOUR early in BST (see [[portal-timestamp-timezone-trap]]),
  // locking the composer and demanding a template while free-form would still deliver.
  const waInb = (await pool.query("SELECT from_email, COALESCE(received_at, created_at) AS at, EXTRACT(EPOCH FROM (NOW() - COALESCE(received_at, created_at))) AS age_secs FROM inbox_messages WHERE ticket_id=$1 AND channel='whatsapp' AND message_direction='inbound' ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1", [r.rows[0].id]).catch(() => ({ rows: [] }))).rows[0];
  const waNum = waInb ? String(waInb.from_email || '').replace(/[^\d]/g, '') : '';
  const waName = requesterName || r.rows[0].contact_name || '';
  const waWindowOpen = !!(waInb && Number(waInb.age_secs) < 24 * 60 * 60);
  // Whether a Teams send can actually work on this case (drives the composer's Teams pill).
  const teamsSendOk = await teamsSendPossible(r.rows[0].teams_conversation || null);
  // Whether this case is linked to a LumenMSP Agent device (drives the composer's Agent pill).
  const agentSendOk = !!r.rows[0].agent_device_id;
  // Chat id for "Open in Teams" deep links on this case's Teams messages (Graph path only — the
  // old Bot Framework/Power Automate relay never stored a usable chatId here).
  let teamsChatId = '';
  if (r.rows[0].teams_conversation) { try { teamsChatId = JSON.parse(r.rows[0].teams_conversation).chatId || ''; } catch { /* not JSON */ } }

  // Finance Agent hand-off: an inbound case whose subject cites an invoice number gets a
  // one-click jump to that invoice's Finance Agent (Terry, 2026-07-30).
  let subjectInvoice: any = null;
  try {
    const invCands = Array.from(String(r.rows[0].subject || '').matchAll(/\b([A-Z]{1,4}-[0-9][0-9-]{2,}|[A-Z]{1,4}[0-9]{7,})\b/g)).map((m: any) => m[1].replace(/-+$/, ''));
    if (invCands.length) {
      subjectInvoice = (await pool.query('SELECT id, invoice_number FROM invoices WHERE invoice_number = ANY($1) AND deleted_at IS NULL LIMIT 1', [invCands])).rows[0] || null;
    }
  } catch { /* cosmetic — never block the case page */ }

  // Requester's devices — Portal-side allocation (customer_assets.assigned_contact_id) so staff
  // can jump straight from a case to the requester's machine (and its Atera remote page).
  let requesterAssets: any[] = [];
  if (r.rows[0].contact_id) {
    try {
      // Remote here means our own remote control, offered only when MeshCentral actually
      // has the machine. The old Atera deep-link is gone.
      requesterAssets = (await pool.query(
        `SELECT a.id, a.hostname, a.friendly_name, a.device_type, a.online_status,
                (ad.mesh_node_id IS NOT NULL) AS remote_ready
           FROM customer_assets a
           LEFT JOIN agent_devices ad ON ad.id = a.agent_device_id AND ad.revoked = false
          WHERE a.assigned_contact_id=$1 AND a.merged_into_id IS NULL AND a.archived_at IS NULL
          ORDER BY COALESCE(NULLIF(a.friendly_name,''), a.hostname)`, [r.rows[0].contact_id]
      )).rows.map((d: any) => ({ ...d, remote_url: d.remote_ready ? `/assets/${d.id}/remote-mesh` : null }));
    } catch { /* assigned_contact_id ships in the same deploy as this code */ }
  }
  // Our own mailboxes, so Reply-to-all on a message doesn't put us in our own To line
  // and start a loop with the inbox sync.
  const ourDomains = Array.from(new Set([config.GRAPH_SYNC_MAILBOX, config.GRAPH_SEND_FROM, config.GRAPH_TEAMS_SENDER]
    .map((a) => String(a || '').split('@')[1] || '').filter(Boolean).map((d) => d.toLowerCase())));
  const aiCatOn = await aiTicketCategoryEnabled();
  await ensureReplyTemplates().catch(() => {});
  const replyTemplates = await listReplyTemplates().catch(() => [] as any[]);
  // The Properties panel sets status too, so it needs the third-party picker as well as
  // the composer does — one list, both places, or the two disagree about who a case is with.
  const thirdParties = (await listThirdParties(false).catch(() => [])).map(tp => ({
    id: tp.id, name: tp.name, chaseBy: chaseByDefault(tp.typicalDays) }));

  res.render('tickets/detail', { user, ticket: r.rows[0], timeline, caseLog, requesterAssets, subjectInvoice, quotes: quotesRes.rows, users: users.rows, contacts, customerDomain, requesterEmail, requesterName, lastChannel, waNum, waName, waWindowOpen, teamsSendOk, agentSendOk, teamsChatId, aiCatOn, replyTemplates, thirdParties, ourDomains, DEPARTMENTS, STATUSES, CATEGORIES, error: req.query.err || null, notice: req.query.msg || null });
});

/**
 * Keep the third-party attachment honest whenever a case's status moves.
 * Parking on 'awaiting 3rd party' names WHO and dates the chase; moving off it clears
 * the attachment, so a resolved case can never still read as waiting on someone.
 * Returns a sentence to append to the redirect, or '' — the engineer should see the
 * chase date that was chosen for them rather than discover it later.
 */
async function applyThirdParty(ticketId: number, status: string | null, b: any): Promise<string> {
  if (!status) return '';
  if (status !== 'awaiting_3rd_party') { await clearThirdParty(ticketId); return ''; }
  const tpId = parseInt(String(b.tp_id || ''), 10);
  if (!Number.isFinite(tpId) || tpId <= 0) {
    // Parked with nobody named. Allowed — refusing the status would just push people to
    // pick the wrong one — but it lands on the Third parties board flagged as unnamed.
    await pool.query(
      `UPDATE inbox_tickets SET waiting_since=COALESCE(waiting_since, NOW()) WHERE id=$1`, [ticketId]);
    return ' Nobody was named, so it shows on the Third parties board as unattached.';
  }
  const parked = await parkOnThirdParty(ticketId, tpId, String(b.tp_ref || ''), String(b.tp_chase || ''));
  if (!parked) return ' That third party is no longer on the list, so nothing was attached.';
  return ` Waiting on ${parked.name} — chase by ${parked.chaseBy}.`;
}

/** A chase-by day key overrides the blanket 24h auto-return for a third-party park. */
function chaseReturn(status: string | null, b: any, fallback: Date | null): Date | null {
  if (status !== 'awaiting_3rd_party') return fallback;
  const day = String(b.tp_chase || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fallback;
  // 09:00 London on the chase day — it should be back in the queue when work starts,
  // not at midnight where it lands under yesterday's date.
  const naive = Date.parse(day + 'T09:00:00Z');
  const offset = Date.parse(new Date(naive).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T') + 'Z') - naive;
  return new Date(naive - offset);
}

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

  // Postpone keeps its explicit date; Awaiting customer gets a 24h auto-return timer.
  // Awaiting 3rd party used to get that same blanket 24h, which is why chases were guesswork:
  // when a chase-by day is given it wins, so the case returns on the day we said we would
  // go back at them rather than tomorrow regardless of who we are waiting on.
  const postponedUntil = chaseReturn(effectiveStatus, b,
    autoReturnAt(effectiveStatus, b.postponed_until ? new Date(b.postponed_until) : null));
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
  // Name (or release) the third party this case is waiting on.
  const tpNote = effectiveStatus !== prevStatus ? await applyThirdParty(id, effectiveStatus, b) : '';
  if (tpNote.trim()) {
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [id, user.id, tpNote.trim()]);
  }

  // Resolving a case sends you back to the helpdesk overview, not the (now-done) ticket.
  res.redirect(effectiveStatus === 'resolved'
    ? '/tickets'
    : '/tickets/' + id + (tpNote ? '?msg=' + encodeURIComponent(tpNote.trim()) : ''));
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
  // Posted from the helpdesk review? Errors return TO the review, and success advances it.
  const isReview = String(req.body.review || '') === '1';
  const back = isReview ? '/tickets/review/' + id : '/tickets/' + id;
  const noteType = ['public_reply', 'side_convo', 'private_note'].includes(req.body.note_type) ? req.body.note_type : 'private_note';
  // Can't reply to the customer until a support category is set (only while the AI-category feature
  // is switched on; Claude leaves the category blank when unsure).
  if (noteType === 'public_reply' && await aiTicketCategoryEnabled()) {
    const cat = (await pool.query('SELECT category FROM inbox_tickets WHERE id=$1', [id])).rows[0]?.category;
    if (!cat) { res.redirect(back + '?err=' + encodeURIComponent('Set a support category before replying to the customer.')); return; }
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
    res.redirect(back + '?err=' + encodeURIComponent('Pick a date & time to postpone the case.')); return;
  }
  const ppVal = ppRaw && !isNaN(ppRaw.getTime()) ? ppRaw : null;
  // A chase-by day beats the blanket 24h timer for a third-party park, and naming the
  // third party (or releasing it) rides with the status change itself, so the two can
  // never disagree about who a case is sitting with.
  let tpNote = '';
  const applyStatus = async (st: string | null) => {
    if (!st) return;
    await pool.query('UPDATE inbox_tickets SET status=$2, postponed_until=$3, updated_at=NOW() WHERE id=$1',
      [id, st, chaseReturn(st, req.body, autoReturnAt(st, ppVal))]);
    tpNote = await applyThirdParty(id, st, req.body);
    if (tpNote.trim()) {
      await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
        [id, user.id, tpNote.trim()]).catch(() => {});
    }
  };

  // A public reply needs a requester (someone to reply to). The engineer requirement is met
  // automatically: replying to a customer means you're taking the case, so an unowned case is
  // assigned to whoever sends the reply. "Requester" is channel-aware — email needs a real
  // address; WhatsApp/Teams just need an inbound from the customer on that channel (or a number).
  if (noteType === 'public_reply' && hasContent) {
    const asg = (await pool.query('SELECT assigned_user_id, contact_id FROM inbox_tickets WHERE id=$1', [id])).rows[0];
    const ch = ['email', 'teams', 'whatsapp', 'agent'].includes(req.body.channel) ? req.body.channel : 'email';
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
      res.redirect(back + '?err=' + encodeURIComponent('This case has no-one to reply to yet — link a contact, or open it from an inbound message.')); return;
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
    const channel = ['email', 'teams', 'whatsapp', 'agent'].includes(req.body.channel) ? req.body.channel : 'email';
    // ONLY public replies and side convos ever leave the building. An internal note must
    // NEVER touch a customer channel, whatever the "Send via" radio happens to be set to —
    // the channel selection simply doesn't apply to it. (Bug 2026-07-21: an internal note
    // with WhatsApp selected went out as a WhatsApp message to the customer.)
    const sendsExternally = noteType === 'public_reply' || noteType === 'side_convo';
    // Persist CC/BCC for the case if the engineer ticked "remember" (email replies only — the
    // box reflects current state, so unticking on an email reply clears it). Internal notes
    // never touch the persisted recipients: their checkbox is hidden, so without this gate an
    // internal note posted with Email selected would silently wipe the remembered CC/BCC.
    if (sendsExternally && channel === 'email') {
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
    // Gated on sendsExternally: an internal note never sends, whatever channel is selected.
    const plainForSend = htmlToPlain(body);
    let waNumberSent: string | null = null;
    let waIdSent: string | null = null;
    let teamsPeerSent: string | null = null;
    if (sendsExternally && channel === 'whatsapp') {
      const looksLikeNumber = (s: string) => !!s && !s.includes('@') && normaliseWaNumber(s).length >= 10;
      let num = '';
      if (looksLikeNumber(toAddr)) num = toAddr;
      else {
        const lm = await pool.query("SELECT from_email FROM inbox_messages WHERE ticket_id=$1 AND channel='whatsapp' AND message_direction='inbound' AND from_email IS NOT NULL ORDER BY received_at DESC LIMIT 1", [id]);
        if (lm.rows[0]?.from_email) num = lm.rows[0].from_email;
        else { const cn = await pool.query('SELECT cc.mobile_phone, cc.phone FROM inbox_tickets t LEFT JOIN customer_contacts cc ON cc.id=t.contact_id WHERE t.id=$1', [id]); num = cn.rows[0]?.mobile_phone || cn.rows[0]?.phone || ''; }
      }
      if (!num) {
        res.redirect(back + '?err=' + encodeURIComponent('No WhatsApp number for this contact, so nothing was sent or added to the case. Add a mobile number to the contact, or reply another way.')); return;
      }
      const r = await sendWhatsAppText(num, plainForSend);
      if (!r.ok) {
        await logChannel({ channel: 'whatsapp', direction: 'outbound', status: 'failed', ticketId: id, peer: num, preview: plainForSend, error: r.error || 'send failed', userId: user.id });
        const friendly = r.reEngagement
          ? 'WhatsApp message not sent — you are outside the 24-hour window, so an approved template is required and the customer needs to message us first. Nothing was added to the case.'
          : 'WhatsApp message could not be sent right now, so nothing was added to the case. Try again shortly, or reply by another channel.';
        res.redirect(back + '?err=' + encodeURIComponent(friendly)); return;
      }
      waNumberSent = num; waIdSent = r.id || null;
    } else if (sendsExternally && channel === 'teams') {
      const row = (await pool.query('SELECT t.teams_conversation, cc.email FROM inbox_tickets t LEFT JOIN customer_contacts cc ON cc.id=t.contact_id WHERE t.id=$1', [id])).rows[0];
      const r = await sendTeamsBest(row?.teams_conversation || null, plainForSend, row?.email || null);
      if (!r.ok) {
        await logChannel({ channel: 'teams', direction: 'outbound', status: 'failed', ticketId: id, peer: row?.email || null, preview: plainForSend, error: r.error || 'send failed', userId: user.id });
        const friendly = 'Teams message could not be sent — there is no live Teams conversation with this customer to reply into (they need to message us on Teams first, or the chat has expired). Nothing was added to the case — reply by email if it is urgent.';
        res.redirect(back + '?err=' + encodeURIComponent(friendly)); return;
      }
      teamsPeerSent = row?.email || null;
    } else if (sendsExternally && channel === 'agent') {
      // Agent channel is pull-based: the device collects the reply on its next poll, so
      // there is no send-failure path — just make sure this case really has a device.
      const ag = (await pool.query('SELECT agent_device_id FROM inbox_tickets WHERE id=$1', [id])).rows[0];
      if (!ag || !ag.agent_device_id) {
        res.redirect(back + '?err=' + encodeURIComponent('This case is not linked to a LumenMSP Agent device, so an Agent reply cannot be delivered. Reply by another channel.')); return;
      }
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
          if (!finalTo) { await sysNote(`No recipient address — reply saved but not emailed (by ${user.displayName})`); res.redirect(back + '?err=' + encodeURIComponent('No recipient address on this case — the reply was saved but not emailed. Add a "To" address or link a contact.')); return; }

          // A case that arrived by WhatsApp has a PHONE NUMBER where an email address would
          // be, and the composer defaults to Email. Sent as-is, Graph rejects the whole
          // message with ErrorInvalidRecipients and the reply silently never reaches anyone
          // (LITS-102570, 19 Aug: recipient '+447954827303' is not resolved). Caught here,
          // before the send, because the person needs to be told which BUTTON to press —
          // not that mail is broken, which it is not.
          const looksLikeEmail = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(finalTo.split(',')[0].trim());
          if (!looksLikeEmail) {
            const isPhone = /^\+?[\d][\d\s()-]{6,}$/.test(finalTo.trim());
            await sysNote(`Reply saved but NOT emailed — "${finalTo}" is not an email address (by ${user.displayName})`);
            res.redirect(back + '?err=' + encodeURIComponent(isPhone
              ? `Not sent: this case's contact is a phone number (${finalTo}), not an email address. Reply on the WhatsApp channel instead, or add an email address to the contact. Your reply has been saved.`
              : `Not sent: "${finalTo}" is not a valid email address. Your reply has been saved — correct the To address and send again.`));
            return;
          }

          const subj = rcpt ? (rcpt.ticketNumber + (rcpt.subject ? ': ' + rcpt.subject : '')) : 'Update on your ticket';
          await sendMail({ to: finalTo, cc, bcc, subject: subj, html: customerEmailHtml(body), signatureName: user.displayName, attachments: graph });
        } catch (e: any) {
          console.error('Public reply email failed:', e);
          // SAY WHAT ACTUALLY HAPPENED. This used to read "check mail settings / Graph
          // token" whatever the cause, which on 19 Aug sent everyone hunting a token that
          // was fine — 213 messages had gone out that week, one more three minutes later.
          // Graph puts the useful sentence inside a JSON body on the end of the message;
          // that sentence is the whole of the answer, so surface it.
          const raw = String(e?.message || e || '');
          let detail = raw;
          const brace = raw.indexOf('{');
          if (brace >= 0) {
            try { detail = JSON.parse(raw.slice(brace))?.error?.message || raw; } catch { /* keep raw */ }
          }
          detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
          await sysNote(`Email send FAILED — reply saved but not delivered: ${detail} (by ${user.displayName})`);
          res.redirect(back + '?err=' + encodeURIComponent('The reply was saved but the email failed to send — ' + detail)); return;
        }
      } else if (channel === 'whatsapp') {
        await recordWaSent();
      } else if (channel === 'teams') {
        await recordTeamsSent();
      } else if (channel === 'agent') {
        await sysNote(`Sent via LumenMSP Agent (by ${user.displayName})`);
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
  if (isReview) {
    // Log what happened to the official review, then walk on to the next oldest case.
    if (hasContent) {
      const what = noteType === 'public_reply' ? 'replied' : noteType === 'side_convo' ? 'side_convo' : 'noted';
      await recordReviewItem(req, id, what, String(req.body.channel || 'email'));
    }
    if (setStatus) await recordReviewItem(req, id, 'status', '→ ' + setStatus);
    const cur = (await pool.query('SELECT created_at FROM inbox_tickets WHERE id=$1', [id])).rows[0];
    const next = await reviewNextId(cur ? cur.created_at : null, id);
    if (!next) {
      const summary = await closeReviewSession(req, 'completed');
      res.redirect('/tickets?msg=' + encodeURIComponent('Review complete — end of the open cases.' + summary)); return;
    }
    res.redirect('/tickets/review/' + next + '?msg=' + encodeURIComponent(
      (hasContent ? (noteType === 'private_note' ? 'Note saved' : 'Sent') : 'Saved') + ' — that\'s logged to the review. Next case.'));
    return;
  }
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
  // Auto-resolve does not go through notifyTicketStatus, so ask here as well. The invite is
  // idempotent per case, so a case that later gets both treatments is still only asked once.
  maybeInviteCaseFeedback(id).catch(() => {});
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
  // Auto-resolve does not go through notifyTicketStatus, so ask here as well. The invite is
  // idempotent per case, so a case that later gets both treatments is still only asked once.
  maybeInviteCaseFeedback(id).catch(() => {});
  await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Transferred to a draft quote (${qn}) by ${user.displayName}`]);
  res.redirect('/quotes/' + q.rows[0].id + '/edit');
});

// Sidebar badge: cases waiting on US - somebody replied (awaiting_engineer), or nobody did and the
// 48h timer flagged it (update_required). Polled by the Support nav item.
router.get('/tickets/nav/awaiting-count', requireAuth, async (_req: Request, res: Response) => {
  try {
    const n = (await pool.query("SELECT COUNT(*)::int n FROM inbox_tickets WHERE status IN ('awaiting_engineer','update_required') AND deleted_at IS NULL AND COALESCE(is_spam,false)=false")).rows[0].n;
    res.json({ n });
  } catch { res.json({ n: 0 }); }
});


// ── "Ask Claude" on a ticket ─────────────────────────────────────────────────────
// Natural-language questions over the ENTIRE ticket — every message (including text
// that's visually hidden in the email HTML: quoted history, collapsed footers), every
// note, the subject and description. Answers cite the block they came from so the UI
// can jump straight to it, and every Q&A is stored per ticket so nobody asks twice.

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_ai_queries (
      id         SERIAL PRIMARY KEY,
      ticket_id  INTEGER NOT NULL,
      user_id    INTEGER,
      question   TEXT NOT NULL,
      answer     JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch((e) => console.error('ensure ticket_ai_queries failed:', e.message));
  await pool.query('CREATE INDEX IF NOT EXISTS ticket_ai_queries_ticket_idx ON ticket_ai_queries (ticket_id)')
    .catch(() => { /* index best-effort */ });
})();

// HTML → text that KEEPS hidden content: styles/scripts go, every text node stays —
// including display:none blocks and quoted history that the rendered view collapses.
function askPlainText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

router.get('/tickets/:id/ask', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const rows = (await pool.query(
    `SELECT q.id, q.question, q.answer, q.created_at, u.display_name AS asked_by
       FROM ticket_ai_queries q LEFT JOIN users u ON u.id = q.user_id
      WHERE q.ticket_id = $1 ORDER BY q.created_at DESC LIMIT 50`, [id])).rows;
  res.json({ ok: true, queries: rows });
});

router.post('/tickets/:id/ask', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const question = String((req.body || {}).question || '').trim().slice(0, 500);
  if (!Number.isInteger(id) || !question) { res.status(400).json({ ok: false, error: 'Ask a question first.' }); return; }
  try {
    const t = (await pool.query(
      `SELECT it.subject, it.description, it.ticket_number, c.name AS customer_name
         FROM inbox_tickets it LEFT JOIN customers c ON c.id = it.customer_id
        WHERE it.id = $1 LIMIT 1`, [id])).rows[0];
    if (!t) { res.status(404).json({ ok: false, error: 'Ticket not found.' }); return; }

    const msgs = (await pool.query(
      `SELECT id, message_direction, from_name, from_email, received_at, created_at, body_html, body_text
         FROM inbox_messages WHERE ticket_id = $1 ORDER BY COALESCE(received_at, created_at) ASC`, [id])).rows;
    const notes = (await pool.query(
      `SELECT n.id, n.note_type, n.body, n.created_at, u.display_name AS author
         FROM inbox_notes n LEFT JOIN users u ON u.id = n.user_id
        WHERE n.ticket_id = $1 ORDER BY n.created_at ASC`, [id])).rows;

    const blocks: string[] = [];
    blocks.push(`[CASE] ${t.ticket_number} — ${t.subject || ''}` +
      (t.customer_name ? ` | Customer: ${t.customer_name}` : '') +
      (t.description ? `\nDescription: ${askPlainText(t.description)}` : ''));
    for (const m of msgs) {
      const who = m.message_direction === 'outbound' ? 'Lumen (sent)' : (m.from_name || m.from_email || 'customer');
      const when = new Date(m.received_at || m.created_at).toISOString().slice(0, 16).replace('T', ' ');
      const text = askPlainText(m.body_html || '') || String(m.body_text || '');
      blocks.push(`[M${m.id}] ${who} · ${when}\n${text.slice(0, 12000)}`);
    }
    for (const n of notes) {
      const when = new Date(n.created_at).toISOString().slice(0, 16).replace('T', ' ');
      blocks.push(`[N${n.id}] ${n.note_type} by ${n.author || 'system'} · ${when}\n${askPlainText(n.body).slice(0, 8000)}`);
    }
    let corpus = blocks.join('\n\n---\n\n');
    if (corpus.length > 160000) corpus = corpus.slice(0, 80000) + '\n\n[... middle of a very long ticket omitted ...]\n\n' + corpus.slice(-80000);

    const system = [
      'You are the helpdesk assistant for Lumen IT Solutions, a UK managed-service provider. You are answering an ENGINEER\'s question in the context of one support ticket.',
      'The ticket content is a series of blocks. Each starts with a reference: [M123] is a message, [N45] is an internal note, [CASE] is the case header.',
      'Questions come in two kinds — decide which this is and answer accordingly:',
      '1. CASE questions ("who reported this?", "what did we quote?", "which device?"): answer ONLY from the ticket content. If it is not in the ticket, say exactly that — never guess or invent case facts. Cite findings.',
      '2. GENERAL IT questions ("are users on Business Basic allowed to use new Outlook?", "does this licence include X?", "how do we fix Y?"): answer from your own expert IT knowledge — Microsoft 365 licensing, Windows, networking, security, common vendor products. Use the ticket only as context to tailor the answer (e.g. which licence or product this customer has). Give the practical answer an engineer can act on. If the fact could have changed since your training (licensing terms, product availability), state what you know and add ONE short line saying where to verify (e.g. the M365 admin centre or Microsoft\'s licensing documentation).',
      'For mixed questions do both: the general answer, tailored by what the ticket says.',
      'Think it through FIRST in the "reasoning" field — work through the licensing or technical logic, or search the blocks, before committing to an answer. The reasoning is never shown to anyone; the final "answer" must stand alone without it.',
      'Other rules:',
      '- The blocks include text hidden in the original emails (quoted history, footers) — treat it all as searchable content.',
      '- Answer concisely and factually, in British English. Start general-knowledge answers with "General guidance: " so the engineer knows it came from expertise rather than the case.',
      '- Reply with STRICT JSON only — no markdown fences, no commentary:',
      '  {"reasoning":"your private working (2-6 sentences)","answer":"...","findings":[{"ref":"M123","quote":"exact verbatim snippet (max 140 chars) supporting the answer"}]}',
      '- 0 to 4 findings, most relevant first (0 is fine for pure general-knowledge answers). Quotes must be copied verbatim from the blocks. Use ref "CASE" for the header.',
    ].join('\n');

    // 1400 tokens: room for the private reasoning pass (the "additional thinking") + the answer.
    // The CASE goes in a cached block and the question comes last. That ordering is the whole
    // trick: the cached prefix has to be byte-identical between calls, so a second question
    // about the same ticket re-reads a 40,000-token thread at a tenth of the input price
    // instead of paying for it again. Nobody asks only one question about a difficult case.
    const { text: raw, usage } = await aiAskCached(system, corpus, `QUESTION: ${question}`, { maxTokens: 1400 });
    // parseJsonAnswer takes the outermost {...} span, so a model that writes a sentence
    // before its JSON no longer dumps the raw blob onto the page underneath the answer.
    const parsed: any = parseJsonAnswer<any>(raw, { answer: stripTrailingJson(raw), findings: [] });
    const answer = { answer: String(parsed.answer || '').slice(0, 4000),
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 4).map((f: any) => ({ ref: String(f.ref || ''), quote: String(f.quote || '').slice(0, 200) })) : [] };

    const ins = (await pool.query(
      'INSERT INTO ticket_ai_queries (ticket_id, user_id, question, answer) VALUES ($1,$2,$3,$4::jsonb) RETURNING id, created_at',
      [id, user.id, question, JSON.stringify(answer)])).rows[0];
    res.json({ ok: true, id: ins.id, question, answer, created_at: ins.created_at, asked_by: user.displayName, cache: cacheNote(usage) });
  } catch (e: any) {
    console.error('[ask-claude] failed:', e?.message || e);
    res.status(400).json({ ok: false, error: e.message || 'Ask failed.' });
  }
});

export default router;
