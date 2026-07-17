import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import { requireAuth, hasVaultAccess } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { PURCHASE_DOCS_DIR } from '../lib/purchase-inbox';
import { loadPurchaseCats } from './purchases';
import { cleanInboundEmail } from '../lib/sanitize';
import { attachmentUpload, processAttachments } from '../lib/attachments';
import {
  ERECYCLING_CATEGORIES, ERECYCLING_CONDITIONS, erecyclingPhotoUpload,
  ensureOpenBatch, loadBatchItems, savedFirmEmail, addItem, deleteItem, submitBatch,
} from '../lib/erecycling';

// Mobile PWA — a slim, task-first front-end served under /m for phones/tablets (Edge,
// Company Portal). Its own design language; online-only. Reuses the portal's data + auth.

const router = Router();
router.use('/m', requireAuth);

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(PURCHASE_DOCS_DIR, { recursive: true }); cb(null, PURCHASE_DOCS_DIR); },
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-receipt-' + (file.originalname || 'photo.jpg').replace(/[^\w.\-]/g, '_')),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const num = (v: any): number => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? 0 : x; };
const q1 = async (sql: string, params: any[] = [], fallback = 0): Promise<number> =>
  Number((await pool.query(sql, params).catch(() => ({ rows: [{ n: fallback }] }))).rows[0]?.n ?? fallback);
const rows = async (sql: string, params: any[] = []): Promise<any[]> =>
  (await pool.query(sql, params).catch(() => ({ rows: [] }))).rows;
function stripHtml(h: string): string {
  return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c]);
}
// Make UK phone numbers tappable (tel: with the 141 CLI-withhold prefix, matching the
// rest of /m). Works on rendered HTML: only text outside tags and outside existing links.
function linkifyPhones(html: string): string {
  let aDepth = 0;
  return String(html || '').split(/(<[^>]+>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<a[\s>]/i.test(part)) aDepth++;
      else if (/^<\/a>/i.test(part)) aDepth = Math.max(0, aDepth - 1);
      return part;
    }
    if (aDepth > 0) return part;
    return part.replace(/(\+44\s?\d(?:[\s-]?\d){8,9}|\b0(?:[\s-]?\d){9,10})(?!\d)/g, (m2) => {
      const digits = m2.replace(/[^0-9+]/g, '');
      const n = digits.startsWith('+44') ? '0' + digits.slice(3) : digits;
      if (!/^0\d{9,10}$/.test(n)) return m2;
      return '<a href="tel:141' + n + '">' + m2 + '</a>';
    });
  }).join('');
}

// Rich, sanitized HTML for a feed item — keeps the email's formatting (like the web feed). Falls
// back to escaped plain text (with line breaks) for plain WhatsApp/Teams messages and notes.
function richBody(html: string | null, text: string | null): string {
  if (html && /<[a-z][\s\S]*>/i.test(html)) return linkifyPhones(cleanInboundEmail(html));
  const t = text || stripHtml(html || '');
  return t ? linkifyPhones('<p>' + escapeHtml(t).replace(/\n/g, '<br>') + '</p>') : '';
}

