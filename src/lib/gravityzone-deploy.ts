import { pool } from '../db/pool';
import { rpc, gzConfigured, findKeyPath, atPath, customerEnabled } from './gravityzone';
import { logActivity } from './activity';

// ─────────────────────────────────────────────────────────────────────────────────
// Deploying Bitdefender — through OUR OWN agent, no Atera anywhere.
//
// Terry, 17 Aug: "this bitdefender deployment is the pri 1", "i dont want any atera
// involvement", "the button to install and manage who is installed and AV detection
// must come to portal".
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE. A machine is only ever reported
// 'protected' when TWO independent sources agree:
//
//   1. our own agent's security collector sees Bitdefender running locally, AND
//   2. GravityZone has the endpoint enrolled.
//
// Neither on its own is trustworthy. An installer exiting 0 told us Chropynska was
// "complete" on machines that had nothing installed at all — the MSI had rolled back
// after the service failed to start. And GravityZone can hold a stale endpoint record
// for a machine that has since been wiped. Only the intersection is evidence, so
// 'installed' (our side agrees) and 'protected' (both sides agree) are deliberately
// different states, and the estate shows which one a machine is in.
//
// The installer URL is resolved HERE, server side, from the customer's cached
// GravityZone link — never taken from the request. Same precedent as agent_packages:
// a crafted POST must not be able to point one of our customer's machines at an
// arbitrary executable.
// ─────────────────────────────────────────────────────────────────────────────────

/** GravityZone reports kit build status per platform: 2 = ready. */
const KIT_READY = 2;
/** How we name the package we own, so it is obvious in the console who made it. */
export const packageNameFor = (customerName: string) =>
  ('Lumen Managed AV - ' + String(customerName || '').trim()).slice(0, 64);

/** Bitdefender's silent-install switch for the full kit. */
const SILENT_ARGS = '/bdparams /silent';

export interface PackageState {
  customerId: number; gzCompanyId: string; packageName: string;
  urlWindows: string | null; readyWindows: boolean; removeCompetitors: boolean;
  refreshedAt: Date | null;
}

/**
 * Make sure the customer has a package with competitive removal ON, and cache its
 * download links. Idempotent — an existing package of the same name is reused, because
 * creating a second package per rollout would litter the console and split reporting.
 */
export async function ensurePackage(customerId: number, userId: number | null = null): Promise<PackageState> {
  const cust = (await pool.query(`SELECT id, name FROM customers WHERE id=$1`, [customerId])).rows[0];
  if (!cust) throw new Error('No such customer.');
  const comp = (await pool.query(
    `SELECT gz_id FROM security_companies WHERE customer_id=$1 ORDER BY gz_id LIMIT 1`, [customerId])).rows[0];
  if (!comp) throw new Error(`${cust.name} is not mapped to a GravityZone company yet — onboard them first.`);

  const gzCompanyId = String(comp.gz_id);
  const name = packageNameFor(cust.name);

  // Is it already there? getPackagesList is scoped by companyId on this service.
  let found: any = null;
  try {
    const list = await rpc<any>('packages', 'getPackagesList', { companyId: gzCompanyId, page: 1, perPage: 100 });
    const items = Array.isArray(list) ? list : (list?.items || []);
    found = items.find((p: any) => String(p?.name || '').trim().toLowerCase() === name.toLowerCase()) || null;
  } catch { /* an unreadable list is not proof it is absent — the create below will tell us */ }

  if (!found) {
    try {
      await rpc('packages', 'createPackage', {
        companyId: gzCompanyId,
        packageName: name,
        description: 'Created by the LumenMSP Portal. Removes existing third-party AV on install.',
        // modules left at Bitdefender's defaults: antimalware + ATC. Nothing chargeable.
        settings: {
          removeCompetitors: 1,      // THE point of the package — strip Webroot et al
          scanBeforeInstall: false,  // a pre-install scan can take an hour; not on a rollout
        },
      });
    } catch (e: any) {
      // "already exists" is a success for our purposes — we only want one.
      if (!/exist/i.test(e.message || '')) throw e;
    }
  }

  return refreshLinks(customerId, gzCompanyId, name, userId);
}

