import { parse } from 'csv-parse/sync';
import crypto from 'crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

export function hhmmssToSeconds(s: string): number {
  if (!s || s === '00:00:00') return 0;
  const parts = s.split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

export function normaliseNumber(n: string): string {
  if (!n) return '';
  let c = n.replace(/[\s\-().]/g, '');
  if (c.startsWith('+44'))  c = '0' + c.slice(3);
  if (c.startsWith('0044')) c = '0' + c.slice(4);
  return c;
}

function parseEventDatetime(dateStr: string, timeStr: string): Date {
  // "03 Jun 2026" + "10:52"
  return new Date(`${dateStr} ${timeStr}:00 UTC`);
}

function parseReportPeriod(line: string): { reportStart: Date; reportEnd: Date } {
  // "Report Period:  Nov 01 2025 to Jun 03 2026"
  const m = line.match(/(\w+\s+\d{1,2}\s+\d{4})\s+to\s+(\w+\s+\d{1,2}\s+\d{4})/);
  if (!m) throw new Error(`Cannot parse report period from: "${line}"`);
  return {
    reportStart: new Date(m[1] + ' UTC'),
    reportEnd:   new Date(m[2] + ' UTC'),
  };
}

// ── EXT CSV (ListCallsbyExtension) ────────────────────────────────────────────

export interface ParsedCallRow {
  eventDatetime:    Date;
  reportStart:      Date;
  reportEnd:        Date;
  groupName:        string;
  outcome:          string;
  numberRaw:        string;
  numberNormalised: string;
  ddi:              string | null;
  waitSeconds:      number;
  sourceFile:       string;
  eventHash:        string;
}

export interface ParseResult {
  rows:        ParsedCallRow[];
  reportStart: Date;
  reportEnd:   Date;
  skippedRows: number;
}

export function parseExtCsv(buffer: Buffer, sourceFile: string): ParseResult {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);

  // Parse report period from first non-empty line
  const { reportStart, reportEnd } = parseReportPeriod(lines[0]);

  // Find header line (contains "Department")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].includes('Department')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('Could not find CSV header row');

  // Parse CSV from header row down
  const records: Record<string, string>[] = parse(
    lines.slice(headerIdx).join('\n'),
    { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }
  );

  const rows: ParsedCallRow[] = [];
  let skippedRows = 0;
  let rowIndex = 0;

  for (const rec of records) {
    rowIndex++;
    const ext  = (rec['Extension'] || '').trim();
    const date = (rec['Date']      || '').trim();
    const time = (rec['Time']      || '').trim();
    const num  = (rec['Number']    || '').trim();
    const ddi  = (rec['DDI']       || '').trim();
    const ring = (rec['Ring Time'] || '00:00:00').trim();
    const type = (rec['Type']      || '').trim();

    if (!date || !time || !ext) { skippedRows++; continue; }

    const eventDatetime    = parseEventDatetime(date, time);
    const numberNormalised = normaliseNumber(num);
    const waitSeconds      = hhmmssToSeconds(ring);

    // Row index + source file makes each row in a given file unique,
    // while still deduplicating correctly when the same file is re-imported.
    const eventHash = crypto
      .createHash('sha256')
      .update(`ext|${sourceFile}|${rowIndex}|${date}|${time}|${ext}|${num}|${ddi}|${type}|${ring}`)
      .digest('hex');

    rows.push({
      eventDatetime,
      reportStart,
      reportEnd,
      groupName:        ext,
      outcome:          type,
      numberRaw:        num,
      numberNormalised,
      ddi:              ddi || null,
      waitSeconds,
      sourceFile,
      eventHash,
    });
  }

  return { rows, reportStart, reportEnd, skippedRows };
}

// ── Group CSV (ContactGroupDetail) ───────────────────────────────────────────
// Headers: Group, Date, Time, Outcome, Number, DDI, Wait time
// Date format: M/D/YYYY HH:MM:SS AM/PM  (US format from iCalls)
// Wait time format: MM:SS

function mmssToSeconds(s: string): number {
  if (!s) return 0;
  const parts = s.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function parseGroupDatetime(dateStr: string, timeStr?: string): Date {
  if (timeStr) {
    // "04 Jun 2026" + "09:07" — newer iCalls format with separate Time column
    return new Date(`${dateStr} ${timeStr}:00 UTC`);
  }
  // "6/3/2026 10:50:45 AM" — older M/D/YYYY combined format
  return new Date(dateStr + ' UTC');
}

export function parseGroupCsv(buffer: Buffer, sourceFile: string): ParseResult {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);

  const { reportStart, reportEnd } = parseReportPeriod(lines[0]);

  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const l = lines[i];
    // Match both quoted ("Group") and unquoted (Group) header formats
    if (l.includes('"Group"') || l.startsWith('Group,') || l.startsWith('"Group",')) {
      headerIdx = i; break;
    }
  }
  if (headerIdx === -1) throw new Error('Could not find header row in Group CSV');

  const records: Record<string, string>[] = parse(
    lines.slice(headerIdx).join('\n'),
    { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }
  );

  const rows: ParsedCallRow[] = [];
  let skippedRows = 0;

  for (const rec of records) {
    const group   = (rec['Group']     || '').trim();
    const dateStr = (rec['Date']      || '').trim();
    const timeStr = (rec['Time']      || '').trim();  // present in newer format
    const num     = (rec['Number']    || '').trim();
    const ddi     = (rec['DDI']       || '').trim();
    const wait    = (rec['Wait time'] || '00:00').trim();
    const outcome = (rec['Outcome']   || '').trim();

    if (!dateStr || !group) { skippedRows++; continue; }

    // Use separate Time column if present, otherwise dateStr includes time
    const eventDatetime    = parseGroupDatetime(dateStr, timeStr || undefined);
    const numberNormalised = normaliseNumber(num);
    const waitSeconds      = mmssToSeconds(wait);

    const eventHash = crypto
      .createHash('sha256')
      .update(`grp|${dateStr}|${timeStr}|${group}|${num}|${ddi}|${outcome}|${wait}`)
      .digest('hex');

    rows.push({
      eventDatetime,
      reportStart,
      reportEnd,
      groupName:        group,
      outcome,
      numberRaw:        num,
      numberNormalised,
      ddi:              ddi || null,
      waitSeconds,
      sourceFile,
      eventHash,
    });
  }

  return { rows, reportStart, reportEnd, skippedRows };
}
