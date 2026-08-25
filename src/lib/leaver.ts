import cron from 'node-cron';
import { pool } from '../db/pool';
import { graphBlockTenantUser, graphRevokeTenantSessions } from './graph';
import { alertGroup } from './notifications';
import { logActivity } from './activity';

// ── Leavers ─────────────────────────────────────────────────────────────────────
//
// Terry's rule, and the whole shape of this: **the Portal owns the schedule, not AD.**
// A date typed into AD's account-expiry attribute is invisible, unauditable, and quietly
// does the wrong thing if a clock or a replication is off. Here, a leaver is a row with a
// time on it; a sweep cuts access at that time and writes down what actually happened.
//
// Two halves, in this order:
//   1. CUT ACCESS — disable the on-prem AD account (via our own agent on the customer's
//      AD agent) and block the Microsoft sign-in, then revoke live sessions so an open
//      session dies rather than running to expiry.
//   2. THEN raise ONE task for all support staff to work the rest of the procedure —
//      shared mailbox, licences, delegation, kit. Deliberately second: the part that has
//      to be instant is the part a person should never be waiting to do.
//
// Nothing here reports success it did not verify. The M365 block is read back from the
// directory; the AD disable is a queued command whose real result is read back later by
// `reconcileLeaverCommands`, and until it lands the plan says so.

export interface LeaverInput {
  customerId: number; contactId: number | null;
  displayName: string; upn: string | null; samAccountName: string | null;
  effectiveAt: Date;
  disableAd: boolean; blockM365: boolean; revokeSessions: boolean;
  notes: string | null; createdBy: number | null;
}

/** The steps a person still has to do. Order matters and the note says why. */
export const LEAVER_CHECKLIST: string[] = [
  'Convert the mailbox to a SHARED mailbox — do this BEFORE removing licences, or the mailbox goes with the licence.',
  'Give the manager (or whoever is named below) access to the shared mailbox.',
  'Remove the Microsoft licences once the mailbox is shared, so we stop paying for the seat.',
  'Set up mail forwarding or an auto-reply if the business wants one.',
  'Remove them from distribution lists, shared calendars and Teams.',
  'Move the AD account to the Disabled Users OU and strip its group memberships.',
  'Reclaim the laptop, phone, tokens and keys; wipe or reassign the device in the Portal.',
  'Change any shared or service passwords they knew, and remove their vault access.',
  'Cancel their phone extension / DDI and any third-party logins in their name.',
];

export async function scheduleLeaver(inp: LeaverInput): Promise<{ ok: boolean; id?: number; error?: string }> {
  if (!inp.displayName.trim()) return { ok: false, error: 'Who is leaving?' };
  if (!inp.upn && !inp.samAccountName) return { ok: false, error: 'Give at least one account — a Microsoft sign-in or an AD username. There is nothing to disable otherwise.' };
  if (inp.blockM365 && !inp.upn) return { ok: false, error: 'Blocking the Microsoft sign-in needs their user principal name.' };
  if (inp.disableAd && !inp.samAccountName) return { ok: false, error: 'Disabling the AD account needs their AD username (sAMAccountName).' };
  if (isNaN(inp.effectiveAt.getTime())) return { ok: false, error: 'Pick the date and time access should be cut.' };

  const r = await pool.query(
    `INSERT INTO leaver_plans (customer_id, contact_id, display_name, upn, sam_account_name, effective_at,
                               disable_ad, block_m365, revoke_sessions, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [inp.customerId, inp.contactId, inp.displayName.trim().slice(0, 160),
     inp.upn ? inp.upn.trim().toLowerCase().slice(0, 190) : null,
     inp.samAccountName ? inp.samAccountName.trim().slice(0, 120) : null,
     inp.effectiveAt, inp.disableAd, inp.blockM365, inp.revokeSessions,
     inp.notes ? inp.notes.slice(0, 4000) : null, inp.createdBy]);
  return { ok: true, id: Number(r.rows[0].id) };
}

/** The AD agent that can actually run a directory command for this customer. */
async function adAgentFor(customerId: number): Promise<{ id: number; hostname: string } | null> {
  const r = await pool.query(
    `SELECT id, hostname FROM agent_devices
      WHERE customer_id=$1 AND is_ad_agent=true AND revoked=false
      ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [customerId]);
  return r.rows[0] || null;
}

/**
 * Cut one leaver's access and raise the follow-up task. Never throws: a step that fails is
 * written into the log in plain words and the plan lands as `partial` or `failed`, so the
 * task tells a person exactly what still needs doing by hand.
 */
