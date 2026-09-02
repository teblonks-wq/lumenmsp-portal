import { pool } from '../db/pool';

// ── The supplier master ─────────────────────────────────────────────────────────
// A supplier stops being a string re-guessed from a bank narrative on every sweep and
// becomes a record a human confirmed once.
//
// Why this exists, in the words of the things that went wrong without it:
//   • supplierKey resolved to "terry o" — a forwarded invoice keyed to the forwarder.
//   • "Amazon", "Amazon.co.uk" and "Amazon J Tf" were three different suppliers.
//   • Aventis — our LANDLORD — sat on the no-invoice-expected list as financing, guarded
//     by a regex lookahead the real bank narrative does not contain.
//
// The rule: EVIDENCE identifies, a HUMAN confirms. An alias may be proposed automatically;
// only a person makes it permanent, and (kind, value) is unique so a match is never
// ambiguous — one alias can point at exactly one supplier.

export type AliasKind =
  | 'email_address' | 'email_domain' | 'bank_narrative' | 'filename'
  | 'vat_number' | 'account_ref' | 'display_name';

export interface Evidence {
  fromEmail?: string | null;
  fromName?: string | null;
  counterparty?: string | null;   // bank payee
  description?: string | null;    // bank narrative
  fileName?: string | null;
  aiSupplier?: string | null;     // what the invoice itself says
  vatNumber?: string | null;
  accountRef?: string | null;
}

export interface Resolved {
  supplierId: number;
  name: string;
  confirmed: boolean;
  via: AliasKind;
  aliasId: number;
  value: string;
  confidence: number;
}

export const norm = (v: any) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const domainOf = (email: any) => { const m = /@([^@\s>]+)$/.exec(norm(email)); return m ? m[1] : ''; };

// Most specific first. An email address is better evidence than a domain; a domain is
// better than a word that happened to appear in a bank narrative; a filename is the last
// resort because it is the easiest thing to be wrong about.
const ORDER: AliasKind[] = ['vat_number', 'account_ref', 'email_address', 'email_domain', 'bank_narrative', 'display_name', 'filename'];

function candidatesFor(kind: AliasKind, e: Evidence): string[] {
  switch (kind) {
    case 'vat_number':    return [norm(e.vatNumber)].filter(Boolean);
    case 'account_ref':   return [norm(e.accountRef)].filter(Boolean);
    case 'email_address': return [norm(e.fromEmail)].filter(Boolean);
    case 'email_domain':  return [domainOf(e.fromEmail)].filter(Boolean);
    case 'bank_narrative':return [norm(e.counterparty), norm(e.description)].filter(Boolean);
    case 'display_name':  return [norm(e.aiSupplier), norm(e.fromName)].filter(Boolean);
    case 'filename':      return [norm(e.fileName)].filter(Boolean);
  }
}

function hit(alias: any, subject: string): boolean {
  const v = String(alias.value || '');
  if (!v || !subject) return false;
  switch (alias.match) {
    case 'exact':  return subject === v;
    case 'prefix': return subject.startsWith(v);
    case 'regex':  { try { return new RegExp(v, 'i').test(subject); } catch { return false; } }
    default:       return subject.includes(v);
  }
}

