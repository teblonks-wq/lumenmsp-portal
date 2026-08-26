import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import {
  importSpec, listQuestionnaires, loadVersion, resultsFor, resultsCsv,
  inviteByToken, markOpened, recordAnswers, setPublishConsent, muteFeedbackForContact,
  feedbackRows, feedbackScores, approveForWebsite, withdrawFromWebsite, setActioned,
  publishedTestimonials,
  SpecError, AnswerError,
} from '../lib/questionnaires';
import { answerOptions, type SpecQuestion } from '../lib/questionnaire-spec';

const router = Router();

// ── Marketing → Questionnaires, Polls and Case Feedback ───────────────────────
// Everything lives under Marketing (Terry, 2026-08-26). Marketing is itself reached from
// the Admin page, so requireAdmin here matches the rest of that section.
//
// The PUBLIC half (/q/:token and the testimonials feed) is deliberately in the same file
// as the admin half: the guard on each route is then visible next to the route it guards,
// which is how the /unsubscribe pages sit inside marketing.ts.

const esc = (s: any): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

// ══ Public pages ══════════════════════════════════════════════════════════════
// Self-contained HTML, no session, no theme — these open in a customer's mail client
// preview pane as often as a browser. Same shape as the /unsubscribe pages.

function page(title: string, body: string, opts: { wide?: boolean } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex,nofollow">`
    + `<title>${esc(title)} — Lumen IT Solutions</title></head>`
    + `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9;margin:0;color:#0f172a;">`
    + `<div style="max-width:${opts.wide ? 640 : 520}px;margin:8vh auto;background:#fff;border-radius:16px;`
    + `padding:34px 32px;box-shadow:0 12px 30px rgba(2,6,23,.12);">${body}</div>`
    + `<p style="text-align:center;color:#94a3b8;font-size:13px;margin:0 0 40px;">Lumen IT Solutions</p>`
    + `</body></html>`;
}

const notFound = () => page('Link not recognised',
  `<h1 style="font-size:21px;margin:0 0 10px;">Link not recognised</h1>`
  + `<p style="color:#475569;font-size:15px;line-height:1.6;margin:0;">This link is not valid, or it has already been used. `
  + `If you meant to send us feedback, just reply to any of our emails and it will reach us.</p>`);

const closedPage = (title: string) => page('Closed',
  `<h1 style="font-size:21px;margin:0 0 10px;">${esc(title)} has closed</h1>`
  + `<p style="color:#475569;font-size:15px;line-height:1.6;margin:0;">Thanks for coming back to it — this one is no longer taking answers.</p>`);

// A crude per-IP limiter on the public write paths. The endpoint is unauthenticated by
// design (customer staff have no Portal login), so the token is the only credential and
// this stops someone walking the space or hammering one link.
const hits = new Map<string, { n: number; until: number }>();
function tooMany(req: Request): boolean {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || cur.until < now) { hits.set(ip, { n: 1, until: now + 60_000 }); return false; }
  cur.n++;
  if (hits.size > 5000) hits.clear();          // never let the map become the leak
  return cur.n > 40;
}

// ── The form ──────────────────────────────────────────────────────────────────

