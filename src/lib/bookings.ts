import { pool } from '../db/pool';
import { getGraphToken, graphConfigured } from './graph';
import { ensureReplyTemplates, listReplyTemplates, saveReplyTemplate } from './reply-templates';
import { listServices, uniqueSlug } from './booking';
import { config } from '../config';

// ── Microsoft Bookings → the Portal's own diary ──────────────────────────────────
//
// Bookings pages were a bolt-on: a second calendar, a second idea of who is free, and a
// link that took the customer off our own estate. This file is the one-way door out of
// that. It reads every Bookings business and service through Graph and writes them into
// `booking_services`, where the Portal's clash engine can see them — after which the
// Microsoft pages can be unpublished and the link in every email points at us.
//
// It is an IMPORT, not a sync. Nothing is ever written back to Microsoft, and re-running
// it updates the same rows (matched on ms_service_id) rather than making a second copy of
// every service. What the import cannot know — who takes it, whether it is Managed-IT
// only, what colour it is in the diary — it leaves at a sensible default for a human to
// tune on the Bookable services page. It never flips a service PUBLIC on its own: that is
// a decision about the open web, and it stays a deliberate click.
//
// Graph requirement: the app registration needs the APPLICATION permission
// **Bookings.Read.All** with admin consent. Without it Graph returns 403 and the error is
// surfaced on the page — nothing else breaks.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const APP = String(config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/+$/, '');

async function gget(path: string): Promise<any> {
  const token = await getGraphToken();
  const res = await fetch(GRAPH + path, { headers: { Authorization: `Bearer ${token}` } });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(res.status === 403
      ? 'Graph refused (403) — the app registration needs the application permission Bookings.Read.All with admin consent.'
      : `Graph error: ${msg}`);
  }
  return data;
}

const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);

/** 'PT1H30M' → 90. Anything unparseable falls back to the caller's default. */
export function isoMinutes(iso: any, dflt: number): number {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return dflt;
  return (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hm = (v: any, dflt: string): string => {
  const t = String(v || '').slice(0, 5);
  return HM.test(t) ? t : dflt;
};

const DOW: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};

/** Strip the HTML Bookings allows in a service description down to one clean line. */
function oneLine(html: any, cap = 300): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim().slice(0, cap);
}

// ── What an import WOULD do ─────────────────────────────────────────────────────

export interface MappedService {
  msServiceId: string; msBusinessId: string; businessName: string;
  name: string; blurb: string | null; kind: string;
  durationMins: number; bufferMins: number; slotStepMins: number;
  leadTimeHours: number; horizonDays: number;
  windowStart: string; windowEnd: string; weekdays: number[];
  staffIds: number[]; unmatchedStaff: string[];
  teamsMeeting: boolean; locationText: string | null;
  existingId: number | null;          // already imported → this run would UPDATE it
}

export interface ImportPreview { businesses: number; services: MappedService[]; }

/** Portal user ids for a set of Microsoft staff email addresses. */
async function portalUserIds(emails: string[]): Promise<{ ids: number[]; unmatched: string[] }> {
  const wanted = emails.map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return { ids: [], unmatched: [] };
  const r = await pool.query(
    `SELECT id, lower(email) AS email FROM users WHERE lower(email) = ANY($1) AND is_active = true`,
    [wanted]).catch(() => ({ rows: [] as any[] }));
  const found = new Map<string, number>(r.rows.map((x: any) => [String(x.email), Number(x.id)]));
  return {
    ids: wanted.map(e => found.get(e)).filter((n): n is number => Number.isInteger(n as number)),
    unmatched: wanted.filter(e => !found.has(e)),
  };
}

/**
 * Read every Bookings business and map its services onto the Portal's shape, WITHOUT
 * writing anything. The page shows this first: an import that silently rewrites a live
 * booking configuration is not something anyone should trigger blind.
 */
