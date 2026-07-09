import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { config } from '../config';
import { sendMail } from '../lib/mailer';
import { nextTicketNumber } from './tickets';
import { cleanHtml, stripEmailFooter } from '../lib/sanitize';
import { attachmentUpload, processAttachments } from '../lib/attachments';

const router = Router();
const ENTITIES: Record<string, string> = { quote: '/quotes/', invoice: '/invoices/', customer: '/customers/' };

// True when rich-text body has no visible content (e.g. Quill's empty '<p><br></p>').
function htmlIsEmpty(html: string): boolean {
  return !html.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
}

export async function getComms(entityType: string, entityId: number) {
  const r = await pool.query(
    `SELECT c.*, u.display_name AS sent_by_name FROM communications c
     LEFT JOIN users u ON u.id = c.sent_by_user_id
     WHERE c.entity_type=$1 AND c.entity_id=$2 AND c.deleted_at IS NULL ORDER BY c.created_at ASC`, [entityType, entityId]
  );
  return r.rows;
}

// Send an email against a record (quote/invoice/customer) and log it on the thread.
router.post('/comms', requireAuth, attachmentUpload.array('attachments', 5), async (req: Request, res: Response) => {
  const user = req.session.user!;
  const entityType = String(req.body.entity_type || '');
  const entityId = parseInt(String(req.body.entity_id || ''), 10);
  const to = (req.body.to_email || '').trim();
  const cc = (req.body.cc || '').trim();
  const bcc = (req.body.bcc || '').trim();
  const subject = (req.body.subject || '').trim();
  const html = cleanHtml(req.body.body || '');
  const back = (ENTITIES[entityType] || '/') + (entityId || '');
  const { stored, graph } = processAttachments((req as any).files || []);

  if (!ENTITIES[entityType] || !entityId || (htmlIsEmpty(html) && !stored.length)) { res.redirect(back); return; }

  const sendFrom = config.GRAPH_SEND_FROM || config.FROM_EMAIL;
  await pool.query(
    `INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, cc_email, bcc_email, subject, body, is_unread, sent_by_user_id, attachments)
     VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8,$9,false,$10,$11)`,
    [entityType, entityId, config.FROM_NAME, sendFrom, to || null, cc || null, bcc || null, subject || null, html, user.id, stored.length ? JSON.stringify(stored) : null]
  );
  if (to || cc || bcc) {
    try {
      await sendMail({ to, cc: cc || undefined, bcc: bcc || undefined, from: sendFrom, subject: subject || 'Message from Lumen IT Solutions', html, signatureName: user.displayName, attachments: graph });
    } catch (e) { console.error('Comms email failed (mail not configured?):', e); }
  }
  res.redirect(back + '#comms');
});

// Mark an inbound message read
router.post('/comms/:id/read', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE communications SET is_unread=false WHERE id=$1', [id]);
  res.redirect(req.get('referer') || '/mail');
});

// Soft-delete a message from the mail inbox
router.post('/comms/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE communications SET deleted_at=NOW() WHERE id=$1', [id]);
  res.redirect('/mail');
});

// Reply to a message — sends via Graph and logs the reply on the same thread.
router.post('/comms/:id/reply', requireAuth, attachmentUpload.array('attachments', 5), async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const html = cleanHtml(req.body.body || '');
  const r = await pool.query('SELECT * FROM communications WHERE id=$1', [id]);
  const { stored, graph } = processAttachments((req as any).files || []);
  if (!r.rows.length || (htmlIsEmpty(html) && !stored.length)) { res.redirect('/mail/' + id); return; }
  const msg = r.rows[0];
  const to = msg.from_email;
  const subject = (msg.subject || '').replace(/^\s*re:\s*/i, '');
  const sendFrom = config.GRAPH_SEND_FROM || config.FROM_EMAIL;

  await pool.query(
    `INSERT INTO communications (entity_type, entity_id, direction, from_name, from_email, to_email, subject, body, is_unread, sent_by_user_id, attachments)
     VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,false,$8,$9)`,
    [msg.entity_type, msg.entity_id, config.FROM_NAME, sendFrom, to || null, 'Re: ' + subject, html, user.id, stored.length ? JSON.stringify(stored) : null]
  );
  await pool.query('UPDATE communications SET is_unread=false WHERE id=$1', [id]);
  if (to) {
    try {
      await sendMail({ to, from: sendFrom, subject: 'Re: ' + subject, html, signatureName: user.displayName, attachments: graph });
    } catch (e) { console.error('Reply send failed:', e); }
  }
  res.redirect('/mail/' + id);
});

// Transfer a message into a support ticket.
router.post('/comms/:id/to-ticket', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM communications WHERE id=$1', [id]);
  if (!r.rows.length) { res.redirect('/mail'); return; }
  const msg = r.rows[0];
  const customerId = msg.entity_type === 'customer' ? msg.entity_id : null;
  const tn = await nextTicketNumber();

  // Description = the email body minus the legal/signature footer (body is HTML → text first).
  const bodyText = String(msg.body || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const t = await pool.query(
    `INSERT INTO inbox_tickets (ticket_number, source, customer_id, assigned_user_id, assigned_at, status, department, category, subject, description, activity_status, stage, updated_at)
     VALUES ($1,'email',$2,$3,NOW(),'new','support','incident',$4,$5,'read','awaiting_triage', NOW()) RETURNING id`,
    [tn, customerId, user.id, msg.subject || 'Email enquiry', stripEmailFooter(bodyText)]
  );
  const ticketId = t.rows[0].id;
  // Put the original email into the conversation feed as the first activity.
  await pool.query(
    `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, from_name, from_email, to_raw, subject, body_html, body_text, received_at, graph_message_id, processing_status)
     VALUES ($1,$2,'inbound',$3,$4,$5,$6,$7,$8,$9,$10,'matched') ON CONFLICT (graph_message_id) DO NOTHING`,
    [ticketId, config.GRAPH_SYNC_MAILBOX || 'mail', msg.from_name || null, msg.from_email || null, msg.to_email || null, msg.subject || null, msg.body || null, bodyText, msg.created_at || new Date(), 'comms-' + id]
  );
  await pool.query(
    `INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [ticketId, user.id, `Transferred from mail (${msg.from_email || 'unknown sender'}) by ${user.displayName}`]
  );
  // Remove from the inbox now it's a ticket.
  await pool.query('UPDATE communications SET deleted_at=NOW(), is_unread=false WHERE id=$1', [id]);
  res.redirect('/tickets/' + ticketId);
});

// Mail inbox — unread + recent inbound across all records
router.get('/mail', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT * FROM communications WHERE direction='inbound' AND deleted_at IS NULL ORDER BY is_unread DESC, created_at DESC LIMIT 100`
  );
  res.render('mail/list', { user: req.session.user!, items: rows });
});

// Single message view
router.get('/mail/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM communications WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!r.rows.length) { res.redirect('/mail'); return; }
  await pool.query('UPDATE communications SET is_unread=false WHERE id=$1', [id]);
  res.render('mail/detail', { user: req.session.user!, m: r.rows[0] });
});

export default router;