// ── Home ─────────────────────────────────────────────────────────────────────────
router.get('/m', async (req: Request, res: Response) => {
  const u = req.session.user!;
  const myCases = await q1("SELECT COUNT(*)::int n FROM inbox_tickets WHERE deleted_at IS NULL AND is_spam=false AND assigned_user_id=$1 AND status NOT IN ('resolved','closed')", [u.id]);
  const tasksDue = await q1("SELECT COUNT(*)::int n FROM tasks WHERE assigned_to_user_id=$1 AND status IN ('open','in_progress')", [u.id]);
  const h = new Date().getHours();
  const greeting = 'Good ' + (h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening') + ', ' + String(u.displayName || '').split(' ')[0];
  const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  res.render('mobile/home', { user: u, active: 'home', greeting, dateStr, myCases, tasksDue });
});

// ── Receipt logger ───────────────────────────────────────────────────────────────
router.get('/m/receipt', async (req: Request, res: Response) => {
  const { cats } = await loadPurchaseCats();
  const recent = await rows("SELECT id, parsed_amount, category_name, created_at FROM purchase_documents WHERE source='mobile' ORDER BY created_at DESC LIMIT 5");
  res.render('mobile/receipt', { user: req.session.user!, active: 'receipt', cats, recent, notice: req.query.msg || null, error: req.query.err || null });
});

router.post('/m/receipt', photoUpload.single('photo'), async (req: Request, res: Response) => {
  const amount = num(req.body.amount);
  const catId = String(req.body.category_id || '').trim() || null;
  const note = String(req.body.note || '').trim() || null;
  if (!amount || !req.file) { res.redirect('/m/receipt?err=' + encodeURIComponent('Enter an amount and take a photo.')); return; }
  let catName: string | null = null;
  if (catId) { const { cats } = await loadPurchaseCats(); const c = cats.find((x: any) => x.Id === catId); catName = c ? c.Name : null; }
  await pool.query(
    `INSERT INTO purchase_documents (source, from_name, subject, received_at, file_name, file_path, content_type, size_bytes, parsed_amount, category_id, category_name, parse_status, status)
     VALUES ('mobile',$1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,'ok','new')`,
    [req.session.user!.displayName || 'Mobile', note, req.file.originalname || 'receipt.jpg', req.file.path, req.file.mimetype || 'image/jpeg', req.file.size || null, amount.toFixed(2), catId, catName]
  );
  await logActivity(req.session.user!.id, 'created', 'invoices', 0, `Mobile receipt £${amount.toFixed(2)}${catName ? ' · ' + catName : ''}`);
  res.redirect('/m/receipt?msg=' + encodeURIComponent('Receipt logged — £' + amount.toFixed(2) + (catName ? ' · ' + catName : '') + '.'));
});

// ── E-Recycling (field capture) ──────────────────────────────────────────────────
router.get('/m/erecycling', async (req: Request, res: Response) => {
  const batch = await ensureOpenBatch(req.session.user!.id);
  const items = await loadBatchItems(batch.id);
  const firmEmail = await savedFirmEmail();
  res.render('mobile/erecycling', {
    user: req.session.user!, active: 'erecycling', batch, items, firmEmail,
    categories: ERECYCLING_CATEGORIES, conditions: ERECYCLING_CONDITIONS,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

router.post('/m/erecycling/item', erecyclingPhotoUpload.array('photos', 8), async (req: Request, res: Response) => {
  try {
    const batch = await ensureOpenBatch(req.session.user!.id);
    await addItem(batch.id, req.body, (req.files as any[]) || [], req.session.user!.id);
    res.redirect('/m/erecycling?msg=' + encodeURIComponent(`${String(req.body.category || 'Item')} added`));
  } catch (e: any) {
    res.redirect('/m/erecycling?err=' + encodeURIComponent(e.message || 'Add failed'));
  }
});

router.post('/m/erecycling/item/:itemId(\\d+)/delete', async (req: Request, res: Response) => {
  await deleteItem(parseInt(String(req.params.itemId), 10));
  res.redirect('/m/erecycling');
});

router.post('/m/erecycling/submit', async (req: Request, res: Response) => {
  try {
    const batch = await ensureOpenBatch(req.session.user!.id);
    const ref = await submitBatch(batch.id, String(req.body.firm_email || '').trim(), String(req.body.notes || '').trim() || null, true, req.session.user!.id);
    res.redirect('/m/erecycling?msg=' + encodeURIComponent(`${ref} submitted to the e-waste firm`));
  } catch (e: any) {
    res.redirect('/m/erecycling?err=' + encodeURIComponent(e.message || 'Submit failed'));
  }
});

// ── Customers ──────────────────────────────────────────────────────────────────
router.get('/m/customers', async (req: Request, res: Response) => {
  const search = String(req.query.q || '').trim();
  const params: any[] = []; let where = 'WHERE deleted_at IS NULL AND is_placeholder=false';
  if (search) { params.push('%' + search + '%'); where += ` AND (name ILIKE $${params.length} OR city ILIKE $${params.length} OR postcode ILIKE $${params.length})`; }
  const list = await rows(`SELECT id, name, status, phone, city, postcode FROM customers ${where} ORDER BY (status='active') DESC, name LIMIT 100`, params);
  res.render('mobile/customers', { user: req.session.user!, active: 'customers', list, search });
});

router.get('/m/customers/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const c = (await rows('SELECT * FROM customers WHERE id=$1 AND deleted_at IS NULL', [id]))[0];
  if (!c) { res.status(404).render('mobile/notfound', { user: req.session.user!, active: 'customers', what: 'Customer' }); return; }
  const contacts = await rows('SELECT id, full_name, job_title, phone, mobile_phone, email, is_primary FROM customer_contacts WHERE customer_id=$1 ORDER BY is_primary DESC, full_name', [id]);
  const tickets = await rows("SELECT id, ticket_number, subject, status FROM inbox_tickets WHERE customer_id=$1 AND deleted_at IS NULL AND status NOT IN ('resolved','closed') ORDER BY updated_at DESC LIMIT 10", [id]);
  const addr = [c.address_line_1, c.address_line_2, c.city, c.county, c.postcode].filter(Boolean).join(', ');
  // Password vault on mobile: same gate as desktop (support/admin); metadata only here —
  // secrets are fetched per-entry through the existing logged /credentials/:id/secret route.
  const canVault = await hasVaultAccess(req.session.user!);
  const credentials = canVault ? await rows(
    `SELECT id, name, login_url, username, category, (secret_encrypted IS NOT NULL) AS has_secret
       FROM customer_credentials WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY name`, [id]) : [];
  res.render('mobile/customer', { user: req.session.user!, active: 'customers', c, contacts, tickets, addr, canVault, credentials });
});

// ── Contacts ──────────────────────────────────────────────────────────────────────
router.get('/m/contacts', async (req: Request, res: Response) => {
  const search = String(req.query.q || '').trim();
  const params: any[] = []; let extra = '';
  if (search) { params.push('%' + search + '%'); extra = ` AND (cc.full_name ILIKE $1 OR cc.email ILIKE $1 OR cc.phone ILIKE $1 OR cc.mobile_phone ILIKE $1 OR c.name ILIKE $1)`; }
  const list = await rows(
    `SELECT cc.id, cc.full_name, cc.job_title, cc.phone, cc.mobile_phone, cc.email, c.name AS customer_name, c.id AS customer_id
       FROM customer_contacts cc JOIN customers c ON c.id=cc.customer_id
      WHERE c.deleted_at IS NULL AND c.is_placeholder=false${extra}
      ORDER BY cc.full_name LIMIT 100`, params);
  res.render('mobile/contacts', { user: req.session.user!, active: 'customers', list, search });
});

// ── Support ───────────────────────────────────────────────────────────────────────
router.get('/m/support', async (req: Request, res: Response) => {
  const u = req.session.user!;
  const scope = req.query.scope === 'all' ? 'all' : 'mine';
  const where = scope === 'all'
    ? "t.deleted_at IS NULL AND t.is_spam=false AND t.status NOT IN ('resolved','closed')"
    : "t.deleted_at IS NULL AND t.is_spam=false AND t.assigned_user_id=$1 AND t.status NOT IN ('resolved','closed')";
  const list = await rows(
    `SELECT t.id, t.ticket_number, t.subject, t.status, t.activity_status, c.name AS customer_name
       FROM inbox_tickets t LEFT JOIN customers c ON c.id=t.customer_id
      WHERE ${where} ORDER BY t.updated_at DESC LIMIT 60`, scope === 'all' ? [] : [u.id]);
  res.render('mobile/support', { user: u, active: 'support', list, scope });
});

router.get('/m/support/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const t = (await rows('SELECT t.*, c.name AS customer_name, c.id AS customer_id, c.phone AS customer_phone FROM inbox_tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=$1', [id]))[0];
  if (!t) { res.status(404).render('mobile/notfound', { user: req.session.user!, active: 'support', what: 'Case' }); return; }
  // Requester for the Call button — their direct/mobile number beats the switchboard.
  const requester = t.contact_id
    ? (await rows('SELECT full_name, phone, mobile_phone FROM customer_contacts WHERE id=$1', [t.contact_id]))[0] || null
    : null;
  if (t.description) t.description = richBody(t.description, t.description);   // render the brief richly too
  const msgs = (await rows("SELECT from_name, body_text, body_html, message_direction AS dir, received_at AS at, 'msg' AS kind FROM inbox_messages WHERE ticket_id=$1", [id]))
    .map((m: any) => ({ who: m.from_name || (m.dir === 'outbound' ? 'Us' : 'Customer'), body: m.body_text || stripHtml(m.body_html), html: richBody(m.body_html, m.body_text), at: m.at, kind: 'msg', dir: m.dir }));
  const notes = (await rows("SELECT u.display_name AS who, n.body, n.created_at AS at, 'note' AS kind FROM inbox_notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.ticket_id=$1 AND n.note_type<>'system_log'", [id]))
    .map((n: any) => ({ who: n.who || 'Note', body: n.body, html: richBody(n.body, n.body), at: n.at, kind: 'note', dir: '' }));
  const timeline = msgs.concat(notes).filter((x: any) => x.body).sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime());
  res.render('mobile/support-view', { user: req.session.user!, active: 'support', t, timeline, requester, notice: req.query.msg || null });
});

router.post('/m/support/:id/note', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const body = String(req.body.body || '').trim();
  if (id && body) {
    await pool.query("INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'note',$3)", [id, req.session.user!.id, body]);
    await pool.query('UPDATE inbox_tickets SET updated_at=NOW() WHERE id=$1', [id]);
  }
  res.redirect('/m/support/' + id + '?msg=' + encodeURIComponent('Note added.'));
});

// Upload photo(s) to a case from the mobile app — files onto the case as an update note with the
// images shown inline (and downloadable). Uses the shared attachment store so they appear on the
// desktop ticket feed too.
router.post('/m/support/:id/photo', attachmentUpload.array('photos', 5), async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const { stored } = processAttachments((req as any).files || []);
  if (!id || !stored.length) { res.redirect('/m/support/' + id + '?msg=' + encodeURIComponent('No photo selected.')); return; }
  const esc = (s: string) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
  const cap = String(req.body.note || '').trim();
  const imgs = stored.map((a) => `<div style="margin:6px 0;"><a href="${a.url}" target="_blank"><img src="${a.url}" alt="${esc(a.name)}" style="max-width:100%;border-radius:8px;"></a></div>`).join('');
  const body = (cap ? `<p>${esc(cap)}</p>` : '') + `<p>📷 ${stored.length} photo${stored.length === 1 ? '' : 's'} added from the mobile app</p>` + imgs;
  await pool.query("INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'note',$3)", [id, req.session.user!.id, body]);
  await pool.query('UPDATE inbox_tickets SET updated_at=NOW() WHERE id=$1', [id]);
  await logActivity(req.session.user!.id, 'updated', 'inbox_tickets', id, `Added ${stored.length} photo(s) from mobile`);
  res.redirect('/m/support/' + id + '?msg=' + encodeURIComponent('Photo added to the case.'));
});

