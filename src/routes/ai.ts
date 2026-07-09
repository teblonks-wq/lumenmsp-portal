import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { aiComposeMessage, aiComposeConfigured, aiComposeTicketReply, aiPolishText } from '../lib/ai-compose';
import { pool } from '../db/pool';

const router = Router();

// Strip stored HTML (messages/notes) down to readable plain text for the AI context.
function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Tidy rough dictation/notes into a ready-to-send message via Claude. Voice-to-text is done in the
// browser (Web Speech API); this endpoint only does the compose/clean-up step.
router.post('/ai/compose', requireAuth, async (req: Request, res: Response) => {
  try {
    const message = await aiComposeMessage({
      transcript: String(req.body.transcript || ''),
      recipient: String(req.body.recipient || '').trim() || null,
      signoffName: String(req.body.signoffName || '').trim() || (req.session.user!.displayName || null),
      tone: String(req.body.tone || '').trim() || null,
      channel: String(req.body.channel || '').trim() || null,
    });
    res.json({ ok: true, message });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Compose failed' });
  }
});

// "Claude Update": polish the engineer's draft into the next reply, using the whole ticket thread
// (messages + notes, incl. internal notes) as context. Stays anchored to the engineer's draft.
router.post('/ai/ticket-update', requireAuth, async (req: Request, res: Response) => {
  try {
    const ticketId = parseInt(String(req.body.ticketId || ''), 10);
    const draft = String(req.body.draft || '');
    if (!ticketId) { res.status(400).json({ ok: false, error: 'Missing ticket reference.' }); return; }
    if (!draft.trim()) { res.status(400).json({ ok: false, error: 'Type or dictate your update first, then use Claude Update.' }); return; }

    const [msgs, notes] = await Promise.all([
      pool.query("SELECT message_direction, channel, from_name, from_email, body_html, body_text, received_at, created_at FROM inbox_messages WHERE ticket_id=$1 ORDER BY COALESCE(received_at, created_at)", [ticketId]),
      pool.query("SELECT nt.note_type, nt.body, nt.created_at, u.display_name AS author FROM inbox_notes nt LEFT JOIN users u ON u.id=nt.user_id WHERE nt.ticket_id=$1 ORDER BY nt.created_at", [ticketId]),
    ]);

    const entries: { at: number; line: string }[] = [];
    for (const m of msgs.rows) {
      const text = htmlToText(m.body_html || m.body_text || '');
      if (!text) continue;
      const who = m.from_name || m.from_email || (m.message_direction === 'inbound' ? 'Customer' : 'Us');
      const dir = m.message_direction === 'inbound' ? 'Customer message' : 'Our reply';
      entries.push({ at: new Date(m.received_at || m.created_at).getTime(), line: `${dir} (${m.channel || 'email'}) — ${who}:\n${text}` });
    }
    for (const n of notes.rows) {
      if (n.note_type === 'system_log' || n.note_type === 'bot') continue;   // skip audit/log noise
      const text = htmlToText(n.body || '');
      if (!text) continue;
      const label = n.note_type === 'public_reply' ? `Our reply — ${n.author || 'team'}`
        : n.note_type === 'side_convo' ? `Side conversation (private) — ${n.author || 'team'}`
        : `INTERNAL NOTE (do not reveal to customer) — ${n.author || 'team'}`;
      entries.push({ at: new Date(n.created_at).getTime(), line: `${label}:\n${text}` });
    }
    entries.sort((a, b) => a.at - b.at);

    let context = entries.map(e => e.line).join('\n\n');
    const CAP = 16000;                                  // keep the most recent context if the thread is huge
    if (context.length > CAP) context = '…(earlier messages trimmed)…\n\n' + context.slice(context.length - CAP);

    const message = await aiComposeTicketReply({
      draft,
      context,
      recipient: String(req.body.recipient || '').trim() || null,
      channel: String(req.body.channel || '').trim() || null,
    });
    res.json({ ok: true, message });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Claude Update failed' });
  }
});

// Generic "Improve with Claude" — polish any draft into clear, professional British English.
// Used platform-wide by the reusable Improve button on every composer.
router.post('/ai/polish', requireAuth, async (req: Request, res: Response) => {
  try {
    const message = await aiPolishText({
      text: String(req.body.text || ''),
      mode: req.body.mode === 'proofread' ? 'proofread' : 'polish',
    });
    res.json({ ok: true, message });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Improve failed' });
  }
});

// Lets the UI hide the button when Claude isn't set up.
router.get('/ai/status', requireAuth, async (_req: Request, res: Response) => {
  res.json({ configured: await aiComposeConfigured() });
});

export default router;
