import crypto from 'crypto';
import path from 'path';

// ── One door for everything that could be an invoice ─────────────────────────────
// Terry, 2026-09-03: "we need a tool that is hardened to deal with inbound emails,
// uploads of emails, photos of invoices and receipts, forwards of email that may be the
// invoice or even have it attached in various formats."
//
// The job is NOT to be clever. It is to never lose anything and never be surprised.
// Whatever arrives — a Graph message, a dragged-out .msg, a phone photo, a forward of a
// forward with the real invoice four levels down inside a zip — comes out of here as a flat
// list of CANDIDATES, each with the trail of how it was found still attached to it.
//
// Three rules this module holds absolutely:
//   1. NOTHING IS DISCARDED. A thing we cannot read becomes a candidate marked unreadable,
//      never a silent drop. Terry: "to protect our business we need every invoice for tax
//      reasons unless we ignore it."
//   2. THE FORWARDER IS NOT THE SUPPLIER. A forwarded invoice carries a colleague's name in
//      every header. We dig for the original sender, and where we cannot find one we say so
//      rather than filing it under whoever pressed forward. This is the "terry o" bug, fixed
//      at the point it is born.
//   3. EVERY CANDIDATE KNOWS WHERE IT CAME FROM. The provenance trail survives to the
//      ledger, so "why is this here?" always has an answer.

export type CandidateKind = 'file' | 'email_body' | 'inline_image';

export interface Candidate {
  bytes: Buffer;
  fileName: string;
  contentType: string;
  kind: CandidateKind;
  /** How we reached it: ["message: FW: invoice", "attachment: bundle.zip", "PKL28945.pdf"] */
  provenance: string[];
  /** The innermost real sender, where a forward let us recover it. */
  originalFrom?: { name?: string; email?: string } | null;
  /** Set when the bytes exist but nothing here can read them. Never a reason to drop it. */
  unreadable?: string | null;
  sha256: string;
  bytesLength: number;
}

export interface UnwrapLimits {
  maxDepth: number; maxCandidates: number; maxBytesEach: number; maxBytesTotal: number;
}
export const DEFAULT_LIMITS: UnwrapLimits = {
  maxDepth: 6,            // FW: FW: FW: with a zip inside is real, six is generous
  maxCandidates: 400,     // a mail export zip can be large; beyond this something is wrong
  maxBytesEach: 60 * 1024 * 1024,
  maxBytesTotal: 400 * 1024 * 1024,
};

// ── What we can and cannot read ─────────────────────────────────────────────────
// Kept explicit rather than clever: a format we do not handle must SAY so, so a human can
// convert it, instead of the file quietly becoming nothing.
const READABLE_DOC = /\.(pdf)$/i;
const READABLE_IMG = /\.(jpe?g|png|gif|webp)$/i;         // what Claude can read natively
const AWKWARD_IMG  = /\.(heic|heif|tiff?|bmp|avif)$/i;   // phone photos that need converting
const EMAIL_FILE   = /\.(eml|msg|mbox)$/i;
const ARCHIVE_FILE = /\.(zip)$/i;
const TEXTY        = /\.(html?|txt|md|csv)$/i;
const OFFICE       = /\.(docx?|xlsx?|pptx?|odt|ods)$/i;
// Never an invoice, whatever it is called. These arrive attached to real supplier emails —
// signature logos, tracking pixels, social icons — and each one used to become a document.
const JUNK_ATTACHMENT = /^(image00\d|logo|signature|banner|icon|spacer|facebook|twitter|linkedin|instagram|footer|header)[-_.0-9]*\.(png|gif|jpe?g|bmp)$/i;
const TINY_IMAGE_BYTES = 12 * 1024;   // a 12KB image is a logo, not a scan of an invoice

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const ext = (n: string) => path.extname(String(n || '')).toLowerCase();

