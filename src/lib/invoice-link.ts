// Public per-invoice view link.
//
// Invoices used to go out as an attachment and nothing else, so the only "open" signal we could
// ever have was the tracking pixel — which Outlook suppresses (a real open records nothing) and
// Apple pre-fetches (an unread mail records an open). That is a guess, not evidence. Giving each
// invoice a page of its own on our site means an open is something we served, exactly as the
// signing page already does for contracts and the accept page does for quotes.
import * as crypto from 'crypto';
import { pool } from '../db/pool';
import { config } from '../config';

// Mints the token on first use and reuses it forever after, so a resent invoice keeps the same
// link and the customer's bookmark never dies.
export async function ensureInvoiceViewToken(invoiceId: number): Promise<string | null> {
  try {
    const existing = (await pool.query('SELECT view_token FROM invoices WHERE id=$1 AND deleted_at IS NULL', [invoiceId])).rows[0];
    if (!existing) return null;
    if (existing.view_token) return existing.view_token;
    // COALESCE, not a bare SET: two sends racing each other must not mint two tokens.
    const r = await pool.query(
      'UPDATE invoices SET view_token = COALESCE(view_token, $1) WHERE id=$2 RETURNING view_token',
      [crypto.randomBytes(24).toString('hex'), invoiceId]);
    return r.rows[0]?.view_token || null;
  } catch (e) {
    // A missing link must never stop an invoice going out — the email still carries the PDF.
    console.error('[invoice-link] token mint failed:', (e as Error).message);
    return null;
  }
}

export async function invoiceViewUrl(invoiceId: number): Promise<string | undefined> {
  const t = await ensureInvoiceViewToken(invoiceId);
  return t ? config.APP_URL + '/i/' + t : undefined;
}
