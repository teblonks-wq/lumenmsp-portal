import cron from 'node-cron';
import { pool } from '../db/pool';
import { getCatalogueItem, dispatchFor } from './software-catalogue';
import { logActivity } from './activity';
import { wakeAgent } from '../routes/agent-api';
import { occurrenceDays } from './diary';
import { getScript } from './scripts';

// ── Automation: scheduled tasks ─────────────────────────────────────────────────
// "Do this, to these machines, at this moment." Everything the Portal could already do to
// one machine on demand - restart it, shut it down, run a script, push a package - plus
// turning Windows Update off and on, now with a chosen set of machines and a condition.
//
// Nothing here is a new agent capability. Every action lands on a command kind the agent
// already handles, which is why this ships without touching the MSI. The Windows Update
// actions ride shell.powershell exactly as the BitLocker scan and the server fix-buttons do.
//
// The important shape: a TASK is an intention, agent_commands are the reality, and the two
// are separated by ARMING. A weekly reboot running for a year would otherwise put 52
// queued commands on every machine on the day it was created, and nobody looking at that
// queue could tell what was outstanding from what was merely future. Instead the sweep
// arms each occurrence when its moment arrives, and only then do commands appear.

// ── Actions ─────────────────────────────────────────────────────────────────────

export type ActionKey = 'power.restart' | 'power.shutdown' | 'wu.off' | 'wu.on' | 'script.run'
  | 'software.install' | 'software.upgrade' | 'software.uninstall';

export interface ActionDef {
  key: ActionKey;
  label: string;
  /** What it says in a confirmation, written as the consequence rather than the verb. */
  consequence: string;
  /** The agent command kind this becomes. */
  kind: string;
  /** Extra thing the form must collect: a script, or a package. */
  needs: 'none' | 'script' | 'package' | 'software';
  /** True if a signed-in user could lose work. Drives the warning on the form. */
  disruptive: boolean;
}

export const ACTIONS: ActionDef[] = [
  { key: 'power.restart', label: 'Restart', kind: 'power.restart', needs: 'none', disruptive: true,
    consequence: 'The machine restarts. Anyone signed in is warned and cannot stop it, and unsaved work is lost.' },
  { key: 'power.shutdown', label: 'Shut down', kind: 'power.shutdown', needs: 'none', disruptive: true,
    consequence: 'The machine shuts down and stays off until someone turns it on. Nothing here can wake it again.' },
  { key: 'wu.off', label: 'Turn Windows Updates OFF', kind: 'shell.powershell', needs: 'none', disruptive: false,
    consequence: 'Windows Update stops and is disabled, and the policy key is set so it stays that way. Nothing installs and nothing reboots itself until it is turned back on.' },
  { key: 'wu.on', label: 'Turn Windows Updates ON', kind: 'shell.powershell', needs: 'none', disruptive: false,
    consequence: 'Windows Update is set back to its normal automatic state and the policy key is removed.' },
  { key: 'script.run', label: 'Run a script', kind: 'shell.powershell', needs: 'script', disruptive: false,
    consequence: 'The script runs on each machine. What it does is whatever the script does - read its review first.' },
  { key: 'software.install', label: 'Deploy software', kind: 'software.install', needs: 'software', disruptive: false,
    consequence: 'The software is installed silently on each machine, from the catalogue entry you pick. A machine that already has it is left alone.' },
  { key: 'software.upgrade', label: 'Update software', kind: 'winget.upgrade', needs: 'software', disruptive: false,
    consequence: 'Each machine updates that software to the latest version. A machine that does not have it installed is unaffected.' },
  { key: 'software.uninstall', label: 'Remove software', kind: 'winget.uninstall', needs: 'software', disruptive: true,
    consequence: 'The software is REMOVED from each machine, silently and without asking the person using it. Anything it was mid-way through is lost.' },
];

export function actionDef(key: string): ActionDef | null {
  return ACTIONS.find((a) => a.key === key) || null;
}

