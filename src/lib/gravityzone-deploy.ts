import { pool } from '../db/pool';
import { rpc, gzConfigured, findKeyPath, atPath, customerEnabled, isOwnToolDetection } from './gravityzone';
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

/**
 * Bitdefender's silent-install switches for the setup downloader.
 *
 * The trailing bare `silent` is not a typo and not a duplicate. `/bdparams` marks the point
 * where the remaining tokens stop being for the DOWNLOADER and start being passed through to
 * the inner installer it unpacks. `/bdparams /silent` therefore quietens the downloader and
 * leaves the real installer to run interactively - on a machine with no desktop to draw on,
 * because our agent runs as SYSTEM.
 *
 * LUMEN-008 answered `installer exit code 3` on 19 Aug with the shorter form. Every published
 * working deployment script uses the three-token version.
 */
const SILENT_ARGS = '/bdparams /silent silent';

export interface PackageState {
  customerId: number; gzCompanyId: string; packageName: string;
  urlWindows: string | null; readyWindows: boolean; removeCompetitors: boolean;
  refreshedAt: Date | null;
}

/** The GravityZone company a customer is mapped to, or a clear reason why not. */
async function companyFor(customerId: number): Promise<{ gzCompanyId: string; customerName: string }> {
  const cust = (await pool.query(`SELECT id, name FROM customers WHERE id=$1`, [customerId])).rows[0];
  if (!cust) throw new Error('No such customer.');
  const comp = (await pool.query(
    `SELECT gz_id FROM security_companies WHERE customer_id=$1 ORDER BY gz_id LIMIT 1`, [customerId])).rows[0];
  if (!comp) throw new Error(`${cust.name} is not mapped to a GravityZone company yet — map them on the settings page first.`);
  return { gzCompanyId: String(comp.gz_id), customerName: String(cust.name) };
}

export interface GzPackage { name: string; id: string | null; description: string | null }

/**
 * Every installation package in this customer's GravityZone company.
 *
 * Terry, 18 Aug: "i think we need to map the installation packages - so I will create them
 * in g zone now." Same shape as the companies: he builds them in GravityZone, the Portal
 * maps them. That is the better split — a package carries real decisions (which modules,
 * which scan mode, whether existing AV is removed) and those belong where he can see them,
 * not guessed by us.
 */
export async function listPackages(customerId: number): Promise<GzPackage[]> {
  const { gzCompanyId } = await companyFor(customerId);
  const list = await rpc<any>('packages', 'getPackagesList', { companyId: gzCompanyId, page: 1, perPage: 100 });
  const items = Array.isArray(list) ? list : (list?.items || []);
  return items
    .filter((p: any) => p && (p.name || p.packageName))
    .map((p: any) => ({
      name: String(p.name || p.packageName),
      id: p.id != null ? String(p.id) : null,
      description: p.description ? String(p.description) : null,
    }));
}

/** Tie a customer to one named package, and cache its download links. */
export async function mapPackage(customerId: number, packageName: string, userId: number | null = null): Promise<PackageState> {
  const { gzCompanyId } = await companyFor(customerId);
  const name = String(packageName || '').trim();
  if (!name) throw new Error('Pick a package.');

  // Confirm it really is in this company before recording it. A package name typed or
  // posted from somewhere else could otherwise point one customer's machines at another
  // customer's installer — which would enrol them into the wrong company entirely.
  const available = await listPackages(customerId);
  const hit = available.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!hit) {
    throw new Error(`"${name}" is not one of that company's packages in GravityZone` +
      (available.length ? ` (found: ${available.map((p) => p.name).join(', ')})` : ' — no packages exist there yet'));
  }

  const state = await refreshLinks(customerId, gzCompanyId, hit.name, userId);
  if (userId) await logActivity(userId, 'gz_package_map', 'customers', customerId,
    `Bitdefender installation package "${hit.name}" mapped to this customer`);
  return state;
}

/**
 * The package to deploy from. Mapped already → use it. Otherwise REFUSE and say what to
 * pick, because since the mapping is what enables a customer, choosing one for them would
 * be enabling them.
 */
