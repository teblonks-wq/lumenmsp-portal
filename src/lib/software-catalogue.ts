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

// ── Looking software up, live ───────────────────────────────────────────────────
// Terry, 2 Sep 2026: look the software up rather than typing ids from memory.
//
// The search runs ON ONE OF OUR OWN MACHINES via the agent's `winget.search` /
// `choco.search`, NOT against a public web API. That is deliberate and it is the better
// answer: the machine searches THE SAME SOURCE the install will use, so an id that appears
// in the results is an id that will actually install. A public feed can disagree with what
// a given machine's configured sources hold, and would have us confidently offering an id
// that then fails on every endpoint.
//
// The cost is that it is asynchronous and needs one machine online. Worth it.

export interface LookupHit { packageRef: string; name: string; version: string | null }

/** `winget search` prints a fixed-width table. Column POSITIONS come from the header row —
 *  splitting on whitespace destroys names like "Google Chrome" and "Microsoft .NET Runtime". */
export function parseWingetSearch(output: string): LookupHit[] {
  const lines = String(output || '').split(/\r?\n/);
  const hdr = lines.findIndex((l) => /(^|\s)Name\s+Id\s+Version/.test(l));
  if (hdr < 0) return [];
  const head = lines[hdr];
  const iName = head.indexOf('Name');
  const iId = head.indexOf('Id', iName);
  const iVer = head.indexOf('Version', iId);
  // The column after Version is Match or Source depending on the query; either ends Version.
  const iNext = Math.min(
    ...[head.indexOf('Match', iVer), head.indexOf('Source', iVer)].filter((n) => n > iVer).concat([head.length])
  );
  if (iName < 0 || iId < 0 || iVer < 0) return [];

  const out: LookupHit[] = [];
  for (let i = hdr + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (/^[-─\s]+$/.test(l)) continue;           // the rule under the header
    if (/^\s*\[winget exit code/.test(l)) continue;
    const name = l.slice(iName, iId).trim();
    const id = l.slice(iId, iVer).trim();
    const version = l.slice(iVer, iNext).trim();
    if (!id || !name) continue;
    if (/^-+$/.test(id)) continue;
    out.push({ packageRef: id, name, version: version || null });
  }
  return out;
}

/** `choco search X --limit-output` prints `id|version` per line — no table to parse. */
export function parseChocoSearch(output: string): LookupHit[] {
  const out: LookupHit[] = [];
  for (const l of String(output || '').split(/\r?\n/)) {
    const line = l.trim();
    if (!line || !line.includes('|')) continue;
    if (/^\d+\s+packages?\s+found/i.test(line)) continue;
    const [id, version] = line.split('|');
    if (!id || !id.trim()) continue;
    out.push({ packageRef: id.trim(), name: id.trim(), version: (version || '').trim() || null });
  }
  return out;
}

/** Results, minus what we already hold and minus anything that must never be deployed here. */
export async function filterLookupHits(hits: LookupHit[]): Promise<LookupHit[]> {
  const have = new Set<string>();
  for (const r of (await pool.query("SELECT lower(package_ref) AS r FROM software_catalogue WHERE package_ref IS NOT NULL")
    .catch(() => ({ rows: [] as any[] }))).rows) have.add(r.r);
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = h.packageRef.toLowerCase();
    if (have.has(k) || seen.has(k)) return false;
    if (blockedReason(h.name, h.packageRef)) return false;
    seen.add(k);
    return true;
  }).slice(0, 40);
}

// ── Suggestions from the estate ─────────────────────────────────────────────────
// Terry, 2 Sep 2026: in practice almost everything will come from WinGet. So the job is to
// stop anyone typing package ids from memory — a wrong id is silently useless, and a
// plausible-but-wrong one is worse.
//
// We already hold real WinGet ids for software actually running on these machines: the
// patch scan namespaces them into `device_patches.update_id` as "winget:Google.Chrome".
// Those ids are better than anything typed, because a machine has already resolved them.
// So the catalogue proposes what the estate is running, with the number of machines behind
// each one, and adding it is a click rather than a lookup.
export interface Suggestion { packageRef: string; title: string; devices: number }

export async function suggestFromEstate(limit = 60): Promise<Suggestion[]> {
  const rows = (await pool.query(
    `SELECT replace(p.update_id, 'winget:', '') AS package_ref,
            max(p.title)                        AS title,
            count(DISTINCT p.device_id)::int    AS devices
       FROM device_patches p
      WHERE p.source = 'winget'
        AND p.update_id LIKE 'winget:%'
        AND length(replace(p.update_id, 'winget:', '')) > 2
      GROUP BY 1
      ORDER BY devices DESC, title
      LIMIT $1`, [limit]
  ).catch(() => ({ rows: [] as any[] }))).rows;

  // Anything already in the catalogue is not a suggestion, however it got there.
  const have = new Set<string>();
  for (const r of (await pool.query("SELECT lower(package_ref) AS r FROM software_catalogue WHERE package_ref IS NOT NULL")
    .catch(() => ({ rows: [] as any[] }))).rows) have.add(r.r);

  return rows
    .filter((r: any) => !have.has(String(r.package_ref).toLowerCase()))
    .filter((r: any) => !blockedReason(r.title || '', r.package_ref))
    .map((r: any) => ({ packageRef: r.package_ref, title: r.title || r.package_ref, devices: r.devices }));
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
