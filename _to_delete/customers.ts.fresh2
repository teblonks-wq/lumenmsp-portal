import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin, requireFinance, hasVaultAccess } from '../middleware/auth';
import { GoCardless } from '../lib/gocardless';
import { pool, insightsPool } from '../db/pool';
import { getComms } from './comms';
import { logActivity } from '../lib/activity';
import { syncCustomerDirectory } from '../lib/dirsync';
import { sendMail } from '../lib/mailer';
import { onboardingEmailHtml } from '../lib/emails';
import { alertGroup } from '../lib/notifications';
import { getSetting, setSetting } from '../lib/settings';
import { accountTotals, cliList, commsAccount, HANDSET_RE, CALL_TYPES, classifyCall, getCallMarkups, allocateNumberRange, commsCallCharge } from '../lib/comms-billing';
import { setSalePrice } from '../lib/service-pricing';
import { config } from '../config';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

// Customer documents — stored PRIVATELY under uploads/customer-docs (not the public static dir),
// and streamed only via the auth-gated /documents/:id/view route below.
const CUSTOMER_DOCS_DIR = path.join(process.cwd(), 'uploads', 'customer-docs');
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(CUSTOMER_DOCS_DIR, { recursive: true }); cb(null, CUSTOMER_DOCS_DIR); },
    filename: (_req, file, cb) => {
      const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

const router = Router();

const STATUSES = ['lead', 'active', 'inactive'];

function normaliseDomain(input: string): string {
  let d = (input || '').trim();
  if (!d) return '';
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/^www\./i, '');
  d = d.replace(/\/.*$/, '');
  return d.toLowerCase();
}

async function generateAccountNumber(name: string): Promise<string> {
  let prefix = (name || '').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase();
  while (prefix.length < 3) prefix += 'X';
  const { rows } = await pool.query('SELECT account_number FROM customers WHERE account_number ILIKE $1', [prefix + '-%']);
  let max = 0;
  for (const r of rows) {
    const num = parseInt((String(r.account_number).split('-')[1] || '0'), 10);
    if (num > max) max = num;
  }
  return prefix + '-' + String(max + 1).padStart(3, '0');
}

const nz = (v: any): string | null => {
  const s = (v ?? '').toString().trim();
  return s !== '' ? s : null;
};
const bool = (v: any): boolean => v === 'on' || v === '1' || v === 'true' || v === true;

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/customers', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const search = ((req.query.search as string) || '').trim();
  const status = ((req.query.status as string) || '').trim();

  const where: string[] = ['c.deleted_at IS NULL', 'c.is_placeholder = false'];
  const params: any[] = [];

  if (search) {
    params.push('%' + search + '%');
    const p = '$' + params.length;
    where.push(`(c.name ILIKE ${p} OR c.account_number ILIKE ${p} OR c.domain ILIKE ${p} OR c.website ILIKE ${p}
      OR EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.customer_id = c.id AND (cc.full_name ILIKE ${p} OR cc.email ILIKE ${p})))`);
  }
  if (status && STATUSES.includes(status)) {
    params.push(status);
    where.push('c.status = $' + params.length);
  }

  const sql = `
    SELECT c.id, c.account_number, c.name, c.status, c.domain, c.phone, c.city, c.county, c.postcode,
           c.is_itsm,
           COALESCE(c.has_internet, false) AS has_internet,
           COALESCE(c.has_phones,   false) AS has_phones,
           COALESCE(c.has_cloud,    false) AS has_cloud,
           (SELECT cc.full_name FROM customer_contacts cc WHERE cc.customer_id = c.id ORDER BY cc.is_primary DESC, cc.id ASC LIMIT 1) AS primary_contact_name,
           (SELECT COUNT(*)::int FROM customer_contacts cc WHERE cc.customer_id = c.id) AS contact_count,
           (SELECT COUNT(*)::int FROM customer_sites cs  WHERE cs.customer_id  = c.id) AS site_count
    FROM customers c
    WHERE ${where.join(' AND ')}
    ORDER BY c.name ASC`;

  const { rows } = await pool.query(sql, params);

  const stat = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM customers WHERE deleted_at IS NULL AND is_placeholder = false GROUP BY status`
  );
  const statusCounts: Record<string, number> = {};
  stat.rows.forEach((r: any) => { statusCounts[r.status] = r.n; });

  res.render('customers/list', { user, customers: rows, search, status, statusCounts });
});

// ── New form ────────────────────────────────────────────────────────────────────
router.get('/customers/new', requireAuth, (req: Request, res: Response) => {
  const q = req.query as any;
  // Pre-fill from a ticket's unknown sender, and remember to link + return to that ticket.
  const prefill = (q.name || q.email || q.domain)
    ? { name: q.name || '', email: q.email || '', domain: q.domain || '' }
    : null;
  res.render('customers/form', {
    user: req.session.user!, customer: prefill, error: null,
    fromTicket: q.from_ticket ? String(q.from_ticket) : '',
    requesterEmail: q.email ? String(q.email) : '',
    requesterName: q.name ? String(q.name) : '',
  });
});

// ── Create ──────────────────────────────────────────────────────────────────────
router.post('/customers', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const b = req.body;
  const name = (b.name || '').trim();
  if (!name) {
    res.render('customers/form', { user, customer: b, error: 'Name is required.' });
    return;
  }
  const status = STATUSES.includes(b.status) ? b.status : 'lead';
  let accountNumber = nz(b.account_number);
  if (!accountNumber) accountNumber = await generateAccountNumber(name);

  const domain = nz(b.domain) ? normaliseDomain(b.domain) : null;

  const { rows } = await pool.query(
    `INSERT INTO customers
       (account_number, name, status, website, domain, phone, email, is_itsm, has_internet, has_phones, has_cloud,
        address_line_1, address_line_2, city, county, postcode, notes, lead_source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id`,
    [
      accountNumber, name, status, nz(b.website), domain, nz(b.phone), nz(b.email),
      bool(b.is_itsm), bool(b.has_internet), bool(b.has_phones), bool(b.has_cloud),
      nz(b.address_line_1), nz(b.address_line_2), nz(b.city), nz(b.county), nz(b.postcode),
      nz(b.notes), nz(b.lead_source), user.id,
    ]
  );

  if (domain) {
    await pool.query(
      `INSERT INTO customer_domains (customer_id, domain, is_primary) VALUES ($1, $2, true)
       ON CONFLICT (customer_id, domain) DO NOTHING`,
      [rows[0].id, domain]
    );
  }

  // Created from a ticket's unknown sender → add the contact, link the case, return to it.
  const fromTicket = parseInt(String(b.from_ticket || ''), 10);
  if (Number.isInteger(fromTicket) && fromTicket > 0) {
    const rEmail = String(b.requester_email || '').toLowerCase().trim();
    const rName = String(b.requester_name || '').trim();
    const protect = b.protect === 'on' || b.protect === 'true';
    let contactId: number | null = null;
    if (rEmail) {
      const ins = await pool.query(
        'INSERT INTO customer_contacts (customer_id, full_name, email, is_primary, protected) VALUES ($1,$2,$3,true,$4) RETURNING id',
        [rows[0].id, (rName || rEmail).slice(0, 180), rEmail, protect]
      );
      contactId = ins.rows[0].id;
    }
    await pool.query('UPDATE inbox_tickets SET customer_id=$1, contact_id=COALESCE($2, contact_id), updated_at=NOW() WHERE id=$3', [rows[0].id, contactId, fromTicket]);
    await pool.query(`INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [fromTicket, user.id, `Created customer ${name} and linked the case (by ${user.displayName})`]);
    res.redirect('/tickets/' + fromTicket + '?msg=' + encodeURIComponent('Created and linked ' + name + '.'));
    return;
  }

  res.redirect('/customers/' + rows[0].id);
});

// ── JSON: customer search (type-ahead) ─────────────────────────────────────────
router.get('/customers/search.json', requireAuth, async (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').trim();
  if (!q) { res.json([]); return; }
  const { rows } = await pool.query(
    `SELECT id, name, account_number, status FROM customers
     WHERE deleted_at IS NULL AND is_placeholder = false AND (name ILIKE $1 OR account_number ILIKE $1)
     ORDER BY name ASC LIMIT 20`, ['%' + q + '%']
  );
  res.json(rows);
});

