import { pool } from '../db/pool';

// ── The software catalogue ──────────────────────────────────────────────────────
// What Automation is allowed to deploy at a fleet. Every entry was added on purpose and
// says HOW it installs:
//   winget  — a WinGet package id. The agent already speaks winget.install/upgrade/uninstall.
//   choco   — a Chocolatey package id, for the handful of things WinGet does not carry.
//   package — one of our own uploaded MSIs (agent_packages), installed from its https URL.
//
// The catalogue is the boundary. A fleet-wide install is not a place for free text: a typo
// in a package id, typed once, lands on two hundred machines.

// ── Never deployable from here ──────────────────────────────────────────────────
// Terry, 2 Sep 2026: Bitdefender and MeshCentral are NEVER pushed by this route.
// They are not merely inconvenient here, they are actively wrong:
//   • Bitdefender must go through GravityZone so the machine ENROLS into the right
//     company and policy. A bare installer produces an endpoint nobody manages, and the
//     Portal already has a proven deploy pipeline for it.
//   • MeshCentral's installer carries the agent CERTIFICATE and group. Installed from a
//     generic package it either fails or attaches to the wrong group.
//   • Our own agent self-updates through agent.update. Pushing it as a package races the
//     updater and can leave the service half-replaced.
// Matched on BOTH the display name and the package id, because either one alone is easy
// to slip past. Enforced when an entry is saved AND again at dispatch — a row that somehow
// exists must still never reach a machine.
const NEVER_DEPLOY: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /bitdefender|gravityzone|\bbdconsole\b|\bepskit\b/i,
    why: 'Bitdefender is deployed through GravityZone so the machine enrols into the right company and policy. Use Endpoints → Security, not a scheduled task.' },
  { pattern: /meshcentral|meshagent|\bmesh\s*agent\b/i,
    why: 'The MeshCentral agent installer carries the certificate and group for the machine. Install it from the device page, not as a catalogue package.' },
  { pattern: /lumenmsp\s*agent|lumenagent/i,
    why: 'Our own agent updates itself through the agent update channel. Pushing it as a package races the updater and can leave the service half-replaced.' },
];

/** Why this software must not be deployed from the catalogue, or null if it is fine. */
export function blockedReason(name: string, packageRef?: string | null): string | null {
  const hay = `${name || ''} ${packageRef || ''}`;
  for (const b of NEVER_DEPLOY) if (b.pattern.test(hay)) return b.why;
  return null;
}

export interface CatalogueItem {
  id: number; name: string; publisher: string | null; category: string;
  source: 'winget' | 'choco' | 'package';
  package_ref: string | null; agent_package_id: number | null;
  install_args: string | null; notes: string | null;
  is_active: boolean; protected: boolean; sort_order: number;
}

export async function listCatalogue(includeInactive = false): Promise<CatalogueItem[]> {
  return (await pool.query(
    `SELECT * FROM software_catalogue ${includeInactive ? '' : 'WHERE is_active = true'}
      ORDER BY category, sort_order, lower(name)`
  ).catch(() => ({ rows: [] as any[] }))).rows;
}

export async function getCatalogueItem(id: number): Promise<CatalogueItem | null> {
  if (!id) return null;
  return (await pool.query('SELECT * FROM software_catalogue WHERE id=$1', [id])
    .catch(() => ({ rows: [] as any[] }))).rows[0] || null;
}

export interface SaveInput {
  name: string; publisher?: string | null; category?: string | null;
  source: string; packageRef?: string | null; agentPackageId?: number | null;
  installArgs?: string | null; notes?: string | null; sortOrder?: number | null;
}