function fieldHtml(q: SpecQuestion, existing: any): string {
  const id = 'q_' + esc(q.key);
  const label = `<label for="${id}" style="display:block;font-weight:600;font-size:15px;margin:0 0 8px;">${esc(q.label)}`
    + (q.required ? ` <span style="color:#dc2626;">*</span>` : '') + `</label>`
    + (q.helpText ? `<p style="margin:-4px 0 10px;color:#64748b;font-size:13px;line-height:1.5;">${esc(q.helpText)}</p>` : '');

  if (q.type === 'heading') {
    return `<h2 style="font-size:16px;margin:26px 0 4px;padding-top:18px;border-top:1px solid #e2e8f0;color:#0f172a;">${esc(q.label)}</h2>`;
  }
  if (q.type === 'short_text') {
    return `<div style="margin:0 0 22px;">${label}<input id="${id}" name="${esc(q.key)}" maxlength="500" value="${esc(existing)}"
      style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px;"></div>`;
  }
  if (q.type === 'long_text') {
    return `<div style="margin:0 0 22px;">${label}<textarea id="${id}" name="${esc(q.key)}" rows="4" maxlength="5000"
      style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px;font-family:inherit;">${esc(existing)}</textarea></div>`;
  }

  const opts = answerOptions(q);
  const multi = q.type === 'multi';
  const chosen: string[] = Array.isArray(existing) ? existing.map(String) : (existing ? [String(existing)] : []);
  const scale = q.type === 'rating' || q.type === 'nps';

  const items = opts.map((o, i) => {
    const on = chosen.some((c) => c.toLowerCase() === o.value.toLowerCase() || c === o.label);
    return `<label style="display:${scale ? 'inline-block' : 'block'};margin:0 ${scale ? '8px' : '0'} 8px 0;padding:${scale ? '10px 14px' : '11px 13px'};
        border:1px solid ${on ? '#0ea5b7' : '#cbd5e1'};background:${on ? '#ecfeff' : '#fff'};border-radius:8px;cursor:pointer;font-size:15px;${scale ? 'min-width:34px;text-align:center;' : ''}">
      <input type="${multi ? 'checkbox' : 'radio'}" name="${esc(q.key)}" value="${esc(o.value)}"${on ? ' checked' : ''}
        style="margin-right:${scale ? '0' : '9px'};${scale ? 'position:absolute;opacity:0;' : ''}">${esc(o.label)}</label>`;
  }).join('');

  const ends = scale
    ? `<div style="color:#94a3b8;font-size:12px;margin:2px 0 0;overflow:hidden;">
        <span>${q.type === 'nps' ? 'Not at all likely' : 'Poor'}</span>
        <span style="float:right;">${q.type === 'nps' ? 'Extremely likely' : 'Excellent'}</span></div>` : '';

  const other = q.allowOther
    ? `<input name="${esc(q.key)}" placeholder="Something else…" maxlength="200"
        style="width:100%;box-sizing:border-box;margin:6px 0 0;padding:10px 12px;border:1px dashed #cbd5e1;border-radius:8px;font-size:15px;">` : '';

  return `<div style="margin:0 0 22px;">${label}<div>${items}</div>${ends}${other}</div>`;
}

function formPage(ctx: any, token: string, error?: string): string {
  const v = ctx.version;
  const prior: Record<string, any> = ctx.priorAnswers || {};
  const err = error
    ? `<p style="margin:0 0 18px;padding:11px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#b91c1c;font-size:14px;">${esc(error)}</p>`
    : '';
  const who = ctx.invite.full_name
    ? `<p style="margin:0 0 24px;color:#64748b;font-size:13px;line-height:1.5;">Answering as <strong>${esc(ctx.invite.full_name)}</strong>`
      + (ctx.invite.customer_name ? ` at ${esc(ctx.invite.customer_name)}` : '') + `. Your answers are linked to your name so we can follow them up.</p>`
    : '';
  return page(v.title,
    `<h1 style="font-size:23px;margin:0 0 ${v.intro ? '10' : '18'}px;">${esc(v.title)}</h1>`
    + (v.intro ? `<p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 18px;">${esc(v.intro)}</p>` : '')
    + who + err
    + `<form method="post" action="/q/${esc(token)}">`
    + v.questions.map((q: SpecQuestion) => fieldHtml(q, prior[q.key] ?? '')).join('')
    + `<button type="submit" style="background:#0ea5b7;color:#fff;border:0;font-weight:600;padding:12px 30px;border-radius:8px;font-size:15px;cursor:pointer;">Send my answers</button>`
    + `</form>`, { wide: true });
}

