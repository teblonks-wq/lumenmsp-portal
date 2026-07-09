import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();
const TYPES = ['product', 'service'];
const FREQS = ['monthly', 'annual', 'one_off'];

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };
const num = (v: any): number => { const x = parseFloat((v ?? '').toString()); return isNaN(x) ? 0 : x; };
const bool = (v: any): boolean => v === 'on' || v === '1' || v === 'true' || v === true;

// JSON catalogue for the quote/invoice line-item picker
router.get('/products/catalogue.json', requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, name, code, description, supplier, unit_price, cost_price, vat_rate, item_type
     FROM asset_products WHERE is_active = true ORDER BY name ASC`
  );
  res.json(rows);
});

// ── Export all products to CSV (Excel-openable) for offline price/category editing ──
router.get('/products/export.csv', requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.code, p.name, c.code AS category_code, c.name AS category_name,
            p.item_type, p.billing_frequency, p.unit_price, p.cost_price, p.vat_rate,
            p.supplier, p.description, p.quickbooks_item_id, p.is_active
       FROM asset_products p LEFT JOIN asset_categories c ON c.id = p.category_id
      ORDER BY c.name NULLS FIRST, p.name ASC`
  );
  const cols = ['id', 'code', 'name', 'category_code', 'category_name', 'item_type', 'billing_frequency', 'unit_price', 'cost_price', 'vat_rate', 'supplier', 'description', 'quickbooks_item_id', 'is_active'];
  const esc = (v: any): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc((r as any)[c])).join(','));
  const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8 cleanly
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="products_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/products', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const search = ((req.query.search as string) || '').trim();
  const category = ((req.query.category as string) || '').trim();
  const type = ((req.query.type as string) || '').trim();
  const showInactive = req.query.inactive === '1';

  const where: string[] = [];
  const params: any[] = [];
  if (!showInactive) where.push('p.is_active = true');
  if (search) { params.push('%' + search + '%'); where.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.supplier ILIKE $${params.length} OR p.description ILIKE $${params.length})`); }
  if (category) { params.push(parseInt(category, 10)); where.push('p.category_id = $' + params.length); }
  if (type && TYPES.includes(type)) { params.push(type); where.push('p.item_type = $' + params.length); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT p.*, c.name AS category_name FROM asset_products p
     LEFT JOIN asset_categories c ON c.id = p.category_id
     ${whereSql} ORDER BY p.name ASC`, params
  );
  const cats = await pool.query('SELECT id, name FROM asset_categories ORDER BY name');
  res.render('products/list', { user, products: rows, categories: cats.rows, search, category, type, showInactive });
});

// ── Duplicate finder + merge ────────────────────────────────────────────────────
router.get('/products/duplicates', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.code, p.supplier, p.unit_price, p.cost_price, p.quickbooks_item_id, p.is_active,
            ((SELECT COUNT(*) FROM quote_items WHERE product_id=p.id)
           + (SELECT COUNT(*) FROM invoice_items WHERE product_id=p.id)
           + (SELECT COUNT(*) FROM contract_lines WHERE product_id=p.id))::int AS usage
     FROM asset_products p WHERE p.is_active = true ORDER BY lower(trim(p.name)), p.id`
  );
  const groups: Record<string, any[]> = {};
  for (const r of rows) { const k = (r.name || '').toLowerCase().trim(); (groups[k] = groups[k] || []).push(r); }
  const dupes = Object.values(groups).filter((g) => g.length > 1);
  res.render('products/duplicates', { user: req.session.user!, groups: dupes, notice: req.query.msg || null });
});

router.post('/products/merge', requireAuth, async (req: Request, res: Response) => {
  const keepId = parseInt(String(req.body.keep_id || ''), 10);
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids])
    .map((x: any) => parseInt(String(x), 10)).filter((x: number) => x && x !== keepId);
  if (!keepId || !ids.length) { res.redirect('/products/duplicates'); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      await client.query('UPDATE quote_items SET product_id=$1 WHERE product_id=$2', [keepId, id]);
      await client.query('UPDATE invoice_items SET product_id=$1 WHERE product_id=$2', [keepId, id]);
      await client.query('UPDATE contract_lines SET product_id=$1 WHERE product_id=$2', [keepId, id]);
    }
    // Adopt a QB item link from a duplicate if the kept product has none
    await client.query(
      `UPDATE asset_products k SET quickbooks_item_id = COALESCE(k.quickbooks_item_id,
         (SELECT d.quickbooks_item_id FROM asset_products d WHERE d.id = ANY($2) AND d.quickbooks_item_id IS NOT NULL LIMIT 1))
       WHERE k.id=$1`, [keepId, ids]
    );
    await client.query('UPDATE asset_products SET is_active=false, updated_at=NOW() WHERE id = ANY($1)', [ids]);
    await client.query('COMMIT');
    res.redirect('/products/duplicates?msg=' + encodeURIComponent('Merged ' + ids.length + ' duplicate(s)'));
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

router.post('/products/merge-all', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.quickbooks_item_id,
            ((SELECT COUNT(*) FROM quote_items WHERE product_id=p.id)
           + (SELECT COUNT(*) FROM invoice_items WHERE product_id=p.id)
           + (SELECT COUNT(*) FROM contract_lines WHERE product_id=p.id))::int AS usage
     FROM asset_products p WHERE p.is_active = true ORDER BY lower(trim(p.name)), p.id`
  );
  const groups: Record<string, any[]> = {};
  for (const r of rows) { const k = (r.name || '').toLowerCase().trim(); (groups[k] = groups[k] || []).push(r); }
  const dupes = Object.values(groups).filter((g) => g.length > 1);

  let mergedGroups = 0, mergedProducts = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const g of dupes) {
      const keep = g.slice().sort((a, b) => (b.quickbooks_item_id ? 1 : 0) - (a.quickbooks_item_id ? 1 : 0) || b.usage - a.usage || a.id - b.id)[0];
      const ids = g.filter((p) => p.id !== keep.id).map((p) => p.id);
      for (const id of ids) {
        await client.query('UPDATE quote_items SET product_id=$1 WHERE product_id=$2', [keep.id, id]);
        await client.query('UPDATE invoice_items SET product_id=$1 WHERE product_id=$2', [keep.id, id]);
        await client.query('UPDATE contract_lines SET product_id=$1 WHERE product_id=$2', [keep.id, id]);
      }
      await client.query(
        `UPDATE asset_products k SET quickbooks_item_id = COALESCE(k.quickbooks_item_id,
           (SELECT d.quickbooks_item_id FROM asset_products d WHERE d.id = ANY($2) AND d.quickbooks_item_id IS NOT NULL LIMIT 1))
         WHERE k.id=$1`, [keep.id, ids]
      );
      await client.query('UPDATE asset_products SET is_active=false, updated_at=NOW() WHERE id = ANY($1)', [ids]);
      mergedGroups++; mergedProducts += ids.length;
    }
    await client.query('COMMIT');
    res.redirect('/products/duplicates?msg=' + encodeURIComponent(`Merged ${mergedProducts} duplicate(s) across ${mergedGroups} group(s)`));
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// ── New / Edit form ──────────────────────────────────────────────────────────────
async function formData() {
  const [cats, sups] = await Promise.all([
    pool.query('SELECT id, name FROM asset_categories ORDER BY name'),
    pool.query('SELECT name FROM suppliers WHERE is_active = true ORDER BY name'),
  ]);
  return { categories: cats.rows, suppliers: sups.rows };
}