// Resolve one document or payment to a supplier. Returns null rather than guessing —
// an unresolved item is a question for a human, not a bad answer written to the ledger.
export async function resolveSupplier(e: Evidence): Promise<Resolved | null> {
  const rows = (await pool.query(
    `SELECT a.id, a.supplier_id, a.kind, a.value, a.match, a.confidence, s.name, s.confirmed_at
       FROM supplier_aliases a JOIN suppliers s ON s.id = a.supplier_id
      WHERE a.status = 'active'`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  if (!rows.length) return null;

  for (const kind of ORDER) {
    const subjects = candidatesFor(kind, e);
    if (!subjects.length) continue;
    // Within a kind the LONGEST alias wins, so "giacom world networks" is preferred
    // over "giacom" and the more specific supplier is chosen.
    const ranked = rows.filter((r: any) => r.kind === kind).sort((a: any, b: any) => String(b.value).length - String(a.value).length);
    for (const subject of subjects) {
      for (const a of ranked) {
        if (!hit(a, subject)) continue;
        await pool.query('UPDATE supplier_aliases SET seen_count = seen_count + 1, last_seen_at = NOW() WHERE id=$1', [a.id]).catch(() => {});
        return {
          supplierId: a.supplier_id, name: a.name, confirmed: !!a.confirmed_at,
          via: kind, aliasId: a.id, value: a.value, confidence: Number(a.confidence) || 100,
        };
      }
    }
  }
  return null;
}

// ── Aliases ─────────────────────────────────────────────────────────────────────
// Proposed aliases are visible and matchable but marked, so a person can see what the
// system worked out for itself before it becomes permanent.
export async function addAlias(
  supplierId: number, kind: AliasKind, value: string,
  opts: { match?: string; source?: string; status?: string; reason?: string; userId?: number | null } = {}
): Promise<{ ok: boolean; conflict?: string }> {
  const v = norm(value);
  if (!v) return { ok: false, conflict: 'empty' };
  const existing = (await pool.query(
    'SELECT a.id, a.supplier_id, s.name FROM supplier_aliases a JOIN suppliers s ON s.id=a.supplier_id WHERE a.kind=$1 AND a.value=$2', [kind, v]
  ).catch(() => ({ rows: [] as any[] }))).rows[0];
  if (existing) {
    if (existing.supplier_id === supplierId) return { ok: true };
    // One alias, one supplier. A clash is a real question, never something to overwrite.
    return { ok: false, conflict: existing.name };
  }
  await pool.query(
    `INSERT INTO supplier_aliases (supplier_id, kind, value, match, source, status, reason, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [supplierId, kind, v, opts.match || 'contains', opts.source || 'human',
     opts.status || 'active', opts.reason || null, opts.userId ?? null]
  ).catch(() => {});
  return { ok: true };
}

export async function setAliasStatus(id: number, status: 'active' | 'rejected', userId: number | null): Promise<void> {
  await pool.query('UPDATE supplier_aliases SET status=$1, created_by=COALESCE(created_by,$2) WHERE id=$3', [status, userId, id]).catch(() => {});
}

// ── Suppliers ───────────────────────────────────────────────────────────────────
// Find by name or create UNCONFIRMED. Nothing created here can drive an automatic
// decision until a person has confirmed it.
export async function ensureSupplier(name: string, opts: { onCredit?: boolean; buys?: string } = {}): Promise<number> {
  const n = String(name || '').trim();
  if (!n) throw new Error('A supplier needs a name.');
  const found = (await pool.query('SELECT id FROM suppliers WHERE lower(name)=lower($1) LIMIT 1', [n])).rows[0];
  if (found) {
    await pool.query('UPDATE suppliers SET is_purchase_supplier=true WHERE id=$1', [found.id]).catch(() => {});
    return found.id;
  }
  const r = await pool.query(
    `INSERT INTO suppliers (name, is_active, is_purchase_supplier, on_credit, buys, created_at, updated_at)
     VALUES ($1, true, true, $2, $3, NOW(), NOW()) RETURNING id`,
    [n, !!opts.onCredit, opts.buys || null]
  );
  return r.rows[0].id;
}

export async function confirmSupplier(id: number, userId: number): Promise<void> {
  await pool.query('UPDATE suppliers SET confirmed_by=$1, confirmed_at=NOW(), is_purchase_supplier=true WHERE id=$2', [userId, id]).catch(() => {});
}

// ── What still has no supplier ──────────────────────────────────────────────────
// The confirm queue, ranked by money. Ten suppliers cover most of this ledger, so this
// list should shorten very fast — and it is the only list a human needs to work through
// to make everything downstream trustworthy.
export async function unresolvedSpend(limit = 60): Promise<Array<{ label: string; total: number; count: number; kind: string }>> {
  const out: Array<{ label: string; total: number; count: number; kind: string }> = [];
  const txns = (await pool.query(
    `SELECT counterparty, description, SUM(ABS(amount))::float total, COUNT(*)::int n
       FROM bank_transactions
      WHERE amount < 0 AND counterparty IS NOT NULL AND booked_at > NOW() - INTERVAL '18 months'
      GROUP BY 1,2 ORDER BY 3 DESC LIMIT 400`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  const seen = new Map<string, { label: string; total: number; count: number; kind: string }>();
  for (const t of txns) {
    const r = await resolveSupplier({ counterparty: t.counterparty, description: t.description });
    if (r) continue;
    const key = norm(t.counterparty);
    const cur = seen.get(key);
    if (cur) { cur.total += Number(t.total); cur.count += Number(t.n); }
    else seen.set(key, { label: t.counterparty, total: Number(t.total), count: Number(t.n), kind: 'payments' });
  }
  out.push(...[...seen.values()].sort((a, b) => b.total - a.total));
  return out.slice(0, limit);
}

// ── Seeding ─────────────────────────────────────────────────────────────────────
// Everything below seeds from evidence we ALREADY hold — sender patterns that were written
// by hand for the mailbox export, and bank descriptors observed on matches a human already
// confirmed. Nothing here is invented.

// The three credit accounts, confirmed by Terry on 2026-09-02. Seeded unconfirmed so a
// person still ticks them off. Giacom Hardware is deliberately separate from Giacom's
// cloud/licence billing: same company, two relationships, and pooling them is what made
// the agent compare a hardware invoice against a monthly service average.
export const CREDIT_ACCOUNTS = [
  { name: 'Giacom — Hardware', buys: 'hardware' },
  { name: 'Adept Networks Swindon', buys: 'connectivity' },
  { name: 'All Trade', buys: 'hardware' },
];

export async function seedCreditAccounts(): Promise<number> {
  let n = 0;
  for (const c of CREDIT_ACCOUNTS) {
    const id = await ensureSupplier(c.name, { onCredit: true, buys: c.buys });
    await pool.query("UPDATE suppliers SET on_credit=true, po_required='always', buys=COALESCE(buys,$2) WHERE id=$1", [id, c.buys]).catch(() => {});
    n++;
  }
  return n;
}

// Bank descriptors the agent recorded on confirmed matches become bank_narrative aliases.
// These are the strongest evidence in the system: a human already agreed each one.
export async function seedFromProfiles(): Promise<{ suppliers: number; aliases: number }> {
  const rows = (await pool.query(
    `SELECT supplier_key, display_name, descriptors FROM purchase_supplier_profiles
      WHERE display_name IS NOT NULL AND match_count > 0`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  let suppliers = 0, aliases = 0;
  const done = new Set<string>();
  for (const r of rows) {
    const name = String(r.display_name || '').trim();
    if (!name || name.length < 2) continue;
    if (done.has(norm(name))) continue;
    done.add(norm(name));
    const id = await ensureSupplier(name);
    suppliers++;
    if ((await addAlias(id, 'display_name', name, { match: 'exact', source: 'import', reason: 'Learned name from confirmed matches' })).ok) aliases++;
    let list: string[] = [];
    try { list = JSON.parse(r.descriptors || '[]'); } catch { list = []; }
    for (const d of list.slice(0, 12)) {
      const v = norm(d);
      if (v.length < 4) continue;   // too short to be safe as a 'contains'
      if ((await addAlias(id, 'bank_narrative', v, { match: 'contains', source: 'import', reason: 'Bank descriptor seen on a confirmed match' })).ok) aliases++;
    }
  }
  return { suppliers, aliases };
}

// The sender rules written by hand for the mailbox export. Each one is a person's judgement
// about which emails are which supplier's — the best seed available for email aliases.
export async function seedFromRules(rules: any): Promise<{ suppliers: number; aliases: number }> {
  const list: any[] = (rules && rules.Suppliers) || [];
  let suppliers = 0, aliases = 0;
  for (const r of list) {
    const name = String(r.Name || '').trim();
    const pattern = String(r.SenderPattern || '').trim();
    if (!name || !pattern) continue;
    const id = await ensureSupplier(name);
    suppliers++;
    if ((await addAlias(id, 'email_address', pattern, {
      match: 'regex', source: 'import',
      reason: 'Sender rule from the mailbox export' + (r.PortalOnly ? ' (invoices are portal-only)' : ''),
    })).ok) aliases++;
    if (r.PortalOnly) {
      await pool.query("UPDATE suppliers SET invoice_source='portal' WHERE id=$1 AND invoice_source IS NULL", [id]).catch(() => {});
    }
  }
  return { suppliers, aliases };
}
