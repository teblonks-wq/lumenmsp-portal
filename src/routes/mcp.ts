import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { customerSubscriptions, subscriptionsOverview } from '../lib/ms-subscriptions';

// ── Claude MCP connector (read-only) ──────────────────────────────────────────
// A minimal, dependency-free Model Context Protocol server over Streamable HTTP,
// so Claude (Desktop / claude.ai / mobile) can query the Portal directly as a
// "custom connector" — no Chrome tab, no session, no writes.
//
//   POST /mcp/<MCP_TOKEN>       JSON-RPC 2.0 (initialize, tools/list, tools/call)
//
// Design notes:
// • READ-ONLY by construction: every tool is a SELECT with a LIMIT. There is no
//   code path here that can INSERT/UPDATE/DELETE — safe to expose to an AI client.
// • Auth = capability URL: the path segment must equal env MCP_TOKEN (unset = the
//   whole endpoint is off, 404-style 401s). Claude's custom-connector UI has no
//   header field for API keys, so the token rides in the URL (TLS protects it in
//   transit; treat the full URL as a secret). Compared timing-safe. OAuth is the
//   future hardening if this ever needs per-user identity.
// • Stateless Streamable HTTP: every request is answered with a single JSON body
//   (the spec allows application/json instead of an SSE stream). No session ids,
//   no GET stream — GET/DELETE get 405, which spec-compliant clients tolerate.
// • No MCP SDK: the TypeScript SDK's exports don't resolve under this project's
//   CommonJS/node10 module resolution, and a stateless tools-only server needs
//   very little protocol. Hand-rolled keeps package.json untouched.
// • No session/CSRF involvement: requests carry no session user, so the global
//   CSRF guard in index.ts already exempts them (same as /api/leads).

const router = Router();

// ── Audit — every MCP call is logged (Terry, 2026-08-14: "we need to log everything").
// Fire-and-forget: a logging failure must NEVER break or slow the actual call.
function auditCall(row: { method: string; tool: string | null; args: any; ok: boolean; error: string | null; durationMs: number; ip: string | null }): void {
  pool.query(
    `INSERT INTO mcp_call_log (method, tool, args, ok, error, duration_ms, ip)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)`,
    [row.method, row.tool, row.args != null ? JSON.stringify(row.args) : null, row.ok,
     row.error ? String(row.error).slice(0, 500) : null, row.durationMs, row.ip]
  ).catch((e) => console.error('[mcp] audit log failed:', e.message));
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function tokenOk(supplied: unknown): boolean {
  const secret = (process.env.MCP_TOKEN || '').trim();
  if (!secret || typeof supplied !== 'string' || !supplied) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Small helpers ─────────────────────────────────────────────────────────────
const clampLimit = (v: any, def = 20, max = 50): number => {
  const n = parseInt(String(v ?? ''), 10);
  return isNaN(n) ? def : Math.max(1, Math.min(max, n));
};

// Lumen's financial year ends 30 June and is named by the calendar year it ends in:
// year_ending_june = 2026 means 1 Jul 2025 → 30 Jun 2026. An explicit issued_from /
// issued_to always wins over the shorthand. Both bounds are inclusive dates; callers
// apply the `to` bound as "< to + 1 day" so a timestamp on the closing day still counts.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const invoiceDateRange = (a: any): { from?: string; to?: string; error?: string } => {
  let from: string | undefined;
  let to: string | undefined;
  if (a.year_ending_june !== undefined && String(a.year_ending_june).trim() !== '') {
    const y = parseInt(String(a.year_ending_june), 10);
    if (isNaN(y) || y < 2000 || y > 2100) {
      return { error: `year_ending_june must be a four-digit year such as 2026 (got "${a.year_ending_june}").` };
    }
    from = `${y - 1}-07-01`;
    to = `${y}-06-30`;
  }
  for (const [key, set] of [['issued_from', (v: string) => (from = v)], ['issued_to', (v: string) => (to = v)]] as const) {
    const raw = a[key];
    if (raw === undefined || String(raw).trim() === '') continue;
    const s = String(raw).trim();
    if (!ISO_DATE.test(s)) return { error: `${key} must be a date in YYYY-MM-DD form (got "${s}").` };
    set(s);
  }
  if (from && to && from > to) return { error: `issued_from (${from}) is after issued_to (${to}).` };
  return { from, to };
};
const trunc = (s: any, n = 1500): string | null => {
  if (s === null || s === undefined) return null;
  const t = String(s);
  return t.length > n ? t.slice(0, n) + ` …[truncated, ${t.length} chars total]` : t;
};
// Crude HTML→text for ticket messages that only have body_html.
const stripHtml = (html: any): string =>
  String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Resolve a customer given an id, account number (lar-001) or (partial) name.
type CustomerRef = { id: number } | { ambiguous: any[] } | null;
async function resolveCustomer(ident: any): Promise<CustomerRef> {
  const t = String(ident ?? '').trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const r = await pool.query('SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL', [Number(t)]);
    return r.rows.length ? { id: r.rows[0].id } : null;
  }
  const acc = await pool.query(
    'SELECT id FROM customers WHERE deleted_at IS NULL AND account_number ILIKE $1 LIMIT 2', [t]);
  if (acc.rows.length === 1) return { id: acc.rows[0].id };
  const exact = await pool.query(
    'SELECT id FROM customers WHERE deleted_at IS NULL AND is_placeholder=false AND name ILIKE $1 ORDER BY id LIMIT 2', [t]);
  if (exact.rows.length === 1) return { id: exact.rows[0].id }; // 2+ exact dups fall through to the ambiguous list
  const fuzzy = await pool.query(
    `SELECT id, name, account_number, status FROM customers
      WHERE deleted_at IS NULL AND is_placeholder=false AND name ILIKE $1 ORDER BY name LIMIT 8`, ['%' + t + '%']);
  if (fuzzy.rows.length === 1) return { id: fuzzy.rows[0].id };
  if (fuzzy.rows.length > 1) return { ambiguous: fuzzy.rows };
  return null;
}
// Standard "which customer did you mean?" payload.
const customerNotFound = (ref: CustomerRef, ident: any) =>
  ref && 'ambiguous' in ref
    ? { error: `Multiple customers match "${ident}" — pass the id or account_number.`, candidates: ref.ambiguous }
    : { error: `No customer found matching "${ident}".` };