router.get('/products/new', requireAuth, async (req: Request, res: Response) => {
  const fd = await formData();
  res.render('products/form', { user: req.session.user!, product: null, ...fd, error: null });
});

router.get('/products/:id/edit', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = await pool.query('SELECT * FROM asset_products WHERE id=$1 LIMIT 1', [id]);
  if (!r.rows.length) { res.status(404).render('error', { message: 'Product not found.' }); return; }
  const fd = await formData();
  res.render('products/form', { user: req.session.user!, product: r.rows[0], ...fd, error: null });
});

function readBody(b: any) {
  return {
    name: (b.name || '').trim(),
    code: nz(b.code),
    categoryId: b.category_id ? parseInt(b.category_id, 10) : null,
    itemType: TYPES.includes(b.item_type) ? b.item_type : 'service',
    billingFrequency: FREQS.includes(b.billing_frequency) ? b.billing_frequency : 'monthly',
    unitPrice: num(b.unit_price), costPrice: num(b.cost_price), vatRate: num(b.vat_rate || 20),
    supplier: nz(b.supplier), description: nz(b.description), isActive: bool(b.is_active),
  };
}

// ── Create ──────────────────────────────────────────────────────────────────────
router.post('/products', requireAuth, async (req: Request, res: Response) => {
  const d = readBody(req.body);
  if (!d.name) { const fd = await formData(); res.render('products/form', { user: req.session.user!, product: req.body, ...fd, error: 'Name is required.' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO asset_products (name, code, category_id, item_type, billing_frequency, unit_price, cost_price, vat_rate, supplier, description, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [d.name, d.code, d.categoryId, d.itemType, d.billingFrequency, d.unitPrice, d.costPrice, d.vatRate, d.supplier, d.description, d.isActive]
  );
  res.redirect('/products');
});

// ── Update ──────────────────────────────────────────────────────────────────────
router.post('/products/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const d = readBody(req.body);
  await pool.query(
    `UPDATE asset_products SET name=$1, code=$2, category_id=$3, item_type=$4, billing_frequency=$5,
       unit_price=$6, cost_price=$7, vat_rate=$8, supplier=$9, description=$10, is_active=$11, updated_at=NOW()
     WHERE id=$12`,
    [d.name, d.code, d.categoryId, d.itemType, d.billingFrequency, d.unitPrice, d.costPrice, d.vatRate, d.supplier, d.description, d.isActive, id]
  );
  res.redirect('/products');
});

// ── Deactivate (soft delete) ───────────────────────────────────────────────────
router.post('/products/:id/delete', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await pool.query('UPDATE asset_products SET is_active = false WHERE id=$1', [id]);
  res.redirect('/products');
});

export default router;