// ── Data Missing (sheet view) ───────────────────────────────────────────────────
// Reached from the button on the customer list. An editable grid of customers whose
// core record is incomplete — default domain, phone, address, or key contacts — so
// gaps can be filled in bulk without opening each customer. The default-domain rule
// matters doubly now: Marketing → Mass Mailer only emails contacts on it.
router.get('/customers/data-missing', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.account_number, c.name, c.status, c.domain, c.phone,
            c.address_line_1, c.address_line_2, c.city, c.county, c.postcode,
            c.principal_contact_id, c.billing_contact_id, c.service_contact_id,
            COALESCE((SELECT json_agg(json_build_object('id', cc.id, 'full_name', cc.full_name, 'email', cc.email) ORDER BY cc.is_primary DESC, cc.full_name ASC)
              FROM customer_contacts cc WHERE cc.customer_id = c.id AND cc.archived = false), '[]'::json) AS contacts
     FROM customers c
     WHERE c.deleted_at IS NULL AND c.is_placeholder = false
     ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'lead' THEN 1 ELSE 2 END, c.name ASC`
  );
  res.render('customers/data-missing', { user: req.session.user!, customers: rows });
});

// Save one row from the sheet. Domain follows the same rule as the customer page:
// it becomes the DEFAULT domain (customers.domain) and is upserted into
// customer_domains as primary, so Mass Mailer and directory matching agree.
router.post('/customers/data-missing/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const b = req.body as Record<string, any>;
    const cur = await pool.query('SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!cur.rows.length) { res.status(404).json({ ok: false, error: 'Customer not found' }); return; }

    const domain = normaliseDomain(String(b.domain || ''));
    await pool.query(
      `UPDATE customers SET domain=$1, phone=$2, address_line_1=$3, city=$4, county=$5, postcode=$6, updated_at=NOW()
       WHERE id=$7`,
      [domain || null, nz(b.phone), nz(b.address_line_1), nz(b.city), nz(b.county), nz(b.postcode), id]
    );
    if (domain) {
      await pool.query('UPDATE customer_domains SET is_primary = false WHERE customer_id = $1', [id]);
      await pool.query(
        `INSERT INTO customer_domains (customer_id, domain, is_primary) VALUES ($1,$2,true)
         ON CONFLICT (customer_id, domain) DO UPDATE SET is_primary = true`,
        [id, domain]
      );
    }

    // Key contacts — only accept a contact that actually belongs to this customer.
    for (const role of ['principal_contact_id', 'billing_contact_id', 'service_contact_id']) {
      const cid = parseInt(String(b[role] || ''), 10) || null;
      if (cid) {
        const chk = await pool.query('SELECT id FROM customer_contacts WHERE id=$1 AND customer_id=$2', [cid, id]);
        if (!chk.rows.length) continue;
      }
      await pool.query(`UPDATE customers SET ${role}=$1 WHERE id=$2`, [cid, id]);
    }

    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message || 'Save failed' }); }
});

// ── JSON: contacts for a customer ───────────────────────────────────────────────
router.get('/customers/:id/contacts.json', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, mobile_phone, job_title, is_primary
     FROM customer_contacts WHERE customer_id=$1 AND archived=false ORDER BY is_primary DESC, full_name ASC`, [id]
  );
  res.json(rows);
});

// Set a customer's Entra tenant ID (for directory sync).
router.post('/customers/:id/entra-tenant', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const tenant = ((req.body as any).entra_tenant_id || '').trim() || null;
  await pool.query('UPDATE customers SET entra_tenant_id=$1, updated_at=NOW() WHERE id=$2', [tenant, id]);
  res.redirect('/customers/' + id + '#contacts');
});

// Master switch for customer-portal login (the deliberate per-customer "enable access" gate —
// separate from the tenant id, which is just data and may be auto-filled from Giacom).
router.post('/customers/:id/portal-access', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const enabled = String((req.body as any).portal_enabled || '') === 'on';
  await pool.query('UPDATE customers SET portal_enabled=$1, updated_at=NOW() WHERE id=$2', [enabled, id]);
  res.redirect('/customers/' + id + '#contacts');
});

// ── Customer documents (private files; auth-gated). A document = title + description + many files ──
const docInsertFiles = async (docId: number, files: any[]): Promise<void> => {
  for (const f of files || []) {
    await pool.query(
      `INSERT INTO customer_document_files (document_id, file_name, file_path, content_type, file_size) VALUES ($1,$2,$3,$4,$5)`,
      [docId, f.originalname, f.path, f.mimetype || null, f.size || null]
    );
  }
};