// ── Tools ─────────────────────────────────────────────────────────────────────
interface Tool {
  name: string;
  description: string;
  inputSchema: any;
  run: (args: any) => Promise<any>;
}

const TOOLS: Tool[] = [
  {
    name: 'search',
    description:
      'Master search across the Portal: companies, contacts, helpdesk tickets, quotes, invoices and comms services (CLI/reference). Same behaviour as the Portal header search. Use this first when you only have a name, number or phrase.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for (min 2 chars) — name, email, ticket/quote/invoice number, phone, postcode, CLI…' } },
      required: ['query'],
    },
    run: async (a) => {
      const q = String(a.query ?? '').trim();
      if (q.length < 2) return { error: 'Query must be at least 2 characters.' };
      const like = '%' + q + '%';
      const [cust, cont, tick, quo, inv, svc] = await Promise.all([
        pool.query(
          `SELECT id, name, account_number, status, email, phone, postcode FROM customers
            WHERE deleted_at IS NULL AND is_placeholder = false
              AND (name ILIKE $1 OR account_number ILIKE $1 OR email ILIKE $1 OR domain ILIKE $1 OR phone ILIKE $1 OR postcode ILIKE $1)
            ORDER BY name LIMIT 8`, [like]),
        pool.query(
          `SELECT ct.id, ct.customer_id, ct.full_name, ct.email, ct.phone, ct.job_title, c.name AS customer_name
             FROM customer_contacts ct LEFT JOIN customers c ON c.id = ct.customer_id
            WHERE ct.full_name ILIKE $1 OR ct.email ILIKE $1 OR ct.phone ILIKE $1 OR ct.mobile_phone ILIKE $1
            ORDER BY ct.full_name LIMIT 8`, [like]),
        pool.query(
          `SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, t.created_at, c.name AS customer_name
             FROM inbox_tickets t LEFT JOIN customers c ON c.id = t.customer_id
            WHERE t.deleted_at IS NULL AND t.is_spam = false
              AND (t.ticket_number ILIKE $1 OR t.subject ILIKE $1)
            ORDER BY t.created_at DESC LIMIT 8`, [like]),
        pool.query(
          `SELECT q.id, q.quote_number, q.title, q.status, q.total, c.name AS customer_name
             FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
            WHERE q.deleted_at IS NULL AND (q.quote_number ILIKE $1 OR q.title ILIKE $1)
            ORDER BY q.created_at DESC LIMIT 8`, [like]),
        pool.query(
          `SELECT i.id, i.invoice_number, i.title, i.status, i.payment_status, i.total, i.balance, c.name AS customer_name
             FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
            WHERE i.deleted_at IS NULL AND (i.invoice_number ILIKE $1 OR i.title ILIKE $1)
            ORDER BY i.issue_date DESC NULLS LAST, i.id DESC LIMIT 8`, [like]),
        pool.query(
          `SELECT DISTINCT ON (si.product_reference, si.customer_id)
                  si.product_reference AS ref, si.description, si.source, si.customer_id,
                  si.external_customer_name, c.name AS customer_name
             FROM service_items si LEFT JOIN customers c ON c.id = si.customer_id
            WHERE si.product_reference IS NOT NULL
              AND (si.product_reference ILIKE $1 OR si.external_customer_id ILIKE $1)
            ORDER BY si.product_reference, si.customer_id LIMIT 10`, [like]),
      ]);
      return {
        query: q,
        companies: cust.rows, contacts: cont.rows, tickets: tick.rows,
        quotes: quo.rows, invoices: inv.rows, services: svc.rows,
      };
    },
  },

  {
    name: 'get_customer',
    description:
      'Full read-only overview of one customer: company details, contacts, open helpdesk tickets, recent invoices and outstanding balance. Accepts a customer id, account number (e.g. lar-001) or company name.',
    inputSchema: {
      type: 'object',
      properties: { customer: { type: 'string', description: 'Customer id, account number or (partial) company name' } },
      required: ['customer'],
    },
    run: async (a) => {
      const ref = await resolveCustomer(a.customer);
      if (!ref || 'ambiguous' in ref) return customerNotFound(ref, a.customer);
      const id = ref.id;
      const [row, contacts, tickets, invoices, owed] = await Promise.all([
        pool.query(
          `SELECT id, account_number, name, status, email, phone, website, domain,
                  address_line_1, address_line_2, city, county, postcode,
                  is_itsm, has_internet, has_phones, has_cloud, portal_enabled,
                  legal_name, company_number, vat_number,
                  (gocardless_mandate_id IS NOT NULL) AS has_dd_mandate,
                  (quickbooks_customer_id IS NOT NULL) AS linked_to_quickbooks,
                  created_at FROM customers WHERE id=$1`, [id]),
        pool.query(
          `SELECT full_name, job_title, email, phone, mobile_phone, is_primary
             FROM customer_contacts WHERE customer_id=$1 ORDER BY is_primary DESC, full_name LIMIT 15`, [id]),
        pool.query(
          `SELECT ticket_number, subject, status, priority, department, created_at, updated_at
             FROM inbox_tickets
            WHERE customer_id=$1 AND deleted_at IS NULL AND is_spam=false
              AND status NOT IN ('resolved','closed')
            ORDER BY updated_at DESC LIMIT 15`, [id]),
        pool.query(
          `SELECT invoice_number, title, status, payment_status, total, balance, issue_date, due_date
             FROM invoices
            WHERE customer_id=$1 AND deleted_at IS NULL AND staged=false
            ORDER BY issue_date DESC NULLS LAST, id DESC LIMIT 12`, [id]),
        pool.query(
          `SELECT COALESCE(SUM(balance),0)::numeric(12,2) AS outstanding, COUNT(*)::int AS unpaid_invoices
             FROM invoices
            WHERE customer_id=$1 AND deleted_at IS NULL AND staged=false AND status='issued' AND balance > 0`, [id]),
      ]);
      return {
        customer: row.rows[0],
        outstanding_gbp: owed.rows[0].outstanding,
        unpaid_invoice_count: owed.rows[0].unpaid_invoices,
        contacts: contacts.rows,
        open_tickets: tickets.rows,
        recent_invoices: invoices.rows,
      };
    },
  },

  {
    name: 'list_tickets',
    description:
      'List helpdesk tickets/cases, newest activity first. Filter by state (open/closed/all or an exact status: new, open, in_progress, pending, resolved, closed), customer, or assigned engineer name.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: "Default 'open' (= not resolved/closed). Also 'closed', 'all', or an exact status value." },
        customer: { type: 'string', description: 'Customer id, account number or name (optional)' },
        assigned_to: { type: 'string', description: 'Engineer display name, partial ok (optional)' },
        limit: { type: 'number', description: 'Max rows, default 20, max 50' },
      },
    },
    run: async (a) => {
      const where: string[] = ['t.deleted_at IS NULL', 't.is_spam=false'];
      const params: any[] = [];
      const state = String(a.state ?? 'open').trim().toLowerCase();
      if (state === 'open') where.push("t.status NOT IN ('resolved','closed')");
      else if (state === 'closed') where.push("t.status IN ('resolved','closed')");
      else if (state !== 'all') { params.push(state); where.push(`t.status = $${params.length}`); }
      if (a.customer !== undefined && String(a.customer).trim() !== '') {
        const ref = await resolveCustomer(a.customer);
        if (!ref || 'ambiguous' in ref) return customerNotFound(ref, a.customer);
        params.push(ref.id); where.push(`t.customer_id = $${params.length}`);
      }
      if (a.assigned_to) { params.push('%' + String(a.assigned_to).trim() + '%'); where.push(`u.display_name ILIKE $${params.length}`); }
      params.push(clampLimit(a.limit));
      const r = await pool.query(
        `SELECT t.ticket_number, t.subject, t.status, t.priority, t.stage, t.department, t.source,
                c.name AS customer_name, u.display_name AS assigned_to, t.created_at, t.updated_at
           FROM inbox_tickets t
           LEFT JOIN customers c ON c.id = t.customer_id
           LEFT JOIN users u ON u.id = t.assigned_user_id
          WHERE ${where.join(' AND ')}
          ORDER BY t.updated_at DESC LIMIT $${params.length}`, params);
      return { count: r.rows.length, tickets: r.rows };
    },
  },

  {
    name: 'get_ticket',
    description:
      'Full read-only detail of one helpdesk ticket/case by ticket number (e.g. LIT-12345) or id: header, recent messages (email/Teams/WhatsApp) and internal notes.',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'string', description: 'Ticket number or numeric id' } },
      required: ['ticket'],
    },
    run: async (a) => {
      const t = String(a.ticket ?? '').trim();
      const byId = /^\d+$/.test(t);
      const head = await pool.query(
        `SELECT t.id, t.ticket_number, t.subject, t.description, t.status, t.priority, t.stage,
                t.category, t.department, t.source, t.mailbox,
                c.id AS customer_id, c.name AS customer_name,
                ct.full_name AS contact_name, ct.email AS contact_email,
                u.display_name AS assigned_to,
                t.created_at, t.updated_at, t.last_customer_message_at, t.last_public_reply_at, t.closed_at
           FROM inbox_tickets t
           LEFT JOIN customers c ON c.id = t.customer_id
           LEFT JOIN customer_contacts ct ON ct.id = t.contact_id
           LEFT JOIN users u ON u.id = t.assigned_user_id
          WHERE t.deleted_at IS NULL AND ${byId ? 't.id = $1' : 't.ticket_number ILIKE $1'} LIMIT 1`,
        [byId ? Number(t) : t]);
      if (!head.rows.length) return { error: `No ticket found matching "${t}".` };
      const tk = head.rows[0];
      const [msgs, notes] = await Promise.all([
        pool.query(
          `SELECT message_direction, channel, from_name, from_email, subject, body_text, body_html,
                  has_attachments, received_at, created_at
             FROM inbox_messages WHERE ticket_id=$1
            ORDER BY COALESCE(received_at, created_at) DESC LIMIT 15`, [tk.id]),
        pool.query(
          `SELECT n.note_type, n.channel, n.body, n.created_at, u.display_name AS author
             FROM inbox_notes n LEFT JOIN users u ON u.id = n.user_id
            WHERE n.ticket_id=$1 ORDER BY n.created_at DESC LIMIT 15`, [tk.id]),
      ]);
      return {
        ticket: tk,
        // Oldest→newest reads naturally; bodies trimmed to keep responses small.
        messages: msgs.rows.reverse().map((m) => ({
          direction: m.message_direction, channel: m.channel,
          from: [m.from_name, m.from_email].filter(Boolean).join(' '),
          subject: m.subject, has_attachments: m.has_attachments,
          at: m.received_at || m.created_at,
          body: trunc(m.body_text && String(m.body_text).trim() ? m.body_text : stripHtml(m.body_html)),
        })),
        notes: notes.rows.reverse().map((n) => ({
          type: n.note_type, channel: n.channel, author: n.author, at: n.created_at, body: trunc(n.body),
        })),
      };
    },
  },

  {
    name: 'list_invoices',
    description:
      'List invoices, newest first (staged bureau drafts excluded). Filter by customer, status (draft/issued/paid/void), payment status (unpaid/pending/paid/failed), unpaid_only, billing period (YYYY-MM), an issue-date range, or a financial year ending 30 June. Pages with offset/next_offset — keep paging until next_offset is null to reach the very first invoice. Each row carries subtotal (net of VAT) as well as total (gross); use subtotal for turnover. For totals rather than rows, prefer turnover_summary — it aggregates in one call with no paging.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: { type: 'string', description: 'Customer id, account number or name (optional)' },
        status: { type: 'string', description: 'draft | issued | paid | void (optional)' },
        payment_status: { type: 'string', description: 'unpaid | pending | paid | failed (optional)' },
        unpaid_only: { type: 'boolean', description: 'Only issued invoices with an outstanding balance' },
        billing_period: { type: 'string', description: 'Comms bill-run period YYYY-MM (optional)' },
        issued_from: { type: 'string', description: 'Earliest issue date, YYYY-MM-DD inclusive (optional)' },
        issued_to: { type: 'string', description: 'Latest issue date, YYYY-MM-DD inclusive (optional)' },
        year_ending_june: { type: 'number', description: "Lumen's financial year, named by the calendar year it ends in: 2026 means 1 Jul 2025 to 30 Jun 2026. Shorthand for issued_from/issued_to (optional)." },
        limit: { type: 'number', description: 'Max rows per page, default 50, max 500' },
        offset: { type: 'number', description: 'Rows to skip. Start at 0 and pass back the next_offset from the previous response.' },
      },
    },
    run: async (a) => {
      const where: string[] = ['i.deleted_at IS NULL', 'i.staged = false'];
      const params: any[] = [];
      if (a.customer !== undefined && String(a.customer).trim() !== '') {
        const ref = await resolveCustomer(a.customer);
        if (!ref || 'ambiguous' in ref) return customerNotFound(ref, a.customer);
        params.push(ref.id); where.push(`i.customer_id = $${params.length}`);
      }
      if (a.status) { params.push(String(a.status).trim().toLowerCase()); where.push(`i.status = $${params.length}`); }
      if (a.payment_status) { params.push(String(a.payment_status).trim().toLowerCase()); where.push(`i.payment_status = $${params.length}`); }
      if (a.unpaid_only) where.push("i.status='issued' AND i.balance > 0");
      if (a.billing_period) { params.push(String(a.billing_period).trim()); where.push(`i.billing_period = $${params.length}`); }
      const range = invoiceDateRange(a);
      if (range.error) return { error: range.error };
      if (range.from) { params.push(range.from); where.push(`i.issue_date >= $${params.length}::date`); }
      if (range.to) { params.push(range.to); where.push(`i.issue_date < ($${params.length}::date + INTERVAL '1 day')`); }

      // Count with the filter params only, then append paging params for the page query.
      const filterParams = params.slice();
      params.push(clampLimit(a.limit, 50, 500)); const pLimit = params.length;
      params.push(Math.max(0, parseInt(String(a.offset ?? 0), 10) || 0)); const pOffset = params.length;
      const offset = params[pOffset - 1] as number;

      const [r, tot] = await Promise.all([
        pool.query(
          `SELECT i.invoice_number, i.title, i.status, i.payment_status, i.invoice_scheme,
                  i.subtotal, i.tax_total, i.total, i.balance, i.issue_date, i.due_date, i.billing_period,
                  i.is_recurring, c.name AS customer_name
             FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
            WHERE ${where.join(' AND ')}
            ORDER BY i.issue_date DESC NULLS LAST, i.id DESC
            LIMIT $${pLimit} OFFSET $${pOffset}`, params),
        pool.query(
          `SELECT COUNT(*)::int AS n
             FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
            WHERE ${where.join(' AND ')}`, filterParams),
      ]);
      const matched = tot.rows[0].n as number;
      return {
        count: r.rows.length,
        total_matching: matched,
        offset,
        next_offset: offset + r.rows.length < matched ? offset + r.rows.length : null,
        invoices: r.rows,
      };
    },
  },

  {
    name: 'turnover_summary',
    description:
      'Aggregated sales turnover, net of VAT, computed in a single query with no paging. Group by financial_year (Lumen\'s year ends 30 June), month, customer or scheme, and optionally scope to one financial year, a date range, or one customer. Voids are always excluded; drafts are included by default (some real billed revenue sits in draft) and the internal Lumen MSP account is excluded by default. This is the right tool for "what was our turnover" — list_invoices is for the underlying rows.',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', description: 'financial_year (default) | month | customer | scheme' },
        year_ending_june: { type: 'number', description: "Scope to one financial year, named by the calendar year it ends in: 2026 means 1 Jul 2025 to 30 Jun 2026 (optional)" },
        issued_from: { type: 'string', description: 'Earliest issue date, YYYY-MM-DD inclusive (optional)' },
        issued_to: { type: 'string', description: 'Latest issue date, YYYY-MM-DD inclusive (optional)' },
        customer: { type: 'string', description: 'Scope to one customer id, account number or name (optional)' },
        include_drafts: { type: 'boolean', description: 'Include invoices still in draft status. Default true.' },
        include_internal: { type: 'boolean', description: 'Include the internal "Lumen MSP" account. Default false.' },
      },
    },
    run: async (a) => {
      const by = String(a.group_by ?? 'financial_year').trim().toLowerCase();
      const dims: Record<string, { expr: string; label: string }> = {
        financial_year: { expr: `EXTRACT(YEAR FROM (i.issue_date + INTERVAL '6 months'))::int`, label: 'financial_year_ending_30_june' },
        month:          { expr: `to_char(i.issue_date, 'YYYY-MM')`, label: 'month' },
        customer:       { expr: `COALESCE(c.name, '(no customer)')`, label: 'customer' },
        scheme:         { expr: `COALESCE(i.invoice_scheme, '(none)')`, label: 'scheme' },
      };
      const dim = dims[by];
      if (!dim) return { error: `Unknown group_by "${a.group_by}". Use financial_year, month, customer or scheme.` };

      const where: string[] = [
        'i.deleted_at IS NULL', 'i.staged = false', "i.status <> 'void'", 'i.issue_date IS NOT NULL',
      ];
      const params: any[] = [];
      if (a.include_drafts === false) where.push("i.status <> 'draft'");
      if (a.include_internal !== true) where.push(`COALESCE(c.name, '') NOT ILIKE 'Lumen MSP'`);
      if (a.customer !== undefined && String(a.customer).trim() !== '') {
        const ref = await resolveCustomer(a.customer);
        if (!ref || 'ambiguous' in ref) return customerNotFound(ref, a.customer);
        params.push(ref.id); where.push(`i.customer_id = $${params.length}`);
      }
      const range = invoiceDateRange(a);
      if (range.error) return { error: range.error };
      if (range.from) { params.push(range.from); where.push(`i.issue_date >= $${params.length}::date`); }
      if (range.to) { params.push(range.to); where.push(`i.issue_date < ($${params.length}::date + INTERVAL '1 day')`); }

      // subtotal is the VAT-exclusive figure; fall back to total - tax for any legacy row that lacks it.
      const net = `COALESCE(i.subtotal, i.total - COALESCE(i.tax_total, 0))`;
      const r = await pool.query(
        `SELECT ${dim.expr} AS bucket,
                COUNT(*)::int AS invoices,
                SUM(${net})::numeric(14,2) AS net_ex_vat,
                SUM(i.total)::numeric(14,2) AS gross_inc_vat,
                MIN(i.issue_date) AS first_invoice,
                MAX(i.issue_date) AS last_invoice
           FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
          WHERE ${where.join(' AND ')}
          GROUP BY 1
          ORDER BY ${by === 'customer' || by === 'scheme' ? '3 DESC NULLS LAST' : '1'}`, params);

      const totalNet = r.rows.reduce((s: number, x: any) => s + Number(x.net_ex_vat || 0), 0);
      return {
        grouped_by: dim.label,
        basis: 'Sales invoices by issue date, net of VAT. Voids excluded' +
               (a.include_drafts === false ? ', drafts excluded' : ', drafts included') +
               (a.include_internal === true ? ', internal account included.' : ', internal Lumen MSP account excluded.'),
        total_net_ex_vat: Number(totalNet.toFixed(2)),
        rows: r.rows,
      };
    },
  },

  {
    name: 'get_invoice',
    description:
      'Full read-only detail of one invoice by invoice number (e.g. IT-2026-0006) or id: header, line items, totals, and payment state including GoCardless Direct Debit info.',
    inputSchema: {
      type: 'object',
      properties: { invoice: { type: 'string', description: 'Invoice number or numeric id' } },
      required: ['invoice'],
    },
    run: async (a) => {
      const t = String(a.invoice ?? '').trim();
      const byId = /^\d+$/.test(t);
      const head = await pool.query(
        `SELECT i.id, i.invoice_number, i.title, i.status, i.payment_status, i.invoice_scheme,
                i.payment_method, i.subtotal, i.tax_total, i.total, i.balance, i.currency_code,
                i.issue_date, i.due_date, i.emailed_at, i.billing_period,
                i.is_recurring, i.recurring_name, i.recurring_parent_id,
                i.gocardless_payment_id, i.gocardless_payout_ref, i.gocardless_paid_out_at,
                i.quickbooks_invoice_id, i.payment_synced_at, i.notes,
                c.id AS customer_id, c.name AS customer_name, c.account_number
           FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
          WHERE i.deleted_at IS NULL AND ${byId ? 'i.id = $1' : 'i.invoice_number ILIKE $1'} LIMIT 1`,
        [byId ? Number(t) : t]);
      if (!head.rows.length) return { error: `No invoice found matching "${t}".` };
      const inv = head.rows[0];
      const items = await pool.query(
        `SELECT sort_order, invoice_category, description, quantity, unit_price, tax_rate, line_total, source
           FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order, id LIMIT 200`, [inv.id]);
      return { invoice: inv, items: items.rows };
    },
  },

  {
    name: 'outstanding_invoices',
    description:
      'Money owed to Lumen right now: every issued invoice with an outstanding balance, grouped per customer with totals, largest debt first. No arguments.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const [byCustomer, total] = await Promise.all([
        pool.query(
          `SELECT c.id AS customer_id, c.name AS customer, c.account_number,
                  COUNT(*)::int AS unpaid_invoices,
                  SUM(i.balance)::numeric(12,2) AS outstanding,
                  MIN(i.due_date) AS oldest_due_date
             FROM invoices i JOIN customers c ON c.id = i.customer_id
            WHERE i.deleted_at IS NULL AND i.staged=false AND i.status='issued' AND i.balance > 0
            GROUP BY c.id, c.name, c.account_number
            ORDER BY outstanding DESC`),
        pool.query(
          `SELECT COALESCE(SUM(balance),0)::numeric(12,2) AS total, COUNT(*)::int AS invoices
             FROM invoices WHERE deleted_at IS NULL AND staged=false AND status='issued' AND balance > 0`),
      ]);
      return { total_outstanding_gbp: total.rows[0].total, unpaid_invoice_count: total.rows[0].invoices, by_customer: byCustomer.rows };
    },
  },

  {
    name: 'list_contracts',
    description:
      'Contracts for one customer (or across the estate). Each row: number, title, status, service type, term dates, monthly recurring value and line count. Pass a customer id / account number / name to scope it, or omit to list recent contracts. Contracts are the durable agreement of what a customer pays monthly; use get_contract for the lines.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: { type: 'string', description: 'Customer id, account number or name (optional — omit to list recent across the estate)' },
        status: { type: 'string', description: 'draft | active | expired | cancelled (optional)' },
        limit: { type: 'number', description: 'Max rows, default 25, max 100' },
      },
    },
    run: async (a) => {
      const params: any[] = [];
      const where: string[] = ['ct.deleted_at IS NULL'];
      if (a.customer != null && String(a.customer).trim() !== '') {
        const ref = await resolveCustomer(a.customer);
        if (!ref || 'ambiguous' in ref) return customerNotFound(ref, a.customer);
        params.push(ref.id); where.push(`ct.customer_id = $${params.length}`);
      }
      if (a.status) { params.push(String(a.status)); where.push(`ct.status = $${params.length}`); }
      const lim = Math.min(Math.max(parseInt(String(a.limit ?? 25), 10) || 25, 1), 100);
      params.push(lim);
      const rows = (await pool.query(
        `SELECT ct.id, ct.contract_number, ct.title, ct.status, ct.service_type,
                ct.start_date, ct.end_date, ct.support_cover, c.name AS customer_name,
                (SELECT COUNT(*)::int FROM contract_lines cl WHERE cl.contract_id=ct.id) AS line_count,
                (SELECT COALESCE(SUM(CASE WHEN cl.billing_frequency='annual' THEN cl.line_total/12
                                          WHEN cl.billing_frequency='one_off' THEN 0
                                          ELSE cl.line_total END),0)::numeric(12,2)
                   FROM contract_lines cl WHERE cl.contract_id=ct.id) AS monthly_value
           FROM contracts ct LEFT JOIN customers c ON c.id=ct.customer_id
          WHERE ${where.join(' AND ')}
          ORDER BY c.name NULLS LAST, ct.contract_number
          LIMIT $${params.length}`, params)).rows;
      return { count: rows.length, contracts: rows };
    },
  },

  {
    name: 'get_contract',
    description:
      'Full detail of one contract by number (e.g. CON-0007) or id: header (status, service type, term, support cover, renewal) and every line with its section (IT / Cloud / Backup / Comms / Hardware), quantity, unit price, billing frequency and line total. This is how a customer\'s monthly agreement is structured, including how cloud licences are laid out.',
    inputSchema: {
      type: 'object',
      properties: { contract: { type: 'string', description: 'Contract number or numeric id' } },
      required: ['contract'],
    },
    run: async (a) => {
      const t = String(a.contract ?? '').trim();
      if (!t) return { error: 'Pass a contract number or id.' };
      const byId = /^\d+$/.test(t);
      const head = (await pool.query(
        `SELECT ct.id, ct.contract_number, ct.title, ct.status, ct.service_type,
                ct.start_date, ct.end_date, ct.term_months, ct.notice_days, ct.auto_renew,
                ct.renewal_mode, ct.current_doc_kind, ct.support_cover, ct.payment_method,
                ct.version, ct.notes, c.id AS customer_id, c.name AS customer_name, c.account_number
           FROM contracts ct LEFT JOIN customers c ON c.id=ct.customer_id
          WHERE ct.deleted_at IS NULL AND ${byId ? 'ct.id = $1' : 'ct.contract_number ILIKE $1'} LIMIT 1`,
        [byId ? Number(t) : t])).rows[0];
      if (!head) return { error: `No contract found matching "${t}".` };
      const lines = (await pool.query(
        `SELECT sort_order, section, description, quantity, unit_price, billing_frequency,
                line_total, detail, term_start, term_end
           FROM contract_lines WHERE contract_id=$1 ORDER BY sort_order, id LIMIT 200`, [head.id])).rows;
      const monthly = lines.reduce((s: number, l: any) =>
        s + (l.billing_frequency === 'annual' ? Number(l.line_total) / 12
           : l.billing_frequency === 'one_off' ? 0 : Number(l.line_total)), 0);
      return { contract: head, lines, monthly_recurring: Math.round(monthly * 100) / 100 };
    },
  },

  {
    name: 'list_subscriptions',
    description:
      'Microsoft / NCE subscriptions mirrored from Giacom. Each row: product, seats, term (Annual = a committed 12-month partner obligation; Monthly = flexible), Microsoft renewalDate, cancellableUntil (penalty-free cancel window), monthly buy, and an exposure state (covered / exposed / flexible / unmatched). "exposed" = an Annual term with no contract cover to its renewal date — the customer could leave mid-term and leave Lumen carrying the residual. Scope by customer, or omit for the estate.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: { type: 'string', description: 'Customer id, account number or name (optional — omit for the whole estate)' },
        exposed_only: { type: 'boolean', description: 'Only return subscriptions flagged as exposed (default false)' },
      },
    },
    run: async (a) => {
      const compact = (s: any) => ({
        product: s.name, seats: s.licences, term: s.term, state: s.state, reason: s.reason,
        renewal_date: s.renewalDate, cancellable_until: s.cancellableUntil,
        days_to_renewal: s.daysToRenewal, days_to_cancellable: s.daysToCancellable,
        monthly_buy: s.monthlyBuy, is_nce: s.isNce, status: s.status,
      });
      if (a.customer != null && String(a.customer).trim() !== '') {
        const ref = await resolveCustomer(a.customer);
        if (!ref || 'ambiguous' in ref) return customerNotFound(ref, a.customer);
        const cs = await customerSubscriptions(ref.id);
        const cname = (await pool.query('SELECT name FROM customers WHERE id=$1', [ref.id])).rows[0]?.name || null;
        let subs = cs.subs;
        if (a.exposed_only) subs = subs.filter((x) => x.state === 'exposed');
        return { customer: cname, cover_end: cs.coverEnd, totals: cs.totals, count: subs.length, subscriptions: subs.map(compact) };
      }
      const ov = await subscriptionsOverview();
      const out: any[] = [];
      for (const g of ov.customers) for (const s of g.subs) {
        if (a.exposed_only && s.state !== 'exposed') continue;
        out.push({ customer: g.name, ...compact(s) });
      }
      return { last_sync: ov.lastSync, totals: ov.totals, count: out.length, subscriptions: out.slice(0, 300) };
    },
  },

  {
    name: 'subscription_exposure',
    description:
      'NCE exposure summary across the estate: how many Annual (committed) subscriptions have no contract cover to their Microsoft renewal date, grouped by customer worst-first. This is the "where could we be left out of pocket if a customer leaves mid-term" view. Each customer: seats, committed count, exposed count, monthly buy, contract cover end, and the exposed products with their renewal dates.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const ov = await subscriptionsOverview();
      const exposed = ov.customers.filter((g) => g.exposed > 0).map((g) => ({
        customer: g.name, seats: g.seats, committed: g.committed, exposed: g.exposed,
        monthly_buy: g.monthlyBuy, cover_end: g.coverEnd,
        subscriptions: g.subs.filter((s) => s.state === 'exposed').map((s) => ({
          product: s.name, seats: s.licences, renewal_date: s.renewalDate,
          cancellable_until: s.cancellableUntil, monthly_buy: s.monthlyBuy, reason: s.reason,
        })),
      }));
      return { last_sync: ov.lastSync, totals: ov.totals, exposed_customers: exposed.length, customers: exposed };
    },
  },
];

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────────
const rpcOk = (id: any, result: any) => ({ jsonrpc: '2.0' as const, id, result });
const rpcErr = (id: any, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } });

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function handleRpc(msg: any, ctx: { ip: string | null }): Promise<any | null> {
  const id = msg && msg.id !== undefined ? msg.id : undefined;
  const method = msg && typeof msg.method === 'string' ? msg.method : '';
  if (!msg || msg.jsonrpc !== '2.0' || !method) {
    return id === undefined ? null : rpcErr(id, -32600, 'Invalid request');
  }
  if (id === undefined) return null; // notification (e.g. notifications/initialized) — nothing to do

  try {
    switch (method) {
      case 'initialize': {
        const requested = String(msg.params?.protocolVersion || '');
        return rpcOk(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'LumenMSP Portal', version: '1.0.0' },
          instructions:
            'Read-only access to the LumenMSP Portal (Lumen IT Solutions): customers, contacts, helpdesk tickets, invoices and billing state. All money values are GBP. Nothing here can modify Portal data. Start with the search tool when you only have a name or number.',
        });
      }
      case 'ping':
        return rpcOk(id, {});
      case 'tools/list':
        return rpcOk(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const name = String(msg.params?.name || '');
        const args = msg.params?.arguments || {};
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) { auditCall({ method, tool: name, args, ok: false, error: 'unknown tool', durationMs: 0, ip: ctx.ip }); return rpcErr(id, -32602, `Unknown tool: ${name}`); }
        const started = Date.now();
        try {
          const result = await tool.run(args);
          // A tool may hand back { error } for a soft failure (no customer found etc.) — record that too.
          const soft = result && typeof result === 'object' && 'error' in result ? String((result as any).error) : null;
          auditCall({ method, tool: name, args, ok: !soft, error: soft, durationMs: Date.now() - started, ip: ctx.ip });
          return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
        } catch (e: any) {
          auditCall({ method, tool: name, args, ok: false, error: e?.message || String(e), durationMs: Date.now() - started, ip: ctx.ip });
          // Tool-level failure → isError result (not a protocol error), per spec.
          return rpcOk(id, { content: [{ type: 'text', text: `Tool error: ${e?.message || e}` }], isError: true });
        }
      }
      // Be lenient with clients that probe these despite our capabilities saying tools-only.
      case 'resources/list':
        return rpcOk(id, { resources: [] });
      case 'resources/templates/list':
        return rpcOk(id, { resourceTemplates: [] });
      case 'prompts/list':
        return rpcOk(id, { prompts: [] });
      default:
        return rpcErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return rpcErr(id, -32603, `Internal error: ${e?.message || e}`);
  }
}