export async function resolvePackage(customerId: number, userId: number | null = null): Promise<PackageState> {
  const saved = (await pool.query(`SELECT * FROM security_packages WHERE customer_id=$1`, [customerId])).rows[0];
  if (saved?.package_name) return refreshLinks(customerId, String(saved.gz_company_id), String(saved.package_name), userId);

  // NOT adopted automatically, even when the company has exactly one package. Since the
  // mapping is now what enables a customer, auto-adopting would let a sync quietly enable
  // a customer nobody had chosen — which is precisely what the old enable switch existed
  // to prevent. Mapping stays a deliberate human act; it is one click on the mapping page.
  const available = await listPackages(customerId);
  if (!available.length) {
    throw new Error('No installation packages exist in that company in GravityZone yet — create one there, then map it here.');
  }
  throw new Error(`No package mapped for this customer. That company has ${available.length} ` +
    `in GravityZone (${available.map((p) => p.name).join(', ')}) — pick one under Integrations.`);
}

/**
 * Create a package ourselves. Kept for the case where Terry would rather the Portal did
 * it, but NOT called automatically any more: he creates them in GravityZone.
 */
export async function createPackage(customerId: number, userId: number | null = null): Promise<PackageState> {
  const { gzCompanyId, customerName } = await companyFor(customerId);
  const name = packageNameFor(customerName);
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
    if (!/exist/i.test(e.message || '')) throw e;   // already there is fine; we want one
  }
  return mapPackage(customerId, name, userId);
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

  // USE THE DOWNLOADER, NOT THE FULL KIT — and this is not a preference, it is the only
  // one of the two that can work.
  //
  // The full-kit URL is an API endpoint:
  //   https://cloudgz.gravityzone.bitdefender.com/api/v1.0/http/downloadFullKit?packageId=...
  // and /api/ requires `Authorization: Basic <apiKey>` like every other GravityZone call.
  // The agent's DownloadAsync deliberately sends NO credentials, because it fetches vendor
  // URLs and our device token has no business being posted to a third-party host. So the
  // agent asks for the kit unauthenticated and Bitdefender answers 401 — which is exactly
  // what LUMEN-008 reported on 19 Aug ("Install failed: ... 401 (Unauthorized)").
  //
  // installLinkWindows is a plain package path with no auth on it at all:
  //   https://cloudgz.gravityzone.bitdefender.com/Packages/<hash>/setupdownloader_[...].exe
  //
  // The old comment argued for the full kit — "fewer moving parts on a machine we cannot
  // see" — which is a fair instinct and wrong twice over here: the kit needs a credential
  // we must not ship, and it is about a GIGABYTE, which the agent was buffering entirely
  // in memory before writing a byte. The ~10 MB downloader fetches what it needs at
  // install time from the same host the kit lives on, so the network dependency it adds
  // is one we already have.
  //
  // Sending the full kit anyway "as a fallback" would be worse than sending nothing: every
  // machine would fail with an authentication error that reads like a broken API key.
  const win = str(mine.installLinkWindows);

  // Readiness, without treating "we could not find the field" as "not ready".
  //
  // This was `Number(mine.status?.windows) === KIT_READY`, which makes an ABSENT status
  // indistinguishable from one that says "still building": Number(undefined) is NaN, and
  // NaN is never 2. On 18 Aug that put all EIGHT mapped customers on "installer still
  // building" at once — and eight kits do not start building simultaneously. The field
  // was simply not where we looked. `status` is on the getPackagesList row; this is the
  // getInstallationLinks response, which is a different shape.
  //
  // Same family as reading agent/modules/malwareStatus off the endpoint LIST row: a
  // missing field rendered as a confident answer, and on a security screen a confident
  // wrong answer is the worst kind. So an explicit status is believed in BOTH directions,
  // and when there is no status at all we fall back to the only other evidence we have —
  // whether Bitdefender handed us a servable URL. A kit with a download link is a kit.
  const rawStatus = mine.status?.windows ?? mine.statusWindows ?? mine.windowsStatus ?? null;
  const ready = rawStatus == null || rawStatus === ''
    ? !!win
    : Number(rawStatus) === KIT_READY;

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
    // Same rule for the other platforms: the installLink* paths are servable, the
    // fullKit* ones are /api/ URLs that need the key.
    [customerId, gzCompanyId, packageName, win, str(mine.installLinkMac), str(mine.installLinkMacArm),
     str(mine.installLinkLinux), ready, JSON.stringify(mine)])).rows[0];

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
/**
 * What a Bitdefender migration on this machine actually has to deal with.
 *
 * Two things are deliberately left out of the third-party list.
 *
 * Microsoft Defender is not a competitor - it steps aside by itself the moment another
 * engine registers. Listing it under "AV before" invites someone to plan a removal that
 * is not needed, and it made every machine look like it was running one more product
 * than it was.
 *
 * Entries the agent could not find on disk (present === false) are Security Center
 * ghosts - registrations left behind by an uninstall that never deregistered. A product
 * that is gone cannot be the thing we are migrating off. More to the point, a ghost
 * BITDEFENDER registration would otherwise satisfy isBitdefender() and the machine would
 * be skipped as already protected - the exact "complete but not installed" failure this
 * module exists to prevent.
 *
 * reportedAny keeps "the agent has told us nothing yet" distinguishable from "it told us,
 * and the answer is Defender only" - which is the easiest deployment there is, not a gap.
 */