// Create a document with one or more files.
router.post('/customers/:id/documents', requireAuth, docUpload.array('files', 20), async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const files = ((req as any).files || []) as any[];
  if (!customerId || !files.length) { res.redirect('/customers/' + customerId + '?err=' + encodeURIComponent('Choose at least one file') + '#documents'); return; }
  const title = (String(req.body.title || '').trim() || files[0]?.originalname || 'Document').slice(0, 200);
  const description = String(req.body.description || '').trim().slice(0, 2000) || null;
  const r = await pool.query(
    `INSERT INTO customer_documents (customer_id, title, description, uploaded_by_user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [customerId, title, description, req.session.user!.id]
  );
  await docInsertFiles(r.rows[0].id, files);
  await logActivity(req.session.user!.id, 'created', 'customer_document', r.rows[0].id, `Uploaded document "${title}" (${files.length} file${files.length > 1 ? 's' : ''})`);
  res.redirect('/customers/' + customerId + '?msg=' + encodeURIComponent('Document uploaded') + '#documents');
});

// Edit a document: update title/description and optionally add more files.
router.post('/customers/:id/documents/:docId/edit', requireAuth, docUpload.array('files', 20), async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const doc = (await pool.query('SELECT id FROM customer_documents WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL', [docId, customerId])).rows[0];
  if (!doc) { res.redirect('/customers/' + customerId + '#documents'); return; }
  const title = (String(req.body.title || '').trim() || 'Document').slice(0, 200);
  const description = String(req.body.description || '').trim().slice(0, 2000) || null;
  await pool.query('UPDATE customer_documents SET title=$1, description=$2, updated_at=NOW() WHERE id=$3', [title, description, docId]);
  const files = ((req as any).files || []) as any[];
  await docInsertFiles(docId, files);
  await logActivity(req.session.user!.id, 'updated', 'customer_document', docId, `Edited document "${title}"${files.length ? ` (+${files.length} file${files.length > 1 ? 's' : ''})` : ''}`);
  res.redirect('/customers/' + customerId + '?msg=' + encodeURIComponent('Document updated') + '#documents');
});

// Stream one file of a document INLINE (auth-gated; ownership-checked). ?dl=1 forces download.
router.get('/customers/:id/documents/:docId/files/:fileId/view', requireAuth, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const fileId = parseInt(String(req.params.fileId), 10);
  const f = (await pool.query(
    `SELECT f.* FROM customer_document_files f JOIN customer_documents d ON d.id=f.document_id
      WHERE f.id=$1 AND f.document_id=$2 AND d.customer_id=$3 AND d.deleted_at IS NULL`, [fileId, docId, customerId])).rows[0];
  if (!f || !fs.existsSync(f.file_path)) { res.status(404).send('Not found'); return; }
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const n = String(f.file_name || '').toLowerCase();
  const ct = /\.pdf$/.test(n) ? 'application/pdf'
    : /\.png$/.test(n) ? 'image/png'
    : /\.(jpe?g)$/.test(n) ? 'image/jpeg'
    : /\.gif$/.test(n) ? 'image/gif'
    : /\.webp$/.test(n) ? 'image/webp'
    : (f.content_type && f.content_type !== 'application/octet-stream' ? f.content_type : 'application/octet-stream');
  res.setHeader('Content-Type', ct);
  const disp = String(req.query.dl) === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', disp + '; filename="' + String(f.file_name || 'document').replace(/[^\w.\-]/g, '_') + '"');
  fs.createReadStream(f.file_path).pipe(res);
});

// Remove a single file from a document (hard delete; the document stays).
router.post('/customers/:id/documents/:docId/files/:fileId/delete', requireAuth, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const fileId = parseInt(String(req.params.fileId), 10);
  const f = (await pool.query(
    `SELECT f.id, f.file_path FROM customer_document_files f JOIN customer_documents d ON d.id=f.document_id
      WHERE f.id=$1 AND f.document_id=$2 AND d.customer_id=$3`, [fileId, docId, customerId])).rows[0];
  if (f) { try { fs.unlinkSync(f.file_path); } catch { /* already gone */ } await pool.query('DELETE FROM customer_document_files WHERE id=$1', [fileId]); }
  res.redirect('/customers/' + customerId + '?msg=' + encodeURIComponent('File removed') + '#documents');
});

// Soft-delete a whole document (and hide its files).
router.post('/customers/:id/documents/:docId/delete', requireAuth, async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const d = (await pool.query('SELECT title FROM customer_documents WHERE id=$1 AND customer_id=$2', [docId, customerId])).rows[0];
  await pool.query('UPDATE customer_documents SET deleted_at=NOW(), deleted_by_user_id=$2 WHERE id=$1 AND customer_id=$3', [docId, req.session.user!.id, customerId]);
  if (d) await logActivity(req.session.user!.id, 'deleted', 'customer_document', docId, `Deleted document "${d.title}"`);
  res.redirect('/customers/' + customerId + '?msg=' + encodeURIComponent('Document deleted') + '#documents');
});

// Sync the customer's Microsoft 365 directory into their contacts.
router.post('/customers/:id/sync-directory', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const r = await syncCustomerDirectory(id);
    res.redirect('/customers/' + id + '?msg=' + encodeURIComponent(`Directory synced: ${r.added} added, ${r.updated} updated, ${r.archived} archived (${r.total} users)`) + '#contacts');
  } catch (e) {
    res.redirect('/customers/' + id + '?err=' + encodeURIComponent('Directory sync failed: ' + (e as Error).message) + '#contacts');
  }
});

// ── Detail (Customer 360) ─────────────────────────────────────────────────────
router.get('/customers/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Customer not found.' }); return; }

  const cRes = await pool.query('SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
  if (cRes.rows.length === 0) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
  const customer = cRes.rows[0];

  const [contactsRes, sitesRes, domainsRes, quotesRes, invoicesRes, contractsRes, reviewRes, serviceItemsRes] = await Promise.all([
    pool.query('SELECT * FROM customer_contacts WHERE customer_id = $1 ORDER BY is_primary DESC, full_name ASC', [id]),
    pool.query('SELECT * FROM customer_sites    WHERE customer_id = $1 ORDER BY is_primary DESC, site_name ASC', [id]),
    pool.query('SELECT * FROM customer_domains  WHERE customer_id = $1 ORDER BY is_primary DESC, domain ASC', [id]),
    pool.query('SELECT id, quote_number, title, status, total FROM quotes WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY id DESC', [id]),
    pool.query(`SELECT i.id, i.invoice_number, i.title, i.status, i.payment_status, i.total, i.balance,
                       i.issue_date, i.due_date, i.payment_synced_at, i.quickbooks_invoice_id, i.gocardless_payment_id,
                       (i.quickbooks_invoice_id IS NOT NULL AND i.created_by IS NULL) AS is_legacy,
                       c.gocardless_mandate_id,
                       EXISTS(SELECT 1 FROM communications cm WHERE cm.entity_type='invoice' AND cm.entity_id=i.id AND cm.direction='outbound') AS emailed
                FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id
                WHERE i.customer_id = $1 AND i.deleted_at IS NULL ORDER BY i.issue_date DESC NULLS LAST, i.id DESC`, [id]),
    pool.query('SELECT id, contract_number, title, status, service_type FROM contracts WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY id DESC', [id]),
    pool.query(`SELECT ri.*, u.display_name AS created_by_name FROM customer_review_items ri LEFT JOIN users u ON u.id=ri.created_by_user_id WHERE ri.customer_id=$1 ORDER BY (ri.status='done'), ri.section, ri.id`, [id]),
    pool.query(`SELECT source, product_id, product_reference, description, quantity, unit_cost, total_cost, billing_date, billing_from, billing_to FROM service_items WHERE customer_id=$1 ORDER BY source, total_cost DESC`, [id]),
  ]);
  const contacts = contactsRes.rows;

  const byId = (cid: number | null) => (cid ? contacts.find((x: any) => x.id === cid) || null : null);
  const keyContacts = {
    principal: byId(customer.principal_contact_id),
    billing:   byId(customer.billing_contact_id),
    service:   byId(customer.service_contact_id),
  };

  const comms = await getComms('customer', id);
  const primaryEmail = contacts.find((c: any) => c.is_primary && c.email)?.email || contacts.find((c: any) => c.email)?.email || customer.email || '';
  // Vault entries — only for support users / admins; metadata only (no secrets).
  const canVault = await hasVaultAccess(user);
  const credentials = canVault ? (await pool.query(
    `SELECT id, name, login_url, username, domain, category, extra_value, note, (secret_encrypted IS NOT NULL) AS has_secret, updated_at
       FROM customer_credentials WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY name`, [id]
  )).rows : [];
  const creditBalance = Number((await pool.query(
    "SELECT COALESCE(SUM(amount),0) AS s FROM customer_credits WHERE customer_id=$1 AND status='open'", [id]
  )).rows[0].s);
  // Customer documents (+ their files). Files are streamed via the auth-gated view route.
  let documents: any[] = [];
  try {
    documents = (await pool.query(
      `SELECT d.id, d.title, d.description, d.created_at, d.updated_at, u.display_name AS uploaded_by
         FROM customer_documents d LEFT JOIN users u ON u.id=d.uploaded_by_user_id
        WHERE d.customer_id=$1 AND d.deleted_at IS NULL ORDER BY d.created_at DESC`, [id]
    )).rows;
    if (documents.length) {
      const fileRows = (await pool.query(
        `SELECT id, document_id, file_name, content_type, file_size FROM customer_document_files WHERE document_id = ANY($1) ORDER BY id`,
        [documents.map((d: any) => d.id)]
      )).rows;
      const byDoc = new Map<number, any[]>();
      for (const f of fileRows) { if (!byDoc.has(f.document_id)) byDoc.set(f.document_id, []); byDoc.get(f.document_id)!.push(f); }
      for (const d of documents) d.files = byDoc.get(d.id) || [];
    }
  } catch { /* customer_documents tables not migrated yet */ }
  // The customer's lead object (if any) — prefer an open one, else the most recent.
  const lead = (await pool.query(
    "SELECT id, status FROM leads WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY (status NOT IN ('won','lost')) DESC, id DESC LIMIT 1", [id]
  )).rows[0] || null;
  // Call history (itemized calls by billing period) — as far back as records exist.
  const callMarkupPct = Number((await getSetting('bureau', 'call_markup_pct')) || '50') || 50;
  let callHistory: any[] = [];
  try {
    callHistory = (await pool.query(
      `SELECT billing_period, COUNT(*)::int AS calls, COALESCE(SUM(cost),0)::numeric AS cost,
              COALESCE(SUM(duration_sec),0)::bigint AS duration
         FROM call_records WHERE customer_id=$1 AND billing_period IS NOT NULL
        GROUP BY billing_period ORDER BY billing_period DESC`, [id]
    )).rows;
  } catch { /* call_records not migrated yet */ }
  // Comms account totals + searchable CLI/Ref list (period-aware, distinct CLIs).
  let commsTotals: any = { period: null, rows: [], cost: 0, sell: 0, profit: 0 };
  let commsClis: any[] = [];
  let commsPkg: any = null;
  let commsHandsets: any[] = [];
  try { commsTotals = await accountTotals(id); commsClis = await cliList(id); commsPkg = await commsAccount(id); } catch { /* comms not imported yet */ }
  // Call-charges total for the current comms period (per-type markup, chargeable calls only).
  let commsCallPeriod: any = null;
  try {
    const sp = (commsPkg && commsPkg.period) || null;
    if (sp) commsCallPeriod = await commsCallCharge(id, sp); // calls = previous month (arrears)
  } catch { /* ignore */ }
  // Durable per-CLI notes (survive imports) — attach to the CLI rows.
  try {
    const refs = commsClis.map((c: any) => String(c.cli).replace(/\s+/g, '')).filter(Boolean);
    if (refs.length) {
      const nmap = new Map((await pool.query(
        "SELECT replace(product_reference,' ','') AS k, note FROM comms_line_notes WHERE replace(product_reference,' ','') = ANY($1)", [refs]
      )).rows.map((r: any) => [String(r.k), r.note]));
      commsClis.forEach((c: any) => { c.note = nmap.get(String(c.cli).replace(/\s+/g, '')) || ''; });
    }
  } catch { /* table not migrated yet */ }
  // Telephony physical assets — the customer's handsets, keyed on the device MAC/ID.
  try {
    commsHandsets = (await pool.query(
      `SELECT DISTINCT ON (product_reference) product_reference AS mac, description AS model, location
         FROM service_items WHERE source='comms' AND customer_id=$1 AND product_reference IS NOT NULL AND description ~* $2
         ORDER BY product_reference, synced_at DESC`, [id, HANDSET_RE.source]
    )).rows;
  } catch { /* ignore */ }
  // Insights (reporting) profile for this customer, bridged by lumenmsp_id → the Reports tab.
  const insights: any = { connected: !!insightsPool, customer: null, sites: [], configs: [], reports: [], error: null };
  if (insightsPool) {
    try {
      const ic = (await insightsPool.query('SELECT id, name, is_internal, last_synced_at, icalls_api_url, icalls_api_token, icalls_api_username FROM customers WHERE lumenmsp_id=$1 AND is_active=true LIMIT 1', [customer.id])).rows[0];
      if (ic) {
        insights.customer = ic;
        const [siteRows, cfgRows, repRows] = await Promise.all([
          insightsPool.query('SELECT id, site_label FROM sites WHERE customer_id=$1 ORDER BY site_label', [ic.id]),
          insightsPool.query('SELECT rc.id, rc.config_label, rc.report_type, s.site_label FROM report_configs rc JOIN sites s ON s.id=rc.site_id WHERE s.customer_id=$1 AND rc.is_active=true ORDER BY rc.config_label', [ic.id]),
          insightsPool.query('SELECT gr.id, gr.report_start, gr.report_end, gr.status, gr.generated_at, gr.created_at, rc.config_label FROM generated_reports gr JOIN report_configs rc ON rc.id=gr.config_id JOIN sites s ON s.id=rc.site_id WHERE s.customer_id=$1 ORDER BY gr.created_at DESC LIMIT 15', [ic.id]),
        ]);
        insights.sites = siteRows.rows; insights.configs = cfgRows.rows; insights.reports = repRows.rows;
      } else {
        // Not linked yet — offer the unlinked Insights profiles to pick from.
        insights.available = (await insightsPool.query('SELECT id, name FROM customers WHERE is_active=true AND lumenmsp_id IS NULL ORDER BY name')).rows;
      }
    } catch (e: any) { insights.error = e.message; }
  }

  // IT & Cloud rate card — UNIFIED with the recurring TEMPLATE: the template's lines (manual +
  // Giacom-locked, already carrying the sell prices) ARE the rate card. itCloudAccount gives the
  // live Giacom cost + any new Giacom services not yet on the template (to pull in).
  let itcloud: any = null; let itcloudTpl: any = null;
  try {
    const { itCloudAccount } = await import('../lib/it-cloud-billing');
    itcloud = await itCloudAccount(customer.id);
    const tpl = (await pool.query(
      "SELECT id, invoice_number, subtotal, total FROM invoices WHERE customer_id=$1 AND is_recurring=true AND invoice_scheme IN ('IT','IC') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [customer.id]
    )).rows[0];
    if (tpl) {
      const items = (await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order, id', [tpl.id])).rows;
      // Giacom products not yet on the template → available to add.
      const onTpl = new Set(items.map((i: any) => (i.sync_ref || String(i.description || '').toLowerCase().replace(/\s+/g, ' ').trim())));
      const avail = (itcloud.cloudLines || []).filter((c: any) => !onTpl.has(String(c.ref || c.description).toLowerCase().replace(/\s+/g, ' ').trim()));
      itcloudTpl = { id: tpl.id, number: tpl.invoice_number, subtotal: Number(tpl.subtotal) || 0, total: Number(tpl.total) || 0, items, available: avail };
    }
  } catch { /* ignore */ }
  let itcloudHistory: any[] = [];
  try { itcloudHistory = (await pool.query("SELECT description, change_type, old_qty, new_qty, detected_at FROM it_cloud_change_log WHERE customer_id=$1 ORDER BY detected_at DESC LIMIT 40", [customer.id])).rows; } catch { /* not migrated */ }

  // Device inventory (Assets tab) — synced from Atera, read-only.
  let assets: any[] = []; let remoteTemplate = '';
  try {
    assets = (await pool.query("SELECT * FROM customer_assets WHERE customer_id=$1 ORDER BY hostname", [customer.id])).rows;
    const { remoteUrlTemplate } = await import('../lib/asset-sync');
    remoteTemplate = await remoteUrlTemplate();
  } catch { /* not migrated yet */ }

  res.render('customers/detail', {
    user, customer, contacts, sites: sitesRes.rows, domains: domainsRes.rows, keyContacts, insights, itcloud, itcloudTpl, itcloudHistory,
    assets, remoteTemplate,
    quotes: quotesRes.rows, invoices: invoicesRes.rows, contracts: contractsRes.rows,
    serviceItems: serviceItemsRes.rows, lead, credentials, canVault, creditBalance, documents,
    comms, commsTo: primaryEmail, graphClientId: config.GRAPH_CLIENT_ID,
    reviewItems: reviewRes.rows, callHistory, callMarkupPct, commsTotals, commsClis, commsPkg, commsHandsets,
    callMarkups: await getCallMarkups(id), callTypes: CALL_TYPES, commsCallPeriod,
    customerRanges: (await pool.query('SELECT * FROM customer_number_ranges WHERE customer_id=$1 ORDER BY range_from', [id])).rows,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// Add a number range to a customer — stores it AND immediately allocates every comms CLI + call
// record in the range to this customer (so existing traffic is attributed at once).
router.post('/customers/:id/number-ranges/add', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const from = String(req.body.from || '').replace(/[^0-9]/g, '');
  const to = (String(req.body.to || '').replace(/[^0-9]/g, '')) || from;
  const location = (req.body.location || '').toString().trim() || null;
  if (!id || !from) { res.redirect('/customers/' + id + '?err=' + encodeURIComponent('Enter at least a from number') + '#comms'); return; }
  await pool.query('INSERT INTO customer_number_ranges (customer_id, range_from, range_to, location) VALUES ($1,$2,$3,$4)', [id, from, to, location]);
  const r = await allocateNumberRange(id, from, to);
  await logActivity(req.session.user!.id, 'updated', 'customers', id, `Added number range ${from}-${to} (${r.lines} line(s), ${r.calls} call(s) attributed)`);
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent(`Range added — ${r.lines} line(s) + ${r.calls} call(s) allocated`) + '#comms');
});

router.post('/customers/:id/number-ranges/:rid/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const rid = parseInt(String(req.params.rid), 10);
  if (id && rid) await pool.query('DELETE FROM customer_number_ranges WHERE id=$1 AND customer_id=$2', [rid, id]);
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Range removed (existing allocations kept)') + '#comms');
});

// Save call-type markups: a global default per type (settings) and/or per-customer overrides.
// A blank/cleared override row deletes it (falls back to global). Markup applies only to
// chargeable calls. Posted from the customer comms tab "Call markup" card.
router.post('/customers/:id/call-markups', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.redirect('/customers'); return; }
  const num = (v: any): number | null => { const s = String(v ?? '').replace(/[^0-9.\-]/g, ''); if (s === '') return null; const n = parseFloat(s); return isNaN(n) ? null : n; };
  for (const t of CALL_TYPES) {
    // Global default (only if a value was supplied in the global column).
    const g = num(req.body['global_' + t.key]);
    if (g != null) await setSetting('comms', 'call_markup_' + t.key, String(g));
    // Per-customer override: value sets/updates it; blank clears it (revert to global).
    const o = num(req.body['cust_' + t.key]);
    if (o == null) {
      await pool.query('DELETE FROM customer_call_markups WHERE customer_id=$1 AND call_type=$2', [id, t.key]);
    } else {
      await pool.query(
        `INSERT INTO customer_call_markups (customer_id, call_type, markup_pct) VALUES ($1,$2,$3)
         ON CONFLICT (customer_id, call_type) DO UPDATE SET markup_pct=EXCLUDED.markup_pct, updated_at=NOW()`,
        [id, t.key, o]
      );
    }
  }
  await logActivity(req.session.user!.id, 'updated', 'customers', id, 'Updated call-type markups');
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Call markups saved') + '#comms');
});

// Itemized call list for a customer (optionally one billing period), HIGHEST-VALUE calls first.
router.get('/customers/:id/calls', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
  const c = (await pool.query('SELECT id, name FROM customers WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!c) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
  const markups = await getCallMarkups(id); // effective % per call type (override else global)
  const typeLabel: Record<string, string> = {}; CALL_TYPES.forEach((t) => { typeLabel[t.key] = t.label; });
  const period = req.query.period != null ? String(req.query.period) : '';
  let periods: string[] = []; let calls: any[] = [];
  try {
    periods = (await pool.query(
      "SELECT DISTINCT billing_period AS p FROM call_records WHERE customer_id=$1 AND billing_period IS NOT NULL ORDER BY billing_period DESC", [id]
    )).rows.map((r: any) => r.p);
    calls = (await pool.query(
      `SELECT call_at, dialled, description, duration_sec, cost, cli, source, billing_period
         FROM call_records WHERE customer_id=$1 AND ($2='' OR billing_period=$2)
        ORDER BY cost DESC, duration_sec DESC, call_at DESC LIMIT 10000`, [id, period]
    )).rows;
    // Per-call sell = cost × (1 + the effective markup for its call type). £0 calls stay £0.
    for (const c2 of calls) {
      const t = classifyCall(c2.description, c2.dialled, { cli: c2.cli, source: c2.source });
      const cost = Number(c2.cost) || 0;
      c2.call_type = t; c2.call_type_label = typeLabel[t]; c2.markup_pct = markups.effective[t] || 0;
      c2.sell = cost > 0 ? cost * (1 + (markups.effective[t] || 0) / 100) : 0;
    }
  } catch { /* call_records not migrated yet */ }
  // Page insights — volume over time (per day within one period, per month across all),
  // sell by call type, and the top 5 CLIs by call count. Small pre-aggregated arrays so
  // the view can draw its charts without shipping the raw rows twice.
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const byBucket = new Map<string, { k: string; n: number; secs: number; sell: number }>();
  const byType = new Map<string, { label: string; n: number; sell: number }>();
  const byCli = new Map<string, { cli: string; n: number; secs: number; sell: number }>();
  for (const c2 of calls) {
    let k = '';
    if (period) { const d = c2.call_at ? new Date(c2.call_at) : null; k = d && !isNaN(d.getTime()) ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : ''; }
    else { k = c2.billing_period || ''; }
    if (k) { const b = byBucket.get(k) || { k, n: 0, secs: 0, sell: 0 }; b.n++; b.secs += Number(c2.duration_sec) || 0; b.sell += Number(c2.sell) || 0; byBucket.set(k, b); }
    const tl = c2.call_type_label || 'Other';
    const t = byType.get(tl) || { label: tl, n: 0, sell: 0 }; t.n++; t.sell += Number(c2.sell) || 0; byType.set(tl, t);
    const cliKey = String(c2.cli || '').trim() || '(no CLI)';
    const cl = byCli.get(cliKey) || { cli: cliKey, n: 0, secs: 0, sell: 0 }; cl.n++; cl.secs += Number(c2.duration_sec) || 0; cl.sell += Number(c2.sell) || 0; byCli.set(cliKey, cl);
  }
  const stats = {
    byBucket: [...byBucket.values()].sort((a, b) => (a.k < b.k ? -1 : 1)),
    bucketLabel: period ? 'day' : 'month',
    byType: [...byType.values()].sort((a, b) => b.sell - a.sell),
    topClis: [...byCli.values()].sort((a, b) => b.n - a.n).slice(0, 5),
  };
  res.render('customers/calls', { user: req.session.user!, customer: c, calls, periods, period, markups, stats });
});

// CSV export of the itemised calls — same data and period filter as the page, oldest first.
router.get('/customers/:id/calls.csv', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).send('Not found'); return; }
  const c = (await pool.query('SELECT id, name FROM customers WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!c) { res.status(404).send('Not found'); return; }
  const markups = await getCallMarkups(id);
  const typeLabel: Record<string, string> = {}; CALL_TYPES.forEach((t) => { typeLabel[t.key] = t.label; });
  const period = req.query.period != null ? String(req.query.period) : '';
  let calls: any[] = [];
  try {
    calls = (await pool.query(
      `SELECT call_at, dialled, description, duration_sec, cost, cli, source, billing_period
         FROM call_records WHERE customer_id=$1 AND ($2='' OR billing_period=$2)
        ORDER BY call_at ASC, cost DESC LIMIT 50000`, [id, period]
    )).rows;
  } catch { /* call_records not migrated yet */ }
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = ['When,CLI,Dialled,Description,Type,Markup %,Duration (sec),Cost,Sell,Billing period'];
  for (const r2 of calls) {
    const t = classifyCall(r2.description, r2.dialled, { cli: r2.cli, source: r2.source });
    const cost = Number(r2.cost) || 0;
    const sell = cost > 0 ? cost * (1 + (markups.effective[t] || 0) / 100) : 0;
    const d = r2.call_at ? new Date(r2.call_at) : null;
    const when = d && !isNaN(d.getTime()) ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
    lines.push([when, r2.cli || '', r2.dialled || '', r2.description || '', typeLabel[t] || t, markups.effective[t] || 0,
      Number(r2.duration_sec) || 0, cost.toFixed(4), sell.toFixed(4), r2.billing_period || ''].map(esc).join(','));
  }
  const fname = (String(c.name || 'customer').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'customer')
    + '-calls' + (period ? '-' + period : '') + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send('\ufeff' + lines.join('\r\n')); // BOM so Excel reads it as UTF-8
});

// Save/clear a durable note on a comms CLI/ref (survives imports) — e.g. "line rental ceasing".
router.post('/customers/:id/cli-note', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  const note = (req.body.note || '').toString().trim();
  if (id && cli) {
    if (note) {
      await pool.query(
        `INSERT INTO comms_line_notes (customer_id, product_reference, note, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_reference) DO UPDATE SET note=EXCLUDED.note, customer_id=EXCLUDED.customer_id, updated_at=NOW()`,
        [id, cli, note, req.session.user!.id]
      );
    } else {
      await pool.query("DELETE FROM comms_line_notes WHERE replace(product_reference,' ','')=$1", [cli]);
    }
  }
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Note saved') + '#comms');
});

// Label a comms CLI/circuit with a location (e.g. the broadband site/office).
router.post('/customers/:id/cli-location', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  const location = (req.body.location || '').toString().trim() || null;
  if (cli) await pool.query("UPDATE service_items SET location=$1 WHERE source='comms' AND customer_id=$2 AND replace(product_reference,' ','')=$3", [location, id, cli]);
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Location updated') + '#comms');
});

// Set the sale price for a comms item on the customer's Comms account page. ref is the pricing
// key the engine reads: 'SEAT', 'FEATURE_PACK', 'REC' (call recording), a circuit ref (broadband),
// 'LR:<cli>' (line rental) or 'MOB:<cli>' (mobile). unit_cost ties the row to the right buy tier.
router.post('/customers/:id/comms-price', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const ref = String(req.body.ref || '').trim();
  const unitCost = parseFloat(String(req.body.unit_cost || '0').replace(/[^0-9.\-]/g, ''));
  const salePrice = parseFloat(String(req.body.sale_price || '').replace(/[^0-9.\-]/g, ''));
  if (id && ref && !isNaN(salePrice)) {
    await setSalePrice({ source: 'comms', customerId: id, productReference: ref, description: (req.body.description || '').toString().trim() || null, unitCost: isNaN(unitCost) ? 0 : unitCost, salePrice });
    await logActivity(req.session.user!.id, 'updated', 'customers', id, `Comms: set price ${salePrice} for ${ref}`);
  }
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Price updated') + '#comms');
});

// IT & Cloud rate card: set the SELL price for a Giacom product.
//   scope=global   → the GLOBAL catalogue price (asset_products.unit_price by code) — applies to all.
//   scope=customer → a per-customer override (service_pricing).
router.post('/customers/:id/cloud-price', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const ref = String(req.body.ref || '').trim();
  const unitCost = parseFloat(String(req.body.unit_cost || '0').replace(/[^0-9.\-]/g, ''));
  const salePrice = parseFloat(String(req.body.sale_price || '').replace(/[^0-9.\-]/g, ''));
  const scope = String(req.body.scope || 'customer');
  let note = 'Sell price updated';
  if (id && ref && !isNaN(salePrice)) {
    if (scope === 'global') {
      const r = await pool.query("UPDATE asset_products SET unit_price=$1, updated_at=NOW() WHERE source_tag='giacom' AND lower(code)=lower($2)", [salePrice, ref]);
      if (!r.rowCount) {
        await pool.query(
          `INSERT INTO asset_products (name, code, item_type, billing_frequency, unit_price, cost_price, supplier, source_tag, vat_rate, is_active)
           VALUES ($1,$2,'service','monthly',$3,$4,'Giacom','giacom',20,true)`,
          [(req.body.description || ref).toString().trim(), ref, salePrice, isNaN(unitCost) ? 0 : unitCost]
        );
      }
      note = 'Standard (global) price updated';
      await logActivity(req.session.user!.id, 'updated', 'customers', id, `IT&Cloud: set GLOBAL sell ${salePrice} for ${ref}`);
    } else {
      await setSalePrice({ source: 'giacom', customerId: id, productReference: ref || null, description: (req.body.description || '').toString().trim() || null, unitCost: isNaN(unitCost) ? 0 : unitCost, salePrice });
      note = 'Customer override saved';
      await logActivity(req.session.user!.id, 'updated', 'customers', id, `IT&Cloud: set sell ${salePrice} for ${ref || '(no ref)'}`);
    }
  }
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent(note) + '#cloud');
});

// ── Unified IT&Cloud rate card = the recurring template. These edit the template's invoice_items. ──
async function recomputeTemplate(invoiceId: number): Promise<void> {
  await pool.query(
    `UPDATE invoices SET
       subtotal=(SELECT COALESCE(SUM(line_total),0) FROM invoice_items WHERE invoice_id=$1),
       tax_total=(SELECT COALESCE(SUM(line_total*tax_rate/100),0) FROM invoice_items WHERE invoice_id=$1),
       total=(SELECT COALESCE(SUM(line_total*(1+tax_rate/100)),0) FROM invoice_items WHERE invoice_id=$1),
       updated_at=NOW() WHERE id=$1`, [invoiceId]);
}
async function customerTemplateId(customerId: number): Promise<number | null> {
  const r = (await pool.query(
    "SELECT id FROM invoices WHERE customer_id=$1 AND is_recurring=true AND invoice_scheme IN ('IT','IC') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [customerId]
  )).rows[0];
  return r ? r.id : null;
}

// Create an empty recurring IT&Cloud template for a customer that has none.
router.post('/customers/:id/cloud-template/create', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    if (await customerTemplateId(id)) { res.redirect('/customers/' + id + '#cloud'); return; }
    const { nextInvoiceNumber } = await import('../lib/recurring-billing');
    // Retry on the (rare) race where two creates grab the same number.
    let done = false;
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      const number = await nextInvoiceNumber('IC');
      try {
        await pool.query(
          `INSERT INTO invoices (customer_id, invoice_number, invoice_scheme, title, status, payment_status, issue_date, due_date, currency_code, subtotal, tax_total, total, is_recurring, recurring_active, created_by)
           VALUES ($1,$2,'IC','IT & Cloud (template)','draft','unpaid',NOW(),NOW(),'GBP',0,0,0,true,true,$3)`, [id, number, req.session.user!.id]
        );
        done = true;
      } catch (e: any) { if (e && e.code === '23505') continue; throw e; } // duplicate number → try next
    }
    if (!done) throw new Error('could not allocate an invoice number');
    res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Template created — add your services') + '#cloud');
  } catch (e: any) {
    res.redirect('/customers/' + id + '?err=' + encodeURIComponent('Create failed: ' + (e.message || 'error')) + '#cloud');
  }
});

// Delete (recycle) a customer's IT & Cloud template. Soft-delete via deleted_at so it can be restored,
// and it drops out of every billing query. Warned in the UI when the customer has synced Giacom services
// (their cloud lines would no longer roll up onto a consolidated bill). Staged period drafts are left
// alone — recycle those separately if wanted.
router.post('/customers/:id/cloud-template/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  try {
    const tplId = await customerTemplateId(id);
    if (!tplId) { res.redirect('/customers/' + id + '#cloud'); return; }
    await pool.query(
      'UPDATE invoices SET deleted_at=NOW(), recurring_active=false, updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL',
      [tplId]
    );
    try { await logActivity(req.session.user!.id, 'deleted', 'customers', id, `Recycled IT & Cloud template #${tplId}`); } catch { /* activity optional */ }
    res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Template deleted (recycled) — it can be restored from the recycle bin') + '#cloud');
  } catch (e: any) {
    res.redirect('/customers/' + id + '?err=' + encodeURIComponent('Delete failed: ' + (e.message || 'error')) + '#cloud');
  }
});