// The thank-you, plus the two things that can only be asked AFTER an answer exists:
// anything they want to add, and whether we may quote them on the website.
function thanksPage(ctx: any, token: string, saved = false): string {
  const v = ctx.version;
  const isFeedback = v.kind === 'case_feedback';
  const r = ctx.response || {};
  const commentQ = v.questions.find((q: SpecQuestion) => q.type === 'long_text');

  const done = saved
    ? `<p style="margin:0 0 4px;padding:11px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;color:#15803d;font-size:14px;">Saved — thank you.</p>` : '';

  let extra = '';
  if (commentQ && !String(r.comment || '').trim()) {
    extra = `<form method="post" action="/q/${esc(token)}/comment" style="margin:22px 0 0;">`
      + `<label style="display:block;font-weight:600;font-size:15px;margin:0 0 8px;">${esc(commentQ.label)}</label>`
      + `<textarea name="comment" rows="4" maxlength="5000" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px;font-family:inherit;"></textarea>`
      + (isFeedback
        ? `<label style="display:block;margin:14px 0 0;font-size:14px;color:#475569;line-height:1.5;">`
          + `<input type="checkbox" name="publish_consent" value="1" style="margin-right:8px;">`
          + `Happy for us to quote this on our website? We will never use your words without this tick, and you can ask us to take it down at any time.</label>`
        : '')
      + `<button type="submit" style="margin:16px 0 0;background:#0ea5b7;color:#fff;border:0;font-weight:600;padding:11px 26px;border-radius:8px;font-size:15px;cursor:pointer;">Send</button>`
      + `</form>`;
  } else if (isFeedback && String(r.comment || '').trim() && !r.publish_consent) {
    extra = `<form method="post" action="/q/${esc(token)}/comment" style="margin:22px 0 0;padding-top:18px;border-top:1px solid #e2e8f0;">`
      + `<input type="hidden" name="keep" value="1">`
      + `<label style="display:block;font-size:14px;color:#475569;line-height:1.5;">`
      + `<input type="checkbox" name="publish_consent" value="1" style="margin-right:8px;">`
      + `Happy for us to quote what you wrote on our website?</label>`
      + `<button type="submit" style="margin:14px 0 0;background:#fff;color:#0f172a;border:1px solid #cbd5e1;font-weight:600;padding:9px 20px;border-radius:8px;font-size:14px;cursor:pointer;">Save</button>`
      + `</form>`;
  }

  const mute = isFeedback && ctx.invite.contact_id
    ? `<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.5;">`
      + `We ask this once a case is closed, at most once a week. `
      + `<a href="/q/${esc(token)}/mute" style="color:#94a3b8;">Stop asking me for feedback</a>.</p>`
    : '';

  return page('Thank you',
    `<h1 style="font-size:23px;margin:0 0 10px;">Thank you</h1>`
    + `<p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 6px;">${esc(v.thankYou || 'Your answer is in — we appreciate it.')}</p>`
    + done + extra + mute, { wide: true });
}

// GET the questionnaire. A poll lands here too (from "answer on the web" links, or if
// somebody saves the message and comes back later).
router.get('/q/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  const ctx = await inviteByToken(token).catch(() => null);
  if (!ctx) { res.status(404).send(notFound()); return; }
  await markOpened(ctx.invite.id).catch(() => {});
  if (ctx.closed) { res.status(410).send(closedPage(ctx.version.title)); return; }
  if (ctx.response && ctx.response.completed_at) { res.send(thanksPage(ctx, token)); return; }

  // Re-fill anything already answered, so a part-finished form is not lost.
  const prior: Record<string, any> = {};
  if (ctx.response) {
    const a = await pool.query(
      `SELECT qq.key, a.value_text, a.value_json FROM questionnaire_answers a
         JOIN questionnaire_questions qq ON qq.id=a.question_id WHERE a.response_id=$1`, [ctx.response.id]);
    for (const row of a.rows as any[]) {
      prior[row.key] = row.value_json
        ? (typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json)
        : row.value_text;
    }
  }
  res.send(formPage({ ...ctx, priorAnswers: prior }, token));
});