export async function previewBookingsImport(): Promise<ImportPreview> {
  if (!graphConfigured()) throw new Error('Microsoft Graph is not configured.');

  const businesses = (await gget('/solutions/bookingBusinesses')).value || [];
  const existing = await pool.query('SELECT id, ms_service_id FROM booking_services WHERE ms_service_id IS NOT NULL');
  const byMsId = new Map<string, number>(existing.rows.map((x: any) => [String(x.ms_service_id), Number(x.id)]));

  const out: MappedService[] = [];
  for (const b of businesses) {
    const bizId = String(b.id || '');
    if (!bizId) continue;
    const detail = await gget(`/solutions/bookingBusinesses/${encodeURIComponent(bizId)}`);

    // Business hours give the bookable window and the days. Bookings stores one entry per
    // day, each with its own time slots; we take the widest window across the days that
    // are open, because per-day windows have no home in a single service row.
    const hours: any[] = Array.isArray(detail.businessHours) ? detail.businessHours : [];
    const weekdays: number[] = [];
    let winStart = '', winEnd = '';
    for (const h of hours) {
      const d = DOW[String(h?.day || '').toLowerCase()];
      const slots: any[] = Array.isArray(h?.timeSlots) ? h.timeSlots : [];
      if (!d || !slots.length) continue;
      weekdays.push(d);
      for (const sl of slots) {
        const st = hm(sl?.startTime, '');
        const en = hm(sl?.endTime, '');
        if (st && (!winStart || st < winStart)) winStart = st;
        if (en && (!winEnd || en > winEnd)) winEnd = en;
      }
    }

    // Staff: Bookings holds its own member list; we match them to Portal users by email,
    // because the diary can only offer someone it can see the calendar of.
    const staff = (await gget(`/solutions/bookingBusinesses/${encodeURIComponent(bizId)}/staffMembers`).catch(() => ({ value: [] }))).value || [];
    const staffEmailById = new Map<string, string>(
      staff.map((s: any) => [String(s.id || ''), String(s.emailAddress || '')]));

    const services = (await gget(`/solutions/bookingBusinesses/${encodeURIComponent(bizId)}/services`)).value || [];
    for (const s of services) {
      const msId = String(s.id || '');
      if (!msId) continue;
      const pol = s.schedulingPolicy || detail.schedulingPolicy || {};
      const online = !!s.isLocationOnline;
      const emails = (Array.isArray(s.staffMemberIds) ? s.staffMemberIds : [])
        .map((id: any) => staffEmailById.get(String(id)) || '').filter(Boolean);
      const matched = await portalUserIds(emails);

      out.push({
        msServiceId: msId, msBusinessId: bizId,
        businessName: String(detail.displayName || b.displayName || 'Bookings'),
        name: String(s.displayName || 'Service').trim().slice(0, 120),
        blurb: oneLine(s.description) || null,
        // A Bookings service that is not online is somewhere physical, which in our diary
        // is an onsite visit — and onsite visits are the ones that need travel either side.
        kind: online ? 'remote' : 'onsite',
        durationMins: Math.min(480, Math.max(10, isoMinutes(s.defaultDuration, 30))),
        bufferMins: online ? 0 : Math.min(240, Math.max(
          isoMinutes(s.preBuffer, 0), isoMinutes(s.postBuffer, 0), 30)),
        slotStepMins: Math.min(240, Math.max(5, isoMinutes(pol.timeSlotInterval, 30))),
        leadTimeHours: Math.min(720, Math.max(0, Math.round(isoMinutes(pol.minimumLeadTime, 240) / 60))),
        horizonDays: Math.min(365, Math.max(1, Math.round(isoMinutes(pol.maximumAdvance, 30 * 1440) / 1440))),
        windowStart: winStart || '09:00',
        windowEnd: winEnd && winEnd > (winStart || '09:00') ? winEnd : '17:00',
        weekdays: weekdays.length ? Array.from(new Set(weekdays)).sort() : [1, 2, 3, 4, 5],
        staffIds: matched.ids, unmatchedStaff: matched.unmatched,
        teamsMeeting: online,
        locationText: oneLine(s?.defaultLocation?.displayName, 120) || (online ? 'Microsoft Teams' : null),
        existingId: byMsId.get(msId) ?? null,
      });
    }
  }
  return { businesses: businesses.length, services: out };
}

// ── Doing it ────────────────────────────────────────────────────────────────────

export interface ImportResult { created: number; updated: number; skipped: number; names: string[]; }

/**
 * Write the mapped services into `booking_services`. Only the ids in `onlyMsIds` are
 * touched when that list is given, so Terry can bring across three of five.
 *
 * An UPDATE deliberately leaves alone everything a human has since decided: is_public,
 * itsm_only, colour, sort_order, is_active and the slug. Re-running the import to pick up
 * a duration change must not quietly unpublish a page or reshuffle the list.
 */
