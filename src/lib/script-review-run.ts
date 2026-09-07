import { listScripts, ScriptRow } from './scripts';
import { reviewScript, saveReview, reviewIsStale } from './script-review';
import { logActivity } from './activity';
import { notify } from './notifications';

// ─────────────────────────────────────────────────────────────────────────────────
// The script review as a BACKGROUND RUN.
//
// Terry, 7 Sep 2026: "once pressed I want it to go through but the user not have to sit
// on the page — also it is only reviewing 13." Both had the same cause: the queue lived in
// the browser tab. Leave the page and it stopped; hit a Claude rate limit or overload
// mid-run and the failure was counted and skipped, never retried.
//
// Now the queue lives here, in the process. One run at a time (a second click while it is
// going just shows progress). Each verdict is saved as it lands, so a restart mid-run loses
// nothing — the next click simply picks up whatever is still unreviewed. A failed review
// is retried with a growing pause (that is what a 429 or an "overloaded" needs), and only
// after that is it recorded as failed, by name, so the page can say which ones.
// When the run ends, whoever started it gets an in-app notification with the tally.
//
// Terry, later the same day: "we have 1,100 scripts, it needs to check all of them." The shared
// library is IN the queue now (it was excluded when reviewing cost was guessed at four figures;
// on Sonnet at these script sizes the whole library is tens of pounds). PARALLEL reviews of 3 so
// 1,100 scripts is about an hour, not an afternoon — a rate limit is what the retry pause is for.
// ─────────────────────────────────────────────────────────────────────────────────

const PARALLEL = 3;

export interface ReviewRunState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  startedBy: number | null;
  total: number;
  done: number;        // reviewed successfully this run
  broken: number;
  warn: number;
  ok: number;
  failed: { id: number; name: string; error: string }[];
  current: { id: number; name: string; attempt: number }[];   // in flight right now (up to PARALLEL)
  stopRequested: boolean;
  lastError: string | null;
}

const state: ReviewRunState = {
  running: false, startedAt: null, finishedAt: null, startedBy: null,
  total: 0, done: 0, broken: 0, warn: 0, ok: 0, failed: [], current: [], stopRequested: false, lastError: null,
};

export function reviewRunState(): ReviewRunState {
  return { ...state, failed: state.failed.slice(), current: state.current.map((c) => ({ ...c })) };
}

/** Never reviewed, or edited since. The shared library (1,100+ community scripts) is included
 *  unless `library: false` — Terry wants every script checked, not just the 48 team ones. */
export async function reviewQueue(opts: { all?: boolean; library?: boolean } = {}): Promise<ScriptRow[]> {
  const scripts = (await listScripts()).filter((s) => opts.library !== false || s.source !== 'atera-shared');
  return opts.all ? scripts : scripts.filter((s) => !s.reviewedAt || reviewIsStale(s));
}

const RETRY_PAUSE_MS = [5_000, 20_000, 60_000];   // three more goes; a rate limit clears in this time
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Start a run. Returns false if one is already going (caller shows its progress instead). */
export function startReviewRun(userId: number, opts: { all?: boolean; library?: boolean } = {}): boolean {
  if (state.running) return false;
  Object.assign(state, {
    running: true, startedAt: new Date().toISOString(), finishedAt: null, startedBy: userId,
    total: 0, done: 0, broken: 0, warn: 0, ok: 0, failed: [], current: [], stopRequested: false, lastError: null,
  });
  void runQueue(userId, opts);
  return true;
}

export function stopReviewRun(): boolean {
  if (!state.running) return false;
  state.stopRequested = true;
  return true;
}

async function runQueue(userId: number, opts: { all?: boolean; library?: boolean }): Promise<void> {
  try {
    const due = await reviewQueue(opts);
    state.total = due.length;
    let next = 0;
    const setCurrent = (id: number, name: string, attempt: number) => {
      const i = state.current.findIndex((c) => c.id === id);
      if (i >= 0) state.current[i].attempt = attempt; else state.current.push({ id, name, attempt });
    };
    const clearCurrent = (id: number) => { state.current = state.current.filter((c) => c.id !== id); };

    // One script, with its retries. Never throws — the outcome lands in state either way.
    const reviewOne = async (script: ScriptRow): Promise<void> => {
      let lastErr = '';
      for (let attempt = 1; attempt <= RETRY_PAUSE_MS.length + 1; attempt++) {
        setCurrent(script.id, script.name, attempt);
        try {
          const result = await reviewScript(script);
          await saveReview(script.id, script.body, result);
          await logActivity(userId, 'script_review', 'scripts', script.id, `Reviewed ${script.name}: ${result.verdict}`).catch(() => {});
          state.done++;
          if (result.verdict === 'broken') state.broken++;
          else if (result.verdict === 'warn') state.warn++;
          else state.ok++;
          clearCurrent(script.id);
          return;
        } catch (e: any) {
          lastErr = e?.message || 'Review failed.';
          state.lastError = `${script.name}: ${lastErr}`;
          console.warn(`[script-review] ${script.name} attempt ${attempt} failed: ${lastErr}`);
          if (attempt <= RETRY_PAUSE_MS.length && !state.stopRequested) await sleep(RETRY_PAUSE_MS[attempt - 1]);
        }
      }
      clearCurrent(script.id);
      state.failed.push({ id: script.id, name: script.name, error: lastErr });
    };

    // PARALLEL workers sharing one cursor. Stop = finish what is in flight, start nothing new.
    const worker = async (): Promise<void> => {
      while (!state.stopRequested) {
        const i = next++;
        if (i >= due.length) return;
        await reviewOne(due[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, due.length) }, worker));
  } catch (e: any) {
    state.lastError = e?.message || 'Review run failed.';
    console.error('[script-review] run failed:', e);
  } finally {
    state.current = [];
    state.running = false;
    state.finishedAt = new Date().toISOString();
    const stopped = state.stopRequested;
    const left = state.total - state.done - state.failed.length;
    const tally = `${state.done} reviewed · ${state.broken} broken · ${state.warn} with a risk · ${state.ok} fine`
      + (state.failed.length ? ` · ${state.failed.length} could not be reviewed` : '')
      + (stopped && left > 0 ? ` · ${left} not started` : '');
    await logActivity(userId, 'script_review', 'scripts', null, `Script review ${stopped ? 'stopped' : 'finished'}: ${tally}`).catch(() => {});
    await notify(userId, stopped ? 'Script review stopped' : (state.failed.length ? 'Script review finished — some need another go' : 'Script review finished'), {
      body: tally + (state.failed.length ? `. Failed: ${state.failed.map((f) => f.name).slice(0, 5).join(', ')}${state.failed.length > 5 ? '…' : ''}` : ''),
      link: '/scripts', type: state.failed.length ? 'warning' : 'info',
    });
  }
}
