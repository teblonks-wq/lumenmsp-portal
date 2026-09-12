import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import {
  DIARY_KINDS, DIARY_COLOURS, DIARY_RECURRENCE, isDiaryKind, isDiaryColour, isRecurrence,
  dayKeyOf, mondayOf, addDays, dayRange, diaryPeople, loadWeek, saveEntry, saveSeries,
  cancelSeries, findClashes, findAllDayClashes, diaryWhenText, loadOutlookWeek, Clash } from '../lib/diary';
import { freeBusy, pushEntry, removeEntry } from '../lib/diary-graph';
import { sendBookingMail } from '../lib/booking-email';

const router = Router();

// ── The Diary ───────────────────────────────────────────────────────────────────
// One pool of entries; /diary/week renders it through whichever lens is asked for
// (company | mine | u<id> | support | onsite). Writes are JSON so the new-entry
// lightbox can show the HARD BLOCK's evidence — what clashes, whose time, when —
// without a page reload. See lib/diary.ts for the rules and the design brief for
// the decisions.

router.get('/diary', requireAuth, (_req: Request, res: Response) => res.redirect('/diary/week'));

router.get('/diary/week', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const today = dayKeyOf(Math.floor(Date.now() / 1000));
  const wRaw = String(req.query.w || '');
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(wRaw) ? mondayOf(wRaw) : mondayOf(today);
  const view = String(req.query.view || 'company');

  // Outlook runs ALONGSIDE the week, not after it: the cost of the overlay is then the
  // slower of the two, not the sum. It resolves to [] rather than throwing if Graph is
  // unreachable, so the diary never fails to load because a calendar did.
  const [people, entries, customers, outlook] = await Promise.all([
    diaryPeople(),
    loadWeek(monday),
    pool.query(`SELECT id, name FROM customers WHERE status <> 'inactive' AND NOT is_placeholder ORDER BY name`)
      .then(r => r.rows),
    loadOutlookWeek(monday).catch(() => ({ entries: [], warning: null })),
  ]);

  // Arrived from a case's Actions menu: the diary opens with the entry form already up and
  // the case, its customer and a sensible title filled in. Reusing this screen rather than
  // building a second booking form on the case page means the clash engine, the invitation
  // and the Teams link all behave identically wherever a booking is made.
  const seedTicketId = parseInt(String(req.query.ticket || ''), 10) || null;
  const seedTicket = seedTicketId
    ? (await pool.query(
      `SELECT t.id, t.ticket_number, t.subject, t.customer_id
         FROM inbox_tickets t WHERE t.id=$1 AND t.deleted_at IS NULL`, [seedTicketId])
      .catch(() => ({ rows: [] as any[] }))).rows[0] || null
    : null;

  res.render('diary/week', {
    user, monday, today, view,
    days: Array.from({ length: 7 }, (_, i) => addDays(monday, i)),
    prevW: addDays(monday, -7), nextW: addDays(monday, 7),
    people, entries: entries.concat(outlook.entries), customers,
    outlookCount: outlook.entries.length, outlookWarning: outlook.warning,
    seedTicket,
    KINDS: DIARY_KINDS, COLOURS: DIARY_COLOURS, REPEATS: DIARY_RECURRENCE,
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

function parseBody(req: Request) {
  const b = req.body || {};
  const num = (v: any) => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : null; };
  const rawPeople = Array.isArray(b.people) ? b.people : b.people != null ? [b.people] : [];
  return {
    kind: String(b.kind || ''),
    title: String(b.title || ''),
    notes: String(b.notes || '').trim() || null,
    customerId: num(b.customer_id),
    ticketId: num(b.ticket_id),
    personIds: rawPeople.map((v: any) => parseInt(String(v), 10)).filter((n: number) => Number.isFinite(n)),
    startEpoch: num(b.start_epoch),
    endEpoch: num(b.end_epoch),
    dayKey: /^\d{4}-\d{2}-\d{2}$/.test(String(b.day_key || '')) ? String(b.day_key) : null,
    endDayKey: /^\d{4}-\d{2}-\d{2}$/.test(String(b.end_day_key || '')) ? String(b.end_day_key) : null,
    bufferMins: num(b.buffer_mins) ?? 0,
    colour: isDiaryColour(b.colour) ? String(b.colour) : null,
    recurrence: isRecurrence(b.recurrence) ? String(b.recurrence) : 'none',
    recurrenceEnd: /^\d{4}-\d{2}-\d{2}$/.test(String(b.recurrence_end || '')) ? String(b.recurrence_end) : null,
    createdBy: null as number | null,
    teamsMeeting: !!b.teams_meeting,
    inviteName: String(b.invite_name || '').trim().slice(0, 120) || null,
    // Validated here, not at the point of sending. An address that cannot be emailed must
    // never be stored as though somebody had been invited - the entry would claim a
    // confirmation went out that never could.
    inviteEmail: /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(String(b.invite_email || '').trim())
      ? String(b.invite_email).trim().toLowerCase() : null,
  };
}

/**
 * The contacts of one customer, for the diary's invite picker.
 *
 * Archived contacts and ones with no address are left out: the only thing this list is for
 * is choosing somebody to email, and an entry that cannot be emailed is not a choice.
 */
router.get('/diary/customer/:id/contacts.json', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.json({ contacts: [] }); return; }
  const r = await pool.query(
    `SELECT full_name AS name, email FROM customer_contacts
      WHERE customer_id=$1 AND COALESCE(archived,false)=false
        AND email IS NOT NULL AND email <> ''
      ORDER BY is_primary DESC, full_name`, [id]).catch(() => ({ rows: [] as any[] }));
  res.json({ contacts: r.rows });
});