// Update one template line (sell price, qty, description). Editing a Giacom line locks the override.
router.post('/customers/:id/cloud-line', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const itemId = parseInt(String(req.body.item_id), 10);
  const tplId = await customerTemplateId(id);
  if (!tplId || !itemId) { res.redirect('/customers/' + id + '#cloud'); return; }
  const it = (await pool.query('SELECT * FROM invoice_items WHERE id=$1 AND invoice_id=$2', [itemId, tplId])).rows[0];
  if (!it) { res.redirect('/customers/' + id + '#cloud'); return; }
  const num = (v: any, d: number) => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? d : x; };
  const price = num(req.body.sale_price, Number(it.unit_price) || 0);
  const qty = num(req.body.qty, Number(it.quantity) || 1);
  const desc = (req.body.description != null && String(req.body.description).trim()) ? String(req.body.description).trim() : it.description;
  const lockGiacom = it.source === 'giacom';
  await pool.query(
    'UPDATE invoice_items SET unit_price=$1, quantity=$2, description=$3, line_total=$4, sync_locked=CASE WHEN source=$6 THEN true ELSE sync_locked END WHERE id=$5',
    [price.toFixed(2), qty, desc, (price * qty).toFixed(2), itemId, lockGiacom ? 'giacom' : '__none__']
  );
  await recomputeTemplate(tplId);
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Rate card updated') + '#cloud');
});

