import crypto from 'crypto';
import { pool } from '../db/pool';
import { aiAskCached, parseJsonAnswer } from './ai-compose';
import type { ScriptRow } from './scripts';

/**
 * Review a script with Claude.
 *
 * These 48 scripts came off Atera with no history: some are years old, some were cloned and
 * half-edited, several have names like "remove setup" and descriptions that repeat the name.
 * Nobody knows which of them still run. This puts one careful reader over each of them.
 *
 * Two rules shape it:
 *
 * 1. **A review is pinned to the code it read.** `reviewedHash` is the md5 of the body at
 *    review time. Edit the script and the verdict is shown as STALE rather than standing as
 *    a pass mark on code that has since changed. A green tick against a script somebody
 *    rewrote afterwards is worse than no tick at all.
 *
 * 2. **It reports, it never edits.** The review writes findings; changing a script stays a
 *    human decision. Several of these touch AD, BitLocker and public desktops on live
 *    estates — that is not a place for an automatic fix.
 */

const SYSTEM = `You are a careful senior Windows systems engineer reviewing automation scripts for a UK managed service provider. The scripts run unattended on customer machines, usually as SYSTEM, through an RMM agent.

Judge the script as it stands. You are looking for, in order:
1. BROKEN — it cannot work as written: syntax errors, a variable used before it is set, a cmdlet or parameter that does not exist, an unreachable or wrong path, a mismatched brace or quote, a dead download URL pattern, logic that always takes one branch.
2. RISK — it works but could do harm unattended: deleting or overwriting without a check, no error handling around something destructive, assuming a path exists, no elevation check where one is needed, hard-coded credentials or tokens, changes with no way back.
3. IMPROVE — it works and is safe but could be better: no logging, no exit codes an RMM can read, repeated blocks, brittle string parsing, silent failure, no idempotency so a second run does damage or duplicates work.

Rules:
- Judge only what is in front of you. If a script depends on a file or URL you cannot see, say the dependency is unverified rather than calling it broken.
- Be concrete. "Line 42 removes C:\\ITDept before testing it exists" beats "could be more robust".
- An old script that still works is not a problem. Do not invent findings to look thorough — an empty findings list is a perfectly good answer.
- Never suggest weakening logging, error handling or a safety check.

Reply with JSON only:
{"verdict":"ok|warn|broken","headline":"one line, max 90 chars","summary":"2-4 sentences in plain English for someone deciding whether to keep this script","findings":[{"severity":"broken|risk|improve","line":<number or null>,"note":"what is wrong and what to do about it"}]}

verdict: "broken" if anything is severity broken; "warn" if any risk; otherwise "ok".`;

export interface ReviewFinding { severity: 'broken' | 'risk' | 'improve'; line: number | null; note: string; }
export interface ReviewResult {
  verdict: 'ok' | 'warn' | 'broken';
  headline: string;
  summary: string;
  findings: ReviewFinding[];
}

export const bodyHash = (body: string): string =>
  crypto.createHash('md5').update(body ?? '', 'utf8').digest('hex');

/** A review is stale once the script has been edited underneath it. */
export const reviewIsStale = (s: { body: string; reviewedHash?: string | null; reviewedAt?: Date | null }): boolean =>
  !!s.reviewedAt && s.reviewedHash !== bodyHash(s.body);

const MAX_BODY = 60000;

export async function reviewScript(script: ScriptRow): Promise<ReviewResult> {
  const body = script.body.length > MAX_BODY
    ? script.body.slice(0, MAX_BODY) + '\n\n[... truncated for review ...]'
    : script.body;

  // Numbered lines so a finding can point at one. The corpus is cached, so re-reviewing an
  // unchanged script is nearly free.
  const numbered = body.split(/\r\n|\r|\n/).map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
  const corpus = [
    `Script name: ${script.name}`,
    script.description ? `Description as recorded: ${script.description}` : 'No description recorded.',
    `File type: ${script.fileType}    Target OS: ${script.osType}    Runs as: ${script.runAs}`,
    script.arguments ? `Arguments: ${script.arguments}` : 'No arguments configured.',
    '',
    'SCRIPT (line numbers added for reference, they are not part of the file):',
    numbered,
  ].join('\n');

  const raw = await aiAskCached(SYSTEM, corpus, 'Review this script.', { maxTokens: 1800, strong: true });
  const parsed = parseJsonAnswer<ReviewResult>(raw.text, {
    verdict: 'warn', headline: 'Review could not be read back',
    summary: 'Claude answered, but not in the expected shape. Try again.', findings: [],
  });

  const findings: ReviewFinding[] = Array.isArray(parsed.findings) ? parsed.findings
    .filter(f => f && typeof f.note === 'string' && f.note.trim())
    .slice(0, 25)
    .map(f => ({
      severity: (['broken', 'risk', 'improve'] as const).includes(f.severity as any) ? f.severity : 'improve',
      line: Number.isFinite(Number(f.line)) && Number(f.line) > 0 ? Math.round(Number(f.line)) : null,
      note: String(f.note).slice(0, 1200),
    })) : [];

  // The verdict is DERIVED from the findings, not taken on trust — a model that lists a
  // broken finding and then calls the script fine would otherwise put a tick on a dud.
  const verdict: ReviewResult['verdict'] = findings.some(f => f.severity === 'broken') ? 'broken'
    : findings.some(f => f.severity === 'risk') ? 'warn'
    : (['ok', 'warn', 'broken'] as const).includes(parsed.verdict) ? parsed.verdict : 'ok';

  return {
    verdict,
    headline: String(parsed.headline || '').slice(0, 200) || (verdict === 'ok' ? 'No problems found' : 'See findings'),
    summary: String(parsed.summary || '').slice(0, 4000),
    findings,
  };
}

export async function saveReview(scriptId: number, body: string, r: ReviewResult): Promise<void> {
  await pool.query(
    `UPDATE scripts SET review_verdict=$1, review_headline=$2, review_summary=$3,
            review_findings=$4::jsonb, reviewed_at=NOW(), reviewed_hash=$5
      WHERE id=$6`,
    [r.verdict, r.headline, r.summary, JSON.stringify(r.findings), bodyHash(body), scriptId]);
}