async function checkAndSave(req: Request, res: Response, id: number | null) {
  const user = req.session.user!;
  const inp = parseBody(req);
  inp.createdBy = user.id;
  if (!isDiaryKind(inp.kind)) { res.json({ ok: false, error: 'Unknown entry kind.' }); return; }

  const timed = inp.startEpoch != null && inp.endEpoch != null;
  let warning: string | null = null;

  // The hard block, run BEFORE anything is written so the lightbox can show the
  // evidence. saveEntry re-checks — cheap insurance against a race.
  let clashes: Clash[] = [];
  if (timed) clashes = await findClashes(inp.personIds, inp.startEpoch!, inp.endEpoch!, inp.bufferMins, id);
  else if (inp.kind === 'timeoff' && inp.dayKey) clashes = await findAllDayClashes(inp.personIds, dayRange(inp.dayKey, inp.endDayKey), id);

  // Outlook free/busy: the buffer counts here too. Missing permission degrades to
  // a warning — a booking is never blocked because consent has not been granted.
  if (!clashes.length && timed) {
    const emails = (await diaryPeople()).filter(p => inp.personIds.includes(p.id)).map(p => p.email);
    const buf = Math.max(0, inp.bufferMins) * 60;
    const fb = await freeBusy(emails, inp.startEpoch! - buf, inp.endEpoch! + buf);
    warning = fb.warning;
    for (const bzy of fb.busy) {
      if (bzy.s < inp.endEpoch! + buf && bzy.e > inp.startEpoch! - buf) {
        clashes.push({
          id: null,
          who: bzy.email,
          title: bzy.shared
            ? 'Blocked in the shared diary'
            : (bzy.status === 'oof' ? 'Out of office (Outlook)' : 'Busy (Outlook)'),
          kind: 'outlook', whenText: diaryWhenText(bzy.s), source: 'outlook',
        });
      }
    }
  }
  if (clashes.length) { res.json({ ok: false, blocked: true, clashes, warning }); return; }

  // A repeat is only offered on CREATE — editing one occurrence edits that occurrence.
  const isSeries = id == null && inp.recurrence !== 'none';

  // For a series, ask Outlook once for the whole window rather than per occurrence, and
  // hand the busy blocks to saveSeries so later dates are checked as hard as the first.
  let seriesBusy: Array<{ s: number; e: number; who: string; title: string }> = [];
  if (isSeries && timed && inp.recurrenceEnd) {
    const emails = (await diaryPeople()).filter(p => inp.personIds.includes(p.id)).map(p => p.email);
    const windowEnd = Math.floor(new Date(inp.recurrenceEnd + 'T23:59:59Z').getTime() / 1000) + 86400;
    const fb = await freeBusy(emails, inp.startEpoch!, windowEnd);
    if (fb.warning && !warning) warning = fb.warning;
    seriesBusy = fb.busy.map(b => ({
      s: b.s, e: b.e, who: b.email,
      title: b.status === 'oof' ? 'Out of office (Outlook)' : 'Busy (Outlook)',
    }));
  }

  const result = isSeries ? await saveSeries(inp, seriesBusy) : await saveEntry(id, inp);
  if (!result.ok) { res.json({ ...result, blocked: !!result.clashes, warning }); return; }

  // A booking made against a case belongs ON that case: the next person to open it should
  // see that somebody is going out on Tuesday without having to find the diary. Create only
  // — an edit would write the same line again every time the time moved by five minutes.
  if (id == null && inp.ticketId && timed) {
    await pool.query(
      `INSERT INTO inbox_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
      [inp.ticketId, user.id,
       `${DIARY_KINDS[inp.kind] ? DIARY_KINDS[inp.kind].label : inp.kind} booked — ${inp.title} (${diaryWhenText(inp.startEpoch!)})`
       + (inp.inviteEmail ? `. Invitation sent to ${inp.inviteEmail}.` : '.')]).catch(() => {});
  }

  await logActivity(user.id, id == null ? 'diary_create' : 'diary_update', 'diary_entries', result.id!,
    `${DIARY_KINDS[inp.kind].label}: ${inp.title}` + (timed ? ` (${diaryWhenText(inp.startEpoch!)})` : inp.dayKey ? ` (${inp.dayKey})` : '')
    + (isSeries ? ` ×${(result.ids || []).length} (${DIARY_RECURRENCE[inp.recurrence]} to ${inp.recurrenceEnd})` : ''));

  // Mirror to M365 in the background. The first occurrence goes first so the calendar
  // shows the thing you just booked immediately, even if a long series takes a moment.
  //
  // With somebody invited, the push is AWAITED instead: it is what creates the Teams
  // meeting and writes the join link back, and an invitation sent a moment earlier would
  // go out without it - which is the one thing the recipient actually needs.
  let invited: string | null = null;
  if (inp.inviteEmail && timed) {
    await pushEntry(result.id!).catch(() => {});
    try { await sendBookingMail(result.id!, id == null ? 'confirmed' : 'updated'); invited = inp.inviteEmail; }
    catch (e: any) { console.error('[diary] invitation failed:', e.message); }
  } else {
    pushEntry(result.id!).catch(() => {});
  }
  for (const oid of (result.ids || []).slice(1)) pushEntry(oid).catch(() => {});

  res.json({ ok: true, id: result.id, warning, invited, series: isSeries, created: (result.ids || [result.id]).length, skipped: result.skipped || [] });
}

router.post('/diary/entries', requireAuth, (req, res) => { checkAndSave(req, res, null).catch(e => res.json({ ok: false, error: e.message })); });
router.post('/diary/entries/:id', requireAuth, (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  checkAndSave(req, res, id).catch(e => res.json({ ok: false, error: e.message }));
});

// Done / cancel — plain form posts from the week view.
router.post('/diary/entries/:id/status', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const status = ['done', 'cancelled', 'booked'].includes(String(req.body.status)) ? String(req.body.status) : null;
  const back = String(req.body.back || '').startsWith('/') ? String(req.body.back) : '/diary/week';
  if (!status) { res.redirect(back + '?err=' + encodeURIComponent('Unknown status.')); return; }
  const wholeSeries = String(req.body.scope || '') === 'series' && status === 'cancelled';

  const row = (await pool.query(`UPDATE diary_entries SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING title, series_id`, [status, id])).rows[0];
  if (!row) { res.redirect(back + '?err=' + encodeURIComponent('That entry is gone.')); return; }

  // "Cancel the whole series" only ever reaches forward — past occurrences are a record
  // of what was booked and stay exactly as they were.
  let alsoCancelled: number[] = [];
  if (wholeSeries && row.series_id) alsoCancelled = await cancelSeries(Number(row.series_id), null);

  await logActivity(user.id, 'diary_' + status, 'diary_entries', id,
    `${row.title} → ${status}` + (alsoCancelled.length ? ` (series: ${alsoCancelled.length} future occurrence(s))` : ''));
  if (status === 'cancelled') {
    removeEntry(id).catch(() => {});
    for (const oid of alsoCancelled) if (oid !== id) removeEntry(oid).catch(() => {});
  } else pushEntry(id).catch(() => {});

  const msg = status === 'done' ? 'Marked done.'
    : status === 'cancelled'
      ? (alsoCancelled.length > 1
          ? `Series cancelled — ${alsoCancelled.length} future entries removed, and their calendar copies with them.`
          : 'Cancelled — its calendar copies are being removed.')
      : 'Rebooked.';
  res.redirect(back + '?msg=' + encodeURIComponent(msg));
});

// ── Promise button (composer) ───────────────────────────────────────────────────
// "I'll call you Thursday" → a diary day-lane item in the sender's name + an
// internal note on the case, one click. Promises are day items — no fake times.
router.post('/tickets/:id/promise', requireAuth, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.day || '')) ? String(req.body.day) : null;
  const text = String(req.body.text || '').trim();
  const back = String(req.body.back || '').startsWith('/') ? String(req.body.back) : '/tickets/' + id;
  if (!dayKey || !text) { res.redirect(back + '?err=' + encodeURIComponent('A promise needs a day and what you promised.')); return; }

  const t = (await pool.query(`SELECT ticket_number, customer_id FROM inbox_tickets WHERE id=$1`, [id])).rows[0];
  if (!t) { res.redirect('/tickets?err=' + encodeURIComponent('That case is gone.')); return; }

  const r = await saveEntry(null, {
    kind: 'promise', title: text, notes: null,
    customerId: t.customer_id ? Number(t.customer_id) : null, ticketId: id,
    personIds: [user.id], startEpoch: null, endEpoch: null, dayKey, endDayKey: null,
    bufferMins: 0, colour: null, recurrence: 'none', recurrenceEnd: null, createdBy: user.id,
  });
  if (!r.ok) { res.redirect(back + '?err=' + encodeURIComponent(r.error || 'Could not save the promise.')); return; }

  await pool.query(
    `INSERT INTO ticket_notes (ticket_id, user_id, note_type, body) VALUES ($1,$2,'system_log',$3)`,
    [id, user.id, `Promise logged to the Diary for ${dayKey}: ${text} (${user.displayName})`]);
  await logActivity(user.id, 'diary_promise', 'inbox_tickets', id, `${t.ticket_number || id}: ${text} → ${dayKey}`);
  res.redirect(back + '?msg=' + encodeURIComponent(`Promised for ${dayKey} — it's in your diary and on the case.`));
});

export default router;
