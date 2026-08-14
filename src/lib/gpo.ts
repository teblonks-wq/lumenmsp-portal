import { pool } from '../db/pool';
import { aiAskCached, parseJsonAnswer, stripTrailingJson, cacheNote, AskUsage } from './ai-compose';

// ── Group Policy ────────────────────────────────────────────────────────────────
// Read-only, on purpose. Reporting on what a domain's policies actually do is useful
// every day; writing them remotely from a web app is a way to break a customer's estate
// in one click, and Group Policy Management already exists for the writing.
//
// The value here is the two things GPMC is bad at: seeing the whole estate at once, and
// answering "what does this actually do" without reading 300 rows of registry policy.

// ── The two policies nobody deletes ─────────────────────────────────────────────
// Their GUIDs are the same in every Active Directory domain on earth. Guarded here AND
// in the agent script, because a guard that lives in only one of the two is a guard that
// somebody routes around by accident. Until this existed they were safe only because they
// happen to be linked - which is not the same as being protected.
export const PROTECTED_GPOS: Record<string, string> = {
  '31b2f340-016d-11d2-945f-00c04fb984f9': 'Default Domain Policy',
  '6ac1786c-016f-11d2-945f-00c04fb984f9': 'Default Domain Controllers Policy',
};

export function protectedGpoName(gpoId: string): string | null {
  const bare = String(gpoId || '').replace(/[{}]/g, '').toLowerCase();
  return PROTECTED_GPOS[bare] || null;
}

export type DeleteVerdict = 'never' | 'no' | 'check' | 'safe';

export interface VerdictResult { verdict: DeleteVerdict; label: string; reason: string }

/** What the pre-delete script used to say, said in the Portal instead.
 *
 *  Ordered most-protective first on purpose: a policy that is both protected and linked
 *  reads as protected, and a policy whose settings could not be read is never "safe" -
 *  "we could not see inside it" and "there is nothing inside it" are different answers
 *  and only one of them belongs next to a Delete button. */
export function deleteVerdict(g: {
  gpo_id: string; link_count?: number; linked_enabled?: number;
  setting_count?: number; extension_count?: number; report_error?: string | null;
}): VerdictResult {
  const prot = protectedGpoName(g.gpo_id);
  if (prot) {
    return { verdict: 'never', label: 'Never delete',
      reason: `${prot} is built into the domain. Removing it breaks things that are hard to put back.` };
  }

  const enabledLinks = Number(g.linked_enabled) || 0;
  if (enabledLinks > 0) {
    return { verdict: 'no', label: 'Do not delete',
      reason: `Linked and switched on in ${enabledLinks} place${enabledLinks === 1 ? '' : 's'}. It is applying to machines right now.` };
  }

  const links = Number(g.link_count) || 0;
  if (links > 0) {
    return { verdict: 'check', label: 'Check first',
      reason: `Linked in ${links} place${links === 1 ? '' : 's'}, but every link is switched off. Somebody may be about to switch it back on.` };
  }

  if (g.report_error) {
    return { verdict: 'check', label: 'Check first',
      reason: 'Its settings could not be read, so there is no way to tell from here what would be lost.' };
  }

  // null and undefined are not zero. Coercing them would turn "nobody has collected this
  // yet" into "there is nothing in it", which is the one mistranslation this whole column
  // exists to prevent.
  const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v));

  const settings = num(g.setting_count);
  if (!Number.isFinite(settings)) {
    return { verdict: 'check', label: 'Check first',
      reason: 'The Portal does not know what is in this one. Collect again before removing it.' };
  }
  if (settings > 0) {
    return { verdict: 'check', label: 'Check first',
      reason: `Linked nowhere, but it holds ${settings} setting${settings === 1 ? '' : 's'}. Deleting it throws away work somebody did.` };
  }

  // Nothing reads as empty until the Portal can prove it looked. A missing or negative
  // extension count means "we do not know", and "we do not know" must never render as
  // Safe to delete - that is the same mistake that flagged a working Preferences policy
  // as empty next to a Delete button.
  const exts = num(g.extension_count);
  if (!Number.isFinite(exts) || exts < 0) {
    return { verdict: 'check', label: 'Check first',
      reason: 'The Portal cannot tell whether this is genuinely empty or simply could not be read. Collect again to be sure.' };
  }
  if (exts > 0) {
    return { verdict: 'check', label: 'Check first',
      reason: 'It carries settings the collector could not interpret. This is not an empty policy.' };
  }

  return { verdict: 'safe', label: 'Safe to delete',
    reason: 'Linked nowhere and holds no settings. Nothing depends on it.' };
}

