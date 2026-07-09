import { getGraphToken, graphConfigured } from './graph';
import { ensureReplyTemplates, listReplyTemplates, saveReplyTemplate } from './reply-templates';

// ── Microsoft Bookings → reply templates ─────────────────────────────────────────
// Pulls every Bookings business + its services via Graph and upserts one composer
// template per service ("Booking — <service>") with the booking-page link, mirroring
// the hand-made remote-service template. Re-running refreshes names/durations/links.
//
// Graph requirement: the app registration needs the APPLICATION permission
// **Bookings.Read.All** with admin consent. Without it, Graph returns 403 and the
// error is surfaced on the templates page — nothing else breaks.

const GRAPH = 'https://graph.microsoft.com/v1.0';

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

// 'PT2H' / 'PT1H30M' / 'PT45M' → '2 hours' / '1 hour 30 minutes' / '45 minutes'
function humanDuration(iso: string): string {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m || (!m[1] && !m[2])) return '';
  const parts: string[] = [];
  if (m[1]) parts.push(`${m[1]} hour${m[1] === '1' ? '' : 's'}`);
  if (m[2]) parts.push(`${m[2]} minute${m[2] === '1' ? '' : 's'}`);
  return parts.join(' ');
}

export interface BookingsSyncResult { businesses: number; services: number; created: number; updated: number; }

export async function syncBookingsTemplates(): Promise<BookingsSyncResult> {
  if (!graphConfigured()) throw new Error('Microsoft Graph is not configured.');
  await ensureReplyTemplates();

  const businesses = (await gget('/solutions/bookingBusinesses')).value || [];
  const existing = await listReplyTemplates(false);
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));

  const out: BookingsSyncResult = { businesses: businesses.length, services: 0, created: 0, updated: 0 };
  for (const b of businesses) {
    const detail = await gget(`/solutions/bookingBusinesses/${encodeURIComponent(b.id)}`);
    const publicUrl = detail.publicUrl || '';
    if (!publicUrl) continue; // unpublished booking page — nothing to link to
    const services = (await gget(`/solutions/bookingBusinesses/${encodeURIComponent(b.id)}/services`)).value || [];
    for (const s of services) {
      out.services++;
      const dur = humanDuration(s.defaultDuration);
      const name = `Booking — ${String(s.displayName || 'Service').slice(0, 70)}`;
      const body = `<p>Dear Team,</p>
<p>Please use the link below to book your <strong>${esc(s.displayName)}</strong> appointment${dur ? ` (allow ${esc(dur)})` : ''}.</p>
${(s.description || '').trim() ? `<p>${esc(s.description)}</p>` : ''}<p><a href="${esc(publicUrl)}">Book: ${esc(s.displayName)}</a></p>
<p>Kind regards,<br>Lumen IT Solutions — Customer Success Team</p>`;
      const ex = byName.get(name.toLowerCase());
      if (ex) { await saveReplyTemplate({ id: ex.id, name, body_html: body, sort: ex.sort, is_active: ex.is_active }); out.updated++; }
      else { await saveReplyTemplate({ name, body_html: body, sort: 50 }); out.created++; }
    }
  }
  return out;
}
