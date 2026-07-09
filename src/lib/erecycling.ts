import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/pool';
import { getSetting, setSetting } from './settings';
import { htmlToPdf } from './pdf';
import { sendMail } from './mailer';
import { logActivity } from './activity';

// Shared core for the E-Recycling module (used by both the desktop Bureau route and the /m mobile app).
// Collection batches of end-of-life IT kit, audited with photos, submitted as a PDF manifest to the
// e-waste firm.

export const ERECYCLING_CATEGORIES = ['Desktop PC', 'Laptop', 'Server', 'Mobile', 'Tablet', 'Monitor', 'Printer', 'Networking', 'Peripheral', 'Cables / Misc', 'Other'];
export const ERECYCLING_CONDITIONS = ['Working', 'Faulty', 'For Parts', 'Unknown'];

// Photos stored publicly (UI thumbnails) and embedded into the PDF manifest as base64.
export const ERECYCLING_PHOTO_DIR = path.join(process.cwd(), 'static', 'attachments', 'erecycling');
export const PHOTO_URL_BASE = '/static/attachments/erecycling/';

export const erecyclingPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(ERECYCLING_PHOTO_DIR, { recursive: true }); cb(null, ERECYCLING_PHOTO_DIR); },
    filename: (_req, file, cb) => {
      const safe = (file.originalname || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 },
});