/**
 * Re-read the download links. Worth doing before every rollout: Bitdefender builds the
 * kits asynchronously, so a package created a moment ago has status 1 (building) and a
 * URL that is not yet servable. Deploying from it would fail on every machine at once
 * and look exactly like a broken agent.
 */
export async function refreshLinks(
  customerId: number, gzCompanyId?: string, packageName?: string, userId: number | null = null,
): Promise<PackageState> {
  if (!gzCompanyId || !packageName) {
    const row = (await pool.query(`SELECT gz_company_id, package_name FROM security_packages WHERE customer_id=$1`, [customerId])).rows[0];
    if (!row) throw new Error('No package recorded for this customer yet.');
    gzCompanyId = gzCompanyId || String(row.gz_company_id);
    packageName = packageName || String(row.package_name);
  }

  const res = await rpc<any>('packages', 'getInstallationLinks', { companyId: gzCompanyId, packageName });
  const rows = Array.isArray(res) ? res : (res?.items || (res ? [res] : []));
  const mine = rows.find((r: any) => String(r?.packageName || '').trim().toLowerCase() === packageName!.toLowerCase()) || rows[0] || {};

  // Prefer the FULL KIT over the tiny downloader. The downloader has to reach
  // Bitdefender's CDN from the customer's machine at install time; the full kit is one
  // file we can hand the agent. Fewer moving parts on a machine we cannot see.
  const win = str(mine.fullKitWindowsX64) || str(mine.installLinkWindows);
  const ready = Number(mine.status?.windows) === KIT_READY;

  const saved = (await pool.query(
    `INSERT INTO security_packages
       (customer_id, gz_company_id, package_name, remove_competitors,
        url_windows, url_mac, url_mac_arm, url_linux, ready_windows, raw, refreshed_at)
     VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (customer_id) DO UPDATE SET
       gz_company_id=EXCLUDED.gz_company_id, package_name=EXCLUDED.package_name,
       url_windows=EXCLUDED.url_windows, url_mac=EXCLUDED.url_mac,
       url_mac_arm=EXCLUDED.url_mac_arm, url_linux=EXCLUDED.url_linux,
       ready_windows=EXCLUDED.ready_windows, raw=EXCLUDED.raw, refreshed_at=NOW()
     RETURNING *`,
    [customerId, gzCompanyId, packageName, win, str(mine.installLinkMac), str(mine.installLinkMacArm),
     str(mine.installLinkLinux) || str(mine.fullKitLinuxX64), ready, JSON.stringify(mine)])).rows[0];

  if (userId) await logActivity(userId, 'gz_package_links', 'customers', customerId,
    `Refreshed the Bitdefender package links ("${packageName}")`);

  return {
    customerId, gzCompanyId, packageName,
    urlWindows: saved.url_windows, readyWindows: saved.ready_windows,
    removeCompetitors: saved.remove_competitors, refreshedAt: saved.refreshed_at,
  };
}

const str = (v: any) => (v == null || v === '' ? null : String(v));

/** What our own agent currently believes is protecting a machine. */
function avNames(securityJson: any): string[] {
  let j: any = null;
  try { j = typeof securityJson === 'string' ? JSON.parse(securityJson) : securityJson; } catch { return []; }
  if (!j) return [];
  const list = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);
  return Array.from(new Set([...list(j.av), ...list(j.antispyware)]
    .map((p: any) => String(p?.name || '').trim()).filter(Boolean)));
}

const isBitdefender = (names: string[]) => names.some((n) => /bitdefender|gravityzone|endpoint security tools/i.test(n));

export interface QueueResult { ok: boolean; deviceId: number; commandId?: number; error?: string }

/**
 * Queue the install on one device. Returns rather than throws for the per-row failures
 * a bulk rollout will hit — one machine with no agent must not abort the other forty.
 */
