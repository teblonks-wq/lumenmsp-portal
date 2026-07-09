import fs from 'fs';
import { pool } from '../db/pool';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse');

// Reads the text of a pooled invoice (text-based PDF, or an emailed HTML body) and
// pulls the fields we need to auto-match it to a bank payment: the gross total, the
// invoice number and the invoice date. Scanned/image-only PDFs have no extractable
// text — those come back empty (parse_status = 'no_text') and fall back to heuristics.

export interface ParsedInvoice {
  amount: number | null;
  invoiceNo: string | null;
  date: string | null;
  status: 'ok' | 'no_text' | 'error';
}

async function extractText(filePath: string, contentType: string | null, fileName: string): Promise<string> {
  const isPdf = /pdf/i.test(contentType || '') || /\.pdf$/i.test(fileName || '');
  const isHtml = /html/i.test(contentType || '') || /\.html?$/i.test(fileName || '');
  if (isPdf) {
    const buf = fs.readFileSync(filePath);
    const d = await pdfParse(buf);
    return d.text || '';
  }
  if (isHtml) {
    const html = fs.readFileSync(filePath, 'utf8');
    return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&pound;/g, '£')
      .replace(/[ \t]+/g, ' ');
  }
  return '';
}

const moneyRe = /(?:£|gbp\s*)?(\d{1,3}(?:,\d{3})*\.\d{2})\b/i;
function money(s: string): number | null { const m = s.match(moneyRe); return m ? parseFloat(m[1].replace(/,/g, '')) : null; }

export function parseInvoiceFields(text: string): ParsedInvoice {
  if (!text || text.replace(/\s/g, '').length < 10) return { amount: null, invoiceNo: null, date: null, status: 'no_text' };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Total: prefer a line mentioning the amount due / grand total / total payable (gross,
  // VAT-inclusive — that's what the bank pays). Fall back to the largest money value seen.
  const priority = /(amount\s+due|balance\s+due|total\s+(?:due|payable|to\s+pay)|grand\s+total|invoice\s+total)/i;
  let amount: number | null = null;
  for (const l of lines) { if (priority.test(l)) { const v = money(l); if (v != null) { amount = v; break; } } }
  if (amount == null) {
    for (const l of lines) { if (/\btotal\b/i.test(l) && !/sub\s*-?\s*total/i.test(l)) { const v = money(l); if (v != null) amount = v; } }
  }
  if (amount == null) {
    let max = 0; const all = text.match(/(?:£|gbp\s*)?\d{1,3}(?:,\d{3})*\.\d{2}/gi) || [];
    for (const a of all) { const v = parseFloat(a.replace(/[^0-9.]/g, '')); if (v > max) max = v; }
    amount = max || null;
  }

  // Require an explicit "no/number/#/ref" indicator, and the value must contain a digit
  // (so we don't capture the word "Invoice" from a heading like "Tax Invoice").
  const inv = text.match(/invoice\s*(?:no\.?|number|num|#|ref(?:erence)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i);
  let invoiceNo = inv ? inv[1].replace(/[.,;]$/, '') : null;
  if (invoiceNo && !/\d/.test(invoiceNo)) invoiceNo = null;

  const dm = text.match(/(?:invoice\s*date|date(?:\s+of\s+issue)?)\D{0,12}(\d{1,2}[\/\-.](?:\d{1,2}|[a-z]{3,9})[\/\-.]\d{2,4})/i)
    || text.match(/\b(\d{1,2}\s+[a-z]{3,9}\s+\d{4})\b/i);
  const date = dm ? dm[1] : null;

  return { amount: amount && amount > 0 ? amount : null, invoiceNo, date, status: 'ok' };
}

// Parse one pooled document and store the extracted fields. Best-effort.
export async function parseAndStoreDoc(doc: { id: number; file_path: string; content_type: string | null; file_name: string }): Promise<number | null> {
  let parsed: ParsedInvoice;
  try {
    const text = await extractText(doc.file_path, doc.content_type, doc.file_name);
    parsed = parseInvoiceFields(text);
  } catch (e) {
    console.error('[invoice-read] parse failed for doc', doc.id, (e as Error).message);
    parsed = { amount: null, invoiceNo: null, date: null, status: 'error' };
  }
  await pool.query(
    'UPDATE purchase_documents SET parsed_amount=$1, parsed_invoice_no=$2, parsed_date=$3, parse_status=$4 WHERE id=$5',
    [parsed.amount, parsed.invoiceNo, parsed.date, parsed.status, doc.id]
  );
  return parsed.amount;
}
