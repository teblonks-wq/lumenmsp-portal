/**
 * Backfill the third-party register.
 *
 * Terry, 2026-08-26: *"back fill some third parties based on our suppliers and contacts
 * marked as third party in portal"*.
 *
 * ── It does not write anything unless you tell it to ───────────────────────────
 *
 *     node dist/scripts/backfill-third-parties.js              # dry run — prints, writes nothing
 *     node dist/scripts/backfill-third-parties.js --apply      # writes everything proposed
 *     node dist/scripts/backfill-third-parties.js --apply --skip=3,7,12
 *
 * The dry run numbers every proposal so a line you disagree with can be skipped by number.
 * Run the dry run, read it, then apply — this touches the live address book and the numbers
 * only mean anything within one run, so do not skip on numbers from an older printout.
 *
 * ── Three passes, in order of how much they are guessing ───────────────────────
 *
 *   A. PROVEN. Any supplier already attached to a real case as its third party
 *      (`inbox_tickets.third_party_id`) but not flagged. This is not inference — we have
 *      already waited on them. Applied even without --apply? No: still gated, but it is the
 *      part you can approve without reading carefully.
 *
 *   B. NAMED. Suppliers whose name matches the list below. This IS guessing, from names
 *      alone, which is why every one is printed with the matched keyword so you can see
 *      why it fired. Add to KNOWN_THIRD_PARTIES rather than flagging by hand — the next
 *      person to run this gets your judgement for free.
 *
 *   C. CONTACTS. Every `customer_contacts.is_third_party` contact becomes a supplier row,
 *      one per contact (Terry's call — no grouping by company). Contacts on the customer's
 *      OWN domain are skipped: a colleague ticked as third party by accident is not an
 *      outside organisation, and importing them would put the customer's own staff in the
 *      picker you use to say who you are waiting on.
 *
 * ── The one rule inherited from the module ─────────────────────────────────────
 *
 * `POST /third-parties` flags an existing supplier rather than duplicating it when the name
 * already exists (case-insensitive). This does the same. One row per contact is what was
 * asked for, but two rows with the SAME NAME is not "one per contact", it is a duplicate —
 * so a collision flags the existing row and records the extra contact in its notes.
 */
import { pool } from '../db/pool';
import { THIRD_PARTY_CATEGORIES } from '../lib/third-party';

// ── The name list. Edit this rather than flagging by hand. ──────────────────────
// keyword (matched case-insensitively anywhere in the supplier name) → what it is, and how
// long they typically take. typicalDays seeds the chase-by date on a parked case, so a
// wrong-but-plausible number is worse than null: null makes somebody choose.
interface Known { match: string; category: string; typicalDays: number | null; note?: string }

