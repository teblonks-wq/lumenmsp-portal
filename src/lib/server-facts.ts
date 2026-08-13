import { pool } from '../db/pool';

// ── Server facts: storing them, and judging them ────────────────────────────────
// The agent collects and judges nothing, same as the Cyber Essentials collector. Every
// "this is worth looking at" below is decided here, so raising a threshold is a Portal
// change rather than a new agent on every customer's domain controller.
//
// Nothing in here is a hard failure. A server is not broken because a checkpoint is three
// weeks old — but somebody should know, and today nobody does until it fills a disk.

export interface ServerAlert {
  level: 'bad' | 'warn';
  area: string;      // AD | SQL | Hyper-V | Storage | Certificates | DHCP
  title: string;
  detail?: string;
  /** Key into SERVER_FIXES (lib/server-fix.ts) when the Portal carries a safe one-click fix. */
  fix?: string;
}

const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const days = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(String(iso).replace(' ', 'T')).getTime();
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

/** Everything we think somebody should look at, worst first. */
export function judge(f: any): ServerAlert[] {
  const out: ServerAlert[] = [];
  if (!f) return out;

  // ── Active Directory ──────────────────────────────────────────────────────────
  const ad = f.ad;
  if (ad) {
    const fails = Array.isArray(ad.replicationFailures) ? ad.replicationFailures : [];
    if (fails.length) {
      out.push({ level: 'bad', area: 'AD', title: `Replication is failing with ${fails.length} partner${fails.length === 1 ? '' : 's'}`,
        detail: fails.map((x: any) => `${x.partner}: ${x.reason || 'unknown'} (${x.count} times since ${String(x.first || '').slice(0, 10)})`).join(' · ') });
    }
    if (num(ad.dcCount) === 1) {
      out.push({ level: 'warn', area: 'AD', title: 'Only one domain controller',
        detail: 'Every authentication in the business depends on this one machine being up. Worth costing a second one.' });
    }
    if (ad.recycleBin === false) {
      out.push({ level: 'warn', area: 'AD', title: 'AD Recycle Bin is not enabled',
        detail: 'Without it, restoring a deleted user or group means an authoritative restore from backup. It is a one-way switch and it is free.',
        fix: 'ad-recycle-bin' });
    }
    const stale = num(ad.staleComputers) || 0;
    if (stale > 0) {
      out.push({ level: 'warn', area: 'AD', title: `${stale} computer account${stale === 1 ? '' : 's'} unused for 90 days`,
        detail: 'Dormant enabled accounts are the easiest thing for an assessor to point at, and they make every device count wrong.',
        fix: 'ad-stale-computers' });
    }
    const pne = num(ad.passwordNeverExpires) || 0;
    if (pne > 0) {
      out.push({ level: 'warn', area: 'AD', title: `${pne} enabled account${pne === 1 ? '' : 's'} with a password that never expires` });
    }
    const das = Array.isArray(ad.domainAdmins) ? ad.domainAdmins.length : 0;
    if (das > 4) {
      out.push({ level: 'warn', area: 'AD', title: `${das} members of Domain Admins`,
        detail: (ad.domainAdmins || []).join(', ') });
    }
    if (/2008|2003|2012/.test(String(ad.domainMode || '')) || /2008|2003|2012/.test(String(ad.forestMode || ''))) {
      out.push({ level: 'warn', area: 'AD', title: `Functional level is ${ad.domainMode || ad.forestMode}`,
        detail: 'Raising it is usually uneventful once every DC is on a supported OS, and several security features depend on it.' });
    }
  }

  // ── SQL Server ────────────────────────────────────────────────────────────────
  for (const inst of (Array.isArray(f.sql) ? f.sql : [])) {
    if (inst.accessError) {
      out.push({ level: 'warn', area: 'SQL', title: `Cannot see inside ${inst.instance}`,
        detail: 'Version and edition come from the registry, but databases and backup dates need a login. Since SQL 2012 the agent account is not sysadmin by default — grant it a read-only login to fill this in.' });
    }
    if (num(inst.failedJobs7d)) {
      out.push({ level: 'bad', area: 'SQL', title: `${inst.failedJobs7d} SQL Agent job failure${inst.failedJobs7d === 1 ? '' : 's'} in the last week on ${inst.instance}` });
    }
    for (const db of (Array.isArray(inst.databases) ? inst.databases : [])) {
      if (['master', 'model', 'msdb', 'tempdb'].includes(String(db.name).toLowerCase())) continue;
      const full = days(db.lastFull);
      if (full === null) {
        out.push({ level: 'bad', area: 'SQL', title: `${db.name} has never been backed up`,
          detail: `On ${inst.instance}. Nothing in the backup history for this database at all.` });
      } else if (full > 7) {
        out.push({ level: 'bad', area: 'SQL', title: `${db.name} last full backup was ${full} days ago`, detail: `On ${inst.instance}.` });
      }
      // Full recovery with no log backups grows the log until the disk fills. It is the
      // single most common SQL callout there is.
      if (String(db.recovery || '').toUpperCase() === 'FULL') {
        const log = days(db.lastLog);
        if (log === null || log > 1) {
          out.push({ level: 'warn', area: 'SQL', title: `${db.name} is in FULL recovery with ${log === null ? 'no log backups' : `no log backup for ${log} days`}`,
            detail: 'The transaction log will grow until the disk fills. Either back the log up on a schedule or switch the database to SIMPLE — whichever matches what was actually promised.' });
        }
      }
    }
  }

  // ── Hyper-V ───────────────────────────────────────────────────────────────────
  for (const vm of (Array.isArray(f.hyperv) ? f.hyperv : [])) {
    const age = days(vm.oldestCheckpoint);
    if (age !== null && age > 14) {
      out.push({ level: 'warn', area: 'Hyper-V', title: `${vm.name} has a checkpoint ${age} days old`,
        detail: 'Checkpoints were meant to be temporary. The differencing disk grows until the volume fills, and merging it later takes the VM down for longer the longer you leave it.' });
    }
  }

  // ── Storage ───────────────────────────────────────────────────────────────────
  for (const v of (Array.isArray(f.volumes) ? f.volumes : [])) {
    const pct = num(v.pctFree);
    if (pct !== null && pct < 10) {
      out.push({ level: pct < 5 ? 'bad' : 'warn', area: 'Storage',
        title: `${v.drive} is ${pct}% free`, detail: `${v.freeGb} GB left of ${v.sizeGb} GB.` });
    }
  }

  // ── Certificates ──────────────────────────────────────────────────────────────
  for (const c of (Array.isArray(f.certificates) ? f.certificates : [])) {
    const left = num(c.daysLeft);
    if (left !== null && left < 30) {
      out.push({ level: left < 0 ? 'bad' : left < 14 ? 'bad' : 'warn', area: 'Certificates',
        title: left < 0 ? `A certificate expired ${Math.abs(left)} days ago` : `A certificate expires in ${left} days`,
        detail: `${c.subject} — expires ${c.expires}` });
    }
  }

  // ── DHCP ──────────────────────────────────────────────────────────────────────
  for (const s of (Array.isArray(f.dhcp) ? f.dhcp : [])) {
    const used = num(s.pctUsed);
    if (used !== null && used > 85) {
      out.push({ level: used > 95 ? 'bad' : 'warn', area: 'DHCP',
        title: `Scope ${s.name || s.id} is ${used}% used`, detail: `${s.free} addresses left in ${s.range}.` });
    }
  }

  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}

