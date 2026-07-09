import cron from 'node-cron';
import { pool } from '../db/pool';
import { config } from '../config';
import { graphConfigured, graphListInbox, graphListAttachments, graphEnsureFolder, graphMoveMessage, GraphMessage } from './graph';
import { saveGraphAttachments, SavedInboundAttachment } from './attachments';
import { cleanInboundEmail, stripEmailFooter } from './sanitize';
import { notify, alertGroup } from './notifications';
import { sendTeamsNotice } from './teams';
import { nextTicketNumber } from '../routes/tickets';
import { aiClassifyTicketCategory, aiTicketCategoryEnabled } from './ai-compose';
import { sendTicketStatusEmail } from './emails';
import { isSpamSender } from './spam';

const escHtml = (s: string): string =>
  (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

// Rough HTML→text for the searchable/plain fallback (description, previews).
function htmlToText(html: string): string {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#3?9;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Splits a reply's HTML into the new content and the quoted history/signature that
// trails it. Operates on the RAW HTML (before sanitising, so structural markers like
// gmail_quote / Outlook reply headers / blockquotes still exist). The slice can land
// mid-tag — that's fine, each half is sanitised separately which re-balances the tags.
function splitReply(rawHtml: string): { visible: string; quoted: string } {
  if (!rawHtml) return { visible: '', quoted: '' };
  const markers: RegExp[] = [
    /<div[^>]*id=["']?divRplyFwdMsg/i,            // Outlook desktop reply/forward header
    /<div[^>]*id=["']?appendonsend/i,             // Outlook web boundary (reply ends here)
    /<div[^>]*class=["'][^"']*gmail_quote/i,      // Gmail quoted block
    /<blockquote/i,                                // generic quoted message
    /border-top:\s*solid\s*#?[0-9a-f]{0,6}\s*1(?:\.0)?pt/i, // Outlook desktop separator line
    /<b>\s*From:\s*<\/b>/i,                        // bolded "From:" reply header
    /On\s+[^<]{3,80}?\bwrote:/i,                   // "On <date>, X wrote:"
  ];
  let cut = -1;
  for (const re of markers) {
    const m = rawHtml.match(re);
    if (m && m.index !== undefined && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut < 0) return { visible: rawHtml, quoted: '' };
  // If the cut landed inside a tag (e.g. the border-top style marker sits in a
  // style="" attribute), move it back to that tag's opening '<' so neither half
  // begins with a broken tag fragment.
  const lt = rawHtml.lastIndexOf('<', cut), gt = rawHtml.lastIndexOf('>', cut);
  if (lt > gt) cut = lt;
  const visible = rawHtml.slice(0, cut);
  // Don't hide everything if the reply text sits below the marker (rare layouts).
  if (htmlToText(visible).replace(/\s+/g, '').length < 2) return { visible: rawHtml, quoted: '' };
  return { visible, quoted: rawHtml.slice(cut) };
}

function rewriteCids(html: string, saved: SavedInboundAttachment[]): string {
  let out = html;
  for (const a of saved) {
    if (a.isInline && a.contentId) {
      const re = new RegExp('cid:' + a.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(re, a.url);
    }
  }
  return out;
}

// Builds the display HTML for an inbound message: sanitized new content, with the
// quoted thread + echoed signature collapsed behind a toggle, inline cid: images
// rewritten to stored URLs, and downloadable attachments returned separately.
async function buildInbound(mailbox: string, m: GraphMessage): Promise<{
  ticketHtml: string; commsHtml: string; text: string; attachments: SavedInboundAttachment[];
}> {
  let saved: SavedInboundAttachment[] = [];
  if (m.hasAttachments) {
    try { saved = saveGraphAttachments(await graphListAttachments(mailbox, m.id)); }
    catch (e) { console.error('[mailsync] attachment fetch failed:', (e as Error).message); }
  }
  const rawHtml = m.bodyHtml && m.bodyHtml.trim()
    ? m.bodyHtml
    : '<div style="white-space:pre-wrap;">' + escHtml(m.bodyText || '') + '</div>';

  const { visible, quoted } = splitReply(rawHtml);
  const body = rewriteCids(cleanInboundEmail(visible), saved);
  const quotedHtml = quoted ? rewriteCids(cleanInboundEmail(quoted), saved) : '';

  const files = saved.filter((a) => !a.isInline);
  const filesHtml = files.length
    ? '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #e2e8f0;font-size:13px;">&#128206; '
      + files.map((a) => `<a href="${a.url}" target="_blank" rel="noopener">${escHtml(a.name)}</a>`).join(' &middot; ') + '</div>'
    : '';
  const quotedBlock = quotedHtml
    ? '<details style="margin-top:10px;"><summary style="cursor:pointer;color:#64748b;font-size:12px;">Show quoted text &amp; signature</summary>'
      + '<div style="margin-top:8px;border-left:3px solid #e2e8f0;padding-left:10px;color:#64748b;">' + quotedHtml + '</div></details>'
    : '';

  return {
    ticketHtml: body + filesHtml + quotedBlock,
    commsHtml: body + quotedBlock,
    text: htmlToText(visible) || (m.bodyText || ''),
    attachments: files,
  };
}

// Polls the shared mailbox (GRAPH_SYNC_MAILBOX) and drops replies onto the
// matching customer/lead conversation thread. Dedupes on the Graph message id.
// Requires Application permission Mail.Read (or Mail.ReadWrite) on the app reg.

// Match an inbound sender to a customer (covers leads — leads are customers).
async function matchEntity(fromEmail: string): Promise<{ type: string; id: number }> {
  if (fromEmail) {
    const c = await pool.query(
      'SELECT customer_id FROM customer_contacts WHERE email IS NOT NULL AND lower(email)=lower($1) LIMIT 1',
      [fromEmail]
    );
    if (c.rows.length) return { type: 'customer', id: c.rows[0].customer_id };
    const cu = await pool.query(
      'SELECT id FROM customers WHERE email IS NOT NULL AND lower(email)=lower($1) LIMIT 1',
      [fromEmail]
    );
    if (cu.rows.length) return { type: 'customer', id: cu.rows[0].id };
  }
  // Unmatched senders still surface in the /mail inbox (entity 'unmatched').
  return { type: 'unmatched', id: 0 };
}

// Internet addresses that are "us". Mail from these — plus bounces and auto-replies —
// must never create or reopen a ticket (was causing resolved cases to loop back open
// off our own outbound notices / out-of-office replies).
const OWN_ADDRESSES = new Set(
  [config.GRAPH_SYNC_MAILBOX, config.GRAPH_SEND_FROM, config.FROM_EMAIL]
    .map((a) => (a || '').toLowerCase().trim()).filter(Boolean)
);
// GENUINE NOISE — filed away, never shown: our own copies, bounces/NDRs and no-reply senders.
// (Out-of-office / auto-replies are intentionally NOT here — we want to SEE those; see isAutoReply.)
function hardSkipReason(m: GraphMessage): string | null {
  const from = (m.from || '').toLowerCase().trim();
  if (!from) return 'No sender';
  if (OWN_ADDRESSES.has(from)) return 'Our own address';
  if (/(?:^|[._+-])(?:postmaster|mailer-daemon|no-?reply|do-?not-?reply|donotreply|bounce)s?@|@(?:bounce|mailer)\./i.test(from)) return 'No-reply / bounce sender';
  if ((m.headers?.['return-path'] || '').trim() === '<>') return 'Empty Return-Path (bounce)';
  const subj = (m.subject || '').trim().toLowerCase();
  if (/^(?:undeliverable|undelivered|delivery status notification|mail delivery (?:failed|subsystem)|read:|delivery receipt|read receipt)\b/.test(subj)) return 'Bounce / receipt';
  if (/\bcould not be delivered\b|\bdelivery (?:has )?failed\b|\bmail delivery (?:failed|subsystem)\b/i.test((m.subject || '') + ' ' + (m.bodyText || '').slice(0, 600))) return 'Delivery failure';
  return null;
}

// AUTO-REPLY / OUT-OF-OFFICE — we DO want these on the case (so the agent can see the person
// is away), but we must NOT acknowledge them (loop) or reopen a closed case off them.
function isAutoReply(m: GraphMessage): boolean {
  const h = m.headers || {};
  const autoSub = (h['auto-submitted'] || '').toLowerCase();
  if (autoSub && autoSub !== 'no') return true;
  if (/\b(auto_reply|bulk|junk)\b/.test((h['precedence'] || '').toLowerCase())) return true;
  if (h['x-auto-response-suppress'] || h['x-autoreply'] || h['x-autorespond'] || h['x-autoresponder']) return true;
  const subj = (m.subject || '').trim().toLowerCase();
  if (/^(?:automatic reply|auto:|auto reply|out of office|ooo\b)/.test(subj)) return true;
  if (/\bout of (?:the )?office\b|\bon (?:annual )?leave\b|\baway from my desk\b|\bautomatic reply\b/i.test((m.subject || '') + ' ' + (m.bodyText || '').slice(0, 600))) return true;
  return false;
}

// Record a skipped inbound so it's visible for diagnosis (deduped on the Graph id).
async function logSuppressed(m: GraphMessage, reason: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO inbox_messages (mailbox, message_direction, from_name, from_email, to_raw, cc_raw, subject, body_text, received_at, graph_message_id, processing_status, suppression_reason)
       VALUES ($1,'inbound',$2,$3,$4,$5,$6,$7,$8,$9,'suppressed',$10) ON CONFLICT (graph_message_id) DO NOTHING`,
      [config.GRAPH_SYNC_MAILBOX, m.fromName || null, m.from || null, (m.toRecipients || []).join(', ') || null, (m.ccRecipients || []).join(', ') || null, m.subject || null, (m.bodyText || '').slice(0, 1000), m.receivedDateTime, m.id, reason]
    );
  } catch (e) { console.error('[mailsync] suppressed-log failed:', (e as Error).message); }
  console.log(`[mailsync] suppressed ${m.id} from ${m.from || 'unknown'} — ${reason}`);
}

// Max brand-new cases we'll auto-create from one sender in an hour before assuming a loop.
const LOOP_LIMIT = 8;

// The "Imported" folder id is resolved once and cached — processed mail is moved there so
// the boundary message is never re-read by the next poll.
let _importedFolderId: string | null = null;
async function getImportedFolderId(): Promise<string | null> {
  if (_importedFolderId) return _importedFolderId;
  try { _importedFolderId = await graphEnsureFolder(config.GRAPH_SYNC_MAILBOX, 'Imported'); }
  catch (e) { console.error('[mailsync] could not ensure Imported folder:', (e as Error).message); _importedFolderId = null; }
  return _importedFolderId;
}

export async function syncInbox(): Promise<{ fetched: number; inserted: number }> {
  if (!graphConfigured() || !config.GRAPH_SYNC_MAILBOX) return { fetched: 0, inserted: 0 };

  // Drain the Inbox: take the oldest messages sitting there, process each, and MOVE it into
  // "Imported" so the Inbox empties in one pass. The hard de-dupe below (graph_message_id)
  // makes any re-read totally safe — no duplicate tickets even if a move fails.
  const importedFolderId = await getImportedFolderId();
  const msgs = await graphListInbox(config.GRAPH_SYNC_MAILBOX, null, 25);
  let inserted = 0;
  let moved = 0, moveFailed = 0;
  if (!importedFolderId) console.error('[mailsync] No "Imported" folder id — mail will NOT be moved out of the Inbox (check Mail.ReadWrite).');

  for (const m of msgs) {
    let processed = false; // handled successfully → safe to file into Imported
    try {
      // Hard de-dupe: if we've ever seen this exact email, don't touch it again — just file
      // it away. This makes any re-read completely safe (no duplicate tickets, ever).
      const seen = await pool.query('SELECT 1 FROM inbox_messages WHERE graph_message_id=$1 LIMIT 1', [m.id]);
      if (seen.rows.length) { processed = true; continue; }
      // Genuine noise (our own copies, bounces/NDRs, no-reply senders) → file away, never shown.
      const hard = hardSkipReason(m);
      if (hard) { await logSuppressed(m, hard); processed = true; continue; }
      // Blocked sender (marked spam) — skip, never raise or touch a ticket.
      if (await isSpamSender(m.from)) { await logSuppressed(m, 'Blocked sender (spam)'); processed = true; continue; }
      // Out-of-office / auto-reply: we WANT it on the case so the agent sees the person is
      // away — but we must not acknowledge it (loop) or reopen a closed case off it.
      const autoReply = isAutoReply(m);
      const subject = m.subject || '';
      const tm = subject.match(/LITS-\d+/i);

      // 1. Reply that quotes a ticket number → attach to that case + reopen.
      if (tm) {
        const tk = await pool.query(
          'SELECT id, status, assigned_user_id, ticket_number FROM inbox_tickets WHERE ticket_number=$1 AND deleted_at IS NULL',
          [tm[0].toUpperCase()]
        );
        if (tk.rows.length) {
          const tid = tk.rows[0].id;
          const inb = await buildInbound(config.GRAPH_SYNC_MAILBOX, m);
          const r = await pool.query(
            `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, from_name, from_email, to_raw, cc_raw, subject, body_text, body_html, has_attachments, received_at, graph_message_id, processing_status)
             VALUES ($1,$2,'inbound',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'matched') ON CONFLICT (graph_message_id) DO NOTHING`,
            [tid, config.GRAPH_SYNC_MAILBOX, m.fromName || null, m.from || null, (m.toRecipients || []).join(', ') || null, (m.ccRecipients || []).join(', ') || null, subject || null, inb.text || null, inb.ticketHtml, inb.attachments.length > 0, m.receivedDateTime, m.id]
          );
          // Only react to a genuinely NEW message (deduped on graph id). A re-read at
          // the sync boundary must not reopen a resolved case.
          if (r.rowCount) {
            inserted++;
            if (autoReply) {
              // Visible on the feed, but don't reopen / re-route / notify — just flag it.
              await pool.query('UPDATE inbox_tickets SET updated_at=NOW() WHERE id=$1', [tid]);
              await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1, NULL, 'system_log', $2)`,
                [tid, 'Auto-reply / out-of-office received from the customer']);
            } else {
              const reopen = ['resolved', 'closed'].includes(tk.rows[0].status);
              await pool.query("UPDATE inbox_tickets SET status='awaiting_engineer', updated_at=NOW() WHERE id=$1", [tid]);
              if (reopen) {
                await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1, NULL, 'system_log', $2)`,
                  [tid, 'Reopened by customer email reply']);
              }
              await notify(tk.rows[0].assigned_user_id, 'Customer replied — ' + tk.rows[0].ticket_number,
                { type: 'reopened', body: subject.slice(0, 120), link: '/tickets/' + tid });
              if (tk.rows[0].assigned_user_id) {
                const eu = await pool.query('SELECT email FROM users WHERE id=$1', [tk.rows[0].assigned_user_id]);
                if (eu.rows[0] && eu.rows[0].email) {
                  await sendTeamsNotice({ toEmail: eu.rows[0].email, title: 'Customer replied — ' + tk.rows[0].ticket_number, text: subject.slice(0, 120), link: config.APP_URL + '/tickets/' + tid });
                }
              }
            }
          }
          processed = true;
          continue;
        }
      }

      // 2. A reply to an email we sent from a lead/quote/invoice → thread onto Mail, not a ticket.
      const oc = await pool.query(
        `SELECT entity_type, entity_id FROM communications
         WHERE direction='outbound' AND to_email IS NOT NULL AND lower(to_email)=lower($1)
           AND created_at > NOW() - INTERVAL '60 days'
         ORDER BY created_at DESC LIMIT 1`, [m.from || '']
      );
      if (oc.rows.length && /^\s*re:/i.test(subject)) {
        const et = oc.rows[0].entity_type, eid = oc.rows[0].entity_id;
        const inb = await buildInbound(config.GRAPH_SYNC_MAILBOX, m);
        const r = await pool.query(
          `INSERT INTO communications (entity_type, entity_id, direction, channel, from_name, from_email, to_email, subject, body, attachments, is_unread, external_id, created_at)
           VALUES ($1,$2,'inbound','email',$3,$4,$5,$6,$7,$8,true,$9,$10) ON CONFLICT (external_id) DO NOTHING`,
          [et, eid, m.fromName || null, m.from || null, m.toRecipients[0] || null, subject || null, inb.commsHtml || null,
           inb.attachments.length ? JSON.stringify(inb.attachments) : null, m.id, m.receivedDateTime]
        );
        if (r.rowCount) {
          inserted++;
          let grp: 'support' | 'sales' = 'support', title = 'Reply needs action', link = '/';
          if (et === 'quote') { grp = 'sales'; title = 'Quote reply needs action'; link = '/quotes/' + eid; }
          else if (et === 'invoice') { grp = 'support'; title = 'Invoice reply'; link = '/invoices/' + eid; }
          else if (et === 'customer') {
            const lc = await pool.query('SELECT lead_status, status FROM customers WHERE id=$1', [eid]);
            const isLead = lc.rows[0] && (lc.rows[0].lead_status || lc.rows[0].status === 'lead');
            if (isLead) { grp = 'sales'; title = 'Lead reply needs action'; link = '/leads/' + eid; }
            else { grp = 'support'; title = 'Customer reply'; link = '/customers/' + eid; }
          }
          await alertGroup(grp, title, (m.fromName || m.from || 'Customer') + ': ' + subject.slice(0, 100), link);
        }
        processed = true;
        continue;
      }

      // 3. Fresh inbound → create a new support ticket (default). Dedupe on the Graph message id.
      const dup = await pool.query('SELECT 1 FROM inbox_messages WHERE graph_message_id=$1', [m.id]);
      if (!dup.rows.length) {
        // Circuit breaker: if one sender has spawned too many fresh cases in the last hour,
        // assume a loop and stop creating/acking (still filed away + logged).
        const recent = await pool.query(
          `SELECT COUNT(*)::int n FROM inbox_tickets t
             JOIN inbox_messages im ON im.ticket_id = t.id
            WHERE t.source='email' AND im.message_direction='inbound'
              AND lower(im.from_email)=lower($1) AND t.created_at > NOW() - INTERVAL '1 hour'`,
          [m.from || '']
        );
        if ((recent.rows[0]?.n || 0) >= LOOP_LIMIT) {
          await logSuppressed(m, `Circuit breaker — more than ${LOOP_LIMIT} new cases from this sender in 1h`);
          processed = true;
          continue;
        }
        const matched = await matchEntity(m.from);
        const custId = matched.type === 'customer' ? matched.id : null;
        const contact = m.from
          ? await pool.query('SELECT id FROM customer_contacts WHERE email IS NOT NULL AND lower(email)=lower($1) LIMIT 1', [m.from])
          : { rows: [] as any[] };
        const contactId = contact.rows.length ? contact.rows[0].id : null;
        const inb = await buildInbound(config.GRAPH_SYNC_MAILBOX, m);
        const tn = await nextTicketNumber();
        // Claude reads the email and picks a category (null when unsure) — only when the feature is
        // switched on; otherwise fall back to the previous default so nothing is gated.
        const aiCat = (await aiTicketCategoryEnabled())
          ? await aiClassifyTicketCategory(subject || '', inb.text || '').catch(() => null)
          : 'incident';
        const t = await pool.query(
          `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, status, department, category, subject, description, activity_status, stage, updated_at)
           VALUES ($1,'email',$2,$3,'new','support',$4,$5,$6,'unread','awaiting_triage', NOW()) RETURNING id`,
          [tn, custId, contactId, aiCat, subject || '(no subject)', stripEmailFooter(inb.text || '')]
        );
        const tid = t.rows[0].id;
        await pool.query(
          `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, from_name, from_email, to_raw, cc_raw, subject, body_text, body_html, has_attachments, received_at, graph_message_id, processing_status)
           VALUES ($1,$2,'inbound',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'matched') ON CONFLICT (graph_message_id) DO NOTHING`,
          [tid, config.GRAPH_SYNC_MAILBOX, m.fromName || null, m.from || null, (m.toRecipients || []).join(', ') || null, (m.ccRecipients || []).join(', ') || null, subject || null, inb.text || null, inb.ticketHtml, inb.attachments.length > 0, m.receivedDateTime, m.id]
        );
        await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1, NULL, 'system_log', $2)`,
          [tid, autoReply ? 'Created from an auto-reply / out-of-office email (no acknowledgement sent)' : 'Created from email (' + (m.from || 'unknown sender') + ')']);
        inserted++;

        // An out-of-office / auto-reply is still visible on the board, but we never ACK it
        // (loop) or spam the team about it. Genuine new mail gets the ack + "new case" ping.
        if (!autoReply) {
          try { if (m.from) await sendTicketStatusEmail('new', m.from, m.fromName || 'there', tn, 'Support', subject); } catch (e) { /* ignore ack failure */ }
          const reporter = (m.fromName ? m.fromName + ' · ' : '') + (m.from || 'unknown');
          const staff = await pool.query("SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL");
          await Promise.allSettled(staff.rows.map((s: any) => sendTeamsNotice({
            toEmail: s.email, title: 'New case waiting — ' + tn, text: (subject || '(no subject)') + ' — ' + reporter, link: config.APP_URL + '/tickets/' + tid,
          })));
        }
      }
      processed = true;
    } catch (e) {
      // Leave processed=false so a transient failure is retried next poll (not filed away).
      console.error('[mailsync] message handling failed:', (e as Error).message);
    } finally {
      // File handled mail into "Imported" so it leaves the Inbox entirely.
      if (processed && importedFolderId) {
        try { await graphMoveMessage(config.GRAPH_SYNC_MAILBOX, m.id, importedFolderId); moved++; }
        catch (e) { moveFailed++; console.error('[mailsync] move to Imported failed:', (e as Error).message); }
      }
    }
  }

  if (msgs.length) console.log(`[mailsync] fetched ${msgs.length}, ticketed ${inserted}, moved ${moved}${moveFailed ? `, moveFailed ${moveFailed}` : ''}`);
  return { fetched: msgs.length, inserted };
}

let _started = false;
export function startMailSync(): void {
  if (_started || !graphConfigured() || !config.GRAPH_SYNC_MAILBOX) return;
  _started = true;
  cron.schedule('* * * * *', () => {
    syncInbox()
      .then((r) => { if (r.inserted) console.log(`[mailsync] +${r.inserted} inbound from ${config.GRAPH_SYNC_MAILBOX}`); })
      .catch((e) => console.error('[mailsync] error:', e.message));
  });
  console.log(`[mailsync] started — polling ${config.GRAPH_SYNC_MAILBOX} every 1m`);
}