// Add a non-Giacom / other-vendor service line to the template.
router.post('/customers/:id/cloud-line/add', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  let tplId = await customerTemplateId(id);
  if (!tplId) { res.redirect('/customers/' + id + '?err=' + encodeURIComponent('Create a template first') + '#cloud'); return; }
  const num = (v: any, d: number) => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? d : x; };
  const desc = String(req.body.description || '').trim();
  if (!desc) { res.redirect('/customers/' + id + '#cloud'); return; }
  const qty = num(req.body.qty, 1); const price = num(req.body.sale_price, 0);
  // Link to a catalogue product (so it carries a QuickBooks item + reporting category). If picked,
  // its name/price seed the line when not overridden.
  const productId = req.body.product_id ? (parseInt(String(req.body.product_id), 10) || null) : null;
  const sort = ((await pool.query('SELECT COALESCE(MAX(sort_order),0) m FROM invoice_items WHERE invoice_id=$1', [tplId])).rows[0].m || 0) + 1;
  await pool.query(
    `INSERT INTO invoice_items (invoice_id, product_id, source, sort_order, description, quantity, unit_price, tax_rate, line_total)
     VALUES ($1,$2,'manual',$3,$4,$5,$6,20,$7)`, [tplId, productId, sort, desc, qty, price.toFixed(2), (price * qty).toFixed(2)]
  );
  await recomputeTemplate(tplId);
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Service added') + '#cloud');
});