/** PowerShell sometimes prefixes output with a warning line; take the JSON object. */
export function parseFacts(output: string): any {
  const t = String(output || '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('no JSON in output');
  return JSON.parse(t.slice(i, j + 1));
}

/** One row per machine, replaced each time. History lives in the command log. */
export async function storeServerFacts(deviceId: number, facts: any, commandId: number | null = null): Promise<void> {
  const alerts = judge(facts);
  const roles = Array.isArray(facts?.roles) ? facts.roles.join(',') : null;
  const domain = facts?.ad?.domain || null;
  const sql = Array.isArray(facts?.sql) ? facts.sql.length : 0;
  const vms = Array.isArray(facts?.hyperv) ? facts.hyperv.length : 0;

  await pool.query(
    `INSERT INTO server_facts (device_id, server_role, roles, domain, sql_instances, vm_count, alerts, facts, command_id, error, collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NOW())
     ON CONFLICT (device_id) DO UPDATE SET
       server_role=EXCLUDED.server_role, roles=EXCLUDED.roles, domain=EXCLUDED.domain,
       sql_instances=EXCLUDED.sql_instances, vm_count=EXCLUDED.vm_count, alerts=EXCLUDED.alerts,
       facts=EXCLUDED.facts, command_id=EXCLUDED.command_id, error=NULL, collected_at=NOW()`,
    [deviceId, facts?.role || null, roles ? roles.slice(0, 2000) : null,
     domain ? String(domain).slice(0, 200) : null, sql, vms, alerts.length, facts, commandId]);
}

/** Called the moment a queued `server.facts` command comes back. */
export async function ingestServerFacts(commandId: number): Promise<void> {
  const cmd = (await pool.query(
    `SELECT device_id, status, output FROM agent_commands WHERE id=$1`, [commandId])).rows[0];
  if (!cmd) return;

  if (cmd.status !== 'done') {
    await pool.query(
      `INSERT INTO server_facts (device_id, error, command_id, collected_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (device_id) DO UPDATE SET error=EXCLUDED.error, command_id=EXCLUDED.command_id`,
      [cmd.device_id, String(cmd.output || 'the collector failed').slice(0, 1000), commandId]);
    return;
  }

  try {
    await storeServerFacts(cmd.device_id, parseFacts(cmd.output), commandId);
  } catch (e: any) {
    await pool.query(
      `INSERT INTO server_facts (device_id, error, command_id, collected_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (device_id) DO UPDATE SET error=EXCLUDED.error, command_id=EXCLUDED.command_id`,
      [cmd.device_id, `could not read the collector output: ${e.message}`.slice(0, 1000), commandId]);
  }
}

/**
 * Queue a collection on any server that has not reported in `staleHours`.
 *
 * Called when the Servers page loads rather than on a timer: the page is the only place
 * the answer is wanted, and a machine nobody is looking at does not need waking up. One
 * command at a time per machine — an offline server would otherwise accumulate a queue of
 * identical requests and run all of them at once when it came back.
 */
export async function refreshStaleServers(staleHours = 24): Promise<number> {
  const due = (await pool.query(
    `SELECT ad.id
       FROM agent_devices ad
       LEFT JOIN server_facts sf ON sf.device_id = ad.id
      WHERE ad.revoked = false
        AND (LOWER(COALESCE(ad.os,'')) LIKE '%server%' OR sf.device_id IS NOT NULL)
        AND (sf.collected_at IS NULL OR sf.collected_at < NOW() - ($1 || ' hours')::interval)
        AND NOT EXISTS (
          SELECT 1 FROM agent_commands ac
           WHERE ac.device_id = ad.id AND ac.kind = 'server.facts'
             AND ac.status IN ('queued','running'))
      LIMIT 50`, [String(staleHours)])).rows;

  for (const d of due) {
    await pool.query(
      `INSERT INTO agent_commands (device_id, kind, status) VALUES ($1,'server.facts','queued')`, [d.id]);
  }
  return due.length;
}