// ── Windows Update on/off ───────────────────────────────────────────────────────
// Terry's call (2026-09-01) was to stop and disable the service. On its own that does not
// hold: Windows Update Medic Service (WaaSMedicSvc) exists to put wuauserv back, it is
// protected, and on current builds the service returns within hours. So the OFF action
// does BOTH - the service stop he asked for, and the AU policy key underneath it, which is
// what actually survives the night. ON reverses both, or the machine would look enabled
// while the policy still held it shut.
//
// Deliberately NOT touched: WaaSMedicSvc and UsoSvc. Disabling those needs registry
// surgery on protected services, breaks Windows' own repair path, and is the sort of thing
// that leaves a machine unable to patch months later with nobody remembering why.

const WU_OFF_SCRIPT = `$ErrorActionPreference = 'Stop'
$report = @()
try {
  Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
  Set-Service  -Name wuauserv -StartupType Disabled
  $report += 'wuauserv stopped and disabled'
} catch { $report += "service: $($_.Exception.Message)" }
try {
  $au = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'
  if (-not (Test-Path $au)) { New-Item -Path $au -Force | Out-Null }
  New-ItemProperty -Path $au -Name NoAutoUpdate -Value 1 -PropertyType DWord -Force | Out-Null
  $report += 'NoAutoUpdate policy set'
} catch { $report += "policy: $($_.Exception.Message)" }
$svc = Get-Service -Name wuauserv -ErrorAction SilentlyContinue
$report += "wuauserv is now: $($svc.Status) / $((Get-CimInstance Win32_Service -Filter "Name='wuauserv'").StartMode)"
$report -join "\`n"`;

const WU_ON_SCRIPT = `$ErrorActionPreference = 'Stop'
$report = @()
try {
  $au = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'
  if (Test-Path $au) {
    Remove-ItemProperty -Path $au -Name NoAutoUpdate -ErrorAction SilentlyContinue
    $report += 'NoAutoUpdate policy removed'
  } else { $report += 'no AU policy key was present' }
} catch { $report += "policy: $($_.Exception.Message)" }
try {
  Set-Service   -Name wuauserv -StartupType Manual
  Start-Service -Name wuauserv -ErrorAction SilentlyContinue
  $report += 'wuauserv set to Manual and started'
} catch { $report += "service: $($_.Exception.Message)" }
$svc = Get-Service -Name wuauserv -ErrorAction SilentlyContinue
$report += "wuauserv is now: $($svc.Status) / $((Get-CimInstance Win32_Service -Filter "Name='wuauserv'").StartMode)"
$report -join "\`n"`;

// Manual, not Automatic: Manual is the Windows default for wuauserv - the Update
// Orchestrator starts it when it needs it. Forcing Automatic would leave the machine in a
// state Windows never puts it in itself.

// ── Conditions ──────────────────────────────────────────────────────────────────

export type ConditionKey = 'next_contact' | 'datetime' | 'after_reboot' | 'window';

export const CONDITIONS: Array<{ key: ConditionKey; label: string; help: string }> = [
  { key: 'next_contact', label: 'Next contact', help: 'As soon as each machine next checks in. A machine that is off simply acts the moment it comes back.' },
  { key: 'datetime', label: 'Time and date', help: 'At a chosen moment. Machines that are off at the time act on their first check-in afterwards.' },
  { key: 'after_reboot', label: 'After next reboot', help: 'The first time each machine checks in having actually restarted since the task was created.' },
  { key: 'window', label: 'Start and finish', help: 'A window to act in. From the start, each machine acts the moment it next checks in. At the finish the task closes — a machine that never appeared is recorded as having missed the window, never actioned hours later.' },
];

export function isCondition(v: unknown): v is ConditionKey {
  return v === 'next_contact' || v === 'datetime' || v === 'after_reboot' || v === 'window';
}

export const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'fortnightly', 'monthly'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export function isRecurrence(v: unknown): v is Recurrence {
  return typeof v === 'string' && (RECURRENCES as readonly string[]).includes(v);
}

// ── Creating a task ─────────────────────────────────────────────────────────────