export async function runLeaver(id: number): Promise<{ status: string; log: string[] }> {
  const p = (await pool.query(
    `SELECT lp.*, c.name AS customer_name, c.entra_tenant_id
       FROM leaver_plans lp JOIN customers c ON c.id = lp.customer_id
      WHERE lp.id=$1`, [id])).rows[0];
  const log: string[] = [];
  if (!p) return { status: 'failed', log: ['That leaver plan no longer exists.'] };
  if (p.status !== 'scheduled') return { status: p.status, log: ['Already run.'] };

  // Claim it first, so a slow step cannot let the next sweep run the same leaver twice.
  const claim = await pool.query(
    `UPDATE leaver_plans SET status='running', ran_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status='scheduled' RETURNING id`, [id]);
  if (!claim.rowCount) return { status: 'running', log: ['Another sweep already has this one.'] };

  let failures = 0, attempted = 0;
  let adCommandId: number | null = null;

  // ── 1a. On-prem AD ────────────────────────────────────────────────────────────
  if (p.disable_ad && p.sam_account_name) {
    attempted++;
    const agent = await adAgentFor(Number(p.customer_id));
    if (!agent) {
      failures++;
      log.push(`AD: NOT disabled — ${p.customer_name} has no AD agent enrolled, so there is nothing to run the command on. Disable ${p.sam_account_name} by hand now.`);
    } else {
      try {
        const ins = await pool.query(
          `INSERT INTO agent_commands (device_id, kind, payload, requested_by) VALUES ($1,'ad.user.disable',$2,$3) RETURNING id`,
          [agent.id, JSON.stringify({ sam: String(p.sam_account_name) }), p.created_by]);
        adCommandId = Number(ins.rows[0].id);
        log.push(`AD: disable queued for ${p.sam_account_name} on ${agent.hostname} (command #${adCommandId}). Not confirmed until the agent reports back.`);
      } catch (e: any) {
        failures++;
        log.push(`AD: could not queue the disable — ${e.message}. Do ${p.sam_account_name} by hand.`);
      }
    }
  }

  // ── 1b. Microsoft 365 ─────────────────────────────────────────────────────────
  if (p.block_m365 && p.upn) {
    attempted++;
    if (!p.entra_tenant_id) {
      failures++;
      log.push(`Microsoft 365: NOT blocked — ${p.customer_name} has no Entra tenant id on their record, so we cannot reach their directory. Block ${p.upn} by hand now.`);
    } else {
      try {
        const r = await graphBlockTenantUser(String(p.entra_tenant_id), String(p.upn));
        if (r.blocked) {
          log.push(`Microsoft 365: sign-in blocked for ${p.upn} — confirmed against the directory.`);
        } else {
          failures++;
          log.push(`Microsoft 365: the change was accepted but the directory still shows ${p.upn} as ENABLED. Check it by hand.`);
        }
      } catch (e: any) {
        failures++;
        log.push(`Microsoft 365: NOT blocked — ${e.message} Block ${p.upn} by hand now.`);
      }
    }
  }

  if (p.revoke_sessions && p.upn && p.entra_tenant_id) {
    attempted++;
    try {
      await graphRevokeTenantSessions(String(p.entra_tenant_id), String(p.upn));
      log.push('Microsoft 365: live sessions revoked — any signed-in device is signed out.');
    } catch (e: any) {
      failures++;
      log.push(`Microsoft 365: sessions NOT revoked — ${e.message} They may stay signed in on a device until the token expires.`);
    }
  }

  const status = attempted === 0 ? 'failed' : failures === 0 ? 'done' : failures >= attempted ? 'failed' : 'partial';

  // ── 2. The task, raised AFTER access is cut ───────────────────────────────────
  const doneLine = status === 'done'
    ? 'Access has already been cut — the account is disabled and sign-in is blocked. Everything below is what remains.'
    : 'ACCESS WAS NOT FULLY CUT. Read the log below and finish the failed steps FIRST, before anything else.';
  const description = [
    `${p.display_name} — ${p.customer_name}`,
    p.upn ? `Microsoft sign-in: ${p.upn}` : null,
    p.sam_account_name ? `AD account: ${p.sam_account_name}` : null,
    '',
    doneLine,
    '',
    'What the Portal did:',
    ...log.map(l => '  · ' + l),
    '',
    'Leavers procedure — still to do:',
    ...LEAVER_CHECKLIST.map((c, i) => `  ${i + 1}. ${c}`),
    p.notes ? '\nNotes from whoever scheduled this:\n' + p.notes : null,
  ].filter(l => l !== null).join('\n');

  let taskId: number | null = null;
  try {
    const t = await pool.query(
      `INSERT INTO tasks (title, description, assigned_to_user_id, assignment_scope, created_by_user_id,
                          priority, status, due_date, related_customer_id, related_contact_id)
       VALUES ($1,$2,NULL,'company',$3,$4,'open',CURRENT_DATE,$5,$6) RETURNING id`,
      [`Leaver: ${p.display_name} (${p.customer_name})`, description, p.created_by || 1,
       status === 'done' ? 'high' : 'high', p.customer_id, p.contact_id]);
    taskId = Number(t.rows[0].id);
  } catch (e: any) {
    log.push(`The follow-up task could not be raised — ${e.message}. Raise it by hand.`);
  }

  await pool.query(
    `UPDATE leaver_plans SET status=$2, task_id=$3, ad_command_id=$4, result_log=$5, updated_at=NOW() WHERE id=$1`,
    [id, status, taskId, adCommandId, log.join('\n')]);

  // The contact is archived only when access really was cut — a half-run must not tidy
  // someone out of the lists while they can still sign in.
  if (status === 'done' && p.contact_id) {
    await pool.query('UPDATE customer_contacts SET archived=true WHERE id=$1', [p.contact_id]).catch(() => {});
  }

  await logActivity(p.created_by || null, 'leaver_run', 'leaver_plans', id,
    `Leaver ${p.display_name} (${p.customer_name}) — ${status}`);
  await alertGroup('support',
    status === 'done'
      ? `Leaver processed: ${p.display_name} (${p.customer_name})`
      : `Leaver NEEDS HANDS: ${p.display_name} (${p.customer_name})`,
    log.join(' · ').slice(0, 400),
    taskId ? '/tasks' : '/leavers').catch(() => {});

  return { status, log };
}

