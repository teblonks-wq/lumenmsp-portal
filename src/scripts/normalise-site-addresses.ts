import 'dotenv/config';
import { Pool } from 'pg';

// Normalise legacy Google-autocomplete "blob" site addresses, where the whole
// address ("Gemini House, Hargreaves Rd, Swindon SN25 5AZ, UK") got jammed into
// address_line_1. Splits out the UK postcode + city, cleans line 1.
//
//   DRY-RUN (default): prints every before -> after, writes nothing.
//   APPLY:  node dist/scripts/normalise-site-addresses.js --apply
//
// Existing clean city/postcode values are preserved (never clobbered). Note: several
// customers legitimately share the Gemini House, Hargreaves Rd building — those are real
// co-located sites and get normalised like any other row.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

const PC_RE = /\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})\b/;
const hasPostcode = (s: any): boolean => PC_RE.test(String(s || ''));

function parseBlob(raw: string): { line1: string; line1Full: string; city: string; postcode: string } {
  let s = String(raw || '').trim();
  s = s.replace(/[,/]?\s*(uk|united kingdom)\.?\s*$/i, '').trim(); // drop trailing country
  let postcode = '';
  const m = s.match(PC_RE);
  if (m && m.index !== undefined) {
    postcode = (m[1] + ' ' + m[2]).toUpperCase();
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim();
  }
  s = s.replace(/[,\s]+$/, '').replace(/^[,\s]+/, '');
  const parts = s.split(/[,/]/).map((p) => p.trim()).filter(Boolean);
  const city = parts.length >= 2 ? parts[parts.length - 1] : '';
  const line1 = parts.length >= 2 ? parts.slice(0, -1).join(', ') : (parts[0] || '');
  const line1Full = parts.join(', ');
  return { line1, line1Full, city, postcode };
}

(async () => {
  const rows = (await pool.query(
    `SELECT id, customer_id, address_line_1, city, county, postcode FROM customer_sites
      WHERE position(',' in coalesce(address_line_1,'')) > 0 ORDER BY customer_id`
  )).rows;

  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'} — ${rows.length} blob site row(s)\n`);
  let applied = 0, changed = 0;

  for (const r of rows) {
    const p = parseBlob(r.address_line_1);
    const cityClean = r.city && !hasPostcode(r.city);
    const newCity = cityClean ? r.city : (p.city || r.city || null);
    const newLine1 = cityClean ? p.line1Full : p.line1;        // keep all parts when we keep the existing city
    const newPc = r.postcode || p.postcode || null;

    const willChange = newLine1 !== r.address_line_1 || (newCity || '') !== (r.city || '') || (newPc || '') !== (r.postcode || '');
    if (willChange) changed++;
    console.log(`site ${r.id} (cust ${r.customer_id})${willChange ? '' : '  [no change]'}`);
    console.log(`   before: l1="${r.address_line_1}"  city="${r.city || ''}"  pc="${r.postcode || ''}"`);
    console.log(`   after : l1="${newLine1}"  city="${newCity || ''}"  pc="${newPc || ''}"`);

    if (APPLY && willChange) {
      await pool.query('UPDATE customer_sites SET address_line_1=$1, city=$2, postcode=$3 WHERE id=$4', [newLine1, newCity, newPc, r.id]);
      applied++;
    }
  }

  console.log(`\nSummary: ${changed} row(s) to fix. ${APPLY ? `Applied ${applied} update(s).` : 'Dry-run only — re-run with --apply to write.'}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