// Pull a Giacom service that isn't on the template yet onto it.
router.post('/customers/:id/cloud-line/pull', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const tplId = await customerTemplateId(id);
  if (!tplId) { res.redirect('/customers/' + id + '#cloud'); return; }
  const num = (v: any, d: number) => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(x) ? d : x; };
  const desc = String(req.body.description || 'Cloud service').trim();
  const ref = String(req.body.ref || '').trim() || null;
  const qty = num(req.body.qty, 1); const price = num(req.body.sale_price, 0);
  const key = (ref || desc).toLowerCase().replace(/\s+/g, ' ').trim();
  const sort = ((await pool.query('SELECT COALESCE(MAX(sort_order),0) m FROM invoice_items WHERE invoice_id=$1', [tplId])).rows[0].m || 0) + 1;
  await pool.query(
    `INSERT INTO invoice_items (invoice_id, source, invoice_category, sort_order, description, quantity, unit_price, tax_rate, line_total, sync_ref)
     VALUES ($1,'giacom','cloud',$2,$3,$4,$5,20,$6,$7)`, [tplId, sort, desc + (ref ? ' (' + ref + ')' : ''), qty, price.toFixed(2), (price * qty).toFixed(2), key]
  );
  await recomputeTemplate(tplId);
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Giacom service added to rate card') + '#cloud');
});

// Remove a template line.
router.post('/customers/:id/cloud-line/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const itemId = parseInt(String(req.body.item_id), 10);
  const tplId = await customerTemplateId(id);
  if (tplId && itemId) { await pool.query('DELETE FROM invoice_items WHERE id=$1 AND invoice_id=$2', [itemId, tplId]); await recomputeTemplate(tplId); }
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Line removed') + '#cloud');
});

// Release a CLI/circuit from this customer — unallocate it so it reappears in the Bureau's
// unallocated list for re-allocation. Clears the directory entry + the customer link on its
// service lines and call records (the underlying Giacom lines stay; they just lose their owner).
router.post('/customers/:id/cli-release', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  if (id && cli) {
    await pool.query("DELETE FROM customer_external_ids WHERE source_system='cli' AND replace(external_id,' ','')=$1 AND customer_id=$2", [cli, id]);
    const s = await pool.query("UPDATE service_items SET customer_id=NULL WHERE source='comms' AND customer_id=$1 AND replace(product_reference,' ','')=$2", [id, cli]);
    try { await pool.query("UPDATE call_records SET customer_id=NULL WHERE customer_id=$1 AND replace(cli,' ','')=$2", [id, cli]); } catch { /* ignore */ }
    await logActivity(req.session.user!.id, 'updated', 'customers', id, `Comms: released CLI ${cli} (${s.rowCount} line(s)) — now unallocated`);
  }
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('CLI ' + cli + ' released — allocate it in the Bureau') + '#comms');
});

// Assign / reassign a CLI to THIS customer (the customer-side counterpart to cli-release, and
// where unaccounted/orphaned CLIs get re-homed). Re-points the comms lines + call records and
// upserts the CLI directory entry, regardless of any previous (e.g. deleted) owner.
router.post('/customers/:id/cli-assign', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cli = String(req.body.cli || '').replace(/\s+/g, '');
  if (id && cli) {
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'cli',$2)
       ON CONFLICT (source_system, external_id) DO UPDATE SET customer_id=EXCLUDED.customer_id`, [id, cli]
    );
    const s = await pool.query("UPDATE service_items SET customer_id=$1 WHERE source='comms' AND replace(product_reference,' ','')=$2", [id, cli]);
    try { await pool.query("UPDATE call_records SET customer_id=$1 WHERE replace(cli,' ','')=$2", [id, cli]); } catch { /* ignore */ }
    await logActivity(req.session.user!.id, 'updated', 'customers', id, `Comms: assigned CLI ${cli} (${s.rowCount} line(s)) to this customer`);
  }
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('CLI ' + cli + ' assigned to this customer') + '#comms');
});

// ── Edit form ─────────────────────────────────────────────────────────────────
router.get('/customers/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
  if (rows.length === 0) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
  res.render('customers/form', { user, customer: rows[0], error: null });
});

// ── Update ──────────────────────────────────────────────────────────────────────
router.post('/customers/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const name = (b.name || '').trim();
  if (!name) {
    res.render('customers/form', { user, customer: { ...b, id }, error: 'Name is required.' });
    return;
  }
  const status = STATUSES.includes(b.status) ? b.status : 'lead';
  const domain = nz(b.domain) ? normaliseDomain(b.domain) : null;

  await pool.query(
    `UPDATE customers SET
       account_number=$1, name=$2, status=$3, website=$4, domain=$5, phone=$6, email=$7,
       is_itsm=$8, has_internet=$9, has_phones=$10, has_cloud=$11,
       address_line_1=$12, address_line_2=$13, city=$14, county=$15, postcode=$16,
       notes=$17, lead_source=$18, updated_at=NOW()
     WHERE id=$19 AND deleted_at IS NULL`,
    [
      nz(b.account_number), name, status, nz(b.website), domain, nz(b.phone), nz(b.email),
      bool(b.is_itsm), bool(b.has_internet), bool(b.has_phones), bool(b.has_cloud),
      nz(b.address_line_1), nz(b.address_line_2), nz(b.city), nz(b.county), nz(b.postcode),
      nz(b.notes), nz(b.lead_source), id,
    ]
  );

  res.redirect('/customers/' + id);
});

// ── Soft delete ───────────────────────────────────────────────────────────────
router.post('/customers/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE customers SET deleted_at = NOW(), deleted_by_user_id = $1 WHERE id = $2', [user.id, id]);
  await logActivity(user.id, 'deleted', 'customers', id, 'Deleted customer #' + id);
  res.redirect('/customers');
});

// ── Contacts ────────────────────────────────────────────────────────────────────
router.post('/customers/:id/contacts', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const fullName = (b.full_name || '').trim();
  if (fullName) {
    if (bool(b.is_primary)) await pool.query('UPDATE customer_contacts SET is_primary = false WHERE customer_id = $1', [id]);
    await pool.query(
      `INSERT INTO customer_contacts (customer_id, full_name, email, phone, mobile_phone, job_title, department, is_primary, is_third_party)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, fullName, nz(b.email), nz(b.phone), nz(b.mobile_phone), nz(b.job_title), nz(b.department), bool(b.is_primary), bool(b.is_third_party)]
    );
  }
  res.redirect('/customers/' + id + '#contacts');
});

// Quick-add a contact from just an email (used by the composer "Add" button on the
// "not a contact" warning). Derives a tidy name from the address; idempotent.
router.post('/customers/:id/contacts/quick.json', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!id || !email || !email.includes('@')) { res.status(400).json({ ok: false, error: 'Bad request' }); return; }
  const found = await pool.query('SELECT id, full_name FROM customer_contacts WHERE customer_id=$1 AND lower(email)=lower($2) LIMIT 1', [id, email]);
  if (found.rows.length) { res.json({ ok: true, id: found.rows[0].id, name: found.rows[0].full_name, email }); return; }
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  const name = (local.replace(/\b\w/g, (c) => c.toUpperCase()) || email).slice(0, 180);
  const hasPrimary = await pool.query('SELECT 1 FROM customer_contacts WHERE customer_id=$1 AND is_primary=true LIMIT 1', [id]);
  const ins = await pool.query(
    'INSERT INTO customer_contacts (customer_id, full_name, email, is_primary) VALUES ($1,$2,$3,$4) RETURNING id',
    [id, name, email, hasPrimary.rows.length === 0]
  );
  res.json({ ok: true, id: ins.rows[0].id, name, email });
});

