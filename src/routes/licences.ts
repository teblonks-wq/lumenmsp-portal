import { Router, Request, Response } from 'express';
import { requireAuth, requireVaultAccess } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { encryptSecret, decryptSecret, vaultConfigured } from '../lib/vault';

// ── Software licences, per customer ───────────────────────────────────────────────
// What the customer has bought, which machine it went on, and the key. The KEY is a
// secret and is treated exactly like a vault password — AES-256-GCM at rest, decrypted
// only on an explicit reveal/copy, and every one of those written to the activity log.
// Everything else on the row (device, type, URL, install date) is ordinary staff data,
// so the tab is readable by any staff user; only the key itself needs vault access.
//
// The Licence Type dropdown is a lookup table rather than a hard-coded list, so a new
// product can be added from the form without a deploy. The licence row stores the type
// NAME, not an id — which is why a type is retired (active=false) and never deleted.
const router = Router();
router.use('/customers/:id/licences', requireAuth);
router.use('/licences', requireAuth);

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };
const nzInt = (v: any): number | null => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };
const back = (customerId: number, q = '') => '/customers/' + customerId + q + '#licences';

/** A licence sits on a real asset OR on a typed-in name, never both. Picking an asset
 *  wins; the free-text box is the fallback for machines we do not hold. */
function deviceOf(b: any): { assetId: number | null; deviceName: string | null } {
  const assetId = nzInt(b.asset_id);
  return assetId ? { assetId, deviceName: null } : { assetId: null, deviceName: nz(b.device_name) };
}

/** "Licence Type … and add more": the form posts either an existing name or a new one.
 *  A new name is inserted into the lookup (idempotently) and then used on the row, so
 *  the next licence for any customer already offers it. */
async function resolveType(b: any, userId: number): Promise<string | null> {
  const fresh = nz(b.new_licence_type);
  if (fresh) {
    await pool.query(
      `INSERT INTO licence_types (name, created_by) VALUES ($1,$2)
       ON CONFLICT (name) DO UPDATE SET active = true`,
      [fresh, userId]
    );
    return fresh;
  }
  return nz(b.licence_type);
}

/** An install date is a plain calendar day. Anything else becomes null rather than
 *  letting Postgres throw and lose the whole row the user just typed. */
const dayOrNull = (v: any): string | null => {
  const s = (v ?? '').toString().trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

// ── Add ───────────────────────────────────────────────────────────────────────────
router.post('/customers/:id/licences', async (req: Request, res: Response) => {
  const customerId = parseInt(String(req.params.id), 10);
  const b = req.body;
  const userId = req.session.user!.id;
  if (!customerId) { res.redirect('/customers'); return; }

  const licenceType = await resolveType(b, userId);
  const { assetId, deviceName } = deviceOf(b);
  // A row with nothing on it helps nobody — require at least a type or a device.
  if (!licenceType && !assetId && !deviceName) {
    res.redirect(back(customerId, '?err=' + encodeURIComponent('Give the licence a type or a device before saving'))); return;
  }

  let keyEnc: string | null = null;
  if (nz(b.licence_key)) {
    if (!vaultConfigured()) { res.redirect(back(customerId, '?err=' + encodeURIComponent('Vault key not configured on the server — the licence key cannot be stored'))); return; }
    keyEnc = encryptSecret(String(b.licence_key));
  }

  const r = await pool.query(
    `INSERT INTO customer_licences (customer_id, asset_id, device_name, licence_type, key_encrypted, url, installed_on, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [customerId, assetId, deviceName, licenceType, keyEnc, nz(b.url), dayOrNull(b.installed_on), nz(b.note), userId]
  );
  await logActivity(userId, 'created', 'licences', r.rows[0].id, `Added licence "${licenceType || deviceName || 'Untitled'}"`);
  res.redirect(back(customerId, '?msg=' + encodeURIComponent('Licence saved')));
});

// ── Edit ──────────────────────────────────────────────────────────────────────────
// A blank key box leaves the stored key untouched — the password vault's rule, so
// editing a licence's URL cannot silently wipe its key.
router.post('/licences/:lid/edit', async (req: Request, res: Response) => {
  const lid = parseInt(String(req.params.lid), 10);
  const b = req.body;
  const userId = req.session.user!.id;
  const cur = await pool.query('SELECT customer_id FROM customer_licences WHERE id=$1 AND deleted_at IS NULL', [lid]);
  if (!cur.rows.length) { res.redirect('/customers'); return; }
  const customerId = cur.rows[0].customer_id;

  if (nz(b.licence_key)) {
    if (!vaultConfigured()) { res.redirect(back(customerId, '?err=' + encodeURIComponent('Vault key not configured — the licence key was not changed'))); return; }
    await pool.query('UPDATE customer_licences SET key_encrypted=$1 WHERE id=$2', [encryptSecret(String(b.licence_key)), lid]);
  }
  const licenceType = await resolveType(b, userId);
  const { assetId, deviceName } = deviceOf(b);
  await pool.query(
    `UPDATE customer_licences
        SET asset_id=$1, device_name=$2, licence_type=$3, url=$4, installed_on=$5, note=$6, updated_at=NOW()
      WHERE id=$7`,
    [assetId, deviceName, licenceType, nz(b.url), dayOrNull(b.installed_on), nz(b.note), lid]
  );
  await logActivity(userId, 'updated', 'licences', lid, `Updated licence "${licenceType || deviceName || ''}"`);
  res.redirect(back(customerId, '?msg=' + encodeURIComponent('Licence updated')));
});

// ── Delete (soft) ─────────────────────────────────────────────────────────────────
router.post('/licences/:lid/delete', async (req: Request, res: Response) => {
  const lid = parseInt(String(req.params.lid), 10);
  const r = await pool.query('SELECT customer_id, licence_type, device_name FROM customer_licences WHERE id=$1', [lid]);
  if (!r.rows.length) { res.redirect('/customers'); return; }
  await pool.query('UPDATE customer_licences SET deleted_at=NOW(), deleted_by_user_id=$2 WHERE id=$1', [lid, req.session.user!.id]);
  await logActivity(req.session.user!.id, 'deleted', 'licences', lid,
    `Deleted licence "${r.rows[0].licence_type || r.rows[0].device_name || ''}"`);
  res.redirect(back(r.rows[0].customer_id, '?msg=' + encodeURIComponent('Licence deleted')));
});

// ── Reveal / copy the key ─────────────────────────────────────────────────────────
// Vault-gated and logged, exactly like a password. ?action=copy separates a copy from
// an on-screen reveal in the log.
router.get('/licences/:lid/key', requireVaultAccess, async (req: Request, res: Response) => {
  const lid = parseInt(String(req.params.lid), 10);
  const action = String(req.query.action || 'reveal') === 'copy' ? 'copy' : 'reveal';
  const r = await pool.query(
    'SELECT licence_type, device_name, key_encrypted FROM customer_licences WHERE id=$1 AND deleted_at IS NULL', [lid]
  );
  if (!r.rows.length || !r.rows[0].key_encrypted) { res.status(404).json({ error: 'Not found' }); return; }
  let secret: string;
  try { secret = decryptSecret(r.rows[0].key_encrypted); }
  catch { res.status(500).json({ error: 'Could not decrypt — check VAULT_KEY.' }); return; }
  await logActivity(req.session.user!.id, action === 'copy' ? 'copied' : 'revealed', 'licences', lid,
    `${action === 'copy' ? 'Copied' : 'Revealed'} licence key "${r.rows[0].licence_type || r.rows[0].device_name || ''}"`);
  res.json({ secret });
});

export default router;
