// Builds the render context for a contract document: template boilerplate + customer data
// + priced lines grouped into the sections the Multi Service Agreement uses.
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../db/pool';
import {
  DEFAULT_MSA_SECTIONS, DEFAULT_SERVICE_BLURBS, EXTENSION_SECTIONS, MSA_TEMPLATE_CODE,
  applyCoverTokens, coverOf, MSA_TEMPLATE_VERSION, SUPPLIER, SupportCover,
  TEMPLATE_CHANGELOG, TemplateChange, TemplateSection,
} from './contract-template';

// Same logo the invoice PDFs use, inlined as a data URI so the print page needs no network.
let _logo: string | null = null;
export function logoDataUri(): string {
  if (_logo === null) {
    try {
      const p = path.join(process.cwd(), 'static', 'lumen-msp-logo.png');
      _logo = fs.existsSync(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : '';
    } catch { _logo = ''; }
  }
  return _logo;
}

export const SECTION_ORDER = ['IT', 'Cloud', 'Backup', 'Comms', 'Hardware'];

export interface ContractDocContext {
  contract: any;
  customer: any;
  serviceContacts: any[];
  groups: { key: string; title: string; intro?: string; bullets: string[]; lines: any[]; monthly: number }[];
  sections: TemplateSection[];
  changeControl: any[];
  terms: any[];
  totals: { monthly: number; annual: number; oneOff: number; annualised: number };
  supplier: typeof SUPPLIER;
  logoUrl: string;
  docKind: 'agreement' | 'extension';
  extensionSections: TemplateSection[];
  extension: { previousEnd: any; startDate: any; endDate: any; months: number } | null;
  wordingChanges: TemplateChange[];
  cover: SupportCover;
  changedLines: any[];
  reviewFlags: TemplateSection[];
}

// Load the active MSA template, seeding the built-in default the first time. Kept lazy so
// there is no separate migration step to remember on deploy.
export async function loadTemplate(code = MSA_TEMPLATE_CODE): Promise<{ id: number; version: number; sections: TemplateSection[] }> {
  const { rows } = await pool.query(
    'SELECT id, version, sections FROM contract_templates WHERE code=$1 AND active=true ORDER BY version DESC LIMIT 1', [code]
  );
  if (rows.length) {
    // A stored template that predates the current built-in wording is refreshed in place.
    // Without this, a wording fix would live in the code and never reach a real agreement,
    // because the database copy always wins. Already-signed documents are unaffected — those
    // are frozen PDFs in contract_documents, not re-rendered from the template.
    if ((rows[0].version || 1) < MSA_TEMPLATE_VERSION) {
      const upd = await pool.query(
        `UPDATE contract_templates SET sections=$1::jsonb, version=$2, updated_at=NOW()
          WHERE id=$3 RETURNING id, version`,
        [JSON.stringify(DEFAULT_MSA_SECTIONS), MSA_TEMPLATE_VERSION, rows[0].id]);
      console.log('[contract-template] refreshed stored template to v' + MSA_TEMPLATE_VERSION);
      return { id: upd.rows[0].id, version: upd.rows[0].version, sections: DEFAULT_MSA_SECTIONS };
    }
    const secs = Array.isArray(rows[0].sections) ? rows[0].sections : DEFAULT_MSA_SECTIONS;
    return { id: rows[0].id, version: rows[0].version, sections: secs as TemplateSection[] };
  }
  const ins = await pool.query(
    `INSERT INTO contract_templates (code, name, version, active, sections)
     VALUES ($1,$2,$4,true,$3::jsonb)
     ON CONFLICT (code) DO UPDATE SET updated_at=NOW()
     RETURNING id, version, sections`,
    [code, 'Multi Product — Service Contract', JSON.stringify(DEFAULT_MSA_SECTIONS), MSA_TEMPLATE_VERSION]
  );
  return { id: ins.rows[0].id, version: ins.rows[0].version, sections: DEFAULT_MSA_SECTIONS };
}

export async function buildContractDoc(contractId: number): Promise<ContractDocContext | null> {
  const cRes = await pool.query(
    `SELECT ct.*, c.name AS customer_name, c.address_line_1, c.address_line_2, c.city, c.county, c.postcode
       FROM contracts ct LEFT JOIN customers c ON c.id = ct.customer_id
      WHERE ct.id=$1 AND ct.deleted_at IS NULL LIMIT 1`, [contractId]
  );
  if (!cRes.rows.length) return null;
  const contract = cRes.rows[0];

  const [linesRes, contactsRes, docsRes, termsRes, tpl] = await Promise.all([
    pool.query('SELECT * FROM contract_lines WHERE contract_id=$1 ORDER BY sort_order, id', [contractId]),
    contract.customer_id
      // Who the key contacts are is held on the CUSTOMER record (service_contact_id /
      // principal_contact_id) — that is how the rest of the app resolves them, and how they
      // are set in the UI. The per-contact booleans are honoured too, but on their own they
      // default to false, which is why an agreement could print "Not yet nominated" for a
      // customer that plainly had a service contact.
      ? pool.query(
          `SELECT ct.full_name, ct.job_title, ct.email,
                  (ct.id = c.service_contact_id)   AS is_service_contact,
                  (ct.id = c.principal_contact_id) AS is_primary
             FROM customer_contacts ct
             JOIN customers c ON c.id = ct.customer_id
            WHERE ct.customer_id=$1 AND ct.archived=false
              AND (ct.id = c.service_contact_id
                OR ct.id = c.principal_contact_id
                OR ct.is_service_contact = true
                OR ct.is_primary = true)
            ORDER BY (ct.id = c.service_contact_id) DESC, ct.is_service_contact DESC,
                     (ct.id = c.principal_contact_id) DESC, ct.is_primary DESC, ct.full_name`,
          [contract.customer_id])
      : Promise.resolve({ rows: [] } as any),
    pool.query('SELECT version, kind, title, change_summary, generated_at, signed_at FROM contract_documents WHERE contract_id=$1 ORDER BY version', [contractId]),
    pool.query('SELECT * FROM contract_terms WHERE contract_id=$1 ORDER BY seq', [contractId]),
    loadTemplate(),
  ]);

  const lines = linesRes.rows;
  let monthly = 0, annual = 0, oneOff = 0;
  for (const l of lines) {
    const t = Number(l.line_total) || 0;
    if (l.billing_frequency === 'monthly') monthly += t;
    else if (l.billing_frequency === 'annual') annual += t;
    else oneOff += t;
  }

  // Everything the customer reads about hours comes from the contract's own cover tier, so
  // the inclusions and the Service Levels section cannot drift apart.
  const cover = coverOf(contract.support_cover);
  const sections = tpl.sections.map((sec) => ({ ...sec, body: applyCoverTokens(sec.body, cover) }));

  const groups = SECTION_ORDER.map((key) => {
    const raw = DEFAULT_SERVICE_BLURBS[key] || { title: key, bullets: [] };
    const blurb = { ...raw, bullets: (raw.bullets || []).map((b) => applyCoverTokens(b, cover)) };
    const gl = lines.filter((l: any) => (l.section || 'IT') === key);
    return {
      key, title: blurb.title, intro: blurb.intro, bullets: blurb.bullets, lines: gl,
      monthly: gl.reduce((a: number, l: any) => a + (l.billing_frequency === 'monthly' ? Number(l.line_total) || 0 : 0), 0),
    };
  }).filter((g) => g.lines.length > 0);

  // Change-control table: generated from the document history, never typed by hand. A contract
  // with no generated documents yet shows the initial issue row so the table is never blank.
  const changeControl = docsRes.rows.length
    ? docsRes.rows
    : [{ version: 1, kind: 'agreement', title: 'Initial issue', change_summary: 'Agreement created', generated_at: contract.created_at, signed_at: null }];

  // Once a contract has been extended the live document is the extension, built from the
  // newest term with the one before it as the term that just ended.
  const allTerms = termsRes.rows;
  const latest = allTerms.length ? allTerms[allTerms.length - 1] : null;
  const prior = allTerms.length > 1 ? allTerms[allTerms.length - 2] : null;
  const docKind: 'agreement' | 'extension' = contract.current_doc_kind === 'extension' ? 'extension' : 'agreement';
  const extension = docKind === 'extension' && latest
    ? { previousEnd: prior ? prior.end_date : contract.start_date, startDate: latest.start_date, endDate: latest.end_date, months: latest.months }
    : null;

  return {
    contract, customer: contract, serviceContacts: contactsRes.rows, groups,
    docKind, extensionSections: EXTENSION_SECTIONS, extension, changedLines: [], cover,
    // Only shown on an extension: what has changed in the standard wording since the original
    // was issued. Empty on a new agreement — there is nothing to have changed from. Items are
    // filtered to the tiers they are actually true for before any tokens are substituted.
    wordingChanges: docKind === 'extension'
      ? TEMPLATE_CHANGELOG.map((c) => ({
          ...c,
          items: c.items
            .filter((i) => !i.appliesTo || i.appliesTo.indexOf(cover.code) !== -1)
            .map((i) => ({ ...i, detail: applyCoverTokens(i.detail, cover) })),
        })).filter((c) => c.items.length)
      : [],
    sections, changeControl, terms: termsRes.rows,
    totals: { monthly, annual, oneOff, annualised: monthly * 12 + annual },
    supplier: SUPPLIER,
    logoUrl: logoDataUri(),
    reviewFlags: sections.filter((s) => s.needsReview),
  };
}