router.post('/customers/:id/contacts/:cid', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cid = parseInt(String(req.params.cid), 10);
  const b = req.body;
  await pool.query(
    `UPDATE customer_contacts SET full_name=$1, email=$2, phone=$3, mobile_phone=$4, job_title=$5, department=$6, is_third_party=$7, protected=$8, updated_at=NOW()
     WHERE id=$9 AND customer_id=$10`,
    [(b.full_name || '').trim(), nz(b.email), nz(b.phone), nz(b.mobile_phone), nz(b.job_title), nz(b.department), bool(b.is_third_party), bool(b.protected), cid, id]
  );
  const back = typeof b.return === 'string' && b.return.startsWith('/contacts/') ? b.return : '/customers/' + id + '#contacts';
  res.redirect(back);
});

router.post('/customers/:id/contacts/:cid/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cid = parseInt(String(req.params.cid), 10);
  await pool.query('DELETE FROM customer_contacts WHERE id=$1 AND customer_id=$2', [cid, id]);
  await pool.query(
    `UPDATE customers SET principal_contact_id = CASE WHEN principal_contact_id=$1 THEN NULL ELSE principal_contact_id END,
       billing_contact_id = CASE WHEN billing_contact_id=$1 THEN NULL ELSE billing_contact_id END,
       service_contact_id = CASE WHEN service_contact_id=$1 THEN NULL ELSE service_contact_id END WHERE id=$2`,
    [cid, id]
  );
  res.redirect('/customers/' + id + '#contacts');
});

router.post('/customers/:id/contacts/:cid/primary', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cid = parseInt(String(req.params.cid), 10);
  await pool.query('UPDATE customer_contacts SET is_primary = false WHERE customer_id = $1', [id]);
  await pool.query('UPDATE customer_contacts SET is_primary = true WHERE id = $1 AND customer_id = $2', [cid, id]);
  res.redirect('/customers/' + id + '#contacts');
});

router.post('/customers/:id/key-contact', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const role = String(req.body.role || '');
  const cid = parseInt(String(req.body.contact_id || ''), 10);
  const allowed = ['principal_contact_id', 'billing_contact_id', 'service_contact_id'];
  if (allowed.includes(role)) {
    await pool.query(`UPDATE customers SET ${role} = $1 WHERE id = $2`, [cid || null, id]);
  }
  res.redirect('/customers/' + id);
});

// Set one contact into ALL key-contact roles (principal + billing + service) at once — for
// single-contact customers. Also clears the billing-contact gate that blocks invoice generation.
router.post('/customers/:id/key-contact-all', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const cid = parseInt(String(req.body.contact_id || ''), 10) || null;
  if (cid) {
    await pool.query(
      'UPDATE customers SET principal_contact_id=$1, billing_contact_id=$1, service_contact_id=$1 WHERE id=$2',
      [cid, id]
    );
  }
  res.redirect('/customers/' + id);
});

// ── Onboarding ───────────────────────────────────────────────────────────────────
const asArray = (v: any): any[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

// Email the customer a secure onboarding-form link.
router.post('/customers/:id/onboarding/send', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const c = await pool.query('SELECT id, name FROM customers WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!c.rows.length) { res.status(404).render('error', { message: 'Customer not found.' }); return; }

  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    "UPDATE customers SET onboarding_token=COALESCE(onboarding_token,$1), onboarding_status='sent', onboarding_sent_at=NOW() WHERE id=$2",
    [token, id]
  );
  const tk = (await pool.query('SELECT onboarding_token FROM customers WHERE id=$1', [id])).rows[0].onboarding_token;
  const link = config.APP_URL + '/onboard/' + tk;

  // Recipient: chosen address, else the primary contact.
  let to = nz(req.body.send_to) || '';
  let toName = '';
  if (!to) {
    const pc = await pool.query("SELECT full_name, email FROM customer_contacts WHERE customer_id=$1 AND email IS NOT NULL AND email<>'' ORDER BY is_primary DESC, id LIMIT 1", [id]);
    if (pc.rows[0]) { to = pc.rows[0].email; toName = pc.rows[0].full_name || ''; }
  }
  if (!to) { res.redirect('/customers/' + id + '?err=' + encodeURIComponent('No contact email to send the onboarding form to.') + '#onboarding'); return; }

  try {
    await sendMail({ to, subject: `Onboarding — ${c.rows[0].name}`, html: onboardingEmailHtml({ contactName: toName, customerName: c.rows[0].name, link }), signatureName: user.displayName });
    await logActivity(user.id, 'updated', 'customers', id, `Onboarding form sent to ${to}`);
    res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Onboarding form sent to ' + to) + '#onboarding');
  } catch (e: any) {
    res.redirect('/customers/' + id + '?err=' + encodeURIComponent('Send failed: ' + (e.message || 'mail not configured')) + '#onboarding');
  }
});

// Public onboarding form (no auth — accessed by the customer via token).
router.get('/onboard/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const r = await pool.query('SELECT * FROM customers WHERE onboarding_token=$1 AND deleted_at IS NULL LIMIT 1', [token]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'This onboarding link is not valid.' }); return; }
  const c = r.rows[0];
  res.render('onboard', { customer: c, token, done: c.onboarding_status === 'applied' });
});

router.post('/onboard/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const r = await pool.query('SELECT id, name FROM customers WHERE onboarding_token=$1 AND deleted_at IS NULL LIMIT 1', [token]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'This onboarding link is not valid.' }); return; }
  const id = r.rows[0].id;
  const b = req.body;
  const sameBill = bool(b.bill_same);
  const role = (p: string) => ({ name: nz(b[p + '_name']), email: nz(b[p + '_email']), phone: nz(b[p + '_phone']) });
  const data = {
    legal_name: nz(b.legal_name), company_number: nz(b.company_number), vat_number: nz(b.vat_number),
    reg: { line1: nz(b.reg_line1), line2: nz(b.reg_line2), city: nz(b.reg_city), county: nz(b.reg_county), postcode: nz(b.reg_postcode) },
    billing: sameBill ? 'same' : { line1: nz(b.bill_line1), line2: nz(b.bill_line2), city: nz(b.bill_city), county: nz(b.bill_county), postcode: nz(b.bill_postcode) },
    contacts: { finance: role('finance'), lead: role('lead'), service: role('service') },
    sites: asArray(b.site_name).map((n: any, i: number) => ({ name: nz(n), address: nz(asArray(b.site_address)[i]) })).filter((s: any) => s.name),
  };
  await pool.query(
    "UPDATE customers SET onboarding_data=$1, onboarding_status='submitted', onboarding_submitted_at=NOW() WHERE id=$2",
    [JSON.stringify(data), id]
  );
  await alertGroup('support', 'Onboarding submitted — ' + r.rows[0].name, 'Review & apply the onboarding details', '/customers/' + id + '#onboarding');
  res.render('onboard', { customer: null, token, done: true });
});

// Apply the submitted onboarding data to the customer record (staff review step).
router.post('/customers/:id/onboarding/apply', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT onboarding_data FROM customers WHERE id=$1 AND deleted_at IS NULL', [id]);
  const d: any = r.rows[0]?.onboarding_data;
  if (!d) { res.redirect('/customers/' + id + '?err=' + encodeURIComponent('No onboarding submission to apply.') + '#onboarding'); return; }

  const reg = d.reg || {};
  const bill = d.billing === 'same' ? reg : (d.billing || {});
  await pool.query(
    `UPDATE customers SET
       legal_name=COALESCE($1, legal_name), company_number=COALESCE($2, company_number), vat_number=COALESCE($3, vat_number),
       address_line_1=COALESCE($4, address_line_1), address_line_2=COALESCE($5, address_line_2),
       city=COALESCE($6, city), county=COALESCE($7, county), postcode=COALESCE($8, postcode),
       billing_address_line_1=$9, billing_address_line_2=$10, billing_city=$11, billing_county=$12, billing_postcode=$13,
       onboarding_status='applied', updated_at=NOW()
     WHERE id=$14`,
    [d.legal_name, d.company_number, d.vat_number,
     reg.line1, reg.line2, reg.city, reg.county, reg.postcode,
     bill.line1 || null, bill.line2 || null, bill.city || null, bill.county || null, bill.postcode || null, id]
  );

  // Contacts → find-or-create by email, then set the role on the customer.
  const roleField: Record<string, string> = { finance: 'billing_contact_id', lead: 'principal_contact_id', service: 'service_contact_id' };
  for (const role of ['finance', 'lead', 'service']) {
    const c = (d.contacts || {})[role];
    if (!c || !c.name) continue;
    let cid: number | null = null;
    if (c.email) {
      const ex = await pool.query('SELECT id FROM customer_contacts WHERE customer_id=$1 AND lower(email)=lower($2) LIMIT 1', [id, c.email]);
      if (ex.rows.length) {
        cid = ex.rows[0].id;
        await pool.query('UPDATE customer_contacts SET full_name=$1, phone=COALESCE($2,phone), updated_at=NOW() WHERE id=$3', [c.name, c.phone, cid]);
      }
    }
    if (!cid) {
      const ins = await pool.query(
        'INSERT INTO customer_contacts (customer_id, full_name, email, phone) VALUES ($1,$2,$3,$4) RETURNING id',
        [id, c.name, c.email, c.phone]
      );
      cid = ins.rows[0].id;
    }
    await pool.query(`UPDATE customers SET ${roleField[role]}=$1 WHERE id=$2`, [cid, id]);
  }

  // Sites
  for (const s of (d.sites || [])) {
    if (!s.name) continue;
    await pool.query(
      'INSERT INTO customer_sites (customer_id, site_name, address_line_1, city) VALUES ($1,$2,$3,$4)',
      [id, s.name, s.address || null, null]
    );
  }

  await logActivity(user.id, 'updated', 'customers', id, 'Applied onboarding submission');
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Onboarding details applied') + '#contacts');
});

