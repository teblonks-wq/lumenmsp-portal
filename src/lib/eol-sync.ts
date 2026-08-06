import cron from 'node-cron';
import { pool } from '../db/pool';
import { setSetting } from './settings';

// ── End-of-life, kept up to date by machine ─────────────────────────────────────
// This replaces the list we were maintaining by hand. endoflife.date is a public,
// community-maintained dataset of support dates for a few hundred products; we pull the
// ones that actually turn up on a Windows estate and rewrite our rows from it nightly.
//
// Two things it is NOT:
//   • It is not "is there a newer version" — WinGet and Chocolatey answer that, per
//     machine, and they answer it better than any list could.
//   • It is not exhaustive. Line-of-business software (Sage, a vendor's own utility)
//     will never be in it. Those stay hand-added rows with source='manual', and the
//     sync does not touch them.
//
// A row can be frozen by ticking `overridden` — for when a vendor announces an extension
// before the feed catches up. That is the only reason to edit an automatic row: any other
// edit is undone at 04:20 the next morning.

const FEED_V1 = (p: string) => `https://endoflife.date/api/v1/products/${p}`;
const FEED_LEGACY = (p: string) => `https://endoflife.date/api/${p}.json`;

const esc = (s: string) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const major = (cycle: string) => (String(cycle).match(/\d+/) || ['0'])[0];

interface Cycle { cycle: string; eol: string | boolean | null; latest: string; lts: boolean }

interface Adapter {
  product: string;
  category: string;
  action?: string;
  replacement?: string;
  ceControl?: string;
  /** Human name for the finding. */
  label: (c: Cycle) => string;
  matchType: 'contains' | 'regex';
  /** null skips the cycle — some products have cycles we can't spot on a machine. */
  matchValue: (c: Cycle) => string | null;
  versionMax?: (c: Cycle) => string | null;
  guidance?: (c: Cycle) => string;
}

// Matchers run against agent_software.name — the Add/Remove Programs display name — and,
// for .NET, also against the runtime list the Cyber Essentials scan collects.
const ADAPTERS: Adapter[] = [
  {
    product: 'dotnet', category: 'runtime', replacement: 'the current .NET LTS release',
    label: (c) => `.NET ${c.cycle}`,
    matchType: 'regex',
    // Two shapes: "Microsoft.NETCore.App 6.0" from `dotnet --list-runtimes`, and
    // "Microsoft .NET Runtime - 6.0.36 (x64)" from Add/Remove Programs.
    matchValue: (c) => `(^Microsoft\\.(NETCore|AspNetCore)\\.App ${esc(c.cycle)}$)|(Microsoft \\.NET.*[- ]${esc(c.cycle)}\\.\\d)`,
    guidance: (c) => `.NET ${c.cycle} stopped receiving security fixes. Runtimes install side by side, so the current LTS can go on first and this one comes off once nothing depends on it — check with the application vendor before removing.`,
  },
  {
    product: 'windows-server', category: 'os', action: 'replace', replacement: 'a supported Windows Server release',
    label: (c) => `Windows Server ${c.cycle.replace(/-/g, ' ')}`,
    matchType: 'contains',
    matchValue: (c) => `Server ${c.cycle.replace(/-/g, ' ').replace(/ SP\d$/i, '')}`,
  },
  {
    product: 'nodejs', category: 'runtime', replacement: 'the current Node LTS',
    label: (c) => `Node.js ${c.cycle}`,
    matchType: 'contains', matchValue: () => 'Node.js',
    versionMax: (c) => `${major(c.cycle)}.9999.9999`,
  },
  {
    product: 'python', category: 'app', replacement: 'a supported Python 3.x',
    label: (c) => `Python ${c.cycle}`,
    matchType: 'regex', matchValue: (c) => `Python ${esc(c.cycle)}\\.`,
  },
  {
    product: 'java', category: 'app', action: 'remove', replacement: 'a current LTS JDK where something genuinely needs Java',
    label: (c) => `Java ${c.cycle.replace(/-lts$/i, ' LTS')}`,
    matchType: 'regex', matchValue: (c) => `Java[^0-9]{0,24}${major(c.cycle)}(\\b|\\.)`,
    guidance: () => 'If nothing can name what needs it, uninstall it. The browser plugin should be gone regardless.',
  },
  {
    product: 'mssqlserver', category: 'database', replacement: 'a supported SQL Server',
    label: (c) => `SQL Server ${c.cycle}`,
    matchType: 'contains', matchValue: (c) => `SQL Server ${c.cycle}`,
  },
  {
    product: 'exchange', category: 'server', action: 'replace', replacement: 'Exchange Online',
    label: (c) => `Exchange Server ${c.cycle}`,
    matchType: 'contains', matchValue: (c) => `Exchange Server ${c.cycle}`,
    guidance: () => 'An unpatched internet-facing Exchange server is the worst single thing on a network. Migrate it.',
  },
  {
    product: 'office', category: 'app', replacement: 'Microsoft 365 Apps',
    label: (c) => `Microsoft Office ${c.cycle}`,
    matchType: 'regex', matchValue: (c) => (/^\d{4}$/.test(c.cycle) ? `Office.*\\b${esc(c.cycle)}\\b` : null),
  },
  {
    product: 'mysql', category: 'database', label: (c) => `MySQL ${c.cycle}`,
    matchType: 'regex', matchValue: (c) => `MySQL.*\\b${esc(c.cycle)}\\b`,
  },
  {
    product: 'postgresql', category: 'database', label: (c) => `PostgreSQL ${c.cycle}`,
    matchType: 'regex', matchValue: (c) => `PostgreSQL ${esc(c.cycle)}\\b`,
  },
  {
    product: 'powershell', category: 'app', label: (c) => `PowerShell ${c.cycle}`,
    matchType: 'regex', matchValue: (c) => `PowerShell ${esc(c.cycle)}`,
  },
];