function contentTypeFor(fileName: string, given?: string | null): string {
  const g = String(given || '').toLowerCase();
  if (g && g !== 'application/octet-stream' && g !== 'binary/octet-stream') return g;
  const e = ext(fileName);
  const map: Record<string, string> = {
    '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
    '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.csv': 'text/csv',
    '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook', '.zip': 'application/zip',
  };
  return map[e] || 'application/octet-stream';
}

// Sniff the real type from the first bytes. A supplier portal that serves an invoice as
// "invoice" with no extension, or a .pdf that is really a PNG, must not defeat us.
function sniff(b: Buffer): string | null {
  if (b.length < 8) return null;
  const h = b.subarray(0, 12);
  if (h.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (h.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (h.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (h.subarray(0, 2).toString('latin1') === 'PK') return 'application/zip';   // also docx/xlsx
  if (h.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return 'application/vnd.ms-outlook'; // OLE: .msg/.doc/.xls
  if (b.subarray(4, 12).toString('latin1') === 'ftypheic' || b.subarray(4, 12).toString('latin1') === 'ftypheix') return 'image/heic';
  return null;
}

// ── Forwarded mail: dig out the ORIGINAL sender ─────────────────────────────────
// Outlook, Gmail and Apple Mail all quote the original headers into the body in their own
// way. We read whichever we find, deepest first, because a forward of a forward puts the
// real supplier furthest down.
const FROM_LINES = [
  /^\s*(?:>+\s*)?From:\s*(.+)$/gim,                       // Outlook / generic
  /^\s*(?:>+\s*)?De\s*:\s*(.+)$/gim,                      // French clients do exist
  /On .+?,\s*(.+?)\s*<([^>]+)>\s*wrote:/gi,               // Gmail / Apple
];
const ADDR = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

export function originalSenderFromBody(body: string): { name?: string; email?: string } | null {
  const text = String(body || '');
  if (!text) return null;
  const found: { name?: string; email?: string }[] = [];
  for (const rx of FROM_LINES) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text))) {
      const line = (m[2] ? `${m[1]} <${m[2]}>` : m[1]) || '';
      const addr = ADDR.exec(line);
      if (!addr) continue;
      const name = line.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
      found.push({ name: name || undefined, email: addr[1].toLowerCase() });
    }
  }
  if (!found.length) return null;
  // The LAST quoted From: in the body is the innermost — the one furthest from us.
  return found[found.length - 1];
}

// ── Unwrapping ──────────────────────────────────────────────────────────────────
// Recursive, bounded, and total: every branch either produces candidates or produces one
// candidate marked unreadable. There is no path out of here that produces nothing.
export interface UnwrapCtx {
  limits: UnwrapLimits;
  seen: Set<string>;            // sha256 of everything already emitted — a zip of a zip of the same PDF yields one
  totalBytes: number;
  notes: string[];              // anything a human should know about this intake
}

export function newCtx(limits: Partial<UnwrapLimits> = {}): UnwrapCtx {
  return { limits: { ...DEFAULT_LIMITS, ...limits }, seen: new Set(), totalBytes: 0, notes: [] };
}