export async function queueDeploy(deviceId: number, userId: number | null = null): Promise<QueueResult> {
  const dev = (await pool.query(
    `SELECT d.id, d.hostname, d.customer_id, d.security_json, d.os_name,
            COALESCE(d.revoked,false) AS revoked
       FROM agent_devices d WHERE d.id=$1`, [deviceId])).rows[0];
  if (!dev) return { ok: false, deviceId, error: 'No such device.' };
  if (dev.revoked) return { ok: false, deviceId, error: 'That agent has been revoked.' };
  if (!dev.customer_id) return { ok: false, deviceId, error: 'Device is not attached to a customer.' };

  // THE GATE. Enabling a customer is where someone takes responsibility for stripping the
  // antivirus off their machines; deploying without it is doing that on a customer nobody
  // signed off. Checked here rather than only in the bulk path, because the per-device
  // Deploy button is precisely the route that would otherwise walk around it.
  const gate = await customerEnabled(Number(dev.customer_id));
  if (!gate.ok) {
    return { ok: false, deviceId,
      error: `Endpoint Security is not enabled for this customer (${gate.reason}). Enable them first.` };
  }

  const pkg = (await pool.query(`SELECT * FROM security_packages WHERE customer_id=$1`, [dev.customer_id])).rows[0];
  if (!pkg) return { ok: false, deviceId, error: 'No Bitdefender package for this customer yet.' };
  if (!pkg.url_windows) return { ok: false, deviceId, error: 'The Windows kit has no download link yet.' };
  if (!pkg.ready_windows) return { ok: false, deviceId, error: 'Bitdefender is still building the kit — try again shortly.' };

  // Never queue a second install on top of one already in flight. Duplicated installs
  // are how a machine ends up with a half-removed AV product.
  const inFlight = (await pool.query(
    `SELECT id FROM agent_commands
      WHERE device_id=$1 AND kind='software.install' AND status IN ('queued','running')
        AND payload->>'name' LIKE 'Bitdefender%' LIMIT 1`, [deviceId])).rows[0];
  if (inFlight) return { ok: false, deviceId, error: 'An install is already in flight on this machine.' };

  const before = avNames(dev.security_json);
  if (isBitdefender(before)) {
    // Nothing to do, but record it so the rollout screen shows the machine as done
    // rather than as an untouched gap someone keeps re-clicking.
    await upsertDeployment(deviceId, dev.customer_id, {
      state: 'installed', avBefore: before.join(', '), avAfter: before.join(', '),
      agentSeenAt: new Date(), requestedBy: userId,
    });
    return { ok: false, deviceId, error: 'Bitdefender is already on this machine.' };
  }

  const payload = {
    name: 'Bitdefender Endpoint Security Tools',
    url: String(pkg.url_windows),
    args: SILENT_ARGS,
  };
  const ins = await pool.query(
    `INSERT INTO agent_commands (device_id, kind, payload, requested_by)
     VALUES ($1,'software.install',$2,$3) RETURNING id`,
    [deviceId, JSON.stringify(payload), userId]);
  const commandId = Number(ins.rows[0].id);

  await upsertDeployment(deviceId, dev.customer_id, {
    state: 'queued', commandId, avBefore: before.join(', ') || null,
    requestedBy: userId, bumpAttempts: true,
  });
  await logActivity(userId, 'gz_deploy_queued', 'agent_devices', deviceId,
    `Queued Bitdefender install on ${dev.hostname || 'device ' + deviceId}`
    + (before.length ? ` (currently on ${before.join(', ')})` : ''));

  return { ok: true, deviceId, commandId };
}