export interface GpoRow {
  id: number; gpo_id: string; name: string; status: string | null; description: string | null;
  domain: string | null; created_on: string | null; modified_on: string | null;
  link_count: number; linked_enabled: number; enforced: boolean; setting_count: number;
  extension_count: number;
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
    const { text } = jsonFromOutput(String(cmd.output || ''));
    if (!text) return { ok: false, error: 'no JSON in the output' };
    parsed = JSON.parse(text);
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
           link_count, linked_enabled, enforced, setting_count, extension_count, applies_to, links, settings, report_error, collected_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17,NOW(),NOW())
         ON CONFLICT (customer_id, gpo_id) DO UPDATE SET
           name=$3, status=$4, description=$5, domain=$6, created_on=$7, modified_on=$8,
           link_count=$9, linked_enabled=$10, enforced=$11, setting_count=$12, extension_count=$13,
           applies_to=$14::jsonb, links=$15::jsonb, settings=$16::jsonb, report_error=$17,
           collected_at=NOW(), updated_at=NOW()`,
        [cmd.customer_id, gpoId, String(g.name || '(unnamed)').slice(0, 300),
         g.status ? String(g.status).slice(0, 60) : null,
         g.description ? String(g.description).slice(0, 2000) : null,
         domain, g.created || null, g.modified || null,
         links.length, links.filter((l) => l?.enabled).length, links.some((l) => l?.enforced),
         Number(g.settingCount) || (Array.isArray(g.settings) ? g.settings.length : 0),
         // An older agent does not report this. -1 says "unknown", which the judge treats
         // as "do not claim it is empty" rather than as zero.
         g.extensionCount === undefined || g.extensionCount === null ? -1 : Number(g.extensionCount),
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
 * Pull the JSON out of a command's raw output.
 *
 * PowerShell writes compressed JSON as a single enormous line, and when its host wraps
 * that line at the console width it inserts real CR/LF *inside* the text. Most land
 * between tokens, where JSON treats them as whitespace and nothing looks wrong - until
 * one lands inside a string literal and the whole 25,000-character reply is rejected for
 * a "bad control character". Compressed JSON never contains a legitimate raw control
 * character inside a string, so stripping them is a repair, not a guess.
 */
export function jsonFromOutput(raw: string): { text: string | null; repaired: boolean } {
  const s = String(raw || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return { text: null, repaired: false };
  const span = s.slice(a, b + 1);
  // eslint-disable-next-line no-control-regex
  const cleaned = span.replace(/[\u0000-\u001F]/g, '');
  return { text: cleaned, repaired: cleaned.length !== span.length };
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
  const { text: json } = jsonFromOutput(text);
  if (!json) {
    return { ok: false, message: 'The agent replied, but not with the expected data: ' + text.trim().slice(-300) };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
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
      // The distinction that matters: genuinely empty, versus we could not read it. The
      // first is safe to tidy up; the second is a policy doing real work that we failed to
      // parse, and calling THAT "empty" next to a Delete button is how you lose a domain.
      const ext = Number(g.extension_count);
      if (ext === 0) {
        out.push({ ...base, level: 'warn', title: 'No settings in it',
          detail: 'The report contained no settings at all. An empty policy still costs a little time at every logon.' });
      } else {
        out.push({ ...base, level: 'warn', title: 'Settings could not be read',
          detail: ext > 0
            ? `It carries ${ext} block${ext === 1 ? '' : 's'} of settings the Portal could not interpret, so this policy is NOT empty. Open it in Group Policy Management before touching it.`
            : 'Collected by an older agent that could not read this policy\'s settings. Collect again to find out what is in it - do not assume it is empty.' });
      }
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
  siteKey?: string;   // agent 1.0.22+: the enrolment key the deployment carries — proof it cannot orphan
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
      taskName: j.taskName, exists: j.exists, siteKey: j.siteKey ? String(j.siteKey) : undefined };
  } catch {
    return { ...base, error: raw.trim().slice(-400) };
  }
}

// ── Reviewing one policy ────────────────────────────────────────────────────────
// The estate-wide "Ask Claude" answers questions. This is the other half: a verdict on a
// single policy, stored against it, saying whether it will actually do what somebody
// intended - including the boring failures that cost the most time, like a typo in a path
// or a setting quietly cancelled out by another one in the same object.

const REVIEW_SYSTEM = [
  'You are a senior Windows infrastructure engineer at Lumen IT Solutions, a UK managed-service provider,',
  'reviewing ONE Group Policy Object for a colleague who has to decide whether to keep, fix or bin it.',
  '',
  'Judge it on whether it does what somebody clearly INTENDED, and say so bluntly.',
  '',
  'Look for, in rough order of how often they bite:',
  '- Settings that cannot work as written: a UNC path or drive letter that looks wrong or misspelled,',
  '  a server name that does not match the domain, a script path that will not resolve for a client,',
  '  a value outside the range the setting accepts.',
  '- TYPOS anywhere they matter - policy names, descriptions, paths, group names, script arguments.',
  '  Quote the exact text and give the exact correction.',
  '- Settings that contradict each other inside this policy, or cancel each other out.',
  '- A policy that will never apply: not linked, links disabled, all settings disabled,',
  '  or filtered to a group that would not contain the intended targets.',
  '- Anything that WEAKENS security: firewall or Defender off, SMBv1, LM/NTLMv1, relaxed password or',
  '  lockout policy, scripts run from a writable share, "Everyone" permissions, disabled UAC.',
  '- Deprecated or removed settings that modern Windows ignores, so the policy is doing nothing',
  '  even though it looks configured.',
  '',
  'Rules:',
  '- Work ONLY from the data given. Never invent a setting or a link. If the setting list was capped,',
  '  say your review covers what was shown.',
  '- Be specific. "Check the path" is useless; "\\\\lvg-fs01\\redirect looks like a typo for \\\\lvg-fs1\\redirect" is not.',
  '- Every finding gets a concrete fix. If there is nothing wrong, say so and return no findings -',
  '  a clean verdict is a real answer and padding it destroys trust in the ones that matter.',
  '- British English. No preamble.',
  '',
  'Reply with STRICT JSON only. No prose before or after it, no markdown fences:',
  '{"verdict":"good|watch|broken","summary":"...","findings":[{"level":"bad|warn","title":"...","detail":"...","fix":"..."}]}',
  '',
  '- verdict: "broken" if it will not do what was intended; "watch" if it works but something needs attention;',
  '  "good" if it is sound.',
  '- summary: one or two sentences, plain English, what this policy does and whether it is doing it.',
  '- findings: 0-8. Omit entirely when there are none.',
].join('\n');

export interface PolicyReview {
  verdict: 'good' | 'watch' | 'broken';
  summary: string;
  findings: { level: string; title: string; detail: string; fix: string }[];
  cache: string | null;
}

/** A cheap stable hash of what the verdict was formed on, so it can be invalidated when
 *  the policy actually changes rather than on every collection. */
export function policyFingerprint(g: GpoRow): string {
  const basis = JSON.stringify([g.name, g.status, g.link_count, g.linked_enabled, g.enforced,
    g.setting_count, g.applies_to, g.links, g.settings]);
  let h = 0;
  for (let i = 0; i < basis.length; i++) { h = ((h << 5) - h + basis.charCodeAt(i)) | 0; }
  return String(h >>> 0) + '-' + basis.length;
}

export async function reviewPolicy(g: GpoRow): Promise<PolicyReview> {
  const { text, usage } = await aiAskCached(
    REVIEW_SYSTEM, gpoCorpus(g),
    'QUESTION: Review this policy. Will it do what was intended, and what needs correcting?',
    { maxTokens: 1600, strong: true });
  const p = parseJsonAnswer<any>(text, { summary: stripTrailingJson(text) });
  const v = String(p.verdict || '').toLowerCase();
  return {
    verdict: v === 'broken' ? 'broken' : v === 'good' ? 'good' : 'watch',
    summary: String(p.summary || stripTrailingJson(text)).slice(0, 1200),
    findings: Array.isArray(p.findings) ? p.findings.slice(0, 8).map((f: any) => ({
      level: f?.level === 'bad' ? 'bad' : 'warn',
      title: String(f?.title || '').slice(0, 160),
      detail: String(f?.detail || '').slice(0, 600),
      fix: String(f?.fix || '').slice(0, 400),
    })).filter((f: any) => f.title) : [],
    cache: cacheNote(usage),
  };
}

/** Review one policy and remember the verdict against it. */
export async function reviewAndStore(id: number): Promise<PolicyReview & { id: number }> {
  const g = (await pool.query(`SELECT * FROM customer_gpos WHERE id=$1`, [id])).rows[0];
  if (!g) throw new Error('No such policy.');
  const r = await reviewPolicy(g as GpoRow);
  await pool.query(
    `UPDATE customer_gpos
        SET ai_verdict=$1, ai_summary=$2, ai_findings=$3::jsonb, ai_at=NOW(), ai_fingerprint=$4, updated_at=NOW()
      WHERE id=$5`,
    [r.verdict, r.summary, JSON.stringify(r.findings), policyFingerprint(g as GpoRow), id]);
  return { ...r, id };
}

/** A gpo.delete came back. Write down what was removed and how to get it back BEFORE
 *  taking the row out - the deletion record is the only thing that makes this reversible
 *  from the Portal, and it has to outlive the policy it describes. */
export async function ingestGpoDelete(commandId: number): Promise<void> {
  const cmd = (await pool.query(
    `SELECT ac.output, ac.requested_by, ac.device_id, ad.customer_id, ad.hostname
       FROM agent_commands ac JOIN agent_devices ad ON ad.id = ac.device_id
      WHERE ac.id=$1`, [commandId])).rows[0];
  if (!cmd || !cmd.customer_id) return;

  const { text } = jsonFromOutput(String(cmd.output || ''));
  if (!text) return;
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return; }

  const results: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
  const gone = results.filter((r) => r?.deleted && r?.id);
  const backupPath = parsed?.backupPath ? String(parsed.backupPath).slice(0, 500) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of gone) {
      const gpoId = String(r.id);
      const snap = (await client.query(
        `SELECT * FROM customer_gpos WHERE customer_id=$1 AND gpo_id=$2`,
        [cmd.customer_id, gpoId])).rows[0] || null;

      await client.query(
        `INSERT INTO gpo_deletions (customer_id, device_id, command_id, gpo_id, name, domain, hostname,
           backup_id, backup_path, setting_count, link_snapshot, snapshot, deleted_by, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,NOW())`,
        [cmd.customer_id, cmd.device_id || null, commandId, gpoId,
         String(r.name || snap?.name || '(unnamed)').slice(0, 300),
         snap?.domain || null, cmd.hostname || null,
         r.backupId ? String(r.backupId).slice(0, 100) : null, backupPath,
         Number(snap?.setting_count) || 0,
         JSON.stringify(snap?.links || []), snap ? JSON.stringify(snap) : null,
         cmd.requested_by || null]);

      await client.query('DELETE FROM customer_gpos WHERE customer_id=$1 AND gpo_id=$2',
        [cmd.customer_id, gpoId]);
    }
    await client.query('COMMIT');
  } catch (e: any) {
    await client.query('ROLLBACK');
    // Deliberately loud and deliberately NOT swallowed into a half-done state: if the
    // record could not be written, the row stays, and the Portal disagreeing with the
    // domain for one collection cycle is far better than an untracked deletion.
    console.error('[gpo] could not record deletion, rolled back:', e.message);
    throw e;
  } finally {
    client.release();
  }

  const refused = results.filter((r) => !r?.deleted);
  for (const r of refused) {
    console.log(`[gpo] refused "${r.name || r.id}": ${r.error || 'no reason given'}`);
  }
  console.log(`[gpo] delete on ${cmd.hostname}: ${gone.length} removed and recorded, ${refused.length} refused, backups in ${backupPath || 'unknown'}`);
}

/** A gpo.restore came back. Mark the deletion as undone - the policy itself reappears at
 *  the next collection, which is queued by the route that asked for this. */
export async function ingestGpoRestore(commandId: number): Promise<void> {
  const cmd = (await pool.query(
    `SELECT ac.output, ac.payload, ac.requested_by, ac.device_id, ad.customer_id, ad.hostname
       FROM agent_commands ac JOIN agent_devices ad ON ad.id = ac.device_id
      WHERE ac.id=$1`, [commandId])).rows[0];
  if (!cmd || !cmd.customer_id) return;

  const { text } = jsonFromOutput(String(cmd.output || ''));
  if (!text) return;
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return; }
  if (!parsed?.ok || !parsed?.restored) {
    console.error(`[gpo] restore on ${cmd.hostname} failed: ${parsed?.error || 'no reason given'}`);
    return;
  }

  let payload: any = {};
  try { payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : (cmd.payload || {}); } catch { }
  const deletionId = parseInt(String(payload?.deletionId || ''), 10);
  if (!deletionId) return;

  await pool.query(
    `UPDATE gpo_deletions SET restored_at=NOW(), restored_by=$1 WHERE id=$2 AND customer_id=$3`,
    [cmd.requested_by || null, deletionId, cmd.customer_id]);

  // Collect straight away. Without this the tab keeps saying the policy is deleted until
  // somebody thinks to press Collect, which reads as "the restore did not work".
  try {
    const busy = (await pool.query(
      `SELECT 1 FROM agent_commands WHERE device_id=$1 AND kind='gpo.inventory'
        AND status IN ('queued','running') LIMIT 1`, [cmd.device_id])).rows.length > 0;
    if (!busy) {
      await pool.query(
        `INSERT INTO agent_commands (device_id, kind, payload, status, requested_by)
         VALUES ($1,'gpo.inventory','{}','queued',$2)`, [cmd.device_id, cmd.requested_by || null]);
    }
  } catch (e: any) { console.error('[gpo] could not queue a collection after restore:', e.message); }

  console.log(`[gpo] restored "${parsed.name}" on ${cmd.hostname} - it is back but NOT linked`);
}

/** Deletions for a customer, newest first.
 *
 *  Never throws. This hangs off the device page, and a device page that will not load
 *  because the deletion log is missing would be a worse bug than the one this table was
 *  added to fix - notably on the first deploy, between the schema landing and the table
 *  actually existing. */
export async function recentDeletions(customerId: number, limit = 25): Promise<any[]> {
  try {
    return await deletionRows(customerId, limit);
  } catch (e: any) {
    console.error('[gpo] could not read the deletion log:', e.message);
    return [];
  }
}

async function deletionRows(customerId: number, limit: number): Promise<any[]> {
  return (await pool.query(
    `SELECT d.id, d.gpo_id, d.name, d.hostname, d.backup_id, d.backup_path, d.setting_count,
            d.link_snapshot, d.deleted_at, d.restored_at,
            u.display_name AS deleted_by_name,
            EXTRACT(EPOCH FROM (NOW() - d.deleted_at))::bigint AS age_secs
       FROM gpo_deletions d
       LEFT JOIN users u ON u.id = d.deleted_by
      WHERE d.customer_id=$1
      ORDER BY d.deleted_at DESC
      LIMIT $2`, [customerId, limit])).rows;
}

/** A gpo.unlink came back. The links are gone in the domain, so they go here too - and
 *  the targets it removed are written to the log, because that list is the undo. */
export async function ingestGpoUnlink(commandId: number): Promise<void> {
  const cmd = (await pool.query(
    `SELECT ac.output, ad.customer_id, ad.hostname FROM agent_commands ac
       JOIN agent_devices ad ON ad.id = ac.device_id
      WHERE ac.id=$1`, [commandId])).rows[0];
  if (!cmd || !cmd.customer_id) return;

  const { text } = jsonFromOutput(String(cmd.output || ''));
  if (!text) return;
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return; }

  for (const r of (Array.isArray(parsed?.results) ? parsed.results : [])) {
    if (!r?.id || !Array.isArray(r.removed) || !r.removed.length) continue;
    await pool.query(
      `UPDATE customer_gpos
          SET links='[]'::jsonb, link_count=0, linked_enabled=0, enforced=false, updated_at=NOW()
        WHERE customer_id=$1 AND gpo_id=$2`, [cmd.customer_id, String(r.id)]);
    console.log(`[gpo] unlinked "${r.name}" from ${r.removed.join(', ')} - relink with New-GPLink if that was wrong`);
  }
}