// ── Sites ───────────────────────────────────────────────────────────────────────
router.post('/customers/:id/sites', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body;
  const siteName = (b.site_name || '').trim();
  if (siteName) {
    if (bool(b.is_primary)) await pool.query('UPDATE customer_sites SET is_primary = false WHERE customer_id = $1', [id]);
    await pool.query(
      `INSERT INTO customer_sites (customer_id, site_name, address_line_1, address_line_2, city, county, postcode, site_phone, site_email, notes, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, siteName, nz(b.address_line_1), nz(b.address_line_2), nz(b.city), nz(b.county), nz(b.postcode), nz(b.site_phone), nz(b.site_email), nz(b.notes), bool(b.is_primary)]
    );
  }
  res.redirect('/customers/' + id + '#sites');
});

router.post('/customers/:id/sites/:sid/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const sid = parseInt(String(req.params.sid), 10);
  await pool.query('DELETE FROM customer_sites WHERE id=$1 AND customer_id=$2', [sid, id]);
  res.redirect('/customers/' + id + '#sites');
});

router.post('/customers/:id/sites/:sid/primary', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const sid = parseInt(String(req.params.sid), 10);
  await pool.query('UPDATE customer_sites SET is_primary = false WHERE customer_id = $1', [id]);
  await pool.query('UPDATE customer_sites SET is_primary = true WHERE id = $1 AND customer_id = $2', [sid, id]);
  res.redirect('/customers/' + id + '#sites');
});

// ── Domains ───────────────────────────────────────────────────────────────────
router.post('/customers/:id/domains', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const domain = normaliseDomain(req.body.domain || '');
  if (domain) {
    const makePrimary = bool(req.body.is_primary);
    if (makePrimary) {
      await pool.query('UPDATE customer_domains SET is_primary = false WHERE customer_id = $1', [id]);
      await pool.query('UPDATE customers SET domain = $1 WHERE id = $2', [domain, id]);
    }
    await pool.query(
      `INSERT INTO customer_domains (customer_id, domain, is_primary) VALUES ($1,$2,$3)
       ON CONFLICT (customer_id, domain) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
      [id, domain, makePrimary]
    );
  }
  res.redirect('/customers/' + id + '#domains');
});

router.post('/customers/:id/domains/:did/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const did = parseInt(String(req.params.did), 10);
  await pool.query('DELETE FROM customer_domains WHERE id=$1 AND customer_id=$2', [did, id]);
  res.redirect('/customers/' + id + '#domains');
});

router.post('/customers/:id/domains/:did/primary', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const did = parseInt(String(req.params.did), 10);
  const d = await pool.query('SELECT domain FROM customer_domains WHERE id=$1 AND customer_id=$2', [did, id]);
  if (d.rows.length) {
    await pool.query('UPDATE customer_domains SET is_primary = false WHERE customer_id = $1', [id]);
    await pool.query('UPDATE customer_domains SET is_primary = true WHERE id = $1', [did]);
    await pool.query('UPDATE customers SET domain = $1 WHERE id = $2', [d.rows[0].domain, id]);
  }
  res.redirect('/customers/' + id + '#domains');
});

// ── Merge duplicate customers ────────────────────────────────────────────────────
// Folds a source customer into a target (keeper): all related records are reassigned,
// then the source is soft-deleted (recoverable from the recycle bin). Admin only.
router.get('/customers/:id/merge', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const src = (await pool.query('SELECT id, name, account_number FROM customers WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!src) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
  const others = (await pool.query(
    'SELECT id, name, account_number FROM customers WHERE id<>$1 AND deleted_at IS NULL AND is_placeholder=false ORDER BY name', [id]
  )).rows;
  res.render('customers/merge', { user: req.session.user!, src, others });
});

router.post('/customers/:id/merge', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const sourceId = parseInt(String(req.params.id), 10);
  const targetId = parseInt(String(req.body.target_id || ''), 10);
  if (!sourceId || !targetId || sourceId === targetId) {
    res.redirect('/customers/' + sourceId + '/merge'); return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Simple reassignments (no conflicting unique constraints).
    for (const sql of [
      "UPDATE customer_contacts SET customer_id=$2, is_primary=false WHERE customer_id=$1",
      "UPDATE customer_external_ids SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE quotes SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE invoices SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE contracts SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE inbox_tickets SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE leads SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE customer_credentials SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE service_items SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE call_records SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE customer_review_items SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE tasks SET related_customer_id=$2 WHERE related_customer_id=$1",
      "UPDATE users SET customer_id=$2 WHERE customer_id=$1",
      "UPDATE communications SET entity_id=$2 WHERE entity_type='customer' AND entity_id=$1",
    ]) {
      try { await client.query(sql, [sourceId, targetId]); } catch (e) { /* table may not exist yet */ }
    }
    // Sites & domains have a (customer_id, code/domain) unique — only move non-duplicates.
    await client.query(
      `UPDATE customer_sites s SET customer_id=$2 WHERE s.customer_id=$1
         AND (s.site_code IS NULL OR NOT EXISTS (SELECT 1 FROM customer_sites t WHERE t.customer_id=$2 AND t.site_code=s.site_code))`, [sourceId, targetId]);
    await client.query(
      `UPDATE customer_domains d SET customer_id=$2 WHERE d.customer_id=$1
         AND NOT EXISTS (SELECT 1 FROM customer_domains t WHERE t.customer_id=$2 AND t.domain=d.domain)`, [sourceId, targetId]);
    // Soft-delete the source and note the merge.
    await client.query(
      "UPDATE customers SET deleted_at=NOW(), deleted_by_user_id=$2, status='inactive', notes=COALESCE(notes,'') || ' [merged into customer #' || $3 || ']' WHERE id=$1",
      [sourceId, user.id, targetId]
    );
    await client.query('COMMIT');
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.redirect('/customers/' + sourceId + '/merge?err=' + encodeURIComponent('Merge failed: ' + e.message)); return;
  } finally { client.release(); }
  await logActivity(user.id, 'merged', 'customers', targetId, `Merged customer #${sourceId} into #${targetId}`);
  res.redirect('/customers/' + targetId + '?msg=' + encodeURIComponent('Customer merged in. The duplicate is in the recycle bin.'));
});

// Link this portal customer to an Insights reporting profile (sets lumenmsp_id on the Insights row).
router.post('/customers/:id/link-insights', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const insId = parseInt(String(req.body.insights_customer_id), 10);
  if (!insightsPool || !id || !insId) { res.redirect('/customers/' + id); return; }
  try {
    await insightsPool.query('UPDATE customers SET lumenmsp_id=$1 WHERE id=$2', [id, insId]);
    res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Linked to the Insights reporting profile.'));
  } catch (e: any) { res.redirect('/customers/' + id + '?err=' + encodeURIComponent('Link failed: ' + e.message)); }
});
router.post('/customers/:id/unlink-insights', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (insightsPool && id) { try { await insightsPool.query('UPDATE customers SET lumenmsp_id=NULL WHERE lumenmsp_id=$1', [id]); } catch { /* noop */ } }
  res.redirect('/customers/' + id + '?msg=' + encodeURIComponent('Unlinked from Insights.'));
});

// Send a Direct Debit setup invite — creates a GoCardless billing-request link and emails it.
router.post('/customers/:id/dd-invite', requireAuth, requireFinance, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const back = '/customers/' + id;
  const cust = (await pool.query('SELECT id, name, email FROM customers WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!cust) { res.redirect('/customers'); return; }
  const to = (String(req.body.email || '').trim() || cust.email || '').trim();
  if (!/\S+@\S+\.\S+/.test(to)) { res.redirect(back + '?err=' + encodeURIComponent('Add a recipient email for the Direct Debit invite.')); return; }
  const gc = await GoCardless.load();
  if (!gc.isConfigured()) { res.redirect(back + '?err=' + encodeURIComponent('GoCardless is not configured (Settings → Integrations).')); return; }
  const esc = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
  try {
    const base = (config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/$/, '');
    const flow = await gc.createMandateSetupFlow({
      redirectUri: base + '/dd/complete',
      exitUri: base + '/dd/exit',
      email: to,
      companyName: cust.name,
      metadata: { portal_customer_id: String(id) },
    });
    const html =
      `<p>Hello,</p>`
      + `<p>To set up a Direct Debit for <strong>${esc(cust.name)}</strong> with Lumen IT, please use the secure link below. It takes a couple of minutes and you'll need your bank account details to hand.</p>`
      + `<p style="margin:22px 0;"><a href="${flow.authorisationUrl}" style="background:#0ea5b7;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Set up Direct Debit</a></p>`
      + `<p style="font-size:13px;color:#475569;">If the button doesn't work, copy this link into your browser:<br>${esc(flow.authorisationUrl)}</p>`
      + `<p style="font-size:12px;color:#64748b;">This is handled securely by GoCardless. If you weren't expecting this email, you can safely ignore it.</p>`;
    await sendMail({ to, subject: 'Set up your Direct Debit — Lumen IT', html, signatureName: user.displayName });
    await logActivity(user.id, 'dd_invite', 'customers', id, `Direct Debit invite sent to ${to}`);
    res.redirect(back + '?msg=' + encodeURIComponent('Direct Debit invite sent to ' + to + '.'));
  } catch (e: any) {
    res.redirect(back + '?err=' + encodeURIComponent('Could not send the Direct Debit invite: ' + (e.message || 'unknown error')));
  }
});

export default router;
