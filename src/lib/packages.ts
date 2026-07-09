import { pool } from '../db/pool';

// Package Manager resolver. A Package hides one or more underlying Giacom lines behind one
// customer-facing sell line at a set price (override per customer). Matching is auto by a
// description regex, with a manual per-CLI override (force into / exclude from a package).

export interface PkgDef {
  id: number; name: string; category: string; kind: string;
  re: RegExp | null; products: string[]; requiresSeat: boolean; standardPrice: number;
}

export async function getActivePackages(): Promise<PkgDef[]> {
  let rows: any[] = [];
  try { rows = (await pool.query("SELECT * FROM packages WHERE is_active=true ORDER BY sort_order, id")).rows; }
  catch { return []; } // table may not exist until deploy
  // Core products per package (the intuitive pick-list), lower-cased for matching.
  const prodByPkg = new Map<number, string[]>();
  try {
    (await pool.query('SELECT package_id, lower(product_name) AS n FROM package_products')).rows
      .forEach((r: any) => { if (!prodByPkg.has(r.package_id)) prodByPkg.set(r.package_id, []); prodByPkg.get(r.package_id)!.push(r.n); });
  } catch { /* table may not exist until deploy */ }
  return rows.map((r) => {
    let re: RegExp | null = null;
    if (r.match_pattern) { try { re = new RegExp(r.match_pattern, 'i'); } catch { re = null; } }
    return { id: r.id, name: r.name, category: r.category, kind: r.kind, re, products: prodByPkg.get(r.id) || [], requiresSeat: !!r.requires_seat, standardPrice: Number(r.standard_price) || 0 };
  });
}

// How many of a CLI's line descriptions this package claims (core-product membership OR the
// family pattern). 0 = no match.
function matchScore(pkg: PkgDef, descs: string[]): number {
  let n = 0;
  for (const d of descs) {
    const dl = d.toLowerCase();
    if (pkg.products.some((p) => p && (dl === p || dl.indexOf(p) >= 0 || p.indexOf(dl) >= 0))) { n++; continue; }
    if (pkg.re && pkg.re.test(d)) n++;
  }
  return n;
}

// Detect the best package for a set of line descriptions (no customer pricing). Used by the
// bill run's per-CLI review to advise "package detected".
export async function detectPackage(descs: string[]): Promise<{ id: number; name: string } | null> {
  const pkgs = await getActivePackages();
  let best = 0; let chosen: PkgDef | null = null;
  for (const p of pkgs) { if (p.kind === 'flat') continue; const s = matchScore(p, descs); if (s > best) { best = s; chosen = p; } }
  return chosen ? { id: chosen.id, name: chosen.name } : null;
}

export interface CliPackage { id: number; name: string; category: string; sale: number; requiresSeat: boolean; }

// Resolve which package each CLI belongs to, given the customer's service lines. Manual override
// wins; otherwise the first active per-CLI package whose pattern matches a line on that CLI.
// Returns a Map keyed by the whitespace-stripped CLI. (per_cli packages only — flat/add-ons later.)
export async function resolveCliPackages(
  customerId: number,
  lines: { cli: string | null; description: string | null }[],
): Promise<Map<string, CliPackage>> {
  const pkgs = await getActivePackages();
  const out = new Map<string, CliPackage>();
  if (!pkgs.length) return out;

  const overrides = new Map<string, number | null>();
  (await pool.query("SELECT cli, package_id FROM package_cli_overrides")).rows
    .forEach((r: any) => overrides.set(String(r.cli || '').replace(/\s+/g, ''), r.package_id ?? null));
  const prices = new Map<number, number>();
  (await pool.query("SELECT package_id, sale_price FROM package_prices WHERE customer_id=$1", [customerId])).rows
    .forEach((r: any) => prices.set(r.package_id, Number(r.sale_price)));

  const byCli = new Map<string, string[]>();
  for (const l of lines) {
    const cli = String(l.cli || '').replace(/\s+/g, ''); if (!cli) continue;
    if (!byCli.has(cli)) byCli.set(cli, []);
    byCli.get(cli)!.push(String(l.description || ''));
  }
  for (const [cli, descs] of byCli) {
    let pkg: PkgDef | null = null;
    if (overrides.has(cli)) {
      const ov = overrides.get(cli);
      if (ov === null) continue;            // explicit exclude
      pkg = pkgs.find((p) => p.id === ov) || null;
    }
    if (!pkg) {
      // Best auto-match: the package claiming the MOST of this CLI's lines (so a tariff SKU beats
      // a shared add-on like Data Optimiser); ties broken by sort order (pkgs already sorted).
      let best = 0;
      for (const p of pkgs) {
        if (p.kind === 'flat') continue;
        const score = matchScore(p, descs);
        if (score > best) { best = score; pkg = p; }
      }
    }
    if (!pkg) continue;
    const sale = prices.has(pkg.id) ? prices.get(pkg.id)! : pkg.standardPrice;
    out.set(cli, { id: pkg.id, name: pkg.name, category: pkg.category, sale, requiresSeat: pkg.requiresSeat });
  }
  return out;
}