async function upsertDeployment(
  deviceId: number, customerId: number | null,
  f: { state?: string; commandId?: number | null; avBefore?: string | null; avAfter?: string | null;
       agentSeenAt?: Date | null; gzSeenAt?: Date | null; lastError?: string | null;
       requestedBy?: number | null; bumpAttempts?: boolean; settled?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO security_deployments
       (device_id, customer_id, state, command_id, attempts, av_before, av_after,
        agent_seen_at, gz_seen_at, last_error, requested_by, requested_at, settled_at)
     VALUES ($1,$2,COALESCE($3,'queued'),$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)
     ON CONFLICT (device_id) DO UPDATE SET
       customer_id  = COALESCE(EXCLUDED.customer_id, security_deployments.customer_id),
       state        = COALESCE($3, security_deployments.state),
       command_id   = COALESCE($4, security_deployments.command_id),
       attempts     = security_deployments.attempts + $5,
       -- av_before is the BEFORE picture. Once recorded it must never be overwritten by a
       -- later pass, or the evidence that we removed Webroot quietly becomes "was already
       -- on Bitdefender" and the migration looks like it never happened.
       av_before    = COALESCE(security_deployments.av_before, EXCLUDED.av_before),
       av_after     = COALESCE(EXCLUDED.av_after, security_deployments.av_after),
       agent_seen_at= COALESCE(EXCLUDED.agent_seen_at, security_deployments.agent_seen_at),
       gz_seen_at   = COALESCE(EXCLUDED.gz_seen_at, security_deployments.gz_seen_at),
       last_error   = $10,
       settled_at   = COALESCE($12, security_deployments.settled_at)`,
    [deviceId, customerId, f.state ?? null, f.commandId ?? null, f.bumpAttempts ? 1 : 0,
     f.avBefore ?? null, f.avAfter ?? null, f.agentSeenAt ?? null, f.gzSeenAt ?? null,
     f.lastError ?? null, f.requestedBy ?? null, f.settled ? new Date() : null]);
}

export interface ReconcileResult {
  checked: number; installed: number; protectedCount: number; failed: number; stillWaiting: number;
}

/**
 * Walk every deployment we are watching and move it to the truth.
 *
 * Ordering matters here: the command's own exit code is the WEAKEST evidence and is
 * only used to explain a failure, never to declare success. Success comes from the
 * machine and from GravityZone.
 */
export async function reconcile(): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, installed: 0, protectedCount: 0, failed: 0, stillWaiting: 0 };
  const rows = (await pool.query(
    `SELECT dep.device_id, dep.state, dep.command_id, d.security_json, d.hostname,
            c.status AS cmd_status, c.exit_code, c.output,
            (SELECT MAX(se.synced_at) FROM security_endpoints se
              JOIN customer_assets a ON a.id = se.asset_id
             WHERE a.agent_device_id = dep.device_id) AS gz_seen
       FROM security_deployments dep
       JOIN agent_devices d ON d.id = dep.device_id
       LEFT JOIN agent_commands c ON c.id = dep.command_id
      WHERE dep.state IN ('queued','running','installed','failed')`)).rows;

  for (const r of rows) {
    out.checked++;
    const names = avNames(r.security_json);
    const bd = isBitdefender(names);
    const gzSeen = r.gz_seen ? new Date(r.gz_seen) : null;

    if (bd && gzSeen) {
      await upsertDeployment(Number(r.device_id), null, {
        state: 'protected', avAfter: names.join(', '), agentSeenAt: new Date(), gzSeenAt: gzSeen,
        lastError: null, settled: true,
      });
      out.protectedCount++;
      continue;
    }
    if (bd) {
      // Our side agrees; GravityZone has not caught up. That is a normal few minutes,
      // NOT a success — enrolment can genuinely fail after a clean local install.
      await upsertDeployment(Number(r.device_id), null, {
        state: 'installed', avAfter: names.join(', '), agentSeenAt: new Date(), lastError: null,
      });
      out.installed++;
      continue;
    }
    if (r.cmd_status === 'failed' || (r.cmd_status === 'done' && Number(r.exit_code) !== 0)) {
      await upsertDeployment(Number(r.device_id), null, {
        state: 'failed', lastError: firstLine(r.output) || `installer exit code ${r.exit_code}`, settled: true,
      });
      out.failed++;
      continue;
    }
    if (r.cmd_status === 'done') {
      // The lie we have already been told once: the installer said it was fine and the
      // machine has nothing on it. Call it what it is instead of believing the exit code.
      await upsertDeployment(Number(r.device_id), null, {
        state: 'failed',
        lastError: 'The installer reported success but our agent cannot see Bitdefender on the machine. '
                 + 'That is the MSI-rollback signature — check the security product already installed is not holding it.',
        settled: true,
      });
      out.failed++;
      continue;
    }
    out.stillWaiting++;
  }
  return out;
}

const firstLine = (s: any) => (s ? String(s).split('\n').map((x) => x.trim()).filter(Boolean)[0] || null : null);

export interface RolloutRow {
  deviceId: number | null; assetId: number | null; hostname: string;
  currentAv: string | null; state: string; detail: string;
  attempts: number; lastError: string | null; avBefore: string | null;
  // Bitdefender's own state, straight from GravityZone. Deliberately sourced there
  // rather than from our collector: BD's version, definition freshness and infection
  // status are facts GravityZone owns, and reading them there means none of this waits
  // on the LumenMSP agent rollout.
  bdVersion: string | null;
  definitions: 'current' | 'out-of-date' | null;
  infected: boolean;
  policyName: string | null;
  modulesOn: string | null;
  online: boolean | null;      // our agent's view — is the machine even reachable
  agentSeen: number | null;    // epoch seconds
  gzSeen: number | null;       // epoch seconds
}

/**
 * The rollout screen's data: every machine of a customer with a real, honest state.
 * Machines with no agent are INCLUDED and called out — they are the gap that matters,
 * and leaving them off the list is how an estate looks 100% covered while it isn't.
 */
export async function rolloutFor(customerId: number): Promise<RolloutRow[]> {
  const rows = (await pool.query(
    `SELECT a.id AS asset_id, a.hostname, d.id AS device_id, d.security_json,
            EXTRACT(EPOCH FROM d.last_seen_at)::bigint AS agent_seen,
            dep.state, dep.attempts, dep.last_error, dep.av_before,
            se.gz_id, se.agent_version AS bd_version, se.outdated, se.infected,
            se.policy_name, se.modules_on,
            EXTRACT(EPOCH FROM se.last_seen_at)::bigint AS gz_seen
       FROM customer_assets a
       LEFT JOIN agent_devices d ON d.id = a.agent_device_id AND NOT COALESCE(d.revoked,false)
       LEFT JOIN security_deployments dep ON dep.device_id = d.id
       LEFT JOIN LATERAL (
         SELECT * FROM security_endpoints se2 WHERE se2.asset_id = a.id ORDER BY se2.gz_id LIMIT 1
       ) se ON true
      WHERE a.customer_id=$1 AND a.merged_into_id IS NULL
      ORDER BY a.hostname`, [customerId])).rows;

  const now = Math.floor(Date.now() / 1000);
  return rows.map((r: any) => {
    const names = avNames(r.security_json);
    const currentAv = names.join(', ') || null;
    const agentSeen = r.agent_seen ? Number(r.agent_seen) : null;
    const base = {
      deviceId: r.device_id ? Number(r.device_id) : null,
      assetId: r.asset_id ? Number(r.asset_id) : null,
      hostname: String(r.hostname || '?'),
      currentAv, attempts: Number(r.attempts || 0),
      lastError: r.last_error || null, avBefore: r.av_before || null,
      bdVersion: r.bd_version || null,
      // Only claim a definitions state when GravityZone actually knows the endpoint.
      // "current" on a machine BD has never seen would be an invention.
      definitions: (r.gz_id ? (r.outdated ? 'out-of-date' : 'current') : null) as RolloutRow['definitions'],
      infected: r.infected === true,
      policyName: r.policy_name || null,
      modulesOn: r.modules_on || null,
      // Offline is worth its own state: an install that has not run because the machine
      // has been off for a week is not a failure, and chasing it as one wastes a visit.
      online: agentSeen == null ? null : (now - agentSeen) < 900,
      agentSeen, gzSeen: r.gz_seen ? Number(r.gz_seen) : null,
    };
    if (!r.device_id) return { ...base, state: 'no-agent', detail: 'No LumenMSP agent — that has to go on first.' };
    if (r.gz_id && r.infected) return { ...base, state: 'infected', detail: 'Bitdefender is reporting an active infection on this machine.' };
    if (isBitdefender(names) && r.gz_id) {
      return { ...base, state: 'protected',
        detail: `Installed and enrolled${r.bd_version ? ' — Bitdefender ' + r.bd_version : ''}` +
                (r.outdated ? ', but its definitions are out of date.' : '.') };
    }
    if (r.gz_id) return { ...base, state: 'installed', detail: 'GravityZone has the endpoint; our agent has not confirmed it locally yet.' };
    if (isBitdefender(names)) return { ...base, state: 'installed', detail: 'Installed locally; waiting for GravityZone to show the endpoint.' };
    if (r.state === 'excluded') return { ...base, state: 'excluded', detail: 'Deliberately held back.' };
    if (r.state === 'queued' || r.state === 'running') {
      return { ...base, state: r.state,
        detail: base.online === false
          ? 'Install queued — the machine is offline, so it runs when it next checks in.'
          : 'Install queued — it runs on the next check-in, usually within a minute.' };
    }
    if (r.state === 'failed') return { ...base, state: 'failed', detail: r.last_error || 'The last attempt failed.' };
    if (!names.length) return { ...base, state: 'not-deployed', detail: 'Agent is on, but it has not reported its AV yet.' };
    return { ...base, state: 'not-deployed', detail: `Currently on ${currentAv}.` };
  });
}

export interface InfectionRow {
  hostname: string | null; threat: string | null; detail: string | null;
  ticketId: number | null; detectedAt: Date | null; assetId: number | null;
}

/** Infections for one customer — deduped detections, newest first, with their case. */
export async function infectionsFor(customerId: number): Promise<InfectionRow[]> {
  const r = await pool.query(
    `SELECT sd.hostname, sd.threat_name, sd.detail, sd.ticket_id, sd.detected_at,
            (SELECT se.asset_id FROM security_endpoints se WHERE se.gz_id = sd.endpoint_gz_id) AS asset_id
       FROM security_detections sd
      WHERE sd.customer_id = $1
      ORDER BY sd.detected_at DESC
      LIMIT 200`, [customerId]);
  return r.rows.map((x: any) => ({
    hostname: x.hostname || null, threat: x.threat_name || null, detail: x.detail || null,
    ticketId: x.ticket_id ? Number(x.ticket_id) : null,
    detectedAt: x.detected_at || null,
    assetId: x.asset_id ? Number(x.asset_id) : null,
  }));
}

// ── Exclusions ──────────────────────────────────────────────────────────────────
// RULE ONE: our products never fight each other. Every Bitdefender policy Lumen manages
// has to carry the LumenMSP agent exclusions — folder and process, On-Access AND ATC —
// because a security product holding our unsigned service past Windows' 30-second start
// window is exactly what produced Chropynska's fleet-wide error 1920.
//
// Whether the public API lets us WRITE exclusions is still unproven. Reading them is
// enough to be useful straight away: the Portal can say which policies are missing the
// agent exclusion, which is the difference between "we think it's fine" and knowing.

/** Paths that must be excluded for our own agent to survive. */
export const AGENT_EXCLUSION_HINTS = ['LumenMSP', 'LumenAgentService'];

export interface PolicyExclusions {
  policyId: string; policyName: string;
  items: string[];
  agentExcluded: boolean;
  note: string;
}

export async function policyExclusions(): Promise<{ policies: PolicyExclusions[]; warnings: string[] }> {
  const out: PolicyExclusions[] = []; const warnings: string[] = [];
  if (!await gzConfigured()) return { policies: out, warnings: ['No GravityZone API key saved yet.'] };

  let list: any;
  try { list = await rpc<any>('policies', 'getPoliciesList', { page: 1, perPage: 100 }); }
  catch (e: any) { return { policies: out, warnings: [`Could not read policies: ${e.message}`] }; }

  for (const p of (Array.isArray(list) ? list : list?.items || [])) {
    if (!p?.id) continue;
    let d: any = null;
    try { d = await rpc<any>('policies', 'getPolicyDetails', { policyId: p.id }); }
    catch (e: any) { warnings.push(`Could not read policy "${p.name || p.id}": ${e.message}`); continue; }

    // Find the exclusion LIST, not the on/off switch beside it. The switch is what a
    // naive search hits first — Lumen's tenant returns activateExclusions before the
    // list, and reporting the boolean as "the exclusions" would be worse than useless.
    let items: string[] = [];
    let path = findKeyPath(d, /exclusion/i);
    const seen = new Set<string>();
    while (path && !seen.has(path)) {
      seen.add(path);
      const v = atPath(d, path);
      if (Array.isArray(v)) {
        items = v.map((x: any) => typeof x === 'string' ? x
          : String(x?.path || x?.value || x?.name || x?.hash || JSON.stringify(x)));
        break;
      }
      // not the list — look for a sibling array before giving up
      const parentPath = path.split('.').slice(0, -1).join('.');
      const parent = parentPath ? atPath(d, parentPath) : d;
      const sibling = parent && typeof parent === 'object'
        ? Object.keys(parent).find((k) => Array.isArray((parent as any)[k]) && /exclu/i.test(k)) : null;
      if (sibling) { path = parentPath ? `${parentPath}.${sibling}` : sibling; continue; }
      break;
    }

    const agentExcluded = items.some((i) => AGENT_EXCLUSION_HINTS.some((h) => i.toLowerCase().includes(h.toLowerCase())));
    out.push({
      policyId: String(p.id), policyName: String(p.name || p.id),
      items, agentExcluded,
      note: items.length
        ? (agentExcluded
            ? 'The LumenMSP agent is excluded here.'
            : 'No LumenMSP agent exclusion — add the agent folder and LumenAgentService.exe, On-Access and ATC.')
        : 'No exclusions readable in this policy payload.',
    });
  }
  return { policies: out, warnings };
}

/** Hold one machine back, or release it. */
export async function setExcluded(deviceId: number, excluded: boolean, userId: number | null = null): Promise<void> {
  const dev = (await pool.query(`SELECT customer_id FROM agent_devices WHERE id=$1`, [deviceId])).rows[0];
  await upsertDeployment(deviceId, dev ? dev.customer_id : null,
    { state: excluded ? 'excluded' : 'queued', requestedBy: userId });
  if (!excluded) await pool.query(`UPDATE security_deployments SET state='queued', command_id=NULL WHERE device_id=$1`, [deviceId]);
}

export interface BulkResult { queued: number; skipped: Array<{ deviceId: number | null; hostname: string; why: string }> }

/** Deploy to every eligible machine of a customer. Skips are reported, never silent. */
export async function deployCustomer(customerId: number, userId: number | null = null): Promise<BulkResult> {
  const out: BulkResult = { queued: 0, skipped: [] };
  if (!await gzConfigured()) { out.skipped.push({ deviceId: null, hostname: '—', why: 'No GravityZone API key saved.' }); return out; }

  // The same gate, checked once up front so a disabled customer fails as one clear
  // sentence rather than as N identical per-machine refusals.
  const gate = await customerEnabled(customerId);
  if (!gate.ok) {
    out.skipped.push({ deviceId: null, hostname: '—',
      why: `Endpoint Security is not enabled for this customer (${gate.reason}) — enable them first` });
    return out;
  }

  const rows = await rolloutFor(customerId);
  for (const r of rows) {
    if (r.state === 'protected' || r.state === 'installed') continue;   // done — not a skip worth reporting
    if (!r.deviceId) { out.skipped.push({ deviceId: null, hostname: r.hostname, why: 'no agent on the machine' }); continue; }
    if (r.state === 'excluded') { out.skipped.push({ deviceId: r.deviceId, hostname: r.hostname, why: 'held back on purpose' }); continue; }
    const q = await queueDeploy(r.deviceId, userId);
    if (q.ok) out.queued++;
    else out.skipped.push({ deviceId: r.deviceId, hostname: r.hostname, why: q.error || 'unknown' });
  }
  return out;
}
