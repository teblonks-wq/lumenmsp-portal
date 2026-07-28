// Signing support: render the agreement, freeze it as an immutable PDF snapshot, and hash it.
//
// The hash is the point. A signature is only worth what you can prove it was applied to, so at
// the moment of signing we store the exact bytes the customer was shown along with a SHA-256 of
// them. Regenerating the document later cannot silently change what was signed.
import * as crypto from 'crypto';
import * as ejs from 'ejs';
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../db/pool';
import { htmlToPdf } from './pdf';
import { buildContractDoc, ContractDocContext } from './contract-doc';
import { EXTENSION_SECTIONS, SUPPLIER } from './contract-template';

export const CONTRACT_DOCS_DIR = path.join(process.cwd(), 'uploads', 'contract-docs');
const VIEWS_DIR = path.join(__dirname, '..', '..', 'src', 'views');

export function documentFooterHtml(): string {
  return `<div style="width:100%;padding:0 16mm;font-family:Arial,Helvetica,sans-serif;font-size:6.5pt;` +
    `color:#9ca3af;text-align:center;line-height:1.5;">` +
    `${SUPPLIER.tradingStatement.replace(/&/g, '&amp;')}<br>` +
    `Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
}

export const PDF_OPTS = {
  margin: { top: '14mm', right: '16mm', bottom: '20mm', left: '16mm' },
  headerHtml: '<span></span>',
};

export interface RenderOpts { docKind?: 'agreement' | 'extension'; watermark?: boolean; documentHash?: string | null; }

export async function renderContractHtml(ctx: ContractDocContext, opts: RenderOpts = {}): Promise<string> {
  const file = path.join(VIEWS_DIR, 'contracts', 'document.ejs');
  return ejs.renderFile(file, {
    ...ctx,
    docKind: opts.docKind || 'agreement',
    extensionSections: EXTENSION_SECTIONS,
    changedLines: [],
    extension: null,
    watermark: opts.watermark !== false,
    documentHash: opts.documentHash ?? null,
  }, { views: [VIEWS_DIR] });
}

export async function renderContractPdf(contractId: number, opts: RenderOpts = {}): Promise<{ pdf: Buffer; ctx: ContractDocContext } | null> {
  const ctx = await buildContractDoc(contractId);
  if (!ctx) return null;
  const html = await renderContractHtml(ctx, opts);
  const pdf = await htmlToPdf(html, { ...PDF_OPTS, footerHtml: documentFooterHtml() });
  return { pdf, ctx };
}

// Freeze the current document as a numbered, hashed snapshot. Called at signature and
// counter-signature, so the change-control table and the audit trail share one source.
export async function snapshotContract(
  contractId: number,
  kind: 'agreement' | 'extension' | 'amendment',
  changeSummary: string,
  userId?: number | null,
): Promise<{ version: number; sha256: string; filePath: string } | null> {
  const rendered = await renderContractPdf(contractId, { docKind: kind === 'extension' ? 'extension' : 'agreement', watermark: false });
  if (!rendered) return null;

  const sha256 = crypto.createHash('sha256').update(rendered.pdf).digest('hex');
  const nextVersion = (((await pool.query(
    'SELECT COALESCE(MAX(version),0) v FROM contract_documents WHERE contract_id=$1', [contractId])).rows[0].v) || 0) + 1;

  fs.mkdirSync(CONTRACT_DOCS_DIR, { recursive: true });
  const filePath = path.join(CONTRACT_DOCS_DIR, `contract-${contractId}-v${nextVersion}-${sha256.slice(0, 12)}.pdf`);
  fs.writeFileSync(filePath, rendered.pdf);

  await pool.query(
    `INSERT INTO contract_documents (contract_id, version, kind, title, file_path, sha256, file_size, change_summary, signed_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)`,
    [contractId, nextVersion, kind, rendered.ctx.contract.contract_number + ' v' + nextVersion,
     filePath, sha256, rendered.pdf.length, changeSummary, userId ?? null]
  );
  await pool.query('UPDATE contracts SET version=$1 WHERE id=$2', [nextVersion, contractId]);
  return { version: nextVersion, sha256, filePath };
}

// A typed signature is rendered as text in the signing script face; a drawn one arrives as an
// SVG path. Both are stored inline on the contract so the document renders without a file read.
export function typedSignatureSvg(name: string): string {
  const safe = String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safe;
}

export function clientIp(req: any): string {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || '';
}