// ── the feed ────────────────────────────────────────────────────────────────────

async function get(url: string): Promise<any | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json', 'user-agent': 'LumenMSP-Portal' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** endoflife.date has two API generations live at once. Normalise both to one shape. */
function normalise(raw: any): Cycle[] {
  if (Array.isArray(raw)) {
    return raw.map((c: any) => ({
      cycle: String(c.cycle ?? ''), eol: c.eol ?? null,
      latest: String(c.latest ?? ''), lts: !!c.lts,
    }));
  }
  const rel = raw?.result?.releases || raw?.releases;
  if (Array.isArray(rel)) {
    return rel.map((c: any) => ({
      cycle: String(c.name ?? c.cycle ?? ''),
      eol: c.eolFrom ?? c.eol ?? (c.isEol === true ? true : c.isEol === false ? false : null),
      latest: String(c.latest?.name ?? c.latest ?? ''), lts: !!(c.isLts ?? c.lts),
    }));
  }
  return [];
}

async function fetchProduct(product: string): Promise<Cycle[]> {
  const v1 = await get(FEED_V1(product));
  const rows = v1 ? normalise(v1) : [];
  if (rows.length) return rows;
  const legacy = await get(FEED_LEGACY(product));
  return legacy ? normalise(legacy) : [];
}

/** eol comes back as a date, `true` (already gone) or `false` (no date announced yet). */
function eolDate(v: string | boolean | null): string | null {
  if (v === true) return '2000-01-01';          // long gone; the exact day is not knowable
  if (!v) return null;                          // false, null or empty — no date announced
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ── the sync ────────────────────────────────────────────────────────────────────

export interface EolSyncResult { products: number; rows: number; failed: string[]; supersededManual: number }

export async function syncEol(): Promise<EolSyncResult> {
  const out: EolSyncResult = { products: 0, rows: 0, failed: [], supersededManual: 0 };
  const seen: Array<{ type: string; value: string }> = [];

  for (const a of ADAPTERS) {
    const cycles = await fetchProduct(a.product);
    if (!cycles.length) { out.failed.push(a.product); continue; }
    out.products++;

    for (const c of cycles) {
      if (!c.cycle) continue;
      const when = eolDate(c.eol);
      if (!when) continue;                       // no announced date — nothing to assert
      const value = a.matchValue(c);
      if (!value) continue;

      const key = `${a.product}:${c.cycle}`;
      const vmax = a.versionMax ? a.versionMax(c) : null;

      // ON CONFLICT rather than delete-and-reinsert: the row's id is what findings and
      // the /ce/eol screen refer to, and overridden rows must survive untouched.
      await pool.query(
        `INSERT INTO eol_products
           (category, vendor, name, match_type, match_value, version_max, eol_date, severity,
            action, replacement, guidance, ce_control, active, source, external_key, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,'fail',$8,$9,$10,$11,true,'endoflife.date',$12,NOW())
         ON CONFLICT (source, external_key) DO UPDATE SET
            category=EXCLUDED.category, name=EXCLUDED.name, match_type=EXCLUDED.match_type,
            match_value=EXCLUDED.match_value, version_max=EXCLUDED.version_max,
            eol_date=EXCLUDED.eol_date, action=EXCLUDED.action, replacement=EXCLUDED.replacement,
            guidance=EXCLUDED.guidance, ce_control=EXCLUDED.ce_control, active=true,
            synced_at=NOW(), updated_at=NOW()
          WHERE eol_products.overridden = false`,
        [a.category, 'endoflife.date', a.label(c), a.matchType, value, vmax, when,
         a.action || 'upgrade', a.replacement || null, a.guidance ? a.guidance(c) : null,
         a.ceControl || 'patch', key]);

      seen.push({ type: a.matchType, value });
      out.rows++;
    }
  }

  // Anything we typed by hand that the feed now covers is switched off rather than
  // deleted — so the row, and why someone added it, is still there to look at.
  if (seen.length) {
    const r = await pool.query(
      `UPDATE eol_products SET active=false, updated_at=NOW()
        WHERE source='manual' AND overridden=false AND active=true
          AND (match_type, match_value) IN (${seen.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',')})
        RETURNING id`,
      seen.flatMap((s) => [s.type, s.value]));
    out.supersededManual = r.rows.length;
  }

  await setSetting('eol', 'last_sync',
    JSON.stringify({ at: new Date().toISOString(), ...out })).catch(() => {});

  console.log(`[eol] synced ${out.rows} rows from ${out.products} products` +
    (out.failed.length ? ` (no data for: ${out.failed.join(', ')})` : ''));
  return out;
}

let _started = false;
export function startEolSync(): void {
  if (_started) return;
  _started = true;
  cron.schedule('20 4 * * *', () => { syncEol().catch((e) => console.error('[eol] sync failed:', e.message)); });
  // First boot on a fresh database has an empty list, which would quietly report every
  // machine as fine. Fill it once, a couple of minutes after startup.
  setTimeout(() => {
    pool.query(`SELECT count(*)::int n FROM eol_products WHERE source='endoflife.date'`)
      .then((r) => { if (!r.rows[0].n) return syncEol(); })
      .catch(() => {});
  }, 120 * 1000);
  console.log('✓ End-of-life sync scheduled (04:20 daily, endoflife.date)');
}
