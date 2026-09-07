import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { getSetting, setSetting } from '../lib/settings';
import { attachmentUpload } from '../lib/attachments';
import { logActivity } from '../lib/activity';
import { config } from '../config';

// ── Atera ticket attachments → Portal ────────────────────────────────────────────
// Atera will not export attachments ("must be downloaded individually" — their own FAQ), and
// its REST API never carried them, so the ticket import brought every comment across but no
// files. The only place the files can be read is a signed-in Atera browser tab, and that tab
// cannot use the Portal session (SameSite cookies stay home on a cross-site request). So:
//   1. An admin mints a short-lived MIGRATION TOKEN here (session-authenticated).
//   2. A script running in the Atera tab asks /api/atera-attachments/pending which imported
//      tickets are still unchecked, opens each Atera ticket, and POSTs whatever files it
//      finds to /api/atera-attachments/upload as multipart, token in a header, CORS-scoped
//      to https://app.atera.com only.
//   3. Each file lands in static/attachments like any other note attachment, and the ticket
//      gets ONE internal note listing them, stamped with the Atera ticket id so a re-run
//      updates nothing twice.
// Nothing here can be reached with a cookie alone, and the token dies after four hours.

const router = Router();
const ATERA_ORIGIN = 'https://app.atera.com';
const TOKEN_TTL_MS = 4 * 3600 * 1000;

interface TokenRec { token: string; expires: number; userId: number }

router.post('/settings/atera/attachments/token', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const rec: TokenRec = { token: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + TOKEN_TTL_MS, userId: req.session.user!.id };
  await setSetting('atera', 'attachments_token', JSON.stringify(rec));
  await logActivity(req.session.user!.id, 'atera_attachments_token', 'settings', null, 'Minted an Atera attachment-migration token (4 h)');
  res.json({ ok: true, token: rec.token, expiresAt: new Date(rec.expires).toISOString() });
});

router.get('/settings/atera/attachments/status.json', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const checked = await loadChecked();
  const total = (await pool.query('SELECT COUNT(*)::int n FROM inbox_tickets WHERE atera_ticket_id IS NOT NULL AND deleted_at IS NULL')).rows[0].n;
  const withFiles = (await pool.query(`SELECT COUNT(DISTINCT ticket_id)::int n FROM inbox_notes WHERE body LIKE '%data-atera-att=%'`)).rows[0].n;
  res.json({ ok: true, total, checked: Object.keys(checked).length, withFiles });
});

// ── token-authenticated, CORS-scoped API used from the Atera tab ───────────────

async function tokenUser(req: Request): Promise<number | null> {
  const raw = await getSetting('atera', 'attachments_token');
  if (!raw) return null;
  let rec: TokenRec; try { rec = JSON.parse(raw); } catch { return null; }
  const given = String(req.get('x-atera-migration-token') || '');
  if (!given || given.length !== rec.token.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(rec.token))) return null;
  if (Date.now() > rec.expires) return null;
  return rec.userId;
}