router.post('/m/support/:id/status', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const status = String(req.body.status || '').trim();
  if (id && ['open', 'pending', 'resolved'].includes(status)) {
    const closed = status === 'resolved' ? ', closed_at=NOW()' : '';
    await pool.query(`UPDATE inbox_tickets SET status=$1, updated_at=NOW()${closed} WHERE id=$2`, [status, id]);
  }
  res.redirect((status === 'resolved' ? '/m/support' : '/m/support/' + id) + '?msg=' + encodeURIComponent('Case updated.'));
});

// ── Tasks ──────────────────────────────────────────────────────────────────────────
router.get('/m/tasks', async (req: Request, res: Response) => {
  const u = req.session.user!;
  const list = await rows(
    `SELECT id, title, priority, due_date FROM tasks
      WHERE assigned_to_user_id=$1 AND status IN ('open','in_progress')
      ORDER BY (due_date IS NULL), due_date ASC, priority DESC`, [u.id]);
  res.render('mobile/tasks', { user: u, active: 'tasks', list, notice: req.query.msg || null });
});

router.post('/m/tasks/:id/done', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query("UPDATE tasks SET status='done' WHERE id=$1 AND assigned_to_user_id=$2", [id, req.session.user!.id]).catch(() => {});
  res.redirect('/m/tasks?msg=' + encodeURIComponent('Task completed.'));
});

export default router;