// ── The one-click poll answer ─────────────────────────────────────────────────
// This GET records NOTHING. It renders a page that immediately posts the answer, with a
// visible button behind it for anyone without JavaScript. Mail scanners, link checkers and
// browser prefetch all follow links; none of them submit forms. Recording on the GET would
// hand us a wall of five-star ratings from Microsoft's security scanner.
router.get('/q/:token/a/:value', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  const value = String(req.params.value || '');
  const ctx = await inviteByToken(token).catch(() => null);
  if (!ctx) { res.status(404).send(notFound()); return; }
  await markOpened(ctx.invite.id).catch(() => {});
  if (ctx.closed) { res.status(410).send(closedPage(ctx.version.title)); return; }

  const q = ctx.version.questions.find((x: SpecQuestion) => x.type !== 'heading');
  const label = answerOptions(q!).find((o) => o.value.toLowerCase() === value.toLowerCase())?.label || value;

  res.send(page('Recording your answer',
    `<h1 style="font-size:22px;margin:0 0 10px;">Thanks — one moment</h1>`
    + `<p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">Saving your answer: <strong>${esc(label)}</strong>.</p>`
    + `<form id="f" method="post" action="/q/${esc(token)}/a/${encodeURIComponent(value)}">`
    + `<button type="submit" style="background:#0ea5b7;color:#fff;border:0;font-weight:600;padding:12px 28px;border-radius:8px;font-size:15px;cursor:pointer;">Confirm</button>`
    + `</form>`
    + `<script>document.getElementById('f').submit();</script>`));
});

router.post('/q/:token/a/:value', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  if (tooMany(req)) { res.status(429).send(page('Too many attempts', '<p style="margin:0;color:#475569;">Please try again in a minute.</p>')); return; }
  const ctx = await inviteByToken(token).catch(() => null);
  if (!ctx) { res.status(404).send(notFound()); return; }
  const q = ctx.version.questions.find((x: SpecQuestion) => x.type !== 'heading');
  if (!q) { res.status(404).send(notFound()); return; }
  try {
    await recordAnswers(token, { [q.key]: String(req.params.value || '') });
  } catch (e: any) {
    if (!(e instanceof AnswerError)) throw e;
    res.status(400).send(page('That did not save',
      `<h1 style="font-size:21px;margin:0 0 10px;">That did not save</h1>`
      + `<p style="color:#475569;font-size:15px;line-height:1.6;margin:0;">${esc(e.message)}</p>`));
    return;
  }
  const after = await inviteByToken(token);
  res.send(thanksPage(after, token));
});

// Full-form submit.
router.post('/q/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  if (tooMany(req)) { res.status(429).send(page('Too many attempts', '<p style="margin:0;color:#475569;">Please try again in a minute.</p>')); return; }
  const ctx = await inviteByToken(token).catch(() => null);
  if (!ctx) { res.status(404).send(notFound()); return; }
  try {
    await recordAnswers(token, req.body || {});
  } catch (e: any) {
    if (!(e instanceof AnswerError)) throw e;
    res.status(400).send(formPage({ ...ctx, priorAnswers: req.body || {} }, token, e.message));
    return;
  }
  const after = await inviteByToken(token);
  res.send(thanksPage(after, token, true));
});

// The comment (and, for case feedback, the publish tick) collected after the rating.
router.post('/q/:token/comment', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  if (tooMany(req)) { res.status(429).send(page('Too many attempts', '<p style="margin:0;color:#475569;">Please try again in a minute.</p>')); return; }
  const ctx = await inviteByToken(token).catch(() => null);
  if (!ctx) { res.status(404).send(notFound()); return; }
  const commentQ = ctx.version.questions.find((q: SpecQuestion) => q.type === 'long_text');
  const text = String(req.body?.comment || '').trim();
  try {
    if (commentQ && text && !req.body?.keep) await recordAnswers(token, { [commentQ.key]: text });
  } catch (e: any) { if (!(e instanceof AnswerError)) throw e; }
  const after = await inviteByToken(token);
  if (after?.response) await setPublishConsent(after.response.id, req.body?.publish_consent === '1');
  res.send(thanksPage(await inviteByToken(token), token, true));
});