// ── HTTP endpoint ─────────────────────────────────────────────────────────────
router.post('/mcp/:token', async (req: Request, res: Response) => {
  if (!tokenOk(req.params.token)) {
    res.status(401).json(rpcErr(null, -32000, 'Unauthorized'));
    return;
  }
  const body = req.body;
  const isBatch = Array.isArray(body);
  const msgs: any[] = isBatch ? body : [body];
  const ip = String(req.ip || req.headers['x-forwarded-for'] || '').replace(/^::ffff:/, '').split(',')[0].trim() || null;
  const responses = (await Promise.all(msgs.map((m) => handleRpc(m, { ip })))).filter((r) => r !== null);
  if (!responses.length) { res.status(202).end(); return; } // notifications only
  res.status(200).json(isBatch ? responses : responses[0]);
});

// Streamable HTTP allows a server to refuse the SSE stream — 405 tells the client
// to stick to plain POST request/response, which is all this stateless server needs.
router.all('/mcp/:token', (req: Request, res: Response) => {
  if (!tokenOk(req.params.token)) { res.status(401).json(rpcErr(null, -32000, 'Unauthorized')); return; }
  res.status(405).set('Allow', 'POST').json(rpcErr(null, -32000, 'Method not allowed — POST only'));
});

// ── The MCP audit log — staff view (admin only, session-guarded) ────────────────
// Separate from the token endpoint above: this is Terry reading what the connector did.
router.get('/mcp-log', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const tool = String(req.query.tool || '').trim() || null;
  const rows = (await pool.query(
    `SELECT id, method, tool, args, ok, error, duration_ms, ip, created_at
       FROM mcp_call_log WHERE ($1::text IS NULL OR tool=$1)
      ORDER BY created_at DESC LIMIT 300`, [tool])).rows;
  const tools = (await pool.query(
    `SELECT tool, COUNT(*)::int n, MAX(created_at) last FROM mcp_call_log
      WHERE tool IS NOT NULL GROUP BY tool ORDER BY n DESC`)).rows;
  res.render('mcp-log', { user: req.session.user!, rows, tools, tool });
});

export default router;
