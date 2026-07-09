import path from 'path';
import fs from 'fs';
import { pool } from '../db/pool';
import { htmlToPdf } from './pdf';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ejs = require('ejs');

// Branded, landscape "Expense and Tax Receipts Report" for a month — the document we
// send to the bookkeeper. Lists every expense for the period with its category, account
// and whether a receipt/invoice is attached, plus a by-category summary and total.

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

export interface ExpenseReportData {
  period: string;
  rows: any[];
  byCategory: { name: string; total: number; count: number }[];
  total: number;
  withReceipt: number;
}

export async function loadExpenseReport(period: string): Promise<ExpenseReportData> {
  const txns = (await pool.query(
    `SELECT t.id, t.booked_at, t.account_name, t.counterparty, t.description, t.reference,
            t.amount, t.qb_account_name, t.attachment_name, t.status
       FROM bank_transactions t
      WHERE t.amount < 0 AND t.status <> 'ignored' AND to_char(t.booked_at,'YYYY-MM') = $1
      ORDER BY t.booked_at`, [period]
  )).rows;
  // Split transactions show one report line per split (its own category, amount, receipt).
  const splits = txns.length
    ? (await pool.query('SELECT * FROM bank_transaction_splits WHERE transaction_id = ANY($1) ORDER BY id', [txns.map((t: any) => t.id)])).rows
    : [];
  const splitsByTxn: Record<number, any[]> = {};
  for (const s of splits) { (splitsByTxn[s.transaction_id] = splitsByTxn[s.transaction_id] || []).push(s); }
  const rows: any[] = [];
  for (const t of txns) {
    const sp = splitsByTxn[t.id];
    if (sp && sp.length) {
      for (const s of sp) {
        rows.push({
          booked_at: t.booked_at, account_name: t.account_name, counterparty: t.counterparty,
          description: (t.description || '') + ' (split)', reference: t.reference,
          amount: -Math.abs(Number(s.amount) || 0), qb_account_name: s.qb_account_name,
          attachment_name: s.attachment_name, status: t.status,
        });
      }
    } else {
      rows.push(t);
    }
  }
  const catMap: Record<string, { name: string; total: number; count: number }> = {};
  let total = 0, withReceipt = 0;
  for (const r of rows) {
    const amt = Math.abs(Number(r.amount) || 0);
    total += amt;
    if (r.attachment_name) withReceipt++;
    const key = r.qb_account_name || 'Uncategorised';
    if (!catMap[key]) catMap[key] = { name: key, total: 0, count: 0 };
    catMap[key].total += amt; catMap[key].count++;
  }
  const byCategory = Object.values(catMap).sort((a, b) => b.total - a.total);
  return { period, rows, byCategory, total, withReceipt };
}

export async function renderExpenseReportPdf(period: string): Promise<Buffer> {
  const data = await loadExpenseReport(period);
  const tpl = path.join(process.cwd(), 'src', 'views', 'purchases', 'report.ejs');
  const html: string = await ejs.renderFile(tpl, { ...data, logoUrl: logoDataUri() });
  return htmlToPdf(html, { landscape: true, format: 'A4', margin: { top: '12mm', right: '10mm', bottom: '14mm', left: '10mm' } });
}
