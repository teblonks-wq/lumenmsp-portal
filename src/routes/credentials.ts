import { Router, Request, Response } from 'express';
import { requireVaultAccess } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { encryptSecret, decryptSecret, vaultConfigured } from '../lib/vault';

// Per-customer password vault. Access limited to support users (Support tick box) + admins.
// Secrets are encrypted at rest and only decrypted on an explicit reveal/copy, which is
// always written to the activity log. Plaintext is never logged or put in a URL.
const router = Router();
router.use('/credentials', requireVaultAccess);
router.use('/customers/:id/credentials', requireVaultAccess);
router.use('/purchases/suppliers/:id/logins', requireVaultAccess);
router.use('/supplier-logins', requireVaultAccess);

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };

// Add a credential to a customer.
router.post('/customers/:id/credentials', async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const b = req.body;
  const name = nz(b.name);
  if (!customerId || !name) { res.redirect('/customers/' + customerId + '#passwords'); return; }
  let secretEnc: string | null = null;
  if (nz(b.password)) {
    if (!vaultConfigured()) { res.redirect('/customers/' + customerId + '?err=' + encodeURIComponent('Password vault key not configured on the server') + '#passwords'); return; }
    secretEnc = encryptSecret(String(b.password));
  }
  const r = await pool.query(
    `INSERT INTO customer_credentials (customer_id, name, login_url, username, secret_encrypted, domain, category, extra_value, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [customerId, name, nz(b.login_url), nz(b.username), secretEnc, nz(b.domain), nz(b.category), nz(b.extra_value), nz(b.note), req.session.user!.id]
  );
  await logActivity(req.session.user!.id, 'created', 'credentials', r.rows[0].id, `Added password "${name}"`);
  res.redirect('/customers/' + customerId + '?msg=' + encodeURIComponent('Password saved') + '#passwords');
});

// Edit a credential. The password is only re-encrypted if a new one is supplied
// (blank = leave the stored secret unchanged).
router.post('/credentials/:cid/edit', async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.cid), 10);
  const b = req.body;
  const cur = await pool.query('SELECT customer_id FROM customer_credentials WHERE id=$1 AND deleted_at IS NULL', [cid]);
  if (!cur.rows.length) { res.redirect('/customers'); return; }
  const customerId = cur.rows[0].customer_id;
  if (nz(b.password)) {
    if (!vaultConfigured()) { res.redirect('/customers/' + customerId + '?err=' + encodeURIComponent('Password vault key not configured') + '#passwords'); return; }
    await pool.query('UPDATE customer_credentials SET secret_encrypted=$1 WHERE id=$2', [encryptSecret(String(b.password)), cid]);
  }
  await pool.query(
    `UPDATE customer_credentials SET name=$1, login_url=$2, username=$3, domain=$4, category=$5, extra_value=$6, note=$7, updated_at=NOW() WHERE id=$8`,
    [nz(b.name) || 'Untitled', nz(b.login_url), nz(b.username), nz(b.domain), nz(b.category), nz(b.extra_value), nz(b.note), cid]
  );
  await logActivity(req.session.user!.id, 'updated', 'credentials', cid, `Updated password "${nz(b.name) || ''}"`);
  res.redirect('/customers/' + customerId + '?msg=' + encodeURIComponent('Password updated') + '#passwords');
});

// Soft-delete a credential.
router.post('/credentials/:cid/delete', async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.cid), 10);
  const r = await pool.query('SELECT customer_id, name FROM customer_credentials WHERE id=$1', [cid]);
  if (!r.rows.length) { res.redirect('/customers'); return; }
  await pool.query('UPDATE customer_credentials SET deleted_at=NOW(), deleted_by_user_id=$2 WHERE id=$1', [cid, req.session.user!.id]);
  await logActivity(req.session.user!.id, 'deleted', 'credentials', cid, `Deleted password "${r.rows[0].name}"`);
  res.redirect('/customers/' + r.rows[0].customer_id + '?msg=' + encodeURIComponent('Password deleted') + '#passwords');
});

// Reveal / copy the decrypted secret. Returns JSON over HTTPS; logs the access.
// ?action=copy distinguishes a copy-to-clipboard from an on-screen reveal in the log.
router.get('/credentials/:cid/secret', async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.cid), 10);
  const action = String(req.query.action || 'reveal') === 'copy' ? 'copy' : 'reveal';
  const r = await pool.query('SELECT customer_id, name, secret_encrypted FROM customer_credentials WHERE id=$1 AND deleted_at IS NULL', [cid]);
  if (!r.rows.length || !r.rows[0].secret_encrypted) { res.status(404).json({ error: 'Not found' }); return; }
  let secret: string;
  try { secret = decryptSecret(r.rows[0].secret_encrypted); }
  catch (e: any) { res.status(500).json({ error: 'Could not decrypt — check VAULT_KEY.' }); return; }
  await logActivity(req.session.user!.id, action === 'copy' ? 'copied' : 'revealed', 'credentials', cid,
    `${action === 'copy' ? 'Copied' : 'Revealed'} password "${r.rows[0].name}"`);
  res.json({ secret });
});

// ── Supplier website logins (multiple per supplier) ──────────────────────────────
const SUPP = (id: number, q = '') => '/purchases/suppliers/' + id + q + '#logins';

router.post('/purchases/suppliers/:id/logins', async (req: Request, res: Response) => {
  const supplierId = parseInt(String(req.params.id), 10);
  const b = req.body;
  const name = nz(b.name);
  if (!supplierId || !name) { res.redirect(SUPP(supplierId)); return; }
  let secretEnc: string | null = null;
  if (nz(b.password)) {
    if (!vaultConfigured()) { res.redirect(SUPP(supplierId, '?err=' + encodeURIComponent('Password vault key not configured on the server'))); return; }
    secretEnc = encryptSecret(String(b.password));
  }
  const r = await pool.query(
    `INSERT INTO supplier_credentials (supplier_id, name, login_url, username, secret_encrypted, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [supplierId, name, nz(b.login_url), nz(b.username), secretEnc, nz(b.note), req.session.user!.id]
  );
  await logActivity(req.session.user!.id, 'created', 'supplier_credentials', r.rows[0].id, `Added supplier login "${name}"`);
  res.redirect(SUPP(supplierId, '?msg=' + encodeURIComponent('Login saved')));
});

