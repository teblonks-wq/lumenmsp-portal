import { pool } from '../db/pool';
import { QuickBooks } from './quickbooks';

// ── Purchase matching intelligence ────────────────────────────────────────────────
// Shared knowledge for the purchase ledger, distilled from the Aug 2026 manual
// reconciliation of Starling vs the supplier-invoice pool:
//  • statement descriptors rarely match the invoice sender — billers bill through
//    processors (FastSpring bills MSP360, BlueSnap bills Atera, Paddle bills
//    CrashPlan, Stripe bills Ubiquiti, DWS is Giacom, Aventis collects the
//    Gemini House rent invoiced by Re-Leased/Hurstwood);
//  • Direct Debit suppliers collect up to ~6 weeks AFTER the invoice date
//    (Giacom ~2-4 weeks, Grosvenor ~3 weeks, Atera can collect BEFORE the invoice);
//  • USD-billed card charges (Anthropic/CrashPlan/MSP360) land in GBP at a
//    0.68–0.95 ratio of the invoice total, so exact-amount matching misses them.
// Nothing here ever force-matches: low confidence is left for a human.

// Statement-descriptor aliases: regex on counterparty+reference → extra supplier
// tokens to look for in the invoice sender/filename. Keep lowercase.
export const COUNTERPARTY_ALIASES: Array<{ pattern: RegExp; tokens: string[] }> = [
  { pattern: /digital wholesale|giacom/i,        tokens: ['giacom', 'dws'] },
  { pattern: /bluesnap|atera/i,                  tokens: ['atera'] },
  { pattern: /idm-?inet/i,                       tokens: ['atera', 'splashtop'] }, // Splashtop SOS bought through Atera
  { pattern: /fastspring|msp360/i,               tokens: ['msp360', 'fastspring'] },
  { pattern: /paddle/i,                          tokens: ['crashplan', 'paddle'] },
  { pattern: /aventis/i,                         tokens: ['re-leased', 'releashed', 'hurstwood', 'rent', 'gemini'] }, // rent collector
  { pattern: /gocardless/i,                      tokens: ['pi accountancy', 'intuit', 'piaccountanc'] },
  { pattern: /ubiquiti/i,                        tokens: ['ubiquiti', 'stripe'] }, // Ubiquiti bills via Stripe
  { pattern: /grosvenor/i,                       tokens: ['grosvenor'] },
  { pattern: /re-?leased|hurstwood|gemini/i,     tokens: ['re-leased', 'hurstwood'] },
  { pattern: /anthropic|claude/i,                tokens: ['anthropic'] },
  { pattern: /thirsty/i,                         tokens: ['thirsty'] },
];

// Suppliers that bill in USD to a GBP card — allow a fuzzy FX-ratio match.
const FX_TOKEN = /anthropic|crashplan|paddle|msp360|fastspring/i;
export const FX_MIN = 0.68, FX_MAX = 0.95;

export function aliasTokensFor(counterpartyAndRef: string): string[] {
  const out: string[] = [];
  for (const a of COUNTERPARTY_ALIASES) if (a.pattern.test(counterpartyAndRef)) out.push(...a.tokens);
  return out;
}

export function isFxBilled(hay: string): boolean { return FX_TOKEN.test(hay); }

// Transactions that will NEVER have a supplier invoice — tax, financing, payroll,
// transfers. classify() returns a label used to SUGGEST (never auto-apply) so the
// reconcile screen can offer one-click "no invoice expected" handling.
const NO_INVOICE_CLASSES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /hmrc/i,                                              label: 'Tax (HMRC) — no invoice expected' },
  { pattern: /pipe technologies|aventis capital(?!.*rent)|mbna|capitalise|debt revenue/i, label: 'Financing / card payment — agreement, not an invoice' },
  { pattern: /gocardless.*fee/i,                                   label: 'GoCardless fees — invoice in GC dashboard' },
];
export function classifyNoInvoice(desc: string): string | null {
  for (const c of NO_INVOICE_CLASSES) if (c.pattern.test(desc)) return c.label;
  return null;
}

// ── History-based auto-categorisation ────────────────────────────────────────────
// "How did we categorise this payee before?" — learned from this ledger's own
// categorised/pushed transactions first, then from QuickBooks' historic Purchases.
// Applied ONLY to outstanding (status='new', no category) money-out transactions.
// The category is filled in but the row is NOT locked, so it still gets a human eye.

// Normalise a counterparty to a stable key: lowercase, strip processor noise & refs.
export function normaliseCounterparty(cp: string): string {
  return String(cp || '')
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|llp|uk|com|co|www|inc)\b/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 2)          // first two significant words identify the payee
    .join(' ');
}

interface CatSuggestion { accountId: string; accountName: string; seen: number; source: 'ledger' | 'quickbooks' | 'rule' }

