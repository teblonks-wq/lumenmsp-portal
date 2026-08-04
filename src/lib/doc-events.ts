// Activity log for customer-facing documents (quotes, contracts, invoices).
//
// The honest bit is `confidence`. Anything that happens on our own site — the customer
// loading the signing page, downloading the PDF, hitting print, signing — is evidence: we
// served the request. An email "open" is not: Outlook blocks remote images by default (so a
// real open often records nothing) and Apple Mail Privacy Protection pre-fetches images the
// moment mail arrives (so an unread email can record an open). Those are stored as
// 'indicative' and shown differently, rather than quietly presented as fact.
import * as crypto from 'crypto';
import { pool } from '../db/pool';

export type DocType = 'quote' | 'contract' | 'invoice';
export type DocEvent =
  | 'sent' | 'reminder_sent' | 'email_opened' | 'opened' | 'downloaded' | 'printed'
  | 'signed' | 'countersigned' | 'accepted' | 'declined';

export interface LogOpts {
  customerId?: number | null;
  actor?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, any> | null;
  confidence?: 'evidence' | 'indicative';
  pixelToken?: string | null;
}

const INDICATIVE: DocEvent[] = ['email_opened'];

export function clientIp(req: any): string {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req?.ip || req?.socket?.remoteAddress || '';
}
export function userAgent(req: any): string {
  return String(req?.headers?.['user-agent'] || '').slice(0, 400);
}

// Never let logging break the thing being logged — a failed insert must not stop a
// customer signing or an invoice going out.
export async function logDocEvent(
  docType: DocType, docId: number, event: DocEvent, opts: LogOpts = {},
): Promise<number | null> {
  try {
    const confidence = opts.confidence || (INDICATIVE.includes(event) ? 'indicative' : 'evidence');
    const { rows } = await pool.query(
      `INSERT INTO document_events (doc_type, doc_id, customer_id, event, confidence, actor, ip, user_agent, meta, pixel_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`,
      [docType, docId, opts.customerId ?? null, event, confidence, opts.actor ?? null,
       opts.ip ?? null, opts.userAgent ?? null, opts.meta ? JSON.stringify(opts.meta) : null,
       opts.pixelToken ?? null]
    );
    return rows[0].id;
  } catch (e) {
    console.error('[doc-events] log failed:', (e as Error).message);
    return null;
  }
}

export function newPixelToken(): string { return crypto.randomBytes(18).toString('hex'); }

// A 1×1 transparent GIF. Smaller than a PNG and every mail client renders it.
export const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export interface DocEventRow {
  id: number; event: string; confidence: string; actor: string | null;
  ip: string | null; user_agent: string | null; meta: any; created_at: Date;
}

export async function getDocEvents(docType: DocType, docId: number): Promise<DocEventRow[]> {
  try {
    const { rows } = await pool.query(
      `SELECT id, event, confidence, actor, ip, user_agent, meta, created_at
         FROM document_events WHERE doc_type=$1 AND doc_id=$2 ORDER BY created_at DESC, id DESC`,
      [docType, docId]);
    return rows;
  } catch { return []; }
}

// Resolve a pixel hit back to the send it belongs to.
// age_secs is computed in SQL so the prefetch check below is not an hour out (BST).
export async function findSendByPixel(token: string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      `SELECT id, doc_type, doc_id, customer_id, actor, created_at,
              EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_secs
         FROM document_events WHERE pixel_token=$1 LIMIT 1`, [token]);
    return rows[0] || null;
  } catch { return null; }
}

// Apple Mail (and some scanners) fetch every image the instant mail lands, which looks
// identical to the recipient opening it. An "open" within this window of the send is
// almost certainly automated, so it is flagged rather than counted.
export const PREFETCH_WINDOW_MS = 15000;

// Invisible tracking image appended to an outbound email body.
export function pixelImg(appUrl: string, token: string): string {
  return `<img src="${appUrl}/e/${token}.gif" width="1" height="1" alt="" ` +
    `style="display:block;width:1px;height:1px;border:0;opacity:0;">`;
}
