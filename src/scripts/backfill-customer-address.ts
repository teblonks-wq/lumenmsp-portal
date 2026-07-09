import 'dotenv/config';
import { Pool } from 'pg';

// Backfill the CUSTOMER RECORD address from the customer's MAIN (primary) site, for any
// customer whose own address fields are blank. The primary site = "the main address";
// other sites stay as sites. Records that already have an address (e.g. Larkmead's
// "Ilges Lane") are NOT touched — we never clobber existing record data.
//
// Self-cleans the legacy Google-blob format on the way in, so the record gets tidy fields
// regardless of whether normalise-site-addresses has been run yet.
//
//   DRY-RUN (default): prints every proposed fill, writes nothing.
//   APPLY:  node dist/scripts/backfill-customer-address.js --apply

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

const PC_RE = /\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})\b/;
const hasPostcode = (s: any): boolean => PC_RE.test(String(s || ''));

// Tidy a (possibly blob) site address into structured parts, preserving clean inputs.
function tidy(line1Raw: string, cityRaw: string, countyRaw: string, pcRaw: string) {
  let s = String(line1Raw || '').trim().replace(/[,/]?\s*(uk|united kingdom)\.?\s*$/i, '').trim();
  let postcode = pcRaw || '';
  const m = s.match(PC_RE);
  if (m && m.index !== undefined) {
    if (!postcode) postcode = (m[1] + ' ' + m[2]).toUpperCase();
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim();
  }
  s = s.replace(/[,\s]+$/, '').replace(/^[,\s]+/, '');
  const parts = s.split(/[,/]/).map((p) => p.trim()).filter(Boolean);
  const cityClean = cityRaw && !hasPostcode(cityRaw);
  const city = cityClean ? cityRaw : (parts.length >= 2 ? parts[parts.length - 1] : (cityRaw || ''));
  const line1 = cityClean ? parts.join(', ') : (parts.length >= 2 ? parts.slice(0, -1).join(', ') : (parts[0] || ''));
  return { line1, line2: '', city: city || '', county: countyRaw || '', postcode: postcode || '' };
}

(async () => {
  const rows = (await pool.query(
    `SELECT c.id, c.name,
            s.address_line_1 AS s_l1, s.address_line_2 AS s_l2, s.city AS s_city, s.county AS s_county, s.postcode AS s_pc,
            s.site_name
       FROM customers c
       JOIN LATERAL (
         SELECT * FROM customer_sites WHERE customer_id = c.id AND COALESCE(address_line_1,'') <> ''
          ORDER BY is_primary DESC, id LIMIT 1
       ) s ON true
      WHERE c.deleted_at IS NULL AND COALESCE(c.address_line_1,'') = ''
      ORDER BY c.name`
  )).rows;

  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'} — ${rows.length} customer record(s) with a blank address + a usable primary site\n`);
  let applied = 0;
  for (const r of rows) {
    const a = tidy(r.s_l1, r.s_city, r.s_county, r.s_pc);
    console.log(`#${r.id} ${r.name}  (from site "${r.site_name || ''}")`);
    console.log(`   → l1="${a.line1}"  city="${a.city}"  county="${a.county}"  pc="${a.postcode}"`);
    if (APPLY) {
      await pool.query(
        'UPDATE customers SET address_line_1=$1, address_line_2=$2, city=$3, county=$4, postcode=$5 WHERE id=$6',
        [a.line1, a.line2 || null, a.city || null, a.county || null, a.postcode || null, r.id]
      );
      applied++;
    }
  }
  console.log(`\nSummary: ${rows.length} record(s) to fill. ${APPLY ? `Applied ${applied}.` : 'Dry-run only — re-run with --apply to write.'}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
