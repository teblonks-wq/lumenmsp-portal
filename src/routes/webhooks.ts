import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { config } from '../config';
import { whatsappConfig, verifyWaSignature, fetchWhatsAppMedia } from '../lib/whatsapp';
import { setSetting } from '../lib/settings';
import { saveBufferAttachment } from '../lib/attachments';
import { sendTeamsNotice, teamsConfig } from '../lib/teams';
import { logChannel } from '../lib/commslog';
import { parseWaCall } from '../lib/wacalls';
import { onInboundCall, onCallTerminate, onCallAnswer, notifyAgents } from '../lib/callhub';
import { parseUnifiWebhook } from '../lib/unifi';
import { raiseAlert, resolveAlert } from '../lib/alerts';
import { getGroup } from '../lib/settings';

// Friendly auto-acknowledgement sent back to a customer when their message opens a NEW case.
// Richer than a terse SMS — greets by first name and gives the ticket number.
function firstNameOf(name: string): string {
  const n = String(name || '').trim();
  if (!n || n.startsWith('+')) return 'there';
  return n.split(/\s+/)[0];
}
function ackText(name: string, ticketNumber: string): string {
  return `Hi ${firstNameOf(name)}, thanks for contacting Lumen IT. 👋\n\n`
    + `We've logged your message as case ${ticketNumber} and a member of our team will be in touch shortly. `
    + `You can reply here any time and it'll be added to this same case.\n\n— Lumen IT Support`;
}
function ackHtml(name: string, ticketNumber: string): string {
  return '<div style="white-space:pre-wrap;">' + ackText(name, ticketNumber)
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]) + '</div>';
}

const router = Router();

const escHtml = (s: string): string =>
  String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

// ── WhatsApp Cloud API webhook ──────────────────────────────────────────────────
// GET = Meta's subscription verification handshake.
router.get('/webhooks/whatsapp', async (req: Request, res: Response) => {
  const c = await whatsappConfig();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && c.verifyToken && token === c.verifyToken) {
    res.status(200).send(String(challenge || ''));
    return;
  }
  res.sendStatus(403);
});

// Match an inbound WhatsApp number to a contact (UK-friendly suffix match on the last 9 digits).
async function matchContactByNumber(waNumber: string): Promise<{ id: number; customer_id: number; full_name: string } | null> {
  const last9 = waNumber.slice(-9);
  if (last9.length < 7) return null;
  const r = await pool.query(
    `SELECT cc.id, cc.customer_id, cc.full_name
       FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
      WHERE c.deleted_at IS NULL AND (
            regexp_replace(COALESCE(cc.mobile_phone,''), '\\D', '', 'g') LIKE '%' || $1
         OR regexp_replace(COALESCE(cc.phone,''),        '\\D', '', 'g') LIKE '%' || $1 )
      ORDER BY cc.is_primary DESC LIMIT 1`, [last9]
  );
  return r.rows[0] || null;
}

// Build the displayable body for an inbound WhatsApp message. Text/button/interactive become
// plain text; media (image/document/audio/video/sticker) is DOWNLOADED and embedded so it shows
// on the ticket — previously these were dropped as a "[image]" placeholder.
async function renderInbound(msg: any): Promise<{ bodyText: string; bodyHtml: string }> {
  const wrap = (t: string) => '<div style="white-space:pre-wrap;">' + escHtml(t) + '</div>';
  if (msg.type === 'text') { const t = String(msg.text?.body || ''); return { bodyText: t, bodyHtml: wrap(t) }; }
  if (msg.type === 'button') { const t = String(msg.button?.text || ''); return { bodyText: t, bodyHtml: wrap(t) }; }
  if (msg.type === 'interactive') { const t = String(msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title || ''); return { bodyText: t, bodyHtml: wrap(t) }; }

  const node = (msg as any)[msg.type]; // image | document | audio | video | sticker payload
  if (node && node.id) {
    const caption = String(node.caption || '');
    const media = await fetchWhatsAppMedia(String(node.id));
    if (media.ok && media.buffer) {
      const ext = String(media.mime || '').split('/')[1]?.split(';')[0] || 'bin';
      const name = node.filename || (msg.type + '-' + Date.now() + '.' + ext);
      const saved = saveBufferAttachment(media.buffer, name);
      const u = escHtml(saved.url);
      let html = caption ? wrap(caption) : '';
      if (msg.type === 'image' || msg.type === 'sticker') html += `<img src="${u}" alt="${escHtml(name)}" style="max-width:340px;border-radius:8px;margin-top:6px;display:block;">`;
      else if (msg.type === 'video') html += `<video src="${u}" controls style="max-width:340px;margin-top:6px;display:block;"></video>`;
      else if (msg.type === 'audio') html += `<audio src="${u}" controls style="margin-top:6px;display:block;"></audio>`;
      else html += `<a href="${u}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;">📎 ${escHtml(name)}</a>`;
      const label = caption || ('[' + msg.type + (node.filename ? ': ' + node.filename : '') + ']');
      return { bodyText: label, bodyHtml: html };
    }
    const ph = '[' + msg.type + ' received — could not download: ' + (media.error || 'unknown') + ']';
    return { bodyText: ph, bodyHtml: wrap(ph) };
  }
  const ph = `[${msg.type || 'message'}]`;
  return { bodyText: ph, bodyHtml: wrap(ph) };
}