const KNOWN_THIRD_PARTIES: Known[] = [
  // Connectivity — the classic "waiting on someone else" cases.
  { match: 'openreach',    category: 'Connectivity / Openreach', typicalDays: 5, note: 'Chase via the provider, not Openreach directly.' },
  { match: 'cityfibre',    category: 'Connectivity / Openreach', typicalDays: 5 },
  { match: 'bt wholesale', category: 'Telecoms carrier',         typicalDays: 5 },
  { match: 'bt ',          category: 'Telecoms carrier',         typicalDays: 5 },
  { match: 'gamma',        category: 'Telecoms carrier',         typicalDays: 3 },
  { match: 'vodafone',     category: 'Telecoms carrier',         typicalDays: 5 },
  { match: 'talktalk',     category: 'Telecoms carrier',         typicalDays: 5 },
  { match: 'virgin',       category: 'Telecoms carrier',         typicalDays: 5 },
  { match: 'zen',          category: 'Telecoms carrier',         typicalDays: 3 },
  { match: 'cloudnumbering', category: 'Telecoms carrier',       typicalDays: 2 },
  { match: 'tollring',     category: 'Software vendor',          typicalDays: 3 },

  // Cloud / licensing.
  { match: 'giacom',       category: 'Cloud / licensing',        typicalDays: 3 },
  { match: 'microsoft',    category: 'Cloud / licensing',        typicalDays: 5 },
  { match: 'azure',        category: 'Cloud / licensing',        typicalDays: 5 },
  { match: '20i',          category: 'Cloud / licensing',        typicalDays: 2 },
  { match: 'wasabi',       category: 'Cloud / licensing',        typicalDays: 3 },

  // Software vendors we raise cases with.
  { match: 'bitdefender',  category: 'Software vendor',          typicalDays: 3 },
  { match: 'gravityzone',  category: 'Software vendor',          typicalDays: 3 },
  { match: 'acronis',      category: 'Software vendor',          typicalDays: 3 },
  { match: 'msp360',       category: 'Software vendor',          typicalDays: 3 },
  { match: 'sophos',       category: 'Software vendor',          typicalDays: 3 },
  { match: 'quickbooks',   category: 'Software vendor',          typicalDays: 5 },
  { match: 'intuit',       category: 'Software vendor',          typicalDays: 5 },
  { match: 'gocardless',   category: 'Software vendor',          typicalDays: 3 },
  { match: 'vetlink',      category: "Customer's own supplier",  typicalDays: 5 },

  // Hardware.
  { match: 'dell',         category: 'Hardware vendor',          typicalDays: 3, note: 'Warranty claims go through TechDirect.' },
  { match: 'hewlett',      category: 'Hardware vendor',          typicalDays: 5 },
  { match: 'hp ',          category: 'Hardware vendor',          typicalDays: 5 },
  { match: 'lenovo',       category: 'Hardware vendor',          typicalDays: 5 },
  { match: 'ubiquiti',     category: 'Hardware vendor',          typicalDays: 5 },
  { match: 'unifi',        category: 'Hardware vendor',          typicalDays: 5 },
  { match: 'draytek',      category: 'Hardware vendor',          typicalDays: 5 },

  // Distribution — we buy, and we also wait on RMAs.
  { match: 'ingram',       category: 'Hardware vendor',          typicalDays: 3 },
  { match: 'westcoast',    category: 'Hardware vendor',          typicalDays: 3 },
  { match: 'exertis',      category: 'Hardware vendor',          typicalDays: 3 },
  { match: 'scansource',   category: 'Hardware vendor',          typicalDays: 3 },
  { match: 'tech data',    category: 'Hardware vendor',          typicalDays: 3 },
];

// ── Args ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SKIP = new Set(
  (argv.find((a) => a.startsWith('--skip=')) || '').replace('--skip=', '')
    .split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0),
);

interface Proposal {
  n: number;
  kind: 'flag' | 'create';
  why: string;
  supplierId?: number;
  name: string;
  category: string | null;
  typicalDays: number | null;
  fields?: Record<string, any>;
}

const proposals: Proposal[] = [];
let seq = 0;
const add = (p: Omit<Proposal, 'n'>) => { proposals.push({ n: ++seq, ...p }); };

/** "acmeweb.co.uk" -> "Acmeweb". Public mailbox domains give nothing useful, so they fall
 *  back to the person's name rather than creating a supplier called "Gmail". */
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com', 'btinternet.com',
  'sky.com', 'talktalk.net', 'virginmedia.com', 'protonmail.com', 'proton.me',
]);