/**
 * Read back what the agent actually did with a queued AD disable. A plan that says "done"
 * on the strength of a queued command would be a lie the first time an agent is offline.
 */
export async function reconcileLeaverCommands(): Promise<void> {
  const rows = (await pool.query(
    `SELECT lp.id, lp.ad_command_id, lp.result_log, lp.status,
            ac.status AS cmd_status, ac.exit_code
       FROM leaver_plans lp JOIN agent_commands ac ON ac.id = lp.ad_command_id
      WHERE lp.ad_command_id IS NOT NULL AND lp.status IN ('done','partial')
        AND lp.result_log LIKE '%Not confirmed until the agent reports back.%'
        AND ac.status IN ('done','failed','expired')`)).rows;
  for (const r of rows) {
    // "The command finished" is not "the account is disabled" — a non-zero exit is a
    // failure however cheerfully the status reads (the same lesson as the Atera scripts).
    const exit = r.exit_code == null ? 0 : Number(r.exit_code);
    const good = String(r.cmd_status) === 'done' && exit === 0;
    const line = good
      ? 'AD: the agent confirmed the account is disabled.'
      : `AD: the agent did NOT disable the account (${r.cmd_status}${exit ? ', exit ' + exit : ''}). Do it by hand.`;
    const log = String(r.result_log || '').replace(/ Not confirmed until the agent reports back\./, ' — ' + line);
    await pool.query(
      `UPDATE leaver_plans SET result_log=$2, status=$3, updated_at=NOW() WHERE id=$1`,
      [r.id, log, good ? r.status : 'partial']);
    if (!good) {
      await alertGroup('support', 'Leaver: the AD disable did not run',
        `Leaver plan #${r.id} — the agent reported ${r.cmd_status}. Disable the account by hand.`, '/leavers').catch(() => {});
    }
  }
}

/** Every minute: cut access for anyone whose time has come. */
export function startLeaverSweep(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const due = (await pool.query(
        `SELECT id FROM leaver_plans WHERE status='scheduled' AND effective_at <= NOW() ORDER BY effective_at LIMIT 20`)).rows;
      for (const d of due) {
        const r = await runLeaver(Number(d.id));
        console.log(`[leaver] plan ${d.id} → ${r.status}`);
      }
      await reconcileLeaverCommands();
    } catch (e) { console.error('[leaver] sweep failed:', (e as Error).message); }
  });
  console.log('[leaver] sweep started — checking every minute');
}