async function handleInboundMessage(msg: any, profileName: string): Promise<void> {
  const waId: string = String(msg.id || '');
  const from: string = String(msg.from || '').replace(/[^\d]/g, '');
  if (!waId || !from) return;

  // Dedupe on the WhatsApp message id.
  const dup = await pool.query('SELECT 1 FROM inbox_messages WHERE graph_message_id=$1', [waId]);
  if (dup.rows.length) return;

  // Body — text, button/interactive titles, or downloaded media embedded as HTML.
  const { bodyText, bodyHtml } = await renderInbound(msg);
  const body = bodyText;
  const ts = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();

  const contact = await matchContactByNumber(from);
  const contactId = contact ? contact.id : null;
  const senderName = (contact && contact.full_name) || profileName || ('+' + from);

  // NO auto-tagging: the message arrives UNTAGGED (ticket_id NULL) in the Chat inbox; staff tag it
  // to a case by hand (fixes messages landing on the wrong case) and reply from there. No auto-ack.
  await pool.query(
    `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, channel, from_name, from_email, subject, body_text, body_html, received_at, graph_message_id, processing_status)
     VALUES (NULL,'whatsapp','inbound','whatsapp',$1,$2,$3,$4,$5,$6,$7,'untagged') ON CONFLICT (graph_message_id) DO NOTHING`,
    [senderName, '+' + from, null, body, bodyHtml, ts, waId]
  );

  await logChannel({ channel: 'whatsapp', direction: 'inbound', status: 'received', ticketId: null, contactId, peer: '+' + from, peerName: senderName, preview: body, externalId: waId });

  // Loud real-time toast + chime to every logged-in staff member, so WhatsApp isn't missed.
  try { notifyAgents({ type: 'wa', name: senderName, body: (body || '').slice(0, 200), ticketId: null, waNum: '+' + from }); } catch { /* ignore */ }

  // Heads-up to the support group, linking to the WhatsApp inbox to tag + reply.
  try {
    const staff = await pool.query("SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL");
    await Promise.allSettled(staff.rows.map((s: any) => sendTeamsNotice({
      toEmail: s.email, title: 'New WhatsApp message', text: senderName + ': ' + (body || '').slice(0, 120), link: (config.APP_URL || 'https://portal.lumenmsp.co.uk') + '/chat/channel/whatsapp',
    })));
  } catch { /* ignore */ }
}

// POST = inbound messages + status callbacks.
router.post('/webhooks/whatsapp', async (req: Request, res: Response) => {
  const c = await whatsappConfig();
  if (!verifyWaSignature(c.appSecret, (req as any).rawBody, req.get('x-hub-signature-256'))) {
    res.sendStatus(403);
    return;
  }
  // Always 200 fast so Meta doesn't retry; process best-effort.
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      // The webhook's entry.id IS the WhatsApp Business Account (WABA) id — capture it once so the
      // template Management API is configured automatically, no manual lookup needed.
      if (!c.wabaId && entry.id) { try { await setSetting('whatsapp', 'waba_id', String(entry.id)); c.wabaId = String(entry.id); } catch { /* ignore */ } }
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const profileName = value.contacts?.[0]?.profile?.name || '';
        for (const msg of (value.messages || [])) {
          try { await handleInboundMessage(msg, profileName); }
          catch (e) { console.error('[whatsapp] message handling failed:', (e as Error).message); }
        }
        // WhatsApp Business Calling — inbound voice calls (the `calls` webhook field).
        for (const call of (value.calls || [])) {
          try {
            const ev = parseWaCall(call);
            if (!ev) continue;
            if (ev.event === 'terminate') await onCallTerminate(ev.callId);
            else if (ev.answerSdp) await onCallAnswer(ev.callId, ev.answerSdp); // user answered our outbound call
            else if (ev.offerSdp) await onInboundCall(ev);
          } catch (e) { console.error('[whatsapp] call handling failed:', (e as Error).message); }
        }
      }
    }
  } catch (e) { console.error('[whatsapp] webhook parse failed:', (e as Error).message); }
});

// ── Teams webhook (via Azure Bot / Power Automate relay) ─────────────────────────
// Inbound Teams messages thread into the helpdesk; replies go back via the saved reference.
// Health check / relay verification.
router.get('/webhooks/teams', (_req: Request, res: Response) => { res.status(200).send('ok'); });

