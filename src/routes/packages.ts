import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';

const router = Router();
router.use('/admin/packages', requireAuth, requireAdmin);

const CATS = ['internet', 'voice', 'mobile', 'additional'];

// The Giacom comms products available to pick as a package's core products.
async function giacomProducts(): Promise<string[]> {
  const rows = (await pool.query(
    "SELECT DISTINCT description FROM service_items WHERE source='comms' AND description IS NOT NULL AND description<>'' ORDER BY description"
  )).rows;
  return rows.map((r: any) => r.description);
}
const asArray = (v: any): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

router.get('/admin/packages', async (req: Request, res: Response) => {
  const packages = (await pool.query('SELECT * FROM packages ORDER BY sort_order, name')).rows;
  const prod = (await pool.query('SELECT package_id, product_name FROM package_products')).rows;
  const byPkg = new Map<number, string[]>();
  for (const r of prod) { if (!byPkg.has(r.package_id)) byPkg.set(r.package_id, []); byPkg.get(r.package_id)!.push(r.product_name); }
  packages.forEach((p: any) => { p.products = byPkg.get(p.id) || []; });
  res.render('admin/packages', {
    user: req.session.user!, packages, cats: CATS, products: await giacomProducts(),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

async function syncProducts(packageId: number, products: string[]): Promise<void> {
  await pool.query('DELETE FROM package_products WHERE package_id=$1', [packageId]);
  for (const name of products) {
    const n = String(name || '').trim(); if (!n) continue;
    await pool.query('INSERT INTO package_products (package_id, product_name) VALUES ($1,$2) ON CONFLICT (package_id, product_name) DO NOTHING', [packageId, n]);
  }
}

router.post('/admin/packages', async (req: Request, res: Response) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  if (!name) { res.redirect('/admin/packages?err=' + encodeURIComponent('Name required.')); return; }
  const id = (await pool.query(
    `INSERT INTO packages (name, category, kind, match_pattern, requires_seat, standard_price, term_label, sort_order, is_active)
     VALUES ($1,$2,'per_cli',$3,false,$4,$5,$6,true) RETURNING id`,
    [name, CATS.includes(b.category) ? b.category : 'voice', (b.match_pattern || '').trim() || null,
     parseFloat(String(b.standard_price || '0').replace(/[^0-9.\-]/g, '')) || 0, (b.term_label || '').trim() || null,
     parseInt(String(b.sort_order || '100'), 10) || 100]
  )).rows[0].id;
  await syncProducts(id, asArray(b.products));
  await logActivity(req.session.user!.id, 'created', 'customers', 0, `Package created: ${name}`);
  res.redirect('/admin/packages?msg=' + encodeURIComponent('Package "' + name + '" created'));
});

router.post('/admin/packages/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10); const b = req.body;
  if (!id) { res.redirect('/admin/packages'); return; }
  await pool.query(
    `UPDATE packages SET name=$1, category=$2, match_pattern=$3, standard_price=$4, term_label=$5, is_active=$6, updated_at=NOW() WHERE id=$7`,
    [String(b.name || '').trim(), CATS.includes(b.category) ? b.category : 'voice', (b.match_pattern || '').trim() || null,
     parseFloat(String(b.standard_price || '0').replace(/[^0-9.\-]/g, '')) || 0, (b.term_label || '').trim() || null, b.is_active === 'on', id]
  );
  await syncProducts(id, asArray(b.products));
  res.redirect('/admin/packages?msg=' + encodeURIComponent('Package saved'));
});

router.post('/admin/packages/:id/delete', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (id) await pool.query('DELETE FROM packages WHERE id=$1', [id]);
  res.redirect('/admin/packages?msg=' + encodeURIComponent('Package deleted'));
});

export default router;