export interface TaskInput {
  name: string;
  action: string;
  condition: string;
  /** Epoch seconds. Required when condition = 'datetime', and the START when 'window'. */
  runAtEpoch?: number | null;
  /** Epoch seconds. The FINISH. Required when condition = 'window'. */
  runUntilEpoch?: number | null;
  recurrence?: string;
  /** 'YYYY-MM-DD' inclusive. Required when recurrence <> 'none'. */
  recurrenceEnd?: string | null;
  deviceIds: number[];
  scriptId?: number | null;
  packageId?: number | null;
  /** software_catalogue.id — what "Deploy / Update / Remove software" acts on. */
  catalogueId?: number | null;
  delaySeconds?: number | null;
}

export interface CreateResult { ok: boolean; error?: string; taskId?: number; occurrences?: number }

/** 'YYYY-MM-DD' and 'HH:MM' in Europe/London for an epoch — the wall clock a series keeps. */
function londonDayKey(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).reduce((a: any, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

function londonTimeParts(epochSecs: number): { hour: number; minute: number } {
  const s = new Date(epochSecs * 1000).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = s.split(':').map((n) => parseInt(n, 10));
  return { hour: h || 0, minute: m || 0 };
}

// An occurrence's real moment is rebuilt from its DAY plus the series' wall-clock time,
// never by adding 86400 to the last one — a 02:00 reboot must stay 02:00 across the BST
// switch, and adding days in seconds walks it to 01:00 or 03:00 for half the year.
//
// The conversion is done by POSTGRES, not JS. `new Date('2026-10-30T02:00:00')` is read in
// the server's own timezone, and this server runs UTC, so every winter occurrence would be
// an hour out. See [[portal-timestamp-timezone-trap]]. This SQL is the one place a day key
// and a wall-clock time become an instant.
const OCCURRENCE_AT = `(($1::date + $2::time) AT TIME ZONE 'Europe/London')`;

export async function createTask(inp: TaskInput, userId: number | null, userName?: string | null): Promise<CreateResult> {
  const def = actionDef(inp.action);
  if (!def) return { ok: false, error: 'Unknown action.' };
  if (!isCondition(inp.condition)) return { ok: false, error: 'Unknown condition.' };
  const name = String(inp.name || '').trim().slice(0, 200) || def.label;
  const devices = Array.from(new Set((inp.deviceIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)));
  if (!devices.length) return { ok: false, error: 'Pick at least one machine.' };
  if (devices.length > 500) return { ok: false, error: 'That is more than 500 machines in one task — split it.' };

  const recurrence: Recurrence = isRecurrence(inp.recurrence) ? inp.recurrence : 'none';
  // Repeating only makes sense against the clock. "Next contact, every week" has no second
  // moment to repeat at, and "after next reboot, every week" is a different machine event
  // each time — both would be a promise the scheduler cannot keep, so they are refused
  // rather than quietly accepted and silently run once.
  if (recurrence !== 'none' && inp.condition !== 'datetime') {
    return { ok: false, error: 'A repeating task needs a time and date — "next contact", "after next reboot" and "start and finish" happen once.' };
  }

  let runAt: Date | null = null;
  let runUntil: Date | null = null;
  if (inp.condition === 'datetime' || inp.condition === 'window') {
    const epoch = Math.round(Number(inp.runAtEpoch || 0));
    if (!epoch) return { ok: false, error: inp.condition === 'window' ? 'Pick the date and time the window starts.' : 'Pick the date and time it should run.' };
    const now = Math.floor(Date.now() / 1000);
    if (epoch <= now) return { ok: false, error: 'That time has already passed — pick a moment in the future.' };
    if (epoch > now + 365 * 86400) return { ok: false, error: 'That is more than a year away.' };
    runAt = new Date(epoch * 1000);
  }
  if (inp.condition === 'window') {
    // A window with no end is just "next contact" wearing a hat, and a backwards one would
    // close before it opened — both are refused rather than quietly straightened out.
    const endEpoch = Math.round(Number(inp.runUntilEpoch || 0));
    if (!endEpoch) return { ok: false, error: 'Pick the date and time the window finishes.' };
    const startEpoch = Math.round(Number(inp.runAtEpoch || 0));
    if (endEpoch <= startEpoch) return { ok: false, error: 'The finish has to be after the start.' };
    if (endEpoch - startEpoch < 300) return { ok: false, error: 'That window is under five minutes — machines check in on their own schedule and would never make it.' };
    if (endEpoch - startEpoch > 31 * 86400) return { ok: false, error: 'That window is longer than a month. Use "next contact" if you simply want it to happen whenever each machine appears.' };
    runUntil = new Date(endEpoch * 1000);
  }
  if (recurrence !== 'none' && !inp.recurrenceEnd) return { ok: false, error: 'A repeating task needs a date to repeat until.' };

  // Resolve the payload NOW, from ids, server-side. A package URL or a script body must
  // never come off the browser: that is the difference between deploying our software and
  // pointing 200 machines at whatever a crafted request asked for.
  let payload: Record<string, any> = {};
  let kind = def.kind;
  if (def.needs === 'script') {
    const s = await getScript(Number(inp.scriptId || 0));
    if (!s) return { ok: false, error: 'Pick a script.' };
    if (s.osType !== 'windows') return { ok: false, error: 'Only Windows scripts can be sent to the agent today.' };
    if (String(s.body || '').length > 8000) {
      return { ok: false, error: `"${s.name}" is ${String(s.body).length} characters and the agent accepts 8,000. Shorten it, or have it fetch its own payload.` };
    }
    kind = s.fileType === 'bat' || s.fileType === 'cmd' ? 'shell.cmd' : 'shell.powershell';
    payload = { script: s.body, run_as: s.runAs === 'current_user' ? 'user' : 'system', script_id: s.id, script_name: s.name };
  } else if (def.needs === 'software') {
    // The catalogue decides BOTH what is deployable and how it installs — a WinGet id, a
    // Chocolatey id, or one of our own MSIs — so the action's nominal `kind` is replaced by
    // whatever that entry actually needs. dispatchFor() re-checks the never-deploy list; a
    // row edited straight into the database must still never reach a machine.
    const item = await getCatalogueItem(Number(inp.catalogueId || 0));
    if (!item) return { ok: false, error: 'Pick some software from the catalogue.' };
    const verb = def.key === 'software.upgrade' ? 'upgrade' : def.key === 'software.uninstall' ? 'uninstall' : 'install';
    const d = await dispatchFor(item, verb);
    if (!d.ok || !d.dispatch) return { ok: false, error: d.error || 'That software cannot be deployed from here.' };
    kind = d.dispatch.kind;
    payload = d.dispatch.payload;
  } else if (def.key === 'wu.off' || def.key === 'wu.on') {
    payload = { script: def.key === 'wu.off' ? WU_OFF_SCRIPT : WU_ON_SCRIPT, run_as: 'system', wu: def.key };
  } else {
    // Power. The warning the person at the machine gets before it acts.
    const delay = Math.max(0, Math.min(3600, Math.round(Number(inp.delaySeconds ?? 60)) || 0));
    payload = { delay_seconds: String(delay), requested_by: userName || 'Lumen IT' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const days = recurrence === 'none' || !runAt
      ? [null]
      : occurrenceDays(londonDayKey(Math.floor(runAt.getTime() / 1000)), recurrence, String(inp.recurrenceEnd));
    const hm = runAt ? londonTimeParts(Math.floor(runAt.getTime() / 1000)) : { hour: 0, minute: 0 };

    const timeText = `${String(hm.hour).padStart(2, '0')}:${String(hm.minute).padStart(2, '0')}`;
    let firstId = 0;
    let made = 0;
    for (const day of days) {
      // A series whose earliest occurrences are already past is not worth refusing the
      // whole task over — skip the ones that have gone and make the rest.
      // Two shapes on purpose. A one-off already knows its instant; an occurrence is a day
      // plus a wall-clock time and only Postgres may turn that into an instant. Written as
      // separate statements rather than one with a spare parameter, because an unreferenced
      // $n has no inferable type and Postgres refuses to parse it.
      const t = day === null
        ? await client.query(
          `INSERT INTO automation_tasks (name, action, payload, condition, run_at, run_until, recurrence, recurrence_end, series_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [name, def.key, JSON.stringify({ ...payload, kind }), inp.condition, runAt, runUntil,
            recurrence, recurrence === 'none' ? null : inp.recurrenceEnd, firstId || null, userId])
        : await client.query(
          `INSERT INTO automation_tasks (name, action, payload, condition, run_at, run_until, recurrence, recurrence_end, series_id, created_by)
           SELECT $3::text,$4::text,$5::jsonb,$6::text,${OCCURRENCE_AT},NULL::timestamptz,$7::text,$8::text,$9::int,$10::int
            WHERE ${OCCURRENCE_AT} > NOW() RETURNING id`,
          [day, timeText, name, def.key, JSON.stringify({ ...payload, kind }), inp.condition,
            recurrence, recurrence === 'none' ? null : inp.recurrenceEnd, firstId || null, userId]);
      if (!t.rows.length) continue;   // occurrence already in the past
      const id = t.rows[0].id;
      if (!firstId) {
        firstId = id;
        await client.query('UPDATE automation_tasks SET series_id=$1 WHERE id=$1', [id]);
      }
      // One row per machine, up front. The task screen reports per machine from these, so a
      // task is never "partly done" with no way to see which half.
      for (const d of devices) {
        await client.query(
          `INSERT INTO automation_task_devices (task_id, device_id) VALUES ($1,$2)
           ON CONFLICT (task_id, device_id) DO NOTHING`, [id, d]);
      }
      made++;
    }
    if (!made) { await client.query('ROLLBACK'); return { ok: false, error: 'Every occurrence of that series is already in the past.' }; }
    await client.query('COMMIT');

    await logActivity(userId, 'automation_task', 'automation_tasks', firstId,
      `Scheduled "${name}" (${def.label}) on ${devices.length} machine${devices.length === 1 ? '' : 's'}` +
      (recurrence === 'none' ? '' : `, repeating ${recurrence} until ${inp.recurrenceEnd}`));

    // Nothing to wait for on these two — arm the first occurrence straight away.
    if (inp.condition !== 'datetime' && inp.condition !== 'window') await armTask(firstId).catch(() => {});
    return { ok: true, taskId: firstId, occurrences: made };
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[automation] create failed:', e.message);
    return { ok: false, error: 'Could not schedule that.' };
  } finally {
    client.release();
  }
}

// ── Arming ──────────────────────────────────────────────────────────────────────

/**
 * Turn a task into real agent commands. Idempotent: a device row that already carries a
 * command id is left alone, so a sweep that runs twice cannot restart a machine twice.
 */
export async function armTask(taskId: number): Promise<{ queued: number; skipped: number }> {
  const t = (await pool.query('SELECT * FROM automation_tasks WHERE id=$1', [taskId])).rows[0];
  if (!t || t.status === 'cancelled' || t.status === 'done') return { queued: 0, skipped: 0 };

  const payload = (t.payload || {}) as Record<string, any>;
  const kind = String(payload.kind || actionDef(t.action)?.kind || 'shell.powershell');
  const { kind: _drop, ...cmdPayload } = payload;

  const rows = (await pool.query(
    `SELECT atd.id, atd.device_id, ad.hostname, ad.revoked
       FROM automation_task_devices atd
       LEFT JOIN agent_devices ad ON ad.id = atd.device_id
      WHERE atd.task_id=$1 AND atd.command_id IS NULL AND atd.status='pending'`, [taskId])).rows;

  let queued = 0, skipped = 0;
  for (const r of rows) {
    if (!r.hostname || r.revoked) {
      await pool.query(`UPDATE automation_task_devices SET status='skipped', error=$2, finished_at=NOW() WHERE id=$1`,
        [r.id, r.revoked ? 'That machine has been revoked.' : 'That machine is no longer known to the Portal.']);
      skipped++;
      continue;
    }
    try {
      const ins = await pool.query(
        `INSERT INTO agent_commands (device_id, kind, payload, requested_by, run_after_boot)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [r.device_id, kind, JSON.stringify(cmdPayload), t.created_by,
          t.condition === 'after_reboot' ? new Date() : null]);
      await pool.query(`UPDATE automation_task_devices SET command_id=$2, status='queued' WHERE id=$1`, [r.id, ins.rows[0].id]);
      // No point ringing the bell for a command the poll will not hand over yet.
      if (t.condition !== 'after_reboot') wakeAgent(r.device_id);
      queued++;
    } catch (e: any) {
      await pool.query(`UPDATE automation_task_devices SET status='failed', error=$2, finished_at=NOW() WHERE id=$1`,
        [r.id, String(e.message || 'Could not queue that.').slice(0, 400)]);
      skipped++;
    }
  }
  await pool.query(
    `UPDATE automation_tasks SET status='armed', armed_at=COALESCE(armed_at, NOW()), updated_at=NOW() WHERE id=$1`, [taskId]);
  return { queued, skipped };
}

/** Stop a task. Anything already handed to a machine is past recalling and says so. */
export async function cancelTask(taskId: number, userId: number | null, wholeSeries = false): Promise<{ cancelled: number; alreadyRunning: number }> {
  const t = (await pool.query('SELECT id, name, series_id FROM automation_tasks WHERE id=$1', [taskId])).rows[0];
  if (!t) return { cancelled: 0, alreadyRunning: 0 };
  const ids = wholeSeries && t.series_id
    ? (await pool.query(`SELECT id FROM automation_tasks WHERE series_id=$1 AND status IN ('scheduled','armed')`, [t.series_id])).rows.map((r: any) => r.id)
    : [taskId];
  if (!ids.length) return { cancelled: 0, alreadyRunning: 0 };

  // Commands not yet collected can simply be dropped. One already running is out of our
  // hands - the machine is doing it - and the screen must say so rather than imply a stop.
  const del = await pool.query(
    `UPDATE agent_commands SET status='expired', finished_at=NOW()
      WHERE status='queued' AND id IN (SELECT command_id FROM automation_task_devices WHERE task_id = ANY($1::int[]) AND command_id IS NOT NULL)
      RETURNING id`, [ids]);
  const running = (await pool.query(
    `SELECT COUNT(*)::int n FROM agent_commands
      WHERE status='running' AND id IN (SELECT command_id FROM automation_task_devices WHERE task_id = ANY($1::int[]) AND command_id IS NOT NULL)`,
    [ids])).rows[0].n;

  await pool.query(
    `UPDATE automation_task_devices SET status='skipped', error='Cancelled', finished_at=NOW()
      WHERE task_id = ANY($1::int[]) AND status IN ('pending','queued')`, [ids]);
  await pool.query(
    `UPDATE automation_tasks SET status='cancelled', cancelled_at=NOW(), updated_at=NOW() WHERE id = ANY($1::int[])`, [ids]);
  await logActivity(userId, 'automation_cancel', 'automation_tasks', taskId,
    `Cancelled "${t.name}"${wholeSeries ? ' and the rest of its series' : ''} — ${del.rowCount} command(s) withdrawn` +
    (running ? `, ${running} already running and could not be stopped` : ''));
  return { cancelled: ids.length, alreadyRunning: running };
}

/**
 * Close windows whose finish has passed.
 *
 * This is what makes "start and finish" mean anything. Arming a window queues a command for
 * every machine, and a queued command sits waiting however long it takes — so without this
 * a window would be "next contact" with a later start, and a machine that came back on
 * Monday would be rebooted on Monday. The finish has to WITHDRAW what was never collected.
 *
 * A command already running is out of our hands, exactly as in cancelTask. It is left to
 * finish and reported honestly rather than pretended away.
 */
export async function expireWindows(): Promise<number> {
  const due = (await pool.query(
    `SELECT id, name FROM automation_tasks
      WHERE condition='window' AND status IN ('scheduled','armed')
        AND run_until IS NOT NULL AND run_until <= NOW()
      LIMIT 200`)).rows;
  if (!due.length) return 0;

  for (const t of due) {
    const withdrawn = await pool.query(
      `UPDATE agent_commands SET status='expired', finished_at=NOW()
        WHERE status='queued'
          AND id IN (SELECT command_id FROM automation_task_devices WHERE task_id=$1 AND command_id IS NOT NULL)
        RETURNING id`, [t.id]);
    // The wording matters on the screen: these machines were not skipped by choice and did
    // not fail, they simply never checked in while the window was open.
    const missed = await pool.query(
      `UPDATE automation_task_devices
          SET status='skipped', error='Never checked in before the window closed', finished_at=NOW()
        WHERE task_id=$1 AND status IN ('pending','queued') RETURNING id`, [t.id]);
    await pool.query(
      `UPDATE automation_tasks SET status='done', finished_at=NOW(), updated_at=NOW() WHERE id=$1`, [t.id]);
    if (missed.rowCount) {
      console.log(`[automation] window closed on task ${t.id} "${t.name}" — ${missed.rowCount} machine(s) missed it, ${withdrawn.rowCount} command(s) withdrawn`);
    }
    await logActivity(null, 'automation_window_closed', 'automation_tasks', t.id,
      `The window on "${t.name}" closed — ${missed.rowCount ?? 0} machine(s) never checked in and were not actioned`).catch(() => {});
  }
  return due.length;
}

// ── The sweep ───────────────────────────────────────────────────────────────────

/** Copy each command's outcome back onto its device row, and finish tasks that are done. */
export async function reconcileTasks(): Promise<void> {
  await pool.query(
    `UPDATE automation_task_devices atd
        SET status = CASE ac.status WHEN 'done' THEN 'done' WHEN 'failed' THEN 'failed'
                                    WHEN 'expired' THEN 'skipped' WHEN 'running' THEN 'running'
                                    ELSE atd.status END,
            error = CASE WHEN ac.status IN ('failed','expired')
                         THEN left(COALESCE(ac.output, 'The agent did not complete it.'), 400) ELSE atd.error END,
            finished_at = CASE WHEN ac.status IN ('done','failed','expired') THEN COALESCE(ac.finished_at, NOW()) ELSE atd.finished_at END
       FROM agent_commands ac
      WHERE ac.id = atd.command_id
        AND atd.status IN ('queued','running')
        AND ac.status IN ('running','done','failed','expired')`);

  // A task is finished when no machine is still waiting on it. Said in one statement so a
  // task can never sit "armed" for ever because the last machine's row was missed.
  await pool.query(
    `UPDATE automation_tasks t SET status='done', finished_at=NOW(), updated_at=NOW()
      WHERE t.status='armed'
        AND NOT EXISTS (SELECT 1 FROM automation_task_devices d
                         WHERE d.task_id=t.id AND d.status IN ('pending','queued','running'))`);
}

/**
 * Every minute: arm anything whose moment has come, then reconcile what is out there.
 *
 * 'next_contact' and 'after_reboot' tasks are armed at creation, so this is only chasing
 * the clock — plus any task whose arming failed while the Portal was restarting, which is
 * why it re-reads 'scheduled' rows rather than trusting that creation armed them.
 */
export function startAutomationSweep(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const due = (await pool.query(
        `SELECT id FROM automation_tasks
          WHERE status='scheduled'
            AND (condition NOT IN ('datetime','window') OR (run_at IS NOT NULL AND run_at <= NOW()))
          ORDER BY run_at NULLS FIRST LIMIT 50`)).rows;
      for (const d of due) {
        const r = await armTask(d.id);
        if (r.queued || r.skipped) console.log(`[automation] task ${d.id} armed — ${r.queued} queued, ${r.skipped} skipped`);
      }
      // Reconcile FIRST so work that did complete is recorded as done, then close any
      // window whose finish has passed — otherwise a machine that acted in the last minute
      // of the window could be written off as having missed it.
      await reconcileTasks();
      await expireWindows();
    } catch (e) { console.error('[automation] sweep failed:', (e as Error).message); }
  });
  console.log('[automation] sweep started — checking every minute');
}
