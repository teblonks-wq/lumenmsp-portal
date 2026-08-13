import { pool } from '../db/pool';
import { aiAskCached, parseJsonAnswer, stripTrailingJson, cacheNote, AskUsage } from './ai-compose';

// ── Group Policy ────────────────────────────────────────────────────────────────
// Read-only, on purpose. Reporting on what a domain's policies actually do is useful
// every day; writing them remotely from a web app is a way to break a customer's estate
// in one click, and Group Policy Management already exists for the writing.
//
// The value here is the two things GPMC is bad at: seeing the whole estate at once, and
// answering "what does this actually do" without reading 300 rows of registry policy.

export interface GpoRow {
  id: number; gpo_id: string; name: string; status: string | null; description: string | null;
  domain: string | null; created_on: string | null; modified_on: string | null;
  link_count: number; linked_enabled: number; enforced: boolean; setting_count: number;
  applies_to: string[] | null; links: any[] | null; settings: any[] | null;
  report_error: string | null; collected_at: Date;
}

/** Store a collection. Replaces the customer's set wholesale so a GPO deleted in the
 *  domain disappears here too. */
export async function ingestGpoInventory(commandId: number): Promise<{ ok: boolean; count?: number; error?: string }> {
  const cmd = (await pool.query(
    `SELECT ac.output, ad.customer_id FROM agent_commands ac
       JOIN agent_devices ad ON ad.id = ac.device_id
      WHERE ac.id=$1`, [commandId])).rows[0];
  if (!cmd || !cmd.customer_id) return { ok: false, error: 'unknown command' };

  let parsed: any;
  try {
    const raw = String(cmd.output || '');
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a < 0 || b <= a) return { ok: false, error: 'no JSON in the output' };
    parsed = JSON.parse(raw.slice(a, b + 1));
  } catch (e: any) { return { ok: false, error: 'could not parse: ' + e.message }; }

  const gpos: any[] = Array.isArray(parsed?.gpos) ? parsed.gpos : [];
  const domain = parsed?.domain ? String(parsed.domain).slice(0, 200) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seen: string[] = [];
    for (const g of gpos) {
      const gpoId = String(g?.id || '').trim();
      if (!gpoId) continue;
      seen.push(gpoId);
      const links: any[] = Array.isArray(g.links) ? g.links.filter(Boolean) : [];
      await client.query(
        `INSERT INTO customer_gpos (customer_id, gpo_id, name, status, description, domain, created_on, modified_on,
           link_count, linked_enabled, enforced, setting_count, applies_to, links, settings, report_error, collected_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,NOW(),NOW())
         ON CONFLICT (customer_id, gpo_id) DO UPDATE SET
           name=$3, status=$4, description=$5, domain=$6, created_on=$7, modified_on=$8,
           link_count=$9, linked_enabled=$10, enforced=$11, setting_count=$12,
           applies_to=$13::jsonb, links=$14::jsonb, settings=$15::jsonb, report_error=$16,
           collected_at=NOW(), updated_at=NOW()`,
        [cmd.customer_id, gpoId, String(g.name || '(unnamed)').slice(0, 300),
         g.status ? String(g.status).slice(0, 60) : null,
         g.description ? String(g.description).slice(0, 2000) : null,
         domain, g.created || null, g.modified || null,
         links.length, links.filter((l) => l?.enabled).length, links.some((l) => l?.enforced),
         Number(g.settingCount) || (Array.isArray(g.settings) ? g.settings.length : 0),
         JSON.stringify(Array.isArray(g.appliesTo) ? g.appliesTo : []),
         JSON.stringify(links), JSON.stringify(Array.isArray(g.settings) ? g.settings : []),
         g.reportError ? String(g.reportError).slice(0, 500) : null]);
    }
    // Anything the domain no longer has.
    if (seen.length) {
      await client.query('DELETE FROM customer_gpos WHERE customer_id=$1 AND NOT (gpo_id = ANY($2::text[]))', [cmd.customer_id, seen]);
    }
    await client.query('COMMIT');
    return { ok: true, count: seen.length };
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* gone */ }
    console.error('[gpo] ingest failed:', e.message);
    return { ok: false, error: e.message };
  } finally { client.release(); }
}

/**
 * Why a collection stored what it stored. A run that succeeds on the machine, returns
 * output, and files nothing is the worst kind of failure: every surface says "fine" and
 * the page just stays empty. This turns the stored output back into a sentence.
 */
