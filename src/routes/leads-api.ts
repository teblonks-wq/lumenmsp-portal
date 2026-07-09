import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { getSetting } from '../lib/settings';

// Public server-to-server lead intake for the marketing website.
//   POST /api/leads   Authorization: Bearer <token>
// Token = env LEADS_API_KEY (or the 'leads'/'api_key' setting). No session/CSRF (unauthenticated
// requests are exempt from the CSRF guard). Idempotent on `reference` (one per order): a retry
// updates the existing lead rather than creating a duplicate.

const router = Router();

async function leadsApiKey(): Promise<string> {
  return (process.env.LEADS_API_KEY || '').trim() || (((await getSetting('leads', 'api_key')) || '').trim());
}

const s = (v: any): string | null => { const t = String(v ?? '').trim(); return t || null; };
const num = (v: any): number | null => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };

router.post('/api/leads', async (req: Request, res: Response) => {
  // Auth: static bearer token
  const key = await leadsApiKey();
  const auth = String(req.headers['authorization'] || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!key) { res.status(503).json({ ok: false, error: 'lead intake not configured' }); return; }
  if (!token || token !== key) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const b = req.body || {};
  const reference = s(b.reference);
  if (!reference) { res.status(400).json({ ok: false, error: 'reference is required (idempotency key)' }); return; }

  const source = s(b.source) || 'website';
  const company = s(b.company) || s(b.name) || 'Website lead';
  const contactName = s(b.name);
  const email = s(b.email);
  const phone = s(b.phone);
  const postcode = s(b.postcode);
  const product = s(b.product);
  const summary = s(b.summary);
  const monthly = num(b.monthly);
  const oneoff = num(b.oneoff);
  let rawDetails: string | null = null;
  try { const j = JSON.stringify(b.details ?? null); rawDetails = (j && j !== 'null' && j !== '{}') ? j : null; } catch { rawDetails = null; }
  const detailsText = [summary, rawDetails ? 'Raw order: ' + rawDetails : null].filter(Boolean).join('\n\n') || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency: same reference -> update + return the existing lead
    const ex = await client.query('SELECT id, customer_id FROM leads WHERE reference = $1 LIMIT 1', [reference]);
    if (ex.rows.length) {
      const id = ex.rows[0].id;
      await client.query(
        `UPDATE leads SET source=$1, product=$2, monthly=$3, oneoff=$4, services_interested=$5,
                          details=$6, estimated_value=$7, deleted_at=NULL, updated_at=NOW() WHERE id=$8`,
        [source, product, monthly, oneoff, summary, detailsText, monthly, id]
      );
      await client.query('COMMIT');
      res.status(200).json({ ok: true, id: String(id), duplicate: true });
      return;
    }

    // New prospect customer (status='lead') + optional primary contact
    const cust = await client.query(
      `INSERT INTO customers (name, status, lead_source, phone, email, postcode) VALUES ($1,'lead',$2,$3,$4,$5) RETURNING id`,
      [company, source, phone, email, postcode]
    );
    const customerId = cust.rows[0].id;
    if (contactName) {
      await client.query(
        `INSERT INTO customer_contacts (customer_id, full_name, email, phone, is_primary) VALUES ($1,$2,$3,$4,true)`,
        [customerId, contactName, email, phone]
      );
    }

    const lead = await client.query(
      `INSERT INTO leads (customer_id, status, source, reference, product, monthly, oneoff, services_interested, details, estimated_value)
       VALUES ($1,'new',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [customerId, source, reference, product, monthly, oneoff, summary, detailsText, monthly]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: String(lead.rows[0].id) });
  } catch (e: any) {
    await client.query('ROLLBACK');
    // Lost a race on the unique reference -> return the row that won.
    if (e && e.code === '23505') {
      try {
        const r = await pool.query('SELECT id FROM leads WHERE reference = $1 LIMIT 1', [reference]);
        if (r.rows.length) { res.status(200).json({ ok: true, id: String(r.rows[0].id), duplicate: true }); return; }
      } catch { /* fall through */ }
    }
    res.status(500).json({ ok: false, error: e.message || 'failed to store lead' });
  } finally {
    client.release();
  }
});

export default router;