function avSummary(securityJson: any): { thirdParty: string[]; ghosts: string[]; reportedAny: boolean } {
  const empty = { thirdParty: [], ghosts: [], reportedAny: false };
  let j: any = null;
  try { j = typeof securityJson === 'string' ? JSON.parse(securityJson) : securityJson; } catch { return empty; }
  if (!j) return empty;
  const list = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);
  // "Bitdefender" contains "defender" - match Microsoft's naming, not the word.
  const isMs = (n: string) => /(^|\s)(windows|microsoft)\s+defender/i.test(n) || /^microsoft\b/i.test(n);
  const all = [...list(j.av), ...list(j.antispyware)]
    .map((p: any) => ({ name: String(p?.name || '').trim(), present: p?.present }))
    .filter((p) => p.name);
  return {
    thirdParty: Array.from(new Set(all.filter((p) => !isMs(p.name) && p.present !== false).map((p) => p.name))),
    ghosts: Array.from(new Set(all.filter((p) => p.present === false).map((p) => p.name))),
    reportedAny: all.filter((p) => p.present !== false).length > 0,
  };
}

function avNames(securityJson: any): string[] { return avSummary(securityJson).thirdParty; }

const isBitdefender = (names: string[]) => names.some((n) => /bitdefender|gravityzone|endpoint security tools/i.test(n));

export interface QueueResult { ok: boolean; deviceId: number; commandId?: number; error?: string }

/**
 * Queue the install on one device. Returns rather than throws for the per-row failures
 * a bulk rollout will hit — one machine with no agent must not abort the other forty.
 */