export function explainInventoryOutcome(
  raw: string, storedCount: number, keptLimit: number,
): { ok: boolean; message: string | null } {
  const text = String(raw || '');
  if (storedCount > 0) return { ok: true, message: null };

  if (!text.trim()) {
    return { ok: false, message: 'The agent returned nothing at all. Check the command output on the machine.' };
  }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) {
    return { ok: false, message: 'The agent replied, but not with the expected data: ' + text.trim().slice(-300) };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(a, b + 1));
  } catch (e: any) {
    // The failure that actually happened: a large domain reported more than we kept, so
    // the JSON was cut mid-structure and nothing could be read out of it.
    if (text.length >= keptLimit) {
      return { ok: false, message:
        `The reply was larger than the ${keptLimit.toLocaleString('en-GB')} characters the Portal keeps, so it was cut off and could not be read. ` +
        'Collect again now the limit has been raised.' };
    }
    return { ok: false, message: 'The reply could not be read as data (' + (e.message || 'parse failed') + ').' };
  }
  const gpos = Array.isArray(parsed?.gpos) ? parsed.gpos : null;
  if (gpos === null) {
    return { ok: false, message: 'The reply parsed but contained no policy list. ' +
      (parsed?.error ? 'It said: ' + String(parsed.error).slice(0, 300) : '') };
  }
  if (!gpos.length) {
    return { ok: false, message: 'The domain reported no Group Policy Objects at all. ' +
      'That is almost never true of a live domain - check the agent is running on a domain controller with the Group Policy tools.' };
  }
  return { ok: false, message:
    `The agent reported ${gpos.length} policies but none were saved, so the Portal failed to file them. Check the server log for "[gpo] ingest failed".` };
}

export interface GpoFinding { level: 'bad' | 'warn'; gpoId: string; gpoName: string; title: string; detail?: string }

/**
 * The things worth flagging without being asked. Deliberately small and mechanical -
 * anything that needs judgement is what the Claude button is for.
 */
