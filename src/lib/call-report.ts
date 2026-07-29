// A proper laid-out call report — the thing the PDF button should produce instead of asking
// the browser to print a web page. Same branded treatment as the agreements, and the same
// shape whichever lookup produced it, so a customer receiving one twice gets one document.
import * as ejs from 'ejs';
import * as fs from 'fs';
import * as path from 'path';
import { htmlToPdf } from './pdf';
import { SUPPLIER } from './contract-template';
import { aiAskText, aiComposeConfigured } from './ai-compose';

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
  scope?: string | null;   // what this report covers, stated up front
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


// What the report covers, said plainly at the top — so the reader knows the scope before
// they read a single figure, rather than inferring it from the table.
export function scopeStatement(
  kind: ReportKind, heading: string, fromDate: string, toDate: string,
  fromTime?: string, toTime?: string,
): string {
  const d = (x: string) => x ? new Date(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const allDay = (!fromTime || fromTime === '00:00') && (!toTime || toTime === '23:59');
  const window = allDay
    ? `between ${d(fromDate)} and ${d(toDate)}`
    : `between ${d(fromDate)} and ${d(toDate)}, counting only calls between ${fromTime} and ${toTime} each day`;
  const what = kind === 'number'
    ? `every call made to or from ${heading}`
    : kind === 'reverse'
      ? `every call answered by ${heading}`
      : `every call placed to ${heading}`;
  return `This report lists ${what} ${window}, together with how each call was routed and the ` +
         `outcome recorded by the telephony platform. Calls outside that window are not included.`;
}

// A short executive summary of the figures. Deliberately constrained: Claude is given the
// totals and told to summarise ONLY those — no advice, no speculation, no invented context.
// A customer may act on this, so it must not say anything the numbers do not.
export async function writeExecutiveSummary(input: CallReportInput): Promise<string | null> {
  try {
    if (!(await aiComposeConfigured())) return null;
    const facts = [
      `Report type: ${reportTitle(input.kind)}`,
      `Subject: ${input.heading}`,
      `Customer: ${input.customerName || 'not stated'}`,
      `Period: ${input.fromDate} to ${input.toDate}` +
        ((input.fromTime && input.fromTime !== '00:00') || (input.toTime && input.toTime !== '23:59')
          ? `, ${input.fromTime}-${input.toTime} each day` : ''),
      `Calls listed: ${input.rows.length}`,
      ...input.stats.map((st) => `${st.label}: ${st.value}`),
    ].join('\n');

    const system = [
      'You write a two-sentence executive summary for a UK telephony call report that is sent to a business customer.',
      'Rules:',
      '- British English (en-GB). Plain, factual, professional. No greeting, no sign-off, no heading.',
      '- ONE or TWO sentences. Never more. Do not use bullet points or markdown.',
      '- Use ONLY the figures given. Never invent, estimate, extrapolate or infer anything not stated.',
      '- Do not give advice, recommendations, causes, or judgements about performance.',
      '- Do not describe the figures as good, poor, high or low. State what happened, not what it means.',
      '- Write numbers as digits. Refer to the period in plain terms.',
      '- Return ONLY the summary text.',
    ].join('\n');

    // Never let a slow or failing model hold up a document the user is waiting on.
    const summary = await Promise.race([
      aiAskText(system, facts, 220),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
    ]);
    const clean = String(summary || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    return clean.length > 4 ? clean : null;
  } catch (e) {
    // A missing summary is a smaller problem than a missing report.
    console.error('[call-report] summary skipped:', (e as Error).message);
    return null;
  }
}
