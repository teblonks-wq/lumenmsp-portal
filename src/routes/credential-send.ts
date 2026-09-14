// ── Send Credentials ────────────────────────────────────────────────────────────
// Staff mint a one-time link from the composer lightbox; the customer opens it, types the
// passcode we gave them on the phone, and copies their details off a page that then stops
// existing. See lib/credential-send.ts for why the burn happens on unlock and not on open.
//
// Two halves in one file, deliberately: the public page and the thing that mints it drift
// apart the moment they live in different files.
import { Router, Request, Response } from 'express';
import { requireVaultAccess } from '../middleware/auth';
import { pool } from '../db/pool';
import { config } from '../config';
import { logActivity } from '../lib/activity';
import { decryptSecret } from '../lib/vault';
import {
  CredItem, MAX_ATTEMPTS, clientIp, findByToken, getCredentialSendEvents, listCredentialSends,
  logCredEvent, lookupGeo, mintCredentialSend, revealCredentials, revokeCredentialSend,
  stateOf, statusOf, userAgent, whereFrom,
} from '../lib/credential-send';

const router = Router();
const APP = () => (config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/$/, '');

// ═══ PUBLIC — no session. The token in the URL identifies one handover and grants
// nothing on its own; the passcode is the credential. ═══════════════════════════

router.get('/c/:token', async (req: Request, res: Response) => {
  const send = await findByToken(String(req.params.token || ''));
  const state = stateOf(send);
  if (send) {
    // Log the open, but do NOT burn: this hit is as likely to be a mail scanner as a
    // person. The geo lookup is fire-and-forget so the page does not wait on it.
    const ip = clientIp(req); const ua = userAgent(req);
    const ev = state === 'ask' ? 'link_opened'
      : state === 'burnt' ? 'opened_after_burn'
      : state === 'expired' ? 'opened_expired'
      : state === 'revoked' ? 'opened_revoked' : 'link_opened';
    lookupGeo(ip).then((geo) => logCredEvent(send.id, ev as any, { ip, userAgent: ua, meta: { geo } }))
      .catch(() => logCredEvent(send.id, ev as any, { ip, userAgent: ua }));
  }
  res.render('credentials/public', {
    mode: state === 'ask' ? 'ask' : state,
    title: send?.title || null, items: null, error: null,
    attemptsLeft: send ? Math.max(0, MAX_ATTEMPTS - (send.attempts || 0)) : 0,
    token: String(req.params.token || ''),
  });
});

router.post('/c/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  const send = await findByToken(token);
  const state = stateOf(send);
  const base = { title: send?.title || null, token };
  if (!send || state !== 'ask') {
    res.render('credentials/public', { ...base, mode: state, items: null, error: null, attemptsLeft: 0 });
    return;
  }
  const r = await revealCredentials(send, String(req.body?.passcode || ''),
    { ip: clientIp(req), userAgent: userAgent(req) });
  if (r.ok) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.render('credentials/public', { ...base, mode: 'shown', items: r.items, error: null, attemptsLeft: 0 });
    return;
  }
  if (r.state === 'locked') {
    res.render('credentials/public', { ...base, mode: 'locked', items: null, error: null, attemptsLeft: 0 });
    return;
  }
  res.render('credentials/public', {
    ...base, mode: r.state === 'ask' ? 'ask' : (r.state as string), items: null,
    error: 'That passcode is not right. Check it with whoever sent it to you.',
    attemptsLeft: r.attemptsLeft ?? 0,
  });
});

// ═══ STAFF — vault access only, same gate as the password vault itself ═══════════

router.use('/credential-sends', requireVaultAccess);

/** The customer's saved passwords, for the lightbox picker. Metadata only — the secrets
 *  stay on the server and are pulled at mint time. A password the browser never sees is a
 *  password that cannot leak from a screen share or a cached page. */
router.get('/credential-sends/vault.json', async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customerId || ''), 10);
  if (!customerId) { res.json({ ok: true, items: [] }); return; }
  const { rows } = await pool.query(
    `SELECT id, name, username, login_url, category, note, (secret_encrypted IS NOT NULL) AS has_password
       FROM customer_credentials
      WHERE customer_id=$1 AND deleted_at IS NULL
      ORDER BY COALESCE(category,''), name`, [customerId]);
  res.json({ ok: true, items: rows });
});