export function judgeGpos(rows: GpoRow[]): GpoFinding[] {
  const out: GpoFinding[] = [];
  for (const g of rows) {
    const base = { gpoId: g.gpo_id, gpoName: g.name };
    if (g.link_count === 0) {
      out.push({ ...base, level: 'warn', title: 'Not linked anywhere',
        detail: 'It applies to nothing. Either it is a leftover, or somebody unlinked it and expected it to still work.' });
    } else if (g.linked_enabled === 0) {
      out.push({ ...base, level: 'warn', title: 'Every link is disabled',
        detail: 'The policy exists and is linked, but no link is switched on, so it does nothing.' });
    }
    if (String(g.status || '') === 'AllSettingsDisabled') {
      out.push({ ...base, level: 'warn', title: 'All settings disabled', detail: 'The GPO is switched off at the object level.' });
    }
    if (g.setting_count === 0 && !g.report_error) {
      out.push({ ...base, level: 'warn', title: 'No settings in it', detail: 'An empty policy still costs a little time at every logon.' });
    }
    if (g.report_error) {
      out.push({ ...base, level: 'bad', title: 'Could not read its settings', detail: g.report_error });
    }
    const applies = Array.isArray(g.applies_to) ? g.applies_to : [];
    if (applies.length && !applies.some((a) => /authenticated users|domain computers|domain users|everyone/i.test(String(a)))) {
      out.push({ ...base, level: 'warn', title: 'Security filtered',
        detail: 'Applies only to ' + applies.join(', ') + ' — worth confirming that is still who should get it.' });
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}

/** One GPO rendered for reading. Stable between questions, so it caches. */
export function gpoCorpus(g: GpoRow): string {
  const lines: string[] = [];
  lines.push(`GROUP POLICY: ${g.name}`);
  lines.push(`Domain: ${g.domain || 'unknown'} | Status: ${g.status || 'unknown'} | Created: ${g.created_on || '?'} | Last modified: ${g.modified_on || '?'}`);
  if (g.description) lines.push(`Description: ${g.description}`);
  const links = Array.isArray(g.links) ? g.links : [];
  lines.push(`\nLINKED TO (${links.length}):`);
  if (!links.length) lines.push('  (not linked anywhere - this policy applies to nothing)');
  for (const l of links) {
    lines.push(`  ${l.target}${l.enabled ? '' : ' [LINK DISABLED]'}${l.enforced ? ' [ENFORCED]' : ''}`);
  }
  const applies = Array.isArray(g.applies_to) ? g.applies_to : [];
  lines.push(`\nAPPLIES TO: ${applies.length ? applies.join(', ') : 'not reported'}`);
  const settings = Array.isArray(g.settings) ? g.settings : [];
  lines.push(`\nSETTINGS (${g.setting_count} in total${settings.length < g.setting_count ? `, first ${settings.length} shown` : ''}):`);
  if (!settings.length) lines.push('  (none)');
  for (const s of settings) {
    lines.push(`  [${s.scope}/${s.area}] ${s.name} = ${s.state}${s.value ? ' (' + String(s.value).slice(0, 200) + ')' : ''}`);
  }
  return lines.join('\n');
}

/** Every GPO at once, for estate-wide questions ("which of these conflict?"). */
export function estateCorpus(rows: GpoRow[]): string {
  return rows.map((g) => gpoCorpus(g)).join('\n\n---\n\n');
}

const SYSTEM = [
  'You are a Windows infrastructure engineer at Lumen IT Solutions, a UK managed-service provider, explaining Group Policy to a colleague.',
  'You are given one or more GPOs: where they are linked, who they apply to, and their settings as collected from the domain.',
  '',
  'ANSWER THE QUESTION FIRST, in plain English. What a policy DOES matters more than what its settings are called.',
  '',
  'Rules:',
  '- Work only from the policy data given. Never invent a setting, a link or an OU. If the answer is not in the data, say so and say what you would need.',
  '- Registry policy names are jargon ("Turn off Windows Defender"). Translate them into what actually happens to a user or a machine.',
  '- Call out anything that WEAKENS security - disabled firewalls or Defender, legacy protocols, relaxed password or lockout policy, scripts running from a share, "Everyone" permissions. Be specific about what it exposes.',
  '- Say when a policy is doing nothing: not linked, links disabled, all settings disabled, or filtered to a group nobody is in.',
  '- Where the setting list was capped, note that your answer covers what was shown.',
  '- British English. Concise. No preamble.',
  '',
  'Reply with STRICT JSON only. No prose before or after it, no markdown fences:',
  '{"headline":"...","answer":"...","risks":[{"level":"bad|warn","title":"...","detail":"..."}]}',
  '',
  '- headline: one line, max ~15 words, saying what this policy does (or the answer to the question asked).',
  '- answer: 2-5 short paragraphs, \\n between them.',
  '- risks: 0-6 things worth acting on. Omit entirely if there is nothing real - do not pad.',
].join('\n');

export interface GpoAnswer {
  headline: string; answer: string;
  risks: { level: string; title: string; detail: string }[];
  cache: string | null; usage?: AskUsage;
}

export async function askGpo(corpus: string, question: string): Promise<GpoAnswer> {
  const { text, usage } = await aiAskCached(SYSTEM, corpus, `QUESTION: ${question}`, { maxTokens: 1800, strong: true });
  const p = parseJsonAnswer<any>(text, { answer: stripTrailingJson(text) });
  return {
    headline: String(p.headline || '').slice(0, 200),
    answer: String(p.answer || stripTrailingJson(text)).slice(0, 6000),
    risks: Array.isArray(p.risks) ? p.risks.slice(0, 6).map((r: any) => ({
      level: r?.level === 'bad' ? 'bad' : 'warn',
      title: String(r?.title || '').slice(0, 160),
      detail: String(r?.detail || '').slice(0, 400),
    })).filter((r: any) => r.title) : [],
    cache: cacheNote(usage), usage,
  };
}

// ── Deploying the agent by Group Policy ─────────────────────────────────────────
// The pre-flight. A deployment that fails because of AppLocker or an execution-policy
// GPO fails SILENTLY - the task runs, PowerShell is blocked, nothing installs, and the
// only symptom is machines that never appear. Reading the policies first is cheap and
// turns that into a sentence before anybody presses anything.

const PREFLIGHT_SYSTEM = [
  'You are a Windows infrastructure engineer at Lumen IT Solutions, a UK managed-service provider.',
  'You are given every Group Policy Object collected from one customer domain.',
  '',
  'A deployment is about to be made to that domain. It works like this:',
  '- a new GPO carries a Group Policy Preferences IMMEDIATE SCHEDULED TASK',
  '- the task runs as NT AUTHORITY\\System at the next policy refresh',
  '- it launches powershell.exe with -ExecutionPolicy Bypass -EncodedCommand',
  '- that script downloads an MSI over HTTPS from portal.lumenmsp.co.uk and runs msiexec /qn',
  '',
  'YOUR ONE JOB: say whether anything in these policies would stop that working, and be specific.',
  '',
  'Look hard for, and only report, things that actually bite this deployment:',
  '- AppLocker or Software Restriction Policies restricting scripts, MSIs or executables',
  '- Windows Defender Application Control / code integrity policy',
  '- PowerShell execution policy set by policy, PowerShell constrained language mode,',
  '  script block logging that breaks nothing but is worth knowing, PowerShell v2 removal',
  '- Attack Surface Reduction rules that block scripts, or block Office/script child processes',
  '- Windows Installer policy: "Disable Windows Installer", "Always install with elevated privileges",',
  '  "Prohibit User Installs", MSI restrictions of any kind',
  '- Proxy settings, WPAD, or firewall rules that would stop an outbound HTTPS fetch from SYSTEM',
  '  (SYSTEM does not use a per-user proxy - say so if the only proxy is per-user)',
  '- Anything disabling Group Policy Preferences, scheduled tasks, or the Task Scheduler service',
  '- Restrictions on Scheduled Task creation, or policy blocking tasks running as SYSTEM',
  '',
  'Rules:',
  '- Work ONLY from the policy data given. Never invent a setting. If the data does not cover',
  '  something (settings were capped, or a policy could not be read), say which and say so plainly.',
  '- A clear result is a real, useful answer. Do NOT invent a blocker to seem thorough.',
  '- For each blocker, say which GPO it is in and what to do about it.',
  '- British English. Concise. No preamble.',
  '',
  'Reply with STRICT JSON only. No prose before or after it, no markdown fences:',
  '{"verdict":"clear|caution|blocked","headline":"...","answer":"...","blockers":[{"level":"bad|warn","gpo":"...","title":"...","detail":"...","fix":"..."}]}',
  '',
  '- verdict: "blocked" only if something WILL stop it; "caution" if something might or the data is incomplete; "clear" if nothing found.',
  '- headline: one line, max ~15 words, the answer on its own.',
  '- answer: 1-4 short paragraphs, \\n between them.',
  '- blockers: omit entirely if there are none. Never pad.',
].join('\n');

export interface PreflightResult {
  verdict: 'clear' | 'caution' | 'blocked';
  headline: string;
  answer: string;
  blockers: { level: string; gpo: string; title: string; detail: string; fix: string }[];
  cache: string | null;
  usage?: AskUsage;
}

export async function preflightDeployment(rows: GpoRow[]): Promise<PreflightResult> {
  const corpus = estateCorpus(rows);
  const { text, usage } = await aiAskCached(
    PREFLIGHT_SYSTEM, corpus,
    'QUESTION: Would anything in these policies stop that deployment working? Answer for this domain specifically.',
    { maxTokens: 1800, strong: true });
  const p = parseJsonAnswer<any>(text, { answer: stripTrailingJson(text) });
  const v = String(p.verdict || '').toLowerCase();
  return {
    verdict: v === 'blocked' ? 'blocked' : v === 'clear' ? 'clear' : 'caution',
    headline: String(p.headline || '').slice(0, 200),
    answer: String(p.answer || stripTrailingJson(text)).slice(0, 6000),
    blockers: Array.isArray(p.blockers) ? p.blockers.slice(0, 8).map((b: any) => ({
      level: b?.level === 'bad' ? 'bad' : 'warn',
      gpo: String(b?.gpo || '').slice(0, 200),
      title: String(b?.title || '').slice(0, 160),
      detail: String(b?.detail || '').slice(0, 500),
      fix: String(b?.fix || '').slice(0, 400),
    })).filter((b: any) => b.title) : [],
    cache: cacheNote(usage), usage,
  };
}

/** What the agent reported back from its last gpo.deploy run, plan or real. */
export interface DeployRun {
  id: number; status: string; dryRun: boolean; at: Date | null; requestedAt: Date | null;
  ok: boolean; error: string | null; hostname: string | null;
  domain?: string; gpoName?: string; gpoId?: string; created?: boolean;
  linkedTo?: string; computers?: number; taskName?: string; exists?: boolean;
}

export async function lastDeployRun(customerId: number): Promise<DeployRun | null> {
  const r = (await pool.query(
    `SELECT ac.id, ac.status, ac.output, ac.payload, ac.finished_at, ac.requested_at, ad.hostname
       FROM agent_commands ac JOIN agent_devices ad ON ad.id = ac.device_id
      WHERE ad.customer_id=$1 AND ac.kind='gpo.deploy'
      ORDER BY ac.id DESC LIMIT 1`, [customerId])).rows[0];
  if (!r) return null;

  const base: DeployRun = {
    id: r.id, status: String(r.status || ''),
    dryRun: String(r.payload?.dryRun ?? '') === 'true',
    at: r.finished_at || null, requestedAt: r.requested_at || null,
    ok: false, error: null, hostname: r.hostname || null,
  };
  const raw = String(r.output || '');
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) {
    // Still running, or PowerShell fell over before it could say anything structured.
    if (r.status === 'queued' || r.status === 'running') return base;
    return { ...base, error: raw.trim().slice(-400) || 'The agent returned nothing.' };
  }
  try {
    const j = JSON.parse(raw.slice(a, b + 1));
    return { ...base, ok: j.ok === true, error: j.ok === true ? null : String(j.error || 'Unknown error.'),
      dryRun: j.dryRun === true, domain: j.domain, gpoName: j.gpoName, gpoId: j.gpoId,
      created: j.created, linkedTo: j.linkedTo, computers: Number(j.computers),
      taskName: j.taskName, exists: j.exists };
  } catch {
    return { ...base, error: raw.trim().slice(-400) };
  }
}
