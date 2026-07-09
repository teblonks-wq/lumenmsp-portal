import zlib from 'zlib';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

// ── LITS-DMARC: aggregate report parsing ─────────────────────────────────────────
// Receivers (Google, Microsoft, Yahoo…) email RFC 7489 aggregate reports as gzip,
// zip or occasionally bare XML attachments. Receivers deviate from the RFC in small
// ways, so parsing is deliberately forgiving; anything unparseable throws and the
// ingest job logs + skips it rather than dying.

export interface ParsedRecord {
  sourceIp: string;
  count: number;
  disposition: string;       // none | quarantine | reject
  dkimAligned: boolean;      // policy_evaluated dkim
  spfAligned: boolean;       // policy_evaluated spf
  dkimResult: string;        // raw auth_results dkim (pass/fail/…)
  dkimSelector: string;      // selector the sender signed with (when the receiver reports it)
  spfResult: string;         // raw auth_results spf
  headerFrom: string;
  envelopeFrom: string;
}

export interface ParsedReport {
  reportId: string;
  orgName: string;
  orgEmail: string;
  dateBegin: Date;
  dateEnd: Date;
  policyDomain: string;      // policy_published domain — matched against monitored domains
  policyPublished: Record<string, unknown>;
  records: ParsedRecord[];
}

// Attachment bytes → XML text. Sniffs magic bytes rather than trusting filenames,
// because receivers are inconsistent (.xml.gz, .zip, misdeclared content types).
export function extractXml(buf: Buffer): string[] {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {           // gzip
    return [zlib.gunzipSync(buf).toString('utf8')];
  }
  if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b) {           // zip ("PK")
    const zip = new AdmZip(buf);
    const out: string[] = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (/\.xml$/i.test(entry.entryName) || zip.getEntries().length === 1) {
        out.push(entry.getData().toString('utf8'));
      }
    }
    if (out.length) return out;
    throw new Error('zip attachment contained no XML entry');
  }
  const text = buf.toString('utf8');
  if (text.trimStart().startsWith('<')) return [text];                  // bare XML
  throw new Error('attachment is not gzip, zip or XML');
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,       // keep everything as strings; we coerce explicitly
  isArray: (name: string) => name === 'record' || name === 'dkim' || name === 'spf',
});

const asArr = (v: unknown): any[] => (Array.isArray(v) ? v : v != null ? [v] : []);
const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const num = (v: unknown): number => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : 0; };
const epoch = (v: unknown): Date => new Date(num(v) * 1000);

export function parseAggregateReport(xml: string): ParsedReport {
  const doc = parser.parse(xml);
  const fb = doc.feedback;
  if (!fb) throw new Error('no <feedback> root element');
  const meta = fb.report_metadata || {};
  const range = meta.date_range || {};
  const pol = fb.policy_published || {};

  const records: ParsedRecord[] = asArr(fb.record).map((r: any) => {
    const row = r.row || {};
    const pe = row.policy_evaluated || {};
    const ids = r.identifiers || {};
    const auth = r.auth_results || {};
    const dkim = asArr(auth.dkim);
    const spf = asArr(auth.spf);
    return {
      sourceIp: str(row.source_ip),
      count: num(row.count) || 1,
      disposition: str(pe.disposition).toLowerCase() || 'none',
      dkimAligned: str(pe.dkim).toLowerCase() === 'pass',
      spfAligned: str(pe.spf).toLowerCase() === 'pass',
      dkimResult: dkim.length ? str(dkim[0].result).toLowerCase() : '',
      dkimSelector: dkim.length ? str(dkim[0].selector).toLowerCase() : '',
      spfResult: spf.length ? str(spf[0].result).toLowerCase() : '',
      headerFrom: str(ids.header_from).toLowerCase(),
      envelopeFrom: str(ids.envelope_from).toLowerCase(),
    };
  }).filter((r: ParsedRecord) => r.sourceIp);

  return {
    reportId: str(meta.report_id) || `noid-${num(range.begin)}-${str(meta.org_name)}`,
    orgName: str(meta.org_name),
    orgEmail: str(meta.email),
    dateBegin: epoch(range.begin),
    dateEnd: epoch(range.end),
    policyDomain: str(pol.domain).toLowerCase(),
    policyPublished: pol,
    records,
  };
}