// Fixed coding rules that beat history — told to us directly (Terry, Aug 2026).
// MBNA Mastercard payments are Terry's personal card: code to TOK Director Loan
// (a report-only 'local:' category — never pushed to QuickBooks).
const SEED_RULES: Array<{ pattern: RegExp; accountId: string; accountName: string }> = [
  { pattern: /mbna/i, accountId: 'local:TOK Director Loan', accountName: 'TOK Director Loan' },
  // Family/staff transfers are all WAGES (Terry, 20 Aug 2026) — paid through payroll
  // (Pi run PAYE), so they're coded to the report-only Wages category and reconcile
  // against payroll journals in QB, never pushed as Purchases. Includes Andrew
  // Simoncsics (~£1,273/mo salary). "Wages" must exist in Admin → Purchase Ledger →
  // report-only categories for the dropdown; the rule writes it either way.
  { pattern: /daniel +okelly|cody +o'?kelly|zachary +okelly|natalie +o'?kelly|terry +o'?kelly|andrew +simoncsics/i,
    accountId: 'local:Wages', accountName: 'Wages' },
];

// Build payee → most-frequently-used category, from our own ledger history.
async function historyFromLedger(): Promise<Map<string, CatSuggestion>> {
  const rows = (await pool.query(
    `SELECT counterparty, qb_account_id, qb_account_name, COUNT(*)::int AS n
       FROM bank_transactions
      WHERE amount < 0 AND qb_account_id IS NOT NULL AND qb_account_id <> ''
        AND status IN ('categorised','pushed') AND counterparty IS NOT NULL
      GROUP BY counterparty, qb_account_id, qb_account_name`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  const map = new Map<string, CatSuggestion>();
  for (const r of rows) {
    const key = normaliseCounterparty(r.counterparty);
    if (!key) continue;
    const cur = map.get(key);
    if (!cur || r.n > cur.seen) map.set(key, { accountId: r.qb_account_id, accountName: r.qb_account_name, seen: r.n, source: 'ledger' });
  }
  return map;
}

// Merge in QuickBooks' own historic Purchases (payee → expense account), for
// payees we've never categorised in the Portal. Best-effort — QB may be off.
async function historyFromQuickBooks(map: Map<string, CatSuggestion>): Promise<void> {
  try {
    const qb = await QuickBooks.load();
    if (!qb.isConnected()) return;
    const purchases = await qb.getPurchaseHistory(730); // last 2 years
    const counts = new Map<string, Map<string, { name: string; n: number }>>();
    for (const p of purchases) {
      const key = normaliseCounterparty(p.payee);
      if (!key || !p.accountId) continue;
      const byAcct = counts.get(key) || new Map();
      const cur = byAcct.get(p.accountId) || { name: p.accountName, n: 0 };
      cur.n++; byAcct.set(p.accountId, cur); counts.set(key, byAcct);
    }
    for (const [key, byAcct] of counts) {
      if (map.has(key)) continue; // our own ledger history wins
      let best: { id: string; name: string; n: number } | null = null;
      for (const [id, v] of byAcct) if (!best || v.n > best.n) best = { id, name: v.name, n: v.n };
      if (best) map.set(key, { accountId: best.id, accountName: best.name, seen: best.n, source: 'quickbooks' });
    }
  } catch (e) { console.error('[purchase-match] QB history unavailable:', (e as Error).message); }
}

export interface AutoCategoriseResult { applied: number; considered: number; fromLedger: number; fromQb: number; noHistory: number }

// Apply historic categories to every outstanding transaction that has none.
export async function autoCategoriseOutstanding(): Promise<AutoCategoriseResult> {
  const map = await historyFromLedger();
  await historyFromQuickBooks(map);
  const outstanding = (await pool.query(
    `SELECT id, counterparty, description FROM bank_transactions
      WHERE amount < 0 AND status = 'new' AND (qb_account_id IS NULL OR qb_account_id = '')`
  )).rows;
  let applied = 0, fromLedger = 0, fromQb = 0, noHistory = 0;
  for (const t of outstanding) {
    const hay = (t.counterparty || '') + ' ' + (t.description || '');
    const rule = SEED_RULES.find((r) => r.pattern.test(hay));
    const key = normaliseCounterparty(t.counterparty || t.description || '');
    const hit: CatSuggestion | undefined = rule
      ? { accountId: rule.accountId, accountName: rule.accountName, seen: 999, source: 'rule' }
      : (key ? map.get(key) : undefined);
    if (!hit) { noHistory++; continue; }
    // Fill the category but DO NOT lock — status stays 'new' for a human pass.
    await pool.query('UPDATE bank_transactions SET qb_account_id=$1, qb_account_name=$2, updated_at=NOW() WHERE id=$3 AND (qb_account_id IS NULL OR qb_account_id=\'\')',
      [hit.accountId, hit.accountName, t.id]);
    applied++;
    if (hit.source === 'ledger') fromLedger++; else fromQb++;
  }
  return { applied, considered: outstanding.length, fromLedger, fromQb, noHistory };
}