async function matchContactByEmail(email: string): Promise<{ id: number; customer_id: number; full_name: string } | null> {
  const e = String(email || '').toLowerCase().trim();
  if (!e || e.indexOf('@') < 0) return null;
  const r = await pool.query(
    `SELECT cc.id, cc.customer_id, cc.full_name
       FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
      WHERE c.deleted_at IS NULL AND LOWER(cc.email) = $1
      ORDER BY cc.is_primary DESC LIMIT 1`, [e]
  );
  return r.rows[0] || null;
}

// POST = an inbound Teams message relayed to us. Contract (set by the bot/flow):
//   header X-Relay-Secret: <teams.inbound_secret>
//   body  { message_id, from_email, from_name, text, conversation }
router.post('/webhooks/teams', async (req: Request, res: Response) => {
  const c = await teamsConfig();
  const presented = req.get('x-relay-secret') || (req.body && req.body.secret) || '';
  if (!c.inboundSecret || presented !== c.inboundSecret) { res.sendStatus(403); return; }
  res.sendStatus(200); // ack fast; process best-effort
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    const fromEmail = String(b.from_email || '').toLowerCase().trim();
    const fromName = String(b.from_name || '').trim() || fromEmail || 'Teams user';
    const msgId = b.message_id ? 'teams:' + String(b.message_id) : null;
    if (!text && !msgId) return;

    if (msgId) {
      const dup = await pool.query('SELECT 1 FROM inbox_messages WHERE graph_message_id=$1', [msgId]);
      if (dup.rows.length) return;
    }

    const contact = await matchContactByEmail(fromEmail);
    const contactId = contact ? contact.id : null;
    const senderName = (contact && contact.full_name) || fromName;

    // NO auto-tagging: store UNTAGGED (ticket_id NULL); staff tag + reply from the Chat inbox.
    await pool.query(
      `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, channel, from_name, from_email, subject, body_text, body_html, received_at, graph_message_id, processing_status)
       VALUES (NULL,'teams','inbound','teams',$1,$2,$3,$4,$5,NOW(),$6,'untagged') ON CONFLICT (graph_message_id) DO NOTHING`,
      [senderName, fromEmail || null, null, text, '<div style="white-space:pre-wrap;">' + escHtml(text) + '</div>', msgId]
    );

    await logChannel({ channel: 'teams', direction: 'inbound', status: 'received', ticketId: null, contactId, peer: fromEmail || null, peerName: senderName, preview: text, externalId: msgId });

    // Loud real-time toast + chime to every logged-in staff member.
    try { notifyAgents({ type: 'wa', channelLabel: 'Teams', name: senderName, body: (text || '').slice(0, 200), ticketId: null, waNum: fromEmail || '' }); } catch { /* ignore */ }
    // Heads-up to the support group, linking to the Teams inbox to tag + reply.
    try {
      const staff = await pool.query("SELECT email FROM users WHERE is_active=true AND customer_id IS NULL AND support_group=true AND email IS NOT NULL");
      await Promise.allSettled(staff.rows.map((s: any) => sendTeamsNotice({
        toEmail: s.email, title: 'New Teams message', text: senderName + ': ' + (text || '').slice(0, 120), link: (config.APP_URL || 'https://portal.lumenmsp.co.uk') + '/chat/channel/teams',
      })));
    } catch { /* ignore */ }
  } catch (e) { console.error('[teams] webhook failed:', (e as Error).message); }
});

// ── UniFi Alarm Manager webhook ─────────────────────────────────────────────────
// Configure a custom webhook in UniFi → Alarm Manager pointing at this URL with ?token=<secret>
// (settings group 'unifi' key 'webhook_secret'). Real-time alerts → the N3twrx alert pipeline.
router.get('/webhooks/unifi', (_req: Request, res: Response) => { res.status(200).send('ok'); });
router.post('/webhooks/unifi', async (req: Request, res: Response) => {
  const g = await getGroup('unifi').catch(() => ({} as Record<string, string>));
  const secret = g.webhook_secret;
  const presented = String(req.query.token || req.get('x-webhook-secret') || '');
  if (secret && presented !== secret) { res.sendStatus(403); return; }
  res.sendStatus(200); // ack fast
  try {
    const ev = parseUnifiWebhook(req.body);
    if (!ev) return;
    if (ev.resolved) await resolveAlert('unifi', ev.externalId);
    else await raiseAlert({ source: 'unifi', externalId: ev.externalId, severity: ev.severity, title: ev.title, body: JSON.stringify(req.body).slice(0, 1500), raw: req.body, autoTicket: false });
  } catch (e) { console.error('[unifi webhook] failed:', (e as Error).message); }
});

export default router;