export async function queueDeploy(deviceId: number, userId: number | null = null): Promise<QueueResult> {
  // d.os, NOT d.os_name. agent_devices has `os`; os_name is a security_endpoints column.
  // That typo made this query throw for EVERY device, so "Deploy to all" failed with
  // `column d.os_name does not exist` before it queued a single install — and the test
  // suite was green throughout, because the scratch database had been hand-built with an
  // os_name column the real schema has never had. See the schema-parity check in
  // gz-fixture.js, which now fails the run rather than letting that happen again.
  const dev = (await pool.query(
    `SELECT d.id, d.hostname, d.customer_id, d.security_json, d.os,
            COALESCE(d.revoked,false) AS revoked
       FROM agent_devices d WHERE d.id=$1`, [deviceId])).rows[0];
  if (!dev) return { ok: false, deviceId, error: 'No such device.' };
  if (dev.revoked) return { ok: false, deviceId, error: 'That agent has been revoked.' };
  if (!dev.customer_id) return { ok: false, deviceId, error: 'Device is not attached to a customer.' };

  // The kit we are about to send is the WINDOWS one, installed with Windows silent
  // switches. Pushing it at a Mac would download an .exe onto macOS and fail in a way
  // that reads as "the install failed" rather than "we sent the wrong thing" — and we
  // now ship a macOS agent, so those machines are really in the estate. An OS we have
  // not identified is allowed through: the estate predates the agent, plenty of rows
  // have no OS recorded, and refusing those would block real Windows machines.
  if (dev.os && !/windows/i.test(String(dev.os))) {
    return { ok: false, deviceId,
      error: `Only the Windows kit exists so far, and this machine reports ${dev.os}.` };
  }

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
  deviceId: number | null; assetId: number | null; customerId: number | null; hostname: string;
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
// ONE query, two entry points. The customer screen wants every machine; the asset page
// wants exactly one, and it must reach the identical verdict — a device that reads
// "protected" on the rollout screen and "not deployed" on its own page is worse than
// either answer alone, because now nobody knows which to believe.
const ROLLOUT_SELECT = `
  SELECT a.id AS asset_id, a.hostname, a.customer_id, d.id AS device_id, d.security_json,
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
    ) se ON true`;

export async function rolloutFor(customerId: number): Promise<RolloutRow[]> {
  const rows = (await pool.query(
    `${ROLLOUT_SELECT}
      WHERE a.customer_id=$1 AND a.merged_into_id IS NULL
      ORDER BY a.hostname`, [customerId])).rows;
  return rows.map(mapRolloutRow);
}

/**
 * The same verdict for ONE machine, for its own page.
 *
 * Terry, 18 Aug: "i need to be able to deploy via the asset - still after asking cannot
 * find it." Fair — the deploy button only ever existed on the customer rollout screen, so
 * working a single machine meant knowing which customer it belonged to and finding it in
 * a list. The route exists (POST /security/device/:id/deploy); what was missing was
 * anywhere to press it from.
 */
export async function deviceSecurity(assetId: number): Promise<RolloutRow | null> {
  const r = (await pool.query(
    `${ROLLOUT_SELECT} WHERE a.id=$1 AND a.merged_into_id IS NULL LIMIT 1`, [assetId])).rows[0];
  return r ? mapRolloutRow(r) : null;
}

function mapRolloutRow(rows: any): RolloutRow {
  const now = Math.floor(Date.now() / 1000);
  return ((r: any) => {
    const sec = avSummary(r.security_json);
    const names = sec.thirdParty;
    const currentAv = names.join(', ') || null;
    const agentSeen = r.agent_seen ? Number(r.agent_seen) : null;
    const base = {
      deviceId: r.device_id ? Number(r.device_id) : null,
      assetId: r.asset_id ? Number(r.asset_id) : null,
      customerId: r.customer_id ? Number(r.customer_id) : null,
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
    if (!names.length) {
      const leftovers = sec.ghosts.length ? ` ${sec.ghosts.join(', ')} is still registered but not installed — clear the leftover first.` : '';
      if (sec.reportedAny) return { ...base, state: 'not-deployed', detail: 'On Windows Defender only — nothing to remove first.' + leftovers };
      if (sec.ghosts.length) return { ...base, state: 'not-deployed', detail: `Nothing is actually installed here — only a leftover registration for ${sec.ghosts.join(', ')}. Clear it, then deploy.` };
      return { ...base, state: 'not-deployed', detail: 'Agent is on, but it has not reported its AV yet.' };
    }
    return { ...base, state: 'not-deployed',
      detail: `Currently on ${currentAv}.` +
        (sec.ghosts.length ? ` (${sec.ghosts.join(', ')} is still registered but not installed — clear the leftovers before deploying.)` : '') };
  })(rows);
}

export interface DeployLogEntry {
  commandId: number;
  /** queued | running | done | failed | expired — the AGENT's view, not the rollout state. */
  status: string;
  queuedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  /** The tail the agent streams while the installer is still talking. */
  progress: string | null;
  progressAt: Date | null;
  /** Everything the installer printed, once it has stopped. */
  output: string | null;
  requestedBy: string | null;
  /** What we actually told the machine to fetch and run — the two facts that decide the outcome. */
  url: string | null;
  args: string | null;
}

/**
 * What is ACTUALLY happening to this machine, as opposed to what the rollout state says.
 *
 * Terry, 19 Aug: "when BD is queued what is it actually doing - i think we need to see a log."
 * He is right, and the awkward part is that the Portal already had every fact and showed none
 * of them. `security_deployments.state` is a summary that only moves when somebody presses
 * Refresh progress, so a machine reads "Queued" from the moment it is asked until a human
 * intervenes — through the download, the competitive removal, the install and the failure.
 *
 * Meanwhile `agent_commands` has been recording the truth all along: when it was claimed,
 * when it started, the tail of the installer's own output STREAMED AS IT APPEARS (the agent
 * posts every line, throttled), the exit code, and the full output at the end. This just
 * reads it back, newest first, so the panel can show the attempt rather than a summary of it.
 *
 * Scoped to Bitdefender installs on this device: the same command kind carries every other
 * software push, and a log that mixes them is a log nobody trusts.
 */
export async function deployLog(deviceId: number, limit = 5): Promise<DeployLogEntry[]> {
  const rows = (await pool.query(
    `SELECT c.id, c.status, c.requested_at, c.started_at, c.finished_at, c.exit_code,
            c.progress, c.progress_at, c.output, c.payload,
            u.display_name AS requested_by
       FROM agent_commands c
       LEFT JOIN users u ON u.id = c.requested_by
      WHERE c.device_id=$1 AND c.kind='software.install'
        AND c.payload->>'name' LIKE 'Bitdefender%'
      ORDER BY c.id DESC
      LIMIT $2`, [deviceId, limit])).rows;

  return rows.map((r: any) => ({
    commandId: Number(r.id),
    status: String(r.status || 'queued'),
    queuedAt: r.requested_at || null,
    startedAt: r.started_at || null,
    finishedAt: r.finished_at || null,
    exitCode: r.exit_code == null ? null : Number(r.exit_code),
    progress: r.progress || null,
    progressAt: r.progress_at || null,
    output: r.output || null,
    requestedBy: r.requested_by || null,
    url: r.payload?.url ? String(r.payload.url) : null,
    args: r.payload?.args ? String(r.payload.args) : null,
  }));
}

export interface CustomerSummary {
  customerId: number; customerName: string;
  enabled: boolean; enabledReason: string;
  gzCompanyId: string | null; gzCompanyName: string | null;
  packageName: string | null; packageReady: boolean;
  devices: number; protectedCount: number; installing: number; notDeployed: number;
  failed: number; infected: number; noAgent: number;
  ready: boolean;          // everything wired up and able to deploy
  blocker: string | null;  // the ONE thing stopping this customer, if any
}

/**
 * One row per customer, which is the level people actually work at.
 *
 * Terry, 18 Aug: "we do not need an estate view with big list of devices." He is right —
 * 236 device rows across every customer is a list nobody reads. What you want to know is
 * which customers are done, which are mid-rollout, and which are blocked and on what. The
 * device detail lives one click away on that customer's own screen.
 *
 * Counting is done in SQL rather than by walking rolloutFor() per customer: this is the
 * landing page, and it must not fire an API call or a query storm to draw itself.
 */
export async function customerSummaries(): Promise<CustomerSummary[]> {
  const rows = (await pool.query(
    `SELECT c.id, c.name,
            sc.gz_id, sc.name AS company_name,
            sp.package_name, COALESCE(sp.ready_windows, false) AS package_ready,
            COUNT(a.id)::int                                                  AS devices,
            COUNT(*) FILTER (WHERE se.gz_id IS NOT NULL AND NOT se.infected)::int AS protected_count,
            COUNT(*) FILTER (WHERE se.infected)::int                          AS infected,
            COUNT(*) FILTER (WHERE se.gz_id IS NULL AND dep.state IN ('queued','running'))::int AS installing,
            COUNT(*) FILTER (WHERE se.gz_id IS NULL AND dep.state = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE a.agent_device_id IS NULL)::int             AS no_agent
       FROM customers c
       LEFT JOIN security_companies sc ON sc.customer_id = c.id
       LEFT JOIN security_packages  sp ON sp.customer_id = c.id
       LEFT JOIN customer_assets a ON a.customer_id = c.id AND a.merged_into_id IS NULL
       LEFT JOIN agent_devices d ON d.id = a.agent_device_id AND NOT COALESCE(d.revoked,false)
       LEFT JOIN security_deployments dep ON dep.device_id = d.id
       LEFT JOIN security_endpoints se ON se.asset_id = a.id
      WHERE NOT c.is_placeholder AND c.status <> 'inactive'
      GROUP BY c.id, c.name, sc.gz_id, sc.name, sp.package_name, sp.ready_windows
      ORDER BY c.name`)).rows;

  return rows.map((r: any) => {
    // Enabled == mapped. Company AND package, both chosen by a human. See customerEnabled().
    const enabled = !!r.gz_id && !!r.package_name;
    const devices = Number(r.devices || 0);
    const prot = Number(r.protected_count || 0);
    const infected = Number(r.infected || 0);
    const installing = Number(r.installing || 0);
    const failed = Number(r.failed || 0);
    const noAgent = Number(r.no_agent || 0);
    const notDeployed = Math.max(0, devices - prot - infected - installing - failed - noAgent);

    // ONE blocker, in the order you would actually hit them. A list of six things wrong
    // is a list nobody acts on; the next thing to do is what belongs on the screen.
    let blocker: string | null = null;
    if (!r.gz_id) blocker = 'no GravityZone company mapped';
    else if (!r.package_name) blocker = 'no installation package mapped';
    else if (!r.package_ready) blocker = 'installer still building';
    else if (!devices) blocker = 'no machines on record';

    return {
      customerId: Number(r.id), customerName: String(r.name),
      enabled,
      enabledReason: enabled ? 'company and package mapped'
        : (!r.gz_id ? 'no company mapped' : 'no package mapped'),
      gzCompanyId: r.gz_id || null, gzCompanyName: r.company_name || null,
      packageName: r.package_name || null, packageReady: !!r.package_ready,
      devices, protectedCount: prot, installing, notDeployed, failed, infected, noAgent,
      ready: !blocker, blocker,
    };
  });
}

export interface InfectionRow {
  hostname: string | null; threat: string | null; detail: string | null;
  ticketId: number | null; detectedAt: Date | null; assetId: number | null;
  /** One of OUR tools flagged, not a threat — an exclusion to add, not a case to work. */
  ownTool: boolean;
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
    ownTool: isOwnToolDetection(x.threat_name, x.detail),
  }));
}