router.post('/supplier-logins/:cid/edit', async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.cid), 10);
  const b = req.body;
  const cur = await pool.query('SELECT supplier_id FROM supplier_credentials WHERE id=$1 AND deleted_at IS NULL', [cid]);
  if (!cur.rows.length) { res.redirect('/purchases/expenses?view=suppliers'); return; }
  const supplierId = cur.rows[0].supplier_id;
  if (nz(b.password)) {
    if (!vaultConfigured()) { res.redirect(SUPP(supplierId, '?err=' + encodeURIComponent('Password vault key not configured'))); return; }
    await pool.query('UPDATE supplier_credentials SET secret_encrypted=$1 WHERE id=$2', [encryptSecret(String(b.password)), cid]);
  }
  await pool.query(
    `UPDATE supplier_credentials SET name=$1, login_url=$2, username=$3, note=$4, updated_at=NOW() WHERE id=$5`,
    [nz(b.name) || 'Untitled', nz(b.login_url), nz(b.username), nz(b.note), cid]
  );
  await logActivity(req.session.user!.id, 'updated', 'supplier_credentials', cid, `Updated supplier login "${nz(b.name) || ''}"`);
  res.redirect(SUPP(supplierId, '?msg=' + encodeURIComponent('Login updated')));
});

router.post('/supplier-logins/:cid/delete', async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.cid), 10);
  const r = await pool.query('SELECT supplier_id, name FROM supplier_credentials WHERE id=$1', [cid]);
  if (!r.rows.length) { res.redirect('/purchases/expenses?view=suppliers'); return; }
  await pool.query('UPDATE supplier_credentials SET deleted_at=NOW() WHERE id=$1', [cid]);
  await logActivity(req.session.user!.id, 'deleted', 'supplier_credentials', cid, `Deleted supplier login "${r.rows[0].name}"`);
  res.redirect(SUPP(r.rows[0].supplier_id, '?msg=' + encodeURIComponent('Login deleted')));
});

router.get('/supplier-logins/:cid/secret', async (req: Request, res: Response) => {
  const cid = parseInt(String(req.params.cid), 10);
  const action = String(req.query.action || 'reveal') === 'copy' ? 'copy' : 'reveal';
  const r = await pool.query('SELECT name, secret_encrypted FROM supplier_credentials WHERE id=$1 AND deleted_at IS NULL', [cid]);
  if (!r.rows.length || !r.rows[0].secret_encrypted) { res.status(404).json({ error: 'Not found' }); return; }
  let secret: string;
  try { secret = decryptSecret(r.rows[0].secret_encrypted); }
  catch { res.status(500).json({ error: 'Could not decrypt — check VAULT_KEY.' }); return; }
  await logActivity(req.session.user!.id, action === 'copy' ? 'copied' : 'revealed', 'supplier_credentials', cid,
    `${action === 'copy' ? 'Copied' : 'Revealed'} supplier login "${r.rows[0].name}"`);
  res.json({ secret });
});

export default router;
