import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();

// Master search — companies, contacts, tickets, quotes, invoices, services.
// A match on a company's name also surfaces that company's tickets/quotes/invoices/contacts.
async function runSearch(q: string): Promise<{ q: string; groups: any[]; error?: string }> {
  if (q.length < 2) return { q, groups: [] };
  const like = '%' + q + '%';
  try {
    const [cust, cont, tick, quo, inv, svc] = await Promise.all([
      pool.query(
        `SELECT id, name, account_number, status, email
           FROM customers
          WHERE deleted_at IS NULL AND is_placeholder = false
            AND (name ILIKE $1 OR account_number ILIKE $1 OR email ILIKE $1 OR domain ILIKE $1 OR phone ILIKE $1 OR postcode ILIKE $1)
          ORDER BY name LIMIT 8`, [like]),
      pool.query(
        `SELECT ct.id, ct.customer_id, ct.full_name, ct.email, ct.job_title, c.name AS customer_name
           FROM customer_contacts ct
           LEFT JOIN customers c ON c.id = ct.customer_id
          WHERE ct.full_name ILIKE $1 OR ct.email ILIKE $1 OR ct.phone ILIKE $1 OR ct.mobile_phone ILIKE $1 OR c.name ILIKE $1
          ORDER BY ct.full_name LIMIT 8`, [like]),
      pool.query(
        `SELECT t.id, t.ticket_number, t.subject, t.status, c.name AS customer_name
           FROM inbox_tickets t
           LEFT JOIN customers c ON c.id = t.customer_id
           LEFT JOIN customer_contacts ct ON ct.id = t.contact_id
          WHERE t.deleted_at IS NULL AND t.is_spam = false
            AND (t.ticket_number ILIKE $1 OR t.subject ILIKE $1 OR c.name ILIKE $1 OR ct.full_name ILIKE $1)
          ORDER BY t.created_at DESC LIMIT 8`, [like]),
      pool.query(
        `SELECT q.id, q.quote_number, q.title, q.status, q.total, c.name AS customer_name
           FROM quotes q
           LEFT JOIN customers c ON c.id = q.customer_id
          WHERE q.deleted_at IS NULL
            AND (q.quote_number ILIKE $1 OR q.title ILIKE $1 OR c.name ILIKE $1)
          ORDER BY q.created_at DESC LIMIT 8`, [like]),
      pool.query(
        `SELECT i.id, i.invoice_number, i.title, i.status, i.total, c.name AS customer_name
           FROM invoices i
           LEFT JOIN customers c ON c.id = i.customer_id
          WHERE i.deleted_at IS NULL
            AND (i.invoice_number ILIKE $1 OR i.title ILIKE $1 OR c.name ILIKE $1)
          ORDER BY i.issue_date DESC NULLS LAST, i.id DESC LIMIT 8`, [like]),
      pool.query(
        `SELECT DISTINCT ON (si.product_reference, si.customer_id)
                si.product_reference AS ref, si.description, si.source, si.customer_id,
                si.external_customer_name, c.name AS customer_name
           FROM service_items si
           LEFT JOIN customers c ON c.id = si.customer_id
          WHERE si.product_reference IS NOT NULL
            AND (si.product_reference ILIKE $1 OR si.external_customer_id ILIKE $1)
          ORDER BY si.product_reference, si.customer_id LIMIT 10`, [like]),
    ]);

    const money = (v: any) => '£' + (Number(v) || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const groups: any[] = [];

    if (cust.rows.length) groups.push({ type: 'Companies', icon: '🏢', items: cust.rows.map((r) => ({
      label: r.name,
      sub: [r.account_number, r.status, r.email].filter(Boolean).join(' · '),
      url: '/customers/' + r.id,
    })) });

    if (cont.rows.length) groups.push({ type: 'Contacts', icon: '👤', items: cont.rows.map((r) => ({
      label: r.full_name,
      sub: [r.customer_name, r.job_title, r.email].filter(Boolean).join(' · '),
      url: '/contacts/' + r.id,
    })) });

    if (tick.rows.length) groups.push({ type: 'Tickets', icon: '🎫', items: tick.rows.map((r) => ({
      label: r.ticket_number + ' — ' + (r.subject || '(no subject)'),
      sub: [r.customer_name, r.status].filter(Boolean).join(' · '),
      url: '/tickets/' + r.id,
    })) });

    if (quo.rows.length) groups.push({ type: 'Quotes', icon: '📄', items: quo.rows.map((r) => ({
      label: r.quote_number + ' — ' + (r.title || ''),
      sub: [r.customer_name, r.status, money(r.total)].filter(Boolean).join(' · '),
      url: '/quotes/' + r.id,
    })) });

    if (inv.rows.length) groups.push({ type: 'Invoices', icon: '🧾', items: inv.rows.map((r) => ({
      label: r.invoice_number + ' — ' + (r.title || ''),
      sub: [r.customer_name, r.status, money(r.total)].filter(Boolean).join(' · '),
      url: '/invoices/' + r.id,
    })) });

    if (svc.rows.length) groups.push({ type: 'Services (CLI / Ref)', icon: '📞', items: svc.rows.map((r) => ({
      label: r.ref + (r.description ? ' — ' + r.description : ''),
      sub: [r.customer_name || (r.external_customer_name ? r.external_customer_name + ' (unallocated)' : 'Unallocated'), r.source].filter(Boolean).join(' · '),
      url: r.customer_id ? '/customers/' + r.customer_id + '#comms' : '/bureau',
    })) });

    return { q, groups };
  } catch (e) {
    console.error('Master search error:', e);
    return { q, groups: [], error: 'search_failed' };
  }
}

router.get('/search.json', requireAuth, async (req: Request, res: Response) => {
  res.json(await runSearch(((req.query.q as string) || '').trim()));
});

// Full results page — each module's matches laid out horizontally.
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').trim();
  const data = await runSearch(q);
  res.render('search', { user: req.session.user!, q, groups: data.groups, error: data.error || null });
});

export default router;