// "Stop asking me." Its own flag: muting feedback must not mute marketing, and unsubscribing
// from marketing must not silence a customer's view of our support.
router.get('/q/:token/mute', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  const ctx = await inviteByToken(token).catch(() => null);
  if (!ctx || !ctx.invite.contact_id) { res.status(404).send(notFound()); return; }
  res.send(page('Stop feedback requests',
    `<h1 style="font-size:21px;margin:0 0 10px;">Stop feedback requests?</h1>`
    + `<p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 18px;">We will stop asking how your cases went. `
    + `Your support emails and any newsletters are unaffected.</p>`
    + `<form method="post" action="/q/${esc(token)}/mute">`
    + `<button type="submit" style="background:#0ea5b7;color:#fff;border:0;font-weight:600;padding:11px 26px;border-radius:8px;font-size:15px;cursor:pointer;">Stop asking me</button></form>`));
});

router.post('/q/:token/mute', async (req: Request, res: Response) => {
  const ctx = await inviteByToken(String(req.params.token || '')).catch(() => null);
  if (!ctx || !ctx.invite.contact_id) { res.status(404).send(notFound()); return; }
  await muteFeedbackForContact(ctx.invite.contact_id);
  res.send(page('Done',
    `<h1 style="font-size:21px;margin:0 0 10px;">Done</h1>`
    + `<p style="color:#475569;font-size:15px;line-height:1.6;margin:0;">We will not ask you for case feedback again. `
    + `Support emails about your cases are unaffected.</p>`));
});

// ── The website testimonial feed ──────────────────────────────────────────────
// Public and read-only. www.lumenmsp.co.uk is a STATIC Astro build, so it fetches this at
// BUILD time and bakes the quotes in — nothing here is hit by a visitor, and a Portal
// outage cannot blank the website. Both gates are in the query, not in the caller.
router.get('/api/public/testimonials', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '24'), 10) || 24, 1), 100);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ok: true, testimonials: await publishedTestimonials(limit) });
  } catch (e: any) { res.status(500).json({ ok: false, error: 'unavailable', testimonials: [] }); }
});

// ══ Marketing → Questionnaires (staff) ════════════════════════════════════════

router.get('/marketing/questionnaires', requireAdmin, async (req: Request, res: Response) => {
  let items: any[] = [];
  try { items = await listQuestionnaires(); } catch { /* tables arrive with the first prisma db push */ }
  res.render('marketing/questionnaires', { user: req.session.user!, items, notice: req.query.msg || null });
});

router.get('/marketing/questionnaires/import', requireAdmin, async (req: Request, res: Response) => {
  res.render('marketing/questionnaire-import', { user: req.session.user!, error: null, json: '' });
});

router.post('/marketing/questionnaires/import', requireAdmin, async (req: Request, res: Response) => {
  const json = String(req.body?.json || '');
  try {
    const r = await importSpec(json, req.session.user!.id);
    const what = r.isNew ? 'imported' : `imported as version ${r.version}`;
    res.redirect(`/marketing/questionnaires/${r.questionnaireId}?msg=`
      + encodeURIComponent(`"${r.title}" ${what} — ${r.questionCount} question${r.questionCount === 1 ? '' : 's'}`));
  } catch (e: any) {
    // A spec error is a message for the person pasting it, not a stack trace.
    const msg = e instanceof SpecError ? e.message : (e.message || 'Import failed');
    res.status(400).render('marketing/questionnaire-import', { user: req.session.user!, error: msg, json });
  }
});

router.get('/marketing/questionnaires/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const q = (await pool.query('SELECT * FROM questionnaires WHERE id=$1', [id])).rows[0];
  if (!q) { res.status(404).render('error', { message: 'Questionnaire not found.' }); return; }
  const versions = (await pool.query(
    'SELECT id, version, mode, published_at, closes_at FROM questionnaire_versions WHERE questionnaire_id=$1 ORDER BY version DESC', [id])).rows;
  const versionId = parseInt(String(req.query.version || ''), 10) || q.current_version_id;
  const results = versionId ? await resultsFor(versionId) : null;
  res.render('marketing/questionnaire-detail', {
    user: req.session.user!, q, versions, results, versionId,
    notice: req.query.msg || null,
  });
});