function orgFromEmail(email: string | null): string | null {
  const dom = String(email || '').split('@')[1];
  if (!dom) return null;
  const d = dom.toLowerCase().trim();
  if (PUBLIC_DOMAINS.has(d)) return null;
  const first = d.split('.')[0];
  if (!first || first.length < 2) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const cat = (c: string): string => (THIRD_PARTY_CATEGORIES.includes(c) ? c : 'Other');

async function main(): Promise<void> {
  console.log(APPLY ? '\n*** APPLYING — this writes to the live address book ***\n'
                    : '\nDry run. Nothing will be written. Add --apply once you are happy.\n');

  // ── Pass A: proven — already used as a third party on a real case ────────────
  const proven = (await pool.query(
    `SELECT s.id, s.name, s.category, s.typical_days, COUNT(t.id)::int AS cases
       FROM suppliers s
       JOIN inbox_tickets t ON t.third_party_id = s.id
      WHERE s.is_third_party = false
      GROUP BY s.id, s.name, s.category, s.typical_days
      ORDER BY COUNT(t.id) DESC, s.name`)).rows;

  console.log(`── A. Already used on a case, but not flagged (${proven.length}) ─────────────`);
  if (!proven.length) console.log('   none — nothing has been parked on an unflagged supplier.');
  for (const s of proven) {
    const k = KNOWN_THIRD_PARTIES.find((x) => s.name.toLowerCase().includes(x.match));
    add({
      kind: 'flag', supplierId: s.id, name: s.name,
      category: s.category || (k ? cat(k.category) : null),
      typicalDays: s.typical_days ?? (k ? k.typicalDays : null),
      why: `attached to ${s.cases} case${s.cases === 1 ? '' : 's'} already`,
    });
    const p = proposals[proposals.length - 1];
    console.log(`   ${String(p.n).padStart(3)}. FLAG   ${s.name}  — ${p.why}`
      + (p.category ? `  [${p.category}${p.typicalDays ? `, ~${p.typicalDays}d` : ''}]` : ''));
  }

  // ── Pass B: named — matched by the list above ────────────────────────────────
  const named = (await pool.query(
    `SELECT id, name, category, typical_days, support_email, portal_url
       FROM suppliers
      WHERE is_third_party = false AND is_active = true
      ORDER BY name`)).rows;

  const hits = named.map((s: any) => {
    const k = KNOWN_THIRD_PARTIES.find((x) => String(s.name).toLowerCase().includes(x.match));
    return k ? { s, k } : null;
  }).filter(Boolean) as { s: any; k: Known }[];

  console.log(`\n── B. Matched the name list (${hits.length}) ───────────────────────────────`);
  console.log('   Read these: they are matched on NAME ALONE. The keyword that fired is shown.');
  if (!hits.length) console.log('   none matched.');
  for (const { s, k } of hits) {
    if (proposals.some((p) => p.supplierId === s.id)) continue;   // already proposed in pass A
    add({
      kind: 'flag', supplierId: s.id, name: s.name,
      category: s.category || cat(k.category),
      typicalDays: s.typical_days ?? k.typicalDays,
      why: `name contains "${k.match}"`,
      fields: k.note ? { escalation_note: k.note } : undefined,
    });
    const p = proposals[proposals.length - 1];
    console.log(`   ${String(p.n).padStart(3)}. FLAG   ${s.name}  — ${p.why}`
      + `  [${p.category}${p.typicalDays ? `, ~${p.typicalDays}d` : ''}]`);
  }

  // ── Pass C: contacts marked third party ─────────────────────────────────────
  // The customer's own domain is excluded. A contact ticked third party by mistake is a
  // colleague, and importing them would put the customer's own staff into the picker used
  // to say who we are waiting on — which quietly makes the whole register untrustworthy.
  const contacts = (await pool.query(
    `SELECT ct.id, ct.full_name, ct.email, ct.phone, ct.mobile_phone, ct.job_title, ct.department,
            c.name AS customer_name, c.domain AS customer_domain
       FROM customer_contacts ct
       JOIN customers c ON c.id = ct.customer_id
      WHERE ct.is_third_party = true AND ct.archived = false AND c.deleted_at IS NULL
      ORDER BY c.name, ct.full_name`)).rows;

  console.log(`\n── C. Contacts marked third party (${contacts.length}) ─────────────────────`);
  if (!contacts.length) console.log('   none — no contact carries the third-party tick.');

  // Existing names, so a proposal that collides flags rather than duplicates.
  const existing = new Map<string, number>(
    (await pool.query('SELECT id, name FROM suppliers')).rows.map((r: any) => [String(r.name).trim().toLowerCase(), r.id]),
  );
  const proposedNames = new Map<string, number>();   // lower(name) -> proposal index

  let skippedOwnDomain = 0;
  for (const ct of contacts) {
    const dom = String(ct.email || '').split('@')[1]?.toLowerCase();
    const own = String(ct.customer_domain || '').toLowerCase().replace(/^www\./, '');
    if (dom && own && (dom === own || dom.endsWith('.' + own))) {
      skippedOwnDomain++;
      continue;
    }
    const org = orgFromEmail(ct.email);
    // One row per contact, as asked — but named so the row is recognisable in a picker.
    // "Acmeweb — Dave Smith" beats either half on its own.
    const name = org ? `${org} — ${ct.full_name}` : String(ct.full_name);
    const key = name.trim().toLowerCase();

    if (existing.has(key)) {
      add({
        kind: 'flag', supplierId: existing.get(key)!, name,
        category: cat("Customer's own supplier"), typicalDays: null,
        why: `contact at ${ct.customer_name} — a supplier with this name already exists, so it is flagged rather than duplicated`,
      });
      console.log(`   ${String(seq).padStart(3)}. FLAG   ${name}  — existing supplier, ${ct.customer_name}`);
      continue;
    }
    if (proposedNames.has(key)) {
      console.log(`        (skipped duplicate proposal for "${name}")`);
      continue;
    }
    proposedNames.set(key, seq + 1);
    add({
      kind: 'create', name,
      category: cat("Customer's own supplier"), typicalDays: null,
      why: `third-party contact of ${ct.customer_name}${ct.job_title ? ` (${ct.job_title})` : ''}`,
      fields: {
        contact_name: ct.full_name,
        email: ct.email || null,
        support_email: ct.email || null,
        phone: ct.phone || ct.mobile_phone || null,
        support_phone: ct.phone || ct.mobile_phone || null,
        notes: `Backfilled 2026-08-26 from the third-party contact "${ct.full_name}" at ${ct.customer_name}.`
             + (ct.job_title ? ` Job title: ${ct.job_title}.` : ''),
      },
    });
    console.log(`   ${String(seq).padStart(3)}. CREATE ${name}  — ${proposals[proposals.length - 1].why}`);
  }
  if (skippedOwnDomain) {
    console.log(`   (${skippedOwnDomain} skipped — their email is on the customer's OWN domain, so they are colleagues, not an outside organisation. Worth a look: the tick may be wrong.)`);
  }

  // ── Pass D: report only — parked cases with nobody named ────────────────────
  // Never guessed at. The point of the register is that a parked case names somebody, and
  // these are the cases where it still does not.
  try {
    const orphan = (await pool.query(
      `SELECT t.ticket_number, c.name AS customer_name, t.subject,
              EXTRACT(DAY FROM (NOW() - COALESCE(t.waiting_since, t.updated_at)))::int AS days
         FROM inbox_tickets t LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.status = 'awaiting_3rd_party' AND t.third_party_id IS NULL
          AND t.deleted_at IS NULL
        ORDER BY days DESC LIMIT 40`)).rows;
    console.log(`\n── D. Parked on a third party with NOBODY named (${orphan.length}) — report only ──`);
    if (!orphan.length) console.log('   none. Every parked case names who it is waiting on.');
    for (const o of orphan) {
      console.log(`   ${o.ticket_number}  ${String(o.days).padStart(3)}d  ${o.customer_name || '-'} — ${String(o.subject || '').slice(0, 70)}`);
    }
    if (orphan.length) console.log('   These need a person to say who. Nothing here can guess it safely.');
  } catch (e: any) {
    console.log('\n── D. skipped: ' + e.message);
  }

  // ── Apply ────────────────────────────────────────────────────────────────────
  const todo = proposals.filter((p) => !SKIP.has(p.n));
  console.log(`\n${proposals.length} proposal${proposals.length === 1 ? '' : 's'}`
    + (SKIP.size ? `, ${proposals.length - todo.length} skipped by --skip` : ''));

  if (!APPLY) {
    console.log('\nNothing written. Re-run with --apply (and --skip=n,n for any you disagree with).');
    console.log('The numbers are only valid for THIS run — re-read them before skipping.\n');
    return;
  }

  let flagged = 0, created = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of todo) {
      if (p.kind === 'flag' && p.supplierId) {
        // COALESCE on every field: a category or a note somebody has already set by hand is
        // a human decision and outranks anything this script inferred.
        await client.query(
          `UPDATE suppliers
              SET is_third_party = true,
                  category = COALESCE(category, $2),
                  typical_days = COALESCE(typical_days, $3),
                  escalation_note = COALESCE(escalation_note, $4),
                  updated_at = NOW()
            WHERE id = $1`,
          [p.supplierId, p.category, p.typicalDays, p.fields?.escalation_note || null]);
        flagged++;
      } else if (p.kind === 'create') {
        const f = p.fields || {};
        await client.query(
          `INSERT INTO suppliers (name, is_third_party, category, contact_name, email, support_email,
                                  phone, support_phone, notes, is_active)
           VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8, true)`,
          [p.name, p.category, f.contact_name || null, f.email || null, f.support_email || null,
           f.phone || null, f.support_phone || null, f.notes || null]);
        created++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  console.log(`\nDone. ${flagged} supplier${flagged === 1 ? '' : 's'} flagged, ${created} created.`);
  console.log('Check them on /third-parties — names, categories and chase times are all editable there.\n');
}

main()
  .then(() => pool.end())
  .catch(async (e) => { console.error('\nFAILED:', e.message); await pool.end().catch(() => {}); process.exit(1); });