export async function importBookingServices(onlyMsIds?: string[]): Promise<ImportResult> {
  const pick = onlyMsIds && onlyMsIds.length ? new Set(onlyMsIds.map(String)) : null;
  const preview = await previewBookingsImport();
  const out: ImportResult = { created: 0, updated: 0, skipped: 0, names: [] };

  for (const m of preview.services) {
    if (pick && !pick.has(m.msServiceId)) { out.skipped++; continue; }
    const common = [
      m.name, m.blurb, m.kind, m.durationMins, m.bufferMins, m.slotStepMins,
      m.leadTimeHours, m.horizonDays, m.windowStart, m.windowEnd,
      JSON.stringify(m.weekdays), JSON.stringify(m.staffIds),
      m.teamsMeeting, m.locationText, m.msServiceId, m.msBusinessId,
    ];
    if (m.existingId) {
      await pool.query(
        `UPDATE booking_services SET name=$1, blurb=$2, kind=$3, duration_mins=$4, buffer_mins=$5,
                slot_step_mins=$6, lead_time_hours=$7, horizon_days=$8, window_start=$9, window_end=$10,
                weekdays=$11::jsonb, staff_ids=$12::jsonb, teams_meeting=$13, location_text=$14,
                ms_service_id=$15, ms_business_id=$16, updated_at=NOW()
          WHERE id=$17`, [...common, m.existingId]);
      out.updated++;
    } else {
      const slug = await uniqueSlug(m.name);
      await pool.query(
        `INSERT INTO booking_services (name, blurb, kind, duration_mins, buffer_mins, slot_step_mins,
           lead_time_hours, horizon_days, window_start, window_end, weekdays, staff_ids,
           teams_meeting, location_text, ms_service_id, ms_business_id, slug, is_public, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,false,true)`,
        [...common, slug]);
      out.created++;
    }
    out.names.push(m.name);
  }
  return out;
}

// ── Composer templates that point at OUR booking page ───────────────────────────
//
// Kept under the original name because the templates page and its route already call it.
// What changed is where the link goes: it used to be the Microsoft Bookings public URL,
// which is exactly the dependency we are removing. Now it is the Portal's own page, and
// the {{BOOKING_LINK}} placeholder is rewritten per recipient at send time so the person
// receiving it is recognised when they land.

export interface BookingsSyncResult { businesses: number; services: number; created: number; updated: number; }

export async function syncBookingsTemplates(): Promise<BookingsSyncResult> {
  await ensureReplyTemplates();
  const services = (await listServices(true)).filter(s => s.isPublic && s.slug);
  const existing = await listReplyTemplates(false);
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
  const out: BookingsSyncResult = { businesses: 0, services: services.length, created: 0, updated: 0 };

  const mins = (n: number) => n >= 60
    ? (n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'}` : `${Math.floor(n / 60)}h ${n % 60}m`)
    : `${n} minutes`;

  for (const s of services) {
    const url = `${APP}/book/${s.slug}`;
    const name = `Booking — ${s.name.slice(0, 70)}`;
    const body = `<p>Hello,</p>
<p>You can book <strong>${esc(s.name)}</strong> with us directly — pick any time that suits you and it is yours. Allow ${esc(mins(s.durationMins))}.</p>
${s.blurb ? `<p>${esc(s.blurb)}</p>` : ''}
<p style="margin:18px 0;"><a href="${esc(url)}" style="background:#0e7490;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Book ${esc(s.name)}</a></p>
<p style="font-size:13px;color:#6b7280;">Or use this link: <a href="${esc(url)}">${esc(url)}</a></p>
<p>Everything shown on that page is genuinely free in our diary, so whatever you pick is confirmed straight away${s.teamsMeeting ? ' and a Teams invitation follows immediately' : ''}.</p>`;
    const ex = byName.get(name.toLowerCase());
    if (ex) { await saveReplyTemplate({ id: ex.id, name, body_html: body, sort: ex.sort, is_active: ex.is_active }); out.updated++; }
    else { await saveReplyTemplate({ name, body_html: body, sort: 50 }); out.created++; }
  }

  // One catch-all template offering everything, for the common case of "here is how you
  // reach us" rather than a specific service.
  if (services.length) {
    const name = 'Booking — all services';
    const list = services.map(s =>
      `<li style="margin-bottom:6px;"><a href="${APP}/book/${esc(s.slug)}" style="color:#0e7490;font-weight:600;">${esc(s.name)}</a>`
      + ` <span style="color:#6b7280;">— ${esc(mins(s.durationMins))}</span></li>`).join('');
    const body = `<p>Hello,</p>
<p>Whenever you need us, you can put time straight into our diary — no need to wait for a reply:</p>
<ul style="padding-left:20px;line-height:1.7;">${list}</ul>
<p style="margin:18px 0;"><a href="${APP}/book" style="background:#0e7490;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Book time with us</a></p>
<p>Every slot shown is genuinely free, so whatever you pick is confirmed there and then and a calendar invitation follows.</p>`;
    const ex = byName.get(name.toLowerCase());
    if (ex) { await saveReplyTemplate({ id: ex.id, name, body_html: body, sort: ex.sort, is_active: ex.is_active }); out.updated++; }
    else { await saveReplyTemplate({ name, body_html: body, sort: 49 }); out.created++; }
  }
  return out;
}