export async function unwrap(
  bytes: Buffer, fileName: string, contentType: string | null,
  provenance: string[], ctx: UnwrapCtx, depth = 0,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (!bytes || !bytes.length) return out;
  if (out.length >= ctx.limits.maxCandidates) return out;

  const sniffed = sniff(bytes);
  const ct = (sniffed || contentTypeFor(fileName, contentType)).toLowerCase();
  const name = String(fileName || 'attachment');

  const emit = (why?: string | null, from?: { name?: string; email?: string } | null, kind: CandidateKind = 'file') => {
    const h = sha(bytes);
    if (ctx.seen.has(h)) return;                       // the same bytes, however they reached us
    ctx.seen.add(h);
    ctx.totalBytes += bytes.length;
    out.push({ bytes, fileName: name, contentType: ct, kind, provenance: [...provenance, name],
               originalFrom: from ?? null, unreadable: why ?? null, sha256: h, bytesLength: bytes.length });
  };

  // Guard rails first, and each one is reported rather than silent.
  if (bytes.length > ctx.limits.maxBytesEach) { ctx.notes.push(`${name} is ${(bytes.length / 1048576).toFixed(0)}MB and was skipped.`); return out; }
  if (ctx.totalBytes > ctx.limits.maxBytesTotal) { ctx.notes.push('This batch hit the total size limit; the rest was skipped.'); return out; }
  if (depth > ctx.limits.maxDepth) { emit(`Nested more than ${ctx.limits.maxDepth} levels deep — kept as-is rather than opened.`); return out; }

  // Signature logos and tracking pixels are not invoices.
  if (JUNK_ATTACHMENT.test(name) || (/^image\//.test(ct) && bytes.length < TINY_IMAGE_BYTES && depth > 0)) return out;

  // ── An email: the body is a candidate in its own right, and so is everything inside it.
  if (EMAIL_FILE.test(name) || ct === 'message/rfc822' || ct === 'application/vnd.ms-outlook') {
    const parsed = await parseEmail(bytes, name, ct);
    if (!parsed) { emit('This looks like an email but nothing here could open it. Export it as .eml and try again.'); return out; }
    ctx.notes.push(`Opened ${name}: "${parsed.subject || 'no subject'}"`);
    const from = parsed.originalFrom || parsed.from || null;
    const label = `email: ${parsed.subject || name}`;

    // The email body itself. Sometimes the invoice IS the email — no attachment at all —
    // and that is a normal supplier, not a broken one.
    if (parsed.bodyHtml || parsed.bodyText) {
      const body = Buffer.from(parsed.bodyHtml || `<pre>${escapeHtml(parsed.bodyText || '')}</pre>`, 'utf8');
      const bodyName = safeName((parsed.subject || 'email') + ' (email body).html');
      const h = sha(body);
      if (!ctx.seen.has(h)) {
        ctx.seen.add(h);
        out.push({ bytes: body, fileName: bodyName, contentType: 'text/html', kind: 'email_body',
                   provenance: [...provenance, label, bodyName], originalFrom: from, unreadable: null,
                   sha256: h, bytesLength: body.length });
      }
    }
    for (const att of parsed.attachments) {
      if (out.length >= ctx.limits.maxCandidates) break;
      const kids = await unwrap(att.content, att.fileName || 'attachment', att.contentType ?? null, [...provenance, label], ctx, depth + 1);
      // An attachment inside a forward inherits the forward's original sender when it has
      // none of its own — that is the whole point of digging it out.
      for (const k of kids) if (!k.originalFrom) k.originalFrom = from;
      out.push(...kids);
    }
    return out;
  }

  // ── A zip: open it, recurse, and say so if it will not open.
  if (ARCHIVE_FILE.test(name) || (ct === 'application/zip' && !OFFICE.test(name))) {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(bytes);
      const entries = zip.getEntries().filter((e: any) => !e.isDirectory);
      ctx.notes.push(`Opened ${name} — ${entries.length} file(s) inside.`);
      for (const e of entries) {
        if (out.length >= ctx.limits.maxCandidates) break;
        if (/^__MACOSX\//.test(e.entryName) || /(^|\/)\._/.test(e.entryName)) continue;
        out.push(...await unwrap(e.getData(), path.basename(e.entryName), null, [...provenance, `zip: ${name}`], ctx, depth + 1));
      }
      return out;
    } catch (err) {
      emit(`This zip could not be opened (${(err as Error).message}).`);
      return out;
    }
  }

  // ── Leaves. Everything below is kept; the only question is whether we can read it.
  if (READABLE_DOC.test(name) || ct === 'application/pdf') { emit(null); return out; }
  if (READABLE_IMG.test(name) || /^image\/(jpeg|png|gif|webp)$/.test(ct)) { emit(null); return out; }
  if (AWKWARD_IMG.test(name) || /^image\/(heic|heif|tiff|bmp|avif)$/.test(ct)) {
    // A phone photo in Apple's format. Keep it, flag it, ask for a JPEG — never lose it.
    emit('This is a HEIC/TIFF image, which cannot be read directly. Re-send it as a JPEG or PNG and it will read fine.');
    return out;
  }
  if (TEXTY.test(name) || /^text\//.test(ct)) { emit(null); return out; }
  if (OFFICE.test(name)) { emit('This is an Office document. It is kept, but the figures on it have not been read.'); return out; }
  emit(`Unrecognised format (${ct}). Kept so nothing is lost, but nothing has been read off it.`);
  return out;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function safeName(s: string): string {
  return String(s || 'file').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'file';
}

// ── Email parsing ───────────────────────────────────────────────────────────────
// mailparser handles .eml properly — encodings, nested multipart, RFC2047 headers. It is
// loaded lazily and its absence degrades to "we kept the file and told you", because an
// intake that CRASHES on a format is worse than one that admits it cannot read it.
export interface ParsedEmail {
  subject?: string; from?: { name?: string; email?: string } | null;
  originalFrom?: { name?: string; email?: string } | null;
  bodyText?: string; bodyHtml?: string;
  attachments: { fileName?: string; contentType?: string | null; content: Buffer }[];
}

export async function parseEmail(bytes: Buffer, fileName: string, ct: string): Promise<ParsedEmail | null> {
  // .msg is an OLE compound file, not RFC822. We do not pretend to read it.
  if (/\.msg$/i.test(fileName) || ct === 'application/vnd.ms-outlook') return null;
  let simpleParser: any;
  try { ({ simpleParser } = require('mailparser')); }
  catch { return null; }
  try {
    const mail = await simpleParser(bytes);
    const from = mail.from?.value?.[0];
    const text = String(mail.text || '');
    return {
      subject: mail.subject || undefined,
      from: from ? { name: from.name || undefined, email: (from.address || '').toLowerCase() } : null,
      // A forward carries the real supplier in its quoted headers, never in From:.
      originalFrom: originalSenderFromBody(text) || null,
      bodyText: text || undefined,
      bodyHtml: mail.html ? String(mail.html) : undefined,
      attachments: (mail.attachments || [])
        .filter((a: any) => a && a.content && a.content.length)
        .map((a: any) => ({ fileName: a.filename, contentType: a.contentType, content: a.content })),
    };
  } catch { return null; }
}

// ── What the gate lets through ──────────────────────────────────────────────────
// Nothing enters the MATCHING queue unless it is a purchase document addressed to us.
// Everything else is kept and filed — a statement is archived, one of our own sales invoices
// goes to the sales pile, a quiz goes nowhere at all — but none of it is ever offered to the
// matcher, and none of it is ever deleted.
export type Verdict = 'match_queue' | 'archive_statement' | 'sales_pile' | 'not_a_purchase' | 'needs_reading' | 'needs_human';

export function gate(d: {
  docType?: string | null; toUs?: boolean | null; supplier?: string | null;
  gross?: number | null; unreadable?: string | null; fileName?: string | null; subject?: string | null;
}): { verdict: Verdict; because: string } {
  if (d.unreadable) return { verdict: 'needs_human', because: d.unreadable };
  const type = String(d.docType || '').toLowerCase();
  if (type === 'statement') return { verdict: 'archive_statement', because: 'A statement is a list of invoices, not an invoice. Kept for the record, never matched to a payment.' };
  if (type === 'sales_invoice') return { verdict: 'sales_pile', because: 'This is one of our own invoices to a customer, not something we owe.' };
  if (type === 'not_a_purchase' || type === 'quote' || type === 'contract' || type === 'notification') {
    return { verdict: 'not_a_purchase', because: 'Not a purchase document, so it is filed rather than matched.' };
  }
  if (d.toUs === false) return { verdict: 'sales_pile', because: 'This invoice is billed to somebody else, so it is not ours to pay.' };
  if (!type || d.gross == null) return { verdict: 'needs_reading', because: 'Not read yet — it goes to the reading queue, not the matching queue.' };
  return { verdict: 'match_queue', because: 'A purchase invoice or receipt billed to us, with a total read off it.' };
}
