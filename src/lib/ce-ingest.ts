import { pool } from '../db/pool';
import { evaluate, score, EolRow, CeFinding } from './ce';

// ── Cyber Essentials: turning a returned command into findings ──────────────────
// The agent has no special upload path for this. It runs `ce.assess` like any other
// command and the JSON comes back in agent_commands.output, which means the whole
// queue/claim/retry story we already trust applies unchanged. This module is what
// happens the moment that output lands.
//
// Facts are stored alongside the findings. A rule added next month can then be re-run
// against last month's evidence without going back to the machine — which matters when
// the machine belongs to a customer who is mid-certification.

/** Machines that never answered. Commands stay queued for an offline machine, which is
 *  right for a software install and wrong for an assessment someone is waiting on. */
const STALE_MINUTES = 45;

async function loadEol(): Promise<EolRow[]> {
  const r = await pool.query(
    `SELECT id, category, vendor, name, match_type, match_value, version_max,
            eol_date, severity, action, replacement, guidance, ce_control
       FROM eol_products WHERE active = true`);
  return r.rows as EolRow[];
}

/** The device row plus the patch ages the rules need, computed in SQL because the app
 *  server runs Europe/London and Postgres stores UTC. */
async function loadDevice(deviceId: number) {
  const r = await pool.query(
    `SELECT ad.*, c.name AS customer_name,
            (SELECT MAX(EXTRACT(DAY FROM (NOW() - dp.first_seen)))::int
               FROM device_patches dp
              WHERE dp.device_id = ad.id
                AND LOWER(COALESCE(dp.severity,'')) IN ('critical','important')) AS oldest_critical_days
       FROM agent_devices ad
       LEFT JOIN customers c ON c.id = ad.customer_id
      WHERE ad.id = $1`, [deviceId]);
  return r.rows[0] || null;
}

/** PowerShell occasionally prefixes output with a warning line; take the JSON object. */
function parseFacts(output: string): any {
  const t = String(output || '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('no JSON in output');
  return JSON.parse(t.slice(i, j + 1));
}

export async function ingestCeResult(commandId: number): Promise<void> {
  const res = (await pool.query(
    `SELECT id, assessment_id, device_id FROM ce_device_results WHERE command_id = $1`, [commandId])).rows[0];
  if (!res) return; // a ce.assess run by hand from the device page — nothing to file it against

  const cmd = (await pool.query(
    `SELECT status, exit_code, output FROM agent_commands WHERE id = $1`, [commandId])).rows[0];
  if (!cmd) return;

  if (cmd.status !== 'done') {
    await pool.query(
      `UPDATE ce_device_results SET status='failed', error=$2, collected_at=NOW() WHERE id=$1`,
      [res.id, String(cmd.output || 'the assessment command failed').slice(0, 1000)]);
    await refreshAssessment(res.assessment_id);
    return;
  }

  try {
    const facts = parseFacts(cmd.output);
    const device = await loadDevice(res.device_id);
    const software = (await pool.query(
      `SELECT name, version, publisher FROM agent_software WHERE device_id = $1`, [res.device_id])).rows;
    const eol = await loadEol();

    const findings: CeFinding[] = evaluate(facts, { device, software, eol });
    const s = score(findings);
    const counts = {
      fail: findings.filter((x) => x.status === 'fail').length,
      warn: findings.filter((x) => x.status === 'warn').length,
      pass: findings.filter((x) => x.status === 'pass').length,
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-running a device inside the same assessment replaces its findings rather than
      // doubling them up.
      await client.query(`DELETE FROM ce_findings WHERE assessment_id=$1 AND device_id=$2`,
        [res.assessment_id, res.device_id]);
      for (const f of findings) {
        await client.query(
          `INSERT INTO ce_findings (assessment_id, device_id, control, rule, title, status, action, detail, remediation, evidence, eol_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [res.assessment_id, res.device_id, f.control, f.rule, f.title.slice(0, 300), f.status,
           f.action || null, f.detail || null, f.remediation || null,
           f.evidence ? String(f.evidence).slice(0, 2000) : null, f.eolDate || null]);
      }
      await client.query(
        `UPDATE ce_device_results
            SET status='complete', facts=$2, score=$3, fail_count=$4, warn_count=$5, pass_count=$6,
                error=NULL, collected_at=NOW()
          WHERE id=$1`,
        [res.id, facts, s, counts.fail, counts.warn, counts.pass]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) {
    await pool.query(
      `UPDATE ce_device_results SET status='failed', error=$2, collected_at=NOW() WHERE id=$1`,
      [res.id, `could not read the assessment output: ${e.message}`.slice(0, 1000)]);
  }

  await refreshAssessment(res.assessment_id);
}

/** Anything still queued long after the run started is not coming — the machine is off. */
export async function sweepStale(assessmentId: number): Promise<void> {
  await pool.query(
    `UPDATE ce_device_results
        SET status='offline', error='The machine did not report in — it was most likely powered off.'
      WHERE assessment_id=$1 AND status='queued'
        AND (SELECT started_at FROM ce_assessments WHERE id=$1) < NOW() - INTERVAL '${STALE_MINUTES} minutes'`,
    [assessmentId]);
  await refreshAssessment(assessmentId);
}

/** Roll the device rows up into the assessment header. */
export async function refreshAssessment(assessmentId: number): Promise<void> {
  const r = (await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status <> 'queued')::int AS done,
            COUNT(*) FILTER (WHERE status = 'complete')::int AS ok,
            COALESCE(SUM(fail_count),0)::int AS fails,
            COALESCE(SUM(warn_count),0)::int AS warns,
            COALESCE(SUM(pass_count),0)::int AS passes,
            AVG(score) FILTER (WHERE status='complete') AS avg_score
       FROM ce_device_results WHERE assessment_id=$1`, [assessmentId])).rows[0];

  const finished = r.total > 0 && r.done >= r.total;
  const status = !finished ? 'running' : r.ok === 0 ? 'failed' : r.ok < r.total ? 'partial' : 'complete';

  await pool.query(
    `UPDATE ce_assessments
        SET devices_total=$2, devices_done=$3, fail_count=$4, warn_count=$5, pass_count=$6,
            score=$7, status=$8, finished_at=CASE WHEN $9 THEN COALESCE(finished_at, NOW()) ELSE NULL END
      WHERE id=$1`,
    [assessmentId, r.total, r.done, r.fails, r.warns, r.passes,
     r.avg_score === null ? null : Math.round(Number(r.avg_score)), status, finished]);
}