// Hand the original JSON back out unchanged, so a questionnaire can be edited off-portal
// and re-imported as the next version.
router.get('/marketing/questionnaires/:id/spec.json', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const versionId = parseInt(String(req.query.version || ''), 10)
    || (await pool.query('SELECT current_version_id AS v FROM questionnaires WHERE id=$1', [id])).rows[0]?.v;
  const v = versionId ? await loadVersion(versionId) : null;
  if (!v) { res.status(404).json({ error: 'not found' }); return; }
  res.setHeader('Content-Disposition', `attachment; filename="${v.key}-v${v.version}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(v.spec, null, 2));
});

router.get('/marketing/questionnaires/:id/results.csv', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const versionId = parseInt(String(req.query.version || ''), 10)
    || (await pool.query('SELECT current_version_id AS v FROM questionnaires WHERE id=$1', [id])).rows[0]?.v;
  if (!versionId) { res.status(404).send('not found'); return; }
  const v = await loadVersion(versionId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${v?.key || 'questionnaire'}-responses.csv"`);
  res.send(await resultsCsv(versionId));
});

// ══ Marketing → Case Feedback ═════════════════════════════════════════════════

const feedbackFilters = (req: Request) => ({
  rating: parseInt(String(req.query.rating || ''), 10) || null,
  customerId: parseInt(String(req.query.customer || ''), 10) || null,
  engineerId: parseInt(String(req.query.engineer || ''), 10) || null,
  from: String(req.query.from || '').trim() || null,
  to: String(req.query.to || '').trim() || null,
  hasComment: req.query.comment === '1',
  consented: req.query.consent === '1',
  unactioned: req.query.unactioned === '1',
  publishState: String(req.query.publish || '').trim() || null,
});

router.get('/marketing/case-feedback', requireAdmin, async (req: Request, res: Response) => {
  const f = feedbackFilters(req);
  let rows: any[] = [], scores: any = { byEngineer: [], byCustomer: [] }, engineers: any[] = [];
  try {
    rows = await feedbackRows(f);
    scores = await feedbackScores(f.from, f.to);
    engineers = (await pool.query(
      `SELECT id, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND hidden_from_lookups=false ORDER BY display_name`)).rows;
  } catch { /* tables arrive with the first prisma db push */ }
  res.render('marketing/case-feedback', {
    user: req.session.user!, rows, scores, engineers, f, q: req.query,
    notice: req.query.msg || null,
  });
});

router.get('/marketing/case-feedback.csv', requireAdmin, async (req: Request, res: Response) => {
  const rows = await feedbackRows(feedbackFilters(req));
  const cell = (s: any) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const head = ['Date', 'Rating', 'Comment', 'Customer', 'Contact', 'Case', 'Subject', 'Engineer', 'Consent', 'Publish state', 'Actioned'];
  const lines = [head.map(cell).join(',')];
  for (const r of rows) {
    lines.push([
      r.submitted_at ? new Date(r.submitted_at).toISOString().slice(0, 16).replace('T', ' ') : '',
      r.rating ?? '', r.comment || '', r.customer_name || '', r.full_name || '',
      r.ticket_number || '', r.subject || '', r.engineer || '',
      r.publish_consent ? 'yes' : 'no', r.publish_state, r.actioned ? 'yes' : 'no',
    ].map(cell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="case-feedback.csv"');
  res.send(lines.join('\r\n'));
});

router.post('/marketing/case-feedback/:id/actioned', requireAdmin, async (req: Request, res: Response) => {
  try {
    await setActioned(parseInt(String(req.params.id), 10), req.session.user!.id, req.body?.actioned !== '0');
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/marketing/case-feedback/:id/approve', requireAdmin, async (req: Request, res: Response) => {
  try {
    const attribution = ['full', 'partial', 'anonymous'].includes(String(req.body?.attribution))
      ? String(req.body.attribution) as 'full' | 'partial' | 'anonymous' : 'partial';
    await approveForWebsite(parseInt(String(req.params.id), 10), req.session.user!.id, attribution, String(req.body?.text || ''));
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/marketing/case-feedback/:id/withdraw', requireAdmin, async (req: Request, res: Response) => {
  try { await withdrawFromWebsite(parseInt(String(req.params.id), 10)); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
});

export default router;