export interface InfectedDevice {
  customerId: number | null; customerName: string | null;
  assetId: number | null; deviceId: number | null;
  hostname: string; gzId: string;
  policyName: string | null; lastSeenAt: Date | null;
  threat: string | null; detail: string | null; detectedAt: Date | null; ticketId: number | null;
  ownTool: boolean;
}

/**
 * Every infected machine across the estate, with the threat and the case.
 *
 * Terry, 18 Aug: "it does say one is infected. Love to know which one that is because
 * that's not clickable." A count you cannot open is a count you cannot act on, so the
 * tile now leads here. Sorted real threats first — the one that matters must not be
 * pushed off the top by a shelf of our own tooling.
 */
export async function infectedDevices(): Promise<InfectedDevice[]> {
  const rows = (await pool.query(
    `SELECT se.gz_id, se.name, se.policy_name, se.last_seen_at, se.asset_id,
            se.customer_id, c.name AS customer_name,
            a.agent_device_id AS device_id,
            d.threat_name, d.detail, d.detected_at, d.ticket_id
       FROM security_endpoints se
       LEFT JOIN customers c ON c.id = se.customer_id
       LEFT JOIN customer_assets a ON a.id = se.asset_id
       LEFT JOIN LATERAL (
         SELECT sd.threat_name, sd.detail, sd.detected_at, sd.ticket_id
           FROM security_detections sd
          WHERE sd.endpoint_gz_id = se.gz_id
          ORDER BY sd.detected_at DESC LIMIT 1
       ) d ON true
      WHERE se.infected
      ORDER BY c.name NULLS LAST, se.name`)).rows;

  return rows.map((r: any) => ({
    customerId: r.customer_id ? Number(r.customer_id) : null,
    customerName: r.customer_name || null,
    assetId: r.asset_id ? Number(r.asset_id) : null,
    deviceId: r.device_id ? Number(r.device_id) : null,
    hostname: String(r.name || '(unnamed)'),
    gzId: String(r.gz_id),
    policyName: r.policy_name || null,
    lastSeenAt: r.last_seen_at || null,
    threat: r.threat_name || null,
    detail: r.detail || null,
    detectedAt: r.detected_at || null,
    ticketId: r.ticket_id ? Number(r.ticket_id) : null,
    ownTool: isOwnToolDetection(r.threat_name, r.detail),
  })).sort((a, b) => Number(a.ownTool) - Number(b.ownTool));
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

/**
 * Paths that must be excluded in every policy Lumen manages.
 *
 * Two products, not one. The LumenMSP agent is here because a security product holding
 * our unsigned service past Windows' 30-second start window is what produced
 * Chropynska's fleet-wide error 1920. The Mesh agent is here because Bitdefender's
 * Hyper Detect files MeshCentral as Gen:Illusion.PUP.MeshCentral — Terry, 18 Aug:
 * "this is my machine - not good if our chosen remote control is showing up as threat".
 * The detection is not wrong, exactly: MeshCentral IS a remote-access tool, and PUP
 * heuristics exist to catch remote-access tools. It is OURS, which is the whole of the
 * difference, and the policy is the only place that difference can be written down.
 */
export const AGENT_EXCLUSION_HINTS = ['LumenMSP', 'LumenAgentService', 'Mesh Agent', 'MeshAgent'];

/** The exact exclusions to add, in the words the GravityZone policy screen uses. */
export const REQUIRED_EXCLUSIONS: Array<{ kind: string; value: string; why: string }> = [
  { kind: 'Folder',  value: 'C:\\Program Files\\LumenMSP Agent', why: 'our RMM agent — service start timeout, error 1920' },
  { kind: 'Process', value: 'C:\\Program Files\\LumenMSP Agent\\LumenAgentService.exe', why: 'our RMM agent service' },
  { kind: 'Folder',  value: 'C:\\Program Files\\Mesh Agent', why: 'our remote control' },
  { kind: 'Process', value: 'C:\\Program Files\\Mesh Agent\\MeshAgent.exe', why: 'filed as Gen:Illusion.PUP.MeshCentral by Hyper Detect' },
];

// isOwnToolDetection lives in gravityzone.ts because the SYNC needs it too — it is what
// stops a detection on our own remote control from raising a support case.

export interface PolicyExclusions {
  policyId: string; policyName: string;
  items: string[];
  agentExcluded: boolean;
  /** Which of our own tools this policy does NOT exclude, in words. */
  missing: string[];
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

    // Which of OUR tools this policy protects, named individually. "agentExcluded: false"
    // used to mean "one of the two hints is missing" without saying which — and with the
    // Mesh agent added, a policy that covers the RMM agent but not the remote control is
    // the likely state, so the missing one is the only part worth printing.
    const has = (h: string) => items.some((i) => i.toLowerCase().includes(h.toLowerCase()));
    const missing = [
      has('LumenMSP') || has('LumenAgentService') ? null : 'the LumenMSP agent',
      has('Mesh Agent') || has('MeshAgent') ? null : 'the Mesh remote control',
    ].filter(Boolean) as string[];
    const agentExcluded = missing.length === 0;

    out.push({
      policyId: String(p.id), policyName: String(p.name || p.id),
      items, agentExcluded, missing,
      note: items.length
        ? (agentExcluded
            ? 'Both LumenMSP tools are excluded here.'
            : `No exclusion for ${missing.join(' or ')} — add the folder and the .exe, On-Access and ATC.`)
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
