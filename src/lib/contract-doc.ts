// Builds the render context for a contract document: template boilerplate + customer data
// + priced lines grouped into the sections the Multi Service Agreement uses.
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../db/pool';
import {
  DEFAULT_MSA_SECTIONS, DEFAULT_SERVICE_BLURBS, MSA_TEMPLATE_CODE, SUPPLIER, TemplateSection,
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
  reviewFlags: TemplateSection[];
}

// Load the active MSA template, seeding the built-in default the first time. Kept lazy so
// there is no separate migration step to remember on deploy.
export async function loadTemplate(code = MSA_TEMPLATE_CODE): Promise<{ id: number; version: number; sections: TemplateSection[] }> {
  const { rows } = await pool.query(
    'SELECT id, version, sections FROM contract_templates WHERE code=$1 AND active=true ORDER BY version DESC LIMIT 1', [code]
  );
  if (rows.length) {
    const secs = Array.isArray(rows[0].sections) ? rows[0].sections : DEFAULT_MSA_SECTIONS;
    return { id: rows[0].id, version: rows[0].version, sections: secs as TemplateSection[] };
  }
  const ins = await pool.query(
    `INSERT INTO contract_templates (code, name, version, active, sections)
     VALUES ($1,$2,1,true,$3::jsonb)
     ON CONFLICT (code) DO UPDATE SET updated_at=NOW()
     RETURNING id, version, sections`,
    [code, 'Multi Product — Service Contract', JSON.stringify(DEFAULT_MSA_SECTIONS)]
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
      ? pool.query(
          `SELECT full_name, job_title, email, is_primary, is_service_contact FROM customer_contacts
            WHERE customer_id=$1 AND archived=false AND (is_service_contact=true OR is_primary=true)
            ORDER BY is_service_contact DESC, is_primary DESC, full_name`, [contract.customer_id])
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

  const groups = SECTION_ORDER.map((key) => {
    const blurb = DEFAULT_SERVICE_BLURBS[key] || { title: key, bullets: [] };
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

  return {
    contract, customer: contract, serviceContacts: contactsRes.rows, groups,
    sections: tpl.sections, changeControl, terms: termsRes.rows,
    totals: { monthly, annual, oneOff, annualised: monthly * 12 + annual },
    supplier: SUPPLIER,
    logoUrl: logoDataUri(),
    reviewFlags: tpl.sections.filter((s) => s.needsReview),
  };
}
