// A proper laid-out call report — the thing the PDF button should produce instead of asking
// the browser to print a web page. Same branded treatment as the agreements, and the same
// shape whichever lookup produced it, so a customer receiving one twice gets one document.
import * as ejs from 'ejs';
import * as fs from 'fs';
import * as path from 'path';
import { htmlToPdf } from './pdf';
import { SUPPLIER } from './contract-template';

const VIEWS_DIR = path.join(__dirname, '..', '..', 'src', 'views');

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

export type ReportKind = 'number' | 'reverse' | 'outbound';

export interface ReportStat { label: string; value: string; tone?: 'good' | 'warn' | 'bad' | 'plain'; }
export interface ReportRow { cells: string[]; tone?: 'good' | 'warn' | 'bad' | 'plain'; }

export interface CallReportInput {
  kind: ReportKind;
  heading: string;          // e.g. the number or extension the report is about
  subject: string;          // one line saying what this report covers
  customerName: string;
  fromDate: string; toDate: string;
  fromTime?: string; toTime?: string;
  stats: ReportStat[];
  columns: string[];
  rows: ReportRow[];
  // Optional narrative written by Claude for the "Make Report" flow. Never invented facts —
  // the prompt is given the totals and told to summarise only those.
  summary?: string | null;
  requestedBy?: string | null;
  preparedBy?: string | null;
}

export function reportTitle(kind: ReportKind): string {
  return kind === 'number' ? 'Call history' : kind === 'reverse' ? 'Calls answered' : 'Outbound calls';
}

export async function renderCallReportHtml(input: CallReportInput): Promise<string> {
  const file = path.join(VIEWS_DIR, 'insights', 'report-pdf.ejs');
  return ejs.renderFile(file, {
    ...input,
    title: reportTitle(input.kind),
    supplier: SUPPLIER,
    logoUrl: logoDataUri(),
    generatedAt: new Date(),
  }, { views: [VIEWS_DIR] });
}

export async function renderCallReportPdf(input: CallReportInput): Promise<Buffer> {
  const html = await renderCallReportHtml(input);
  return htmlToPdf(html, {
    margin: { top: '14mm', right: '14mm', bottom: '18mm', left: '14mm' },
    headerHtml: '<span></span>',
    footerHtml:
      `<div style="width:100%;padding:0 14mm;font-family:Arial,Helvetica,sans-serif;font-size:6.5pt;` +
      `color:#9ca3af;text-align:center;line-height:1.5;">` +
      `${SUPPLIER.tradingStatement.replace(/&/g, '&amp;')}<br>` +
      `Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
  });
}

export function fmtSecs(s: number): string {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`;
}