export function erecyclingPhotos(json: any): string[] {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

export async function ensureOpenBatch(userId: number | null): Promise<any> {
  const open = (await pool.query("SELECT * FROM erecycling_batches WHERE status='open' ORDER BY id DESC LIMIT 1")).rows[0];
  if (open) return open;
  const year = new Date().getFullYear();
  const n = (await pool.query("SELECT COUNT(*)::int c FROM erecycling_batches WHERE reference LIKE $1", [`EWASTE-${year}-%`])).rows[0].c;
  const ref = `EWASTE-${year}-${String(n + 1).padStart(3, '0')}`;
  return (await pool.query("INSERT INTO erecycling_batches (reference, status, created_by) VALUES ($1,'open',$2) RETURNING *", [ref, userId])).rows[0];
}

export async function loadBatch(batchId: number): Promise<any> {
  return (await pool.query('SELECT * FROM erecycling_batches WHERE id=$1', [batchId])).rows[0] || null;
}

export async function loadBatchItems(batchId: number): Promise<any[]> {
  const rows = (await pool.query('SELECT * FROM erecycling_items WHERE batch_id=$1 ORDER BY id', [batchId])).rows;
  return rows.map((r: any) => ({ ...r, photoList: erecyclingPhotos(r.photos) }));
}

export async function submittedBatches(limit = 50): Promise<any[]> {
  return (await pool.query("SELECT * FROM erecycling_batches WHERE status='submitted' ORDER BY submitted_at DESC NULLS LAST, id DESC LIMIT $1", [limit])).rows;
}

async function refreshCount(batchId: number): Promise<void> {
  await pool.query('UPDATE erecycling_batches SET item_count = (SELECT COUNT(*) FROM erecycling_items WHERE batch_id=$1), updated_at=NOW() WHERE id=$1', [batchId]);
}

export async function addItem(batchId: number, body: any, files: any[], userId: number | null): Promise<void> {
  const batch = (await pool.query("SELECT id, status FROM erecycling_batches WHERE id=$1", [batchId])).rows[0];
  if (!batch || batch.status !== 'open') throw new Error('Batch is not open for changes.');
  const photos = (files || []).map((f) => f.filename);
  const s = (v: any) => { const t = String(v ?? '').trim(); return t || null; };
  await pool.query(
    `INSERT INTO erecycling_items (batch_id, category, make, model, serial, asset_tag, condition, data_wiped, notes, photos, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [batchId, s(body.category) || 'Other', s(body.make), s(body.model), s(body.serial), s(body.asset_tag),
     s(body.condition) || 'Unknown', body.data_wiped === 'on' || body.data_wiped === '1', s(body.notes),
     JSON.stringify(photos), userId]
  );
  await refreshCount(batchId);
}

export async function deleteItem(itemId: number): Promise<void> {
  const it = (await pool.query('SELECT i.*, b.status FROM erecycling_items i JOIN erecycling_batches b ON b.id=i.batch_id WHERE i.id=$1', [itemId])).rows[0];
  if (!it || it.status !== 'open') return;
  for (const fn of erecyclingPhotos(it.photos)) { try { fs.unlinkSync(path.join(ERECYCLING_PHOTO_DIR, fn)); } catch { /* ignore */ } }
  await pool.query('DELETE FROM erecycling_items WHERE id=$1', [itemId]);
  await refreshCount(it.batch_id);
}

export async function savedFirmEmail(): Promise<string> {
  return (await getSetting('erecycling', 'firm_email')) || '';
}

export function manifestHtml(batch: any, items: any[], opts: { embedPhotos: boolean }): string {
  const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
  const dataUri = (fn: string): string | null => {
    try {
      const buf = fs.readFileSync(path.join(ERECYCLING_PHOTO_DIR, fn));
      const ext = (path.extname(fn).slice(1).toLowerCase() || 'jpeg').replace('jpg', 'jpeg');
      return `data:image/${ext};base64,${buf.toString('base64')}`;
    } catch { return null; }
  };
  const rows = items.map((it, i) => {
    const photos = opts.embedPhotos
      ? (it.photoList || []).map((fn: string) => { const u = dataUri(fn); return u ? `<img src="${u}" style="width:78px;height:78px;object-fit:cover;border-radius:6px;margin:2px;border:1px solid #cbd5e1;">` : ''; }).join('')
      : `${(it.photoList || []).length} photo(s)`;
    return `<tr>
      <td style="text-align:center;color:#64748b;">${i + 1}</td>
      <td><strong>${esc(it.category)}</strong></td>
      <td>${esc(it.make || '-')}</td>
      <td>${esc(it.model || '-')}</td>
      <td>${esc(it.serial || '-')}${it.asset_tag ? `<br><span style="color:#64748b;font-size:11px;">Tag: ${esc(it.asset_tag)}</span>` : ''}</td>
      <td>${esc(it.condition || 'Unknown')}${it.data_wiped ? '<br><span style="color:#166534;font-size:11px;">data wiped</span>' : ''}</td>
      <td style="font-size:11px;color:#475569;">${esc(it.notes || '')}</td>
      <td>${photos}</td>
    </tr>`;
  }).join('');
  const byCat: Record<string, number> = {};
  for (const it of items) byCat[it.category] = (byCat[it.category] || 0) + 1;
  const summary = Object.keys(byCat).sort().map((k) => `${esc(k)}: ${byCat[k]}`).join(' &nbsp;&middot;&nbsp; ');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;} body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;font-size:12px;margin:0;padding:28px;}
    h1{font-size:22px;margin:0 0 2px;} .muted{color:#64748b;} table{width:100%;border-collapse:collapse;margin-top:14px;}
    th{background:#0f172a;color:#fff;text-align:left;padding:7px 8px;font-size:11px;} td{padding:7px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;}
    .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0e7490;padding-bottom:10px;}
  </style></head><body>
    <div class="hdr">
      <div><h1>IT Recycling Manifest</h1><div class="muted">Lumen IT Solutions Limited &middot; LumenMSP</div></div>
      <div style="text-align:right;"><div style="font-size:18px;font-weight:800;">${esc(batch.reference)}</div>
        <div class="muted">${items.length} item(s)</div>
        <div class="muted">${new Date(batch.submitted_at || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div></div>
    </div>
    <div class="muted" style="margin-top:8px;">${summary || 'No items'}</div>
    ${batch.notes ? `<div style="margin-top:6px;">${esc(batch.notes)}</div>` : ''}
    <table>
      <thead><tr><th>#</th><th>Category</th><th>Make</th><th>Model</th><th>Serial</th><th>Condition</th><th>Notes</th><th>Photos</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px;">No items</td></tr>'}</tbody>
    </table>
    <p class="muted" style="margin-top:16px;font-size:11px;">Generated by the LumenMSP Portal. All listed equipment is released for environmentally compliant recycling / WEEE disposal.</p>
  </body></html>`;
}

export async function renderManifestPdf(batchId: number): Promise<{ pdf: Buffer; batch: any }> {
  const batch = await loadBatch(batchId);
  if (!batch) throw new Error('Batch not found');
  const items = await loadBatchItems(batchId);
  const pdf = await htmlToPdf(manifestHtml(batch, items, { embedPhotos: true }), { landscape: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  return { pdf, batch };
}

// Submit: email PDF manifest to the e-waste firm, mark submitted. Returns the batch reference.
export async function submitBatch(batchId: number, firmEmail: string, notes: string | null, rememberEmail: boolean, userId: number | null): Promise<string> {
  const batch = (await pool.query("SELECT * FROM erecycling_batches WHERE id=$1 AND status='open'", [batchId])).rows[0];
  if (!batch) throw new Error('Batch not found or already submitted.');
  const items = await loadBatchItems(batchId);
  if (!items.length) throw new Error('Add at least one item before submitting.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(firmEmail)) throw new Error('Enter a valid e-waste firm email.');
  if (rememberEmail) await setSetting('erecycling', 'firm_email', firmEmail);
  if (notes !== null) { await pool.query('UPDATE erecycling_batches SET notes=$1 WHERE id=$2', [notes, batchId]); batch.notes = notes; }
  batch.submitted_at = new Date();
  const pdf = await htmlToPdf(manifestHtml(batch, items, { embedPhotos: true }), { landscape: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  await sendMail({
    to: firmEmail,
    subject: `IT Recycling Collection - ${batch.reference} (${items.length} item(s))`,
    html: `<p>Hi,</p><p>Please find attached our IT recycling manifest <strong>${batch.reference}</strong> covering <strong>${items.length} item(s)</strong> ready for collection / disposal.</p><p>The PDF lists each item with make, model, serial, condition and photos.</p><p>Many thanks,<br>Lumen IT Solutions</p>`,
    attachments: [{ filename: `${batch.reference}.pdf`, contentType: 'application/pdf', base64: pdf.toString('base64') }],
  });
  await pool.query("UPDATE erecycling_batches SET status='submitted', submitted_to=$1, submitted_at=NOW(), updated_at=NOW() WHERE id=$2", [firmEmail, batchId]);
  try { await logActivity(userId || 0, 'submitted', 'erecycling_batches', batchId, `Submitted ${batch.reference} (${items.length} items) to ${firmEmail}`); } catch { /* optional */ }
  return batch.reference;
}
