import path from 'path';
import fs from 'fs';
import { pool } from '../db/pool';
import { htmlToPdf } from './pdf';
import { COMMS_CATS } from './comms-billing';
import { getSetting } from './settings';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ejs = require('ejs');

// Red price-increase notice for an invoice — a scheme-specific note (cloud=Microsoft, comms) plus a
// general one, both editable in Settings. Shown like the Direct Debit note but in red.
async function priceNoticeFor(invoice: any): Promise<string> {
  const scheme = invoice && invoice.invoice_scheme;
  const key = scheme === 'CS' ? 'comms' : (scheme === 'IC' ? 'cloud' : 'standard');
  const specific = ((await getSetting('invoice_notices', key)) || '').trim();
  const all = ((await getSetting('invoice_notices', 'all')) || '').trim();
  return [specific, all].filter(Boolean).join(' ');
}

// Centralised invoice PDF rendering so every path (view, resend, recurring auto-send, bill run)
// produces the SAME document — with the billing address resolved from the customer's PRIMARY
// SITE (falling back to any site, then the customer record). Fixes both "no address on invoice"
// and "emailed invoice had no attachment".

let _logo: string | null = null;
function logoDataUri(): string {
  if (_logo === null) {
    try {
      const p = path.join(process.cwd(), 'static', 'lumen-msp-logo.png');
      _logo = fs.existsSync(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : '';
    } catch { _logo = ''; }
  }
  return _logo;
}

export interface InvoiceRender { invoice: any; items: any[]; }

// Load an invoice + items with the billing address coalesced from the primary site.
export async function loadInvoiceForRender(invoiceId: number): Promise<InvoiceRender | null> {
  const r = await pool.query(
    `SELECT i.*, c.name AS customer_name,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.address_line_1 ELSE s.address_line_1 END AS address_line_1,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.address_line_2 ELSE s.address_line_2 END AS address_line_2,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.city           ELSE s.city           END AS city,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.county         ELSE s.county         END AS county,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.postcode       ELSE s.postcode       END AS postcode,
            c.gocardless_mandate_id
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       LEFT JOIN LATERAL (
         SELECT address_line_1, address_line_2, city, county, postcode
           FROM customer_sites WHERE customer_id = i.customer_id
          ORDER BY is_primary DESC, id LIMIT 1
       ) s ON true
      WHERE i.id = $1 AND i.deleted_at IS NULL LIMIT 1`, [invoiceId]
  );
  if (!r.rows.length) return null;
  r.rows[0].address_parts = formatAddressParts(r.rows[0]);
  const items = (await pool.query(
    `SELECT ii.*, ap.name AS product_name FROM invoice_items ii
       LEFT JOIN asset_products ap ON ap.id = ii.product_id
      WHERE ii.invoice_id = $1 ORDER BY ii.sort_order, ii.id`, [invoiceId]
  )).rows;
  return { invoice: r.rows[0], items };
}

// Render an invoice render-object to branded HTML using the shared template. Works for both a
// saved invoice (loadInvoiceForRender) and an UNSAVED preview (a virtual render object built from
// a bill run) — so the on-screen preview is byte-identical to the PDF the customer receives.
export async function renderInvoiceHtml(data: InvoiceRender): Promise<string> {
  const tpl = path.join(process.cwd(), 'src', 'views', 'invoices', 'pdf.ejs');
  const priceNotice = await priceNoticeFor(data.invoice);
  return ejs.renderFile(tpl, {
    invoice: data.invoice, items: data.items, logoUrl: logoDataUri(), hasMandate: !!data.invoice.gocardless_mandate_id, priceNotice,
  });
}

// Render a COMMS invoice to branded HTML. Comms uses its own layout (category sections +
// account-summary breakdown + labels) — different from the standard invoice template, which
// IT & Cloud / normal invoices use. `data` = { invoice, sections, summary }.
export async function renderCommsInvoiceHtml(data: { invoice: any; sections: any[]; summary: any[] }): Promise<string> {
  const tpl = path.join(process.cwd(), 'src', 'views', 'invoices', 'pdf-comms.ejs');
  const priceNotice = await priceNoticeFor(data.invoice);
  return ejs.renderFile(tpl, {
    invoice: data.invoice, sections: data.sections, summary: data.summary,
    logoUrl: logoDataUri(), hasMandate: !!data.invoice.gocardless_mandate_id, priceNotice,
  });
}

// Build the comms render object (sections by category + summary) from a saved invoice's line
// items, so a generated comms invoice's PDF matches the branded on-screen preview.
function buildCommsRender(data: InvoiceRender): { invoice: any; sections: any[]; summary: any[] } {
  const catLabel: Record<string, string> = {}; COMMS_CATS.forEach((c) => { catLabel[c.key] = c.label; });
  const order = COMMS_CATS.map((c) => c.key);
  const byCat = new Map<string, any[]>();
  for (const it of data.items) {
    const cat = it.invoice_category || 'additional';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push({ description: it.description, ref: null, location: null, quantity: Number(it.quantity) || 1, unit_price: Number(it.unit_price) || 0, line_total: Number(it.line_total) || 0 });
  }
  const sections = order.filter((k) => byCat.has(k)).map((k) => { const lines = byCat.get(k)!; return { label: catLabel[k] || k, lines, subtotal: lines.reduce((a, l) => a + l.line_total, 0) }; });
  const known = new Set<string>(order as string[]);
  const extra = Array.from(byCat.entries()).filter(([k]) => !known.has(k)).flatMap(([, v]) => v);
  if (extra.length) sections.push({ label: 'Other', lines: extra, subtotal: extra.reduce((a, l) => a + l.line_total, 0) });
  const summary = sections.map((s) => ({ label: s.label, count: s.lines.length, amount: s.subtotal }));
  return { invoice: data.invoice, sections, summary };
}

// Render the invoice to a PDF Buffer. Comms (scheme 'CS') invoices use the comms category-
// sectioned template (matching the preview); everything else uses the standard template.
export async function renderInvoicePdf(invoiceId: number): Promise<Buffer> {
  const data = await loadInvoiceForRender(invoiceId);
  if (!data) throw new Error('Invoice not found for PDF render');
  let html: string;
  if (data.invoice.invoice_scheme === 'CS') {
    // Comms layout, but never let a template issue block the invoice — fall back to standard.
    try { html = await renderCommsInvoiceHtml(buildCommsRender(data)); }
    catch (e) { console.error('[invoice-pdf] comms template failed, using standard layout:', (e as Error).message); html = await renderInvoiceHtml(data); }
  } else {
    html = await renderInvoiceHtml(data);
  }
  return htmlToPdf(html, { margin: { top: '0', right: '0', bottom: '0', left: '0' } });
}

// Build a clean, de-duplicated set of address lines from a record's address fields.
// Guards against the case where address_line_1 holds a whole formatted address
// (e.g. "Ilges Ln, Cholsey, Wallingford OX10 9PA, UK") AND the city/county/postcode
// columns are ALSO filled — which otherwise prints the town/postcode twice.
export function formatAddressParts(rec: any): string[] {
  if (!rec) return [];
  const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const line1 = String(rec.address_line_1 || '').trim();
  const l1n = norm(line1);
  const out: string[] = [];
  if (line1) out.push(line1);
  for (const v of [rec.address_line_2, rec.city, rec.county, rec.postcode]) {
    const t = String(v || '').trim();
    if (!t) continue;
    const n = norm(t);
    // skip if this part is already contained within line_1, or already added
    if (l1n && n && l1n.includes(n)) continue;
    if (out.some((o) => norm(o) === n)) continue;
    out.push(t);
  }
  return out;
}

// Resolve a customer's billing identity + address the SAME way loadInvoiceForRender does
// (primary site, falling back to the customer record). For building unsaved invoice previews.
export async function customerBillingIdentity(customerId: number): Promise<any> {
  const r = await pool.query(
    `SELECT c.name AS customer_name,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.address_line_1 ELSE s.address_line_1 END AS address_line_1,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.address_line_2 ELSE s.address_line_2 END AS address_line_2,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.city           ELSE s.city           END AS city,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.county         ELSE s.county         END AS county,
            CASE WHEN COALESCE(c.address_line_1,'')<>'' THEN c.postcode       ELSE s.postcode       END AS postcode,
            c.gocardless_mandate_id
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT address_line_1, address_line_2, city, county, postcode
           FROM customer_sites WHERE customer_id = c.id
          ORDER BY is_primary DESC, id LIMIT 1
       ) s ON true
      WHERE c.id = $1 LIMIT 1`, [customerId]
  );
  const row = r.rows[0] || {};
  if (row && row.customer_name !== undefined) row.address_parts = formatAddressParts(row);
  return row;
}