/** Mint a link. Returns the URL (for the email) and the passcode (shown to staff ONCE). */
router.post('/credential-sends/new.json', async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b = req.body || {};
  const customerId = parseInt(String(b.customerId || ''), 10) || null;
  const ticketId = parseInt(String(b.ticketId || ''), 10) || null;
  const ids: number[] = Array.isArray(b.credentialIds) ? b.credentialIds.map((n: any) => parseInt(String(n), 10)).filter(Boolean) : [];
  const items: CredItem[] = [];

  // Vault picks — decrypted here, never in the browser.
  if (ids.length && customerId) {
    const { rows } = await pool.query(
      `SELECT id, name, username, login_url, secret_encrypted, note FROM customer_credentials
        WHERE customer_id=$1 AND deleted_at IS NULL AND id = ANY($2::int[])`, [customerId, ids]);
    for (const row of rows) {
      let pw: string | null = null;
      if (row.secret_encrypted) {
        try { pw = decryptSecret(row.secret_encrypted); }
        catch { res.status(500).json({ ok: false, error: 'Could not decrypt a vault password — check VAULT_KEY.' }); return; }
      }
      items.push({ label: row.name, url: row.login_url, username: row.username, password: pw, note: row.note });
    }
  }
  // Typed rows and bare links from the lightbox.
  for (const raw of (Array.isArray(b.items) ? b.items : [])) {
    items.push({
      label: String(raw?.label || '').trim() || 'Login',
      url: String(raw?.url || '').trim() || null,
      username: String(raw?.username || '').trim() || null,
      password: String(raw?.password || '') || null,
      note: String(raw?.note || '').trim() || null,
    });
  }
  if (!items.length) { res.status(400).json({ ok: false, error: 'Nothing selected — tick a saved password or fill in a row.' }); return; }

  try {
    const { send, passcode, url } = await mintCredentialSend({
      items, appUrl: APP(), title: String(b.title || '').trim() || null,
      customerId, ticketId, toEmail: String(b.toEmail || '').trim() || null,
      createdBy: user.id, ttlHours: parseInt(String(b.ttlHours || ''), 10) || undefined,
    });
    await logActivity(user.id, 'created', 'credential_send', send.id,
      `Sent ${items.length} credential(s) by one-time link${b.toEmail ? ' to ' + b.toEmail : ''}`);
    res.json({ ok: true, id: send.id, url, passcode, count: items.length,
      expiresAt: send.expires_at, emailHtml: emailBlockHtml(url, items.length) });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message || 'Could not create the link.' });
  }
});

router.get('/credential-sends', async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.query.customer || ''), 10) || undefined;
  const rows = await listCredentialSends({ customerId, limit: 200 });
  res.render('credentials/sends', { user: req.session.user!, rows, statusOf, customerId: customerId || null });
});

router.get('/credential-sends/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query(
    `SELECT s.*, c.name AS customer_name, u.display_name AS created_by_name
       FROM credential_sends s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.created_by WHERE s.id=$1`, [id]);
  if (!r.rows.length) { res.redirect('/credential-sends'); return; }
  const events = await getCredentialSendEvents(id);
  const opens = events.filter((e: any) => e.event === 'link_opened').length;
  res.render('credentials/send-detail', {
    user: req.session.user!, s: r.rows[0], events, whereFrom,
    status: statusOf({ ...r.rows[0], opens }),
    notice: req.query.msg || null,
  });
});

router.post('/credential-sends/:id/revoke', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await revokeCredentialSend(id, req.session.user!.id);
  await logActivity(req.session.user!.id, 'revoked', 'credential_send', id, 'Revoked a credentials link');
  res.redirect('/credential-sends/' + id + '?msg=' + encodeURIComponent('Link revoked — it is dead from now on.'));
});

// ── The block that goes in the email ────────────────────────────────────────────
// Deliberately plain: no credentials, no hint of what they are for, and an explicit line
// telling them the passcode arrives another way. If this email is forwarded or leaks, it
// gives away nothing except that a link exists.
export function emailBlockHtml(url: string, count: number): string {
  const what = count === 1 ? 'the login details' : 'your login details';
  return `<p>As promised, here are ${what}. For your security we don't put passwords in email — they're on a secure page instead:</p>
<p><a href="${url}" style="display:inline-block;background:#0e7490;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:6px;">View your login details</a></p>
<p><strong>You'll need the passcode</strong> we're sending you separately (by phone or text). Type it on the page and your details appear, with a Copy button next to each one.</p>
<p style="font-size:13px;color:#6b7280;">The page can only be opened once, so copy everything you need — save the details straight into your password manager — before you close it. If it's already been opened, just reply to this email and we'll send a fresh link.</p>`;
}

export default router;