function cors(req: Request, res: Response, next: NextFunction): void {
  if (req.get('origin') === ATERA_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ATERA_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Atera-Migration-Token');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
}
router.use('/api/atera-attachments', cors);

/** { ateraTicketId: fileCount } — every Atera ticket a run has looked at, found files or not. */
async function loadChecked(): Promise<Record<string, number>> {
  try { return JSON.parse((await getSetting('atera', 'attachments_checked')) || '{}') || {}; } catch { return {}; }
}
// One writer at a time: the browser runs a few tickets in parallel and a read-modify-write on
// a JSON blob would otherwise lose marks.
let chain: Promise<void> = Promise.resolve();
function markChecked(ateraId: string, count: number): Promise<void> {
  const step = chain.then(async () => {
    const c = await loadChecked();
    c[ateraId] = count;
    await setSetting('atera', 'attachments_checked', JSON.stringify(c));
  });
  chain = step.catch(() => {});
  return step;
}

router.get('/api/atera-attachments/pending', async (req: Request, res: Response) => {
  if (!(await tokenUser(req))) { res.status(401).json({ ok: false, error: 'No valid migration token.' }); return; }
  const checked = await loadChecked();
  const rows = (await pool.query(
    `SELECT id, ticket_number, atera_ticket_id, EXTRACT(EPOCH FROM created_at)::bigint AS created
       FROM inbox_tickets WHERE atera_ticket_id IS NOT NULL AND deleted_at IS NULL ORDER BY atera_ticket_id DESC`)).rows;
  const pending = rows.filter((r: any) => !(String(r.atera_ticket_id) in checked))
    .map((r: any) => ({ id: r.id, ticketNumber: r.ticket_number, ateraTicketId: String(r.atera_ticket_id) }));
  res.json({ ok: true, total: rows.length, checked: Object.keys(checked).length, pending });
});

router.post('/api/atera-attachments/checked', async (req: Request, res: Response) => {
  if (!(await tokenUser(req))) { res.status(401).json({ ok: false, error: 'No valid migration token.' }); return; }
  const ateraId = String(req.body?.ateraTicketId || '').replace(/\D/g, '');
  if (!ateraId) { res.status(400).json({ ok: false, error: 'ateraTicketId?' }); return; }
  await markChecked(ateraId, Math.max(0, parseInt(String(req.body?.count ?? 0), 10) || 0));
  res.json({ ok: true });
});

// Multipart: `ateraTicketId` field + up to 5 `files`. Multer writes them into static/attachments
// under a safe unique name, exactly as a note attachment typed into the Portal would land.
router.post('/api/atera-attachments/upload', attachmentUpload.array('files', 5), async (req: Request, res: Response) => {
  const userId = await tokenUser(req);
  if (!userId) { res.status(401).json({ ok: false, error: 'No valid migration token.' }); return; }
  const ateraId = String(req.body?.ateraTicketId || '').replace(/\D/g, '');
  const files: any[] = (req as any).files || [];
  if (!ateraId) { res.status(400).json({ ok: false, error: 'ateraTicketId?' }); return; }
  const t = (await pool.query('SELECT id, ticket_number, created_at FROM inbox_tickets WHERE atera_ticket_id=$1 AND deleted_at IS NULL LIMIT 1', [ateraId])).rows[0];
  if (!t) { res.status(404).json({ ok: false, error: `No Portal ticket carries Atera #${ateraId}.` }); return; }
  if (!files.length) { res.status(400).json({ ok: false, error: 'No files in that request.' }); return; }

  const base = (config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/$/, '');
  const esc = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
  const links = files.map((f) => `<a href="${base}/static/attachments/${f.filename}" target="_blank">&#128206; ${esc(f.originalname)}</a>`);

  // One note per ticket. A second run for the same ticket appends to that note rather than
  // making another, so the thread never shows the same file twice.
  const marker = `data-atera-att="${ateraId}"`;
  const existing = (await pool.query('SELECT id, body FROM inbox_notes WHERE ticket_id=$1 AND body LIKE $2 LIMIT 1', [t.id, `%${marker}%`])).rows[0];
  if (existing) {
    const fresh = links.filter((l) => !existing.body.includes(l.split('"')[1]));
    if (fresh.length) await pool.query('UPDATE inbox_notes SET body = body || $2 WHERE id=$1', [existing.id, '<div>' + fresh.join(' &middot; ') + '</div>']);
  } else {
    const body = `<div ${marker}><strong>Attachments carried over from Atera ticket #${ateraId}</strong></div><div>` + links.join(' &middot; ') + '</div>';
    await pool.query(
      `INSERT INTO inbox_notes (ticket_id, user_id, note_type, body, created_at) VALUES ($1,$2,'private_note',$3,$4)`,
      [t.id, userId, body, t.created_at || new Date()]);
  }
  await markChecked(ateraId, files.length);
  await logActivity(userId, 'atera_attachments', 'inbox_tickets', t.id, `${files.length} attachment(s) carried over from Atera #${ateraId} onto ${t.ticket_number}`);
  res.json({ ok: true, ticketNumber: t.ticket_number, saved: files.length });
});

export default router;