export async function saveCatalogueItem(inp: SaveInput, userId: number, id?: number): Promise<{ ok: boolean; error?: string; id?: number }> {
  const name = String(inp.name || '').trim();
  if (!name) return { ok: false, error: 'Give the software a name.' };
  const source = String(inp.source || '').trim();
  if (!['winget', 'choco', 'package'].includes(source)) return { ok: false, error: 'Pick where it installs from.' };

  const ref = String(inp.packageRef || '').trim() || null;
  const pkgId = Number(inp.agentPackageId || 0) || null;
  if (source === 'package') {
    if (!pkgId) return { ok: false, error: 'Pick one of the uploaded packages.' };
    const p = (await pool.query('SELECT id, url FROM agent_packages WHERE id=$1', [pkgId])).rows[0];
    if (!p) return { ok: false, error: 'That uploaded package no longer exists.' };
    if (!p.url || !/^https:\/\//i.test(p.url)) return { ok: false, error: 'That package has no https URL, so a machine cannot download it.' };
  } else if (!ref) {
    return { ok: false, error: `Give the ${source === 'winget' ? 'WinGet' : 'Chocolatey'} package id.` };
  }

  // The block is checked HERE as well as at dispatch, so a forbidden entry never even
  // reaches the list where somebody could pick it in a hurry.
  const blocked = blockedReason(name, ref);
  if (blocked) return { ok: false, error: blocked };

  const cat = String(inp.category || 'General').trim() || 'General';
  const sort = Number(inp.sortOrder || 100) || 100;
  if (id) {
    await pool.query(
      `UPDATE software_catalogue SET name=$1, publisher=$2, category=$3, source=$4, package_ref=$5,
              agent_package_id=$6, install_args=$7, notes=$8, sort_order=$9, updated_at=NOW() WHERE id=$10`,
      [name, inp.publisher || null, cat, source, ref, pkgId, inp.installArgs || null, inp.notes || null, sort, id]
    );
    return { ok: true, id };
  }
  const r = await pool.query(
    `INSERT INTO software_catalogue (name, publisher, category, source, package_ref, agent_package_id,
                                     install_args, notes, is_active, protected, sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,false,$9,$10) RETURNING id`,
    [name, inp.publisher || null, cat, source, ref, pkgId, inp.installArgs || null, inp.notes || null, sort, userId]
  );
  return { ok: true, id: r.rows[0].id };
}

export async function setCatalogueActive(id: number, active: boolean): Promise<void> {
  await pool.query('UPDATE software_catalogue SET is_active=$1, updated_at=NOW() WHERE id=$2', [active, id]);
}

// ── Turning a catalogue entry into an agent command ─────────────────────────────
// The ONE place a catalogue row becomes something a machine will run. The block is
// re-checked here on purpose: a row could have been edited straight in the database, or
// added before a name was recognised, and this is the last gate before two hundred
// machines act on it.
export interface Dispatch { kind: string; payload: Record<string, any> }

export async function dispatchFor(item: CatalogueItem, verb: 'install' | 'upgrade' | 'uninstall'): Promise<{ ok: boolean; error?: string; dispatch?: Dispatch }> {
  const blocked = blockedReason(item.name, item.package_ref);
  if (blocked) return { ok: false, error: blocked };
  if (item.protected) return { ok: false, error: `${item.name} is managed by its own pipeline and cannot be deployed from here.` };
  if (!item.is_active) return { ok: false, error: `${item.name} has been retired from the catalogue.` };

  if (item.source === 'winget') {
    if (!item.package_ref) return { ok: false, error: `${item.name} has no WinGet id recorded.` };
    return { ok: true, dispatch: { kind: 'winget.' + verb, payload: { id: item.package_ref, name: item.name, catalogue_id: item.id } } };
  }
  if (item.source === 'choco') {
    if (!item.package_ref) return { ok: false, error: `${item.name} has no Chocolatey id recorded.` };
    // Chocolatey has no separate "upgrade" verb in our agent beyond choco.upgrade.
    return { ok: true, dispatch: { kind: 'choco.' + verb, payload: { id: item.package_ref, name: item.name, catalogue_id: item.id } } };
  }

  // One of our own MSIs. Install works from the https URL; there is no meaningful
  // "upgrade" for a bare MSI (re-installing the newer one IS the upgrade), and an
  // uninstall needs the product code, which only the machine's own inventory knows.
  const pkg = (await pool.query('SELECT id, name, url, install_args FROM agent_packages WHERE id=$1', [item.agent_package_id || 0])).rows[0];
  if (!pkg) return { ok: false, error: `The uploaded package behind ${item.name} no longer exists.` };
  if (verb === 'uninstall') {
    return { ok: false, error: `${item.name} was installed from our own MSI, and removing it needs the product code from each machine. Uninstall it from the device page, or add a WinGet entry for it instead.` };
  }
  if (verb === 'upgrade') {
    return { ok: false, error: `${item.name} is one of our own MSIs — there is no upgrade step. Upload the newer version and deploy that, which replaces it in place.` };
  }
  return { ok: true, dispatch: {
    kind: 'software.install',
    payload: { name: pkg.name, url: pkg.url, args: item.install_args || pkg.install_args || '/qn /norestart', package_id: pkg.id, catalogue_id: item.id },
  } };
}

// ── Backfill ────────────────────────────────────────────────────────────────────
// Every MSI already uploaded becomes a catalogue entry, so switching Automation over to the
// catalogue does not make anything that used to be deployable disappear. Idempotent, and it
// skips anything on the never-deploy list rather than importing it.
export async function backfillFromPackages(): Promise<{ added: number; skipped: number }> {
  const pkgs = (await pool.query('SELECT id, name, url, install_args FROM agent_packages ORDER BY id')
    .catch(() => ({ rows: [] as any[] }))).rows;
  let added = 0, skipped = 0;
  for (const p of pkgs) {
    if (blockedReason(p.name, null)) { skipped++; continue; }
    const exists = (await pool.query('SELECT id FROM software_catalogue WHERE source=$1 AND agent_package_id=$2', ['package', p.id])).rowCount;
    if (exists) { skipped++; continue; }
    await pool.query(
      `INSERT INTO software_catalogue (name, category, source, agent_package_id, install_args, is_active, protected, sort_order)
       VALUES ($1,'Uploaded','package',$2,$3,true,false,200)`,
      [p.name, p.id, p.install_args || null]
    ).catch(() => {});
    added++;
  }
  return { added, skipped };
}
