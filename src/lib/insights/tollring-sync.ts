/**
 * Tollring Data Sync Job (ported from Insights into the portal).
 *
 * For each active Insights customer with Tollring API credentials:
 *   1. Fetches calls since last_synced_at (or 2026-01-01 for first run).
 *   2. Stores the FULL raw record in `tollring_calls` (lossless source of truth).
 *   3. Derives a row into `call_events` (the shape reports already read).
 *   4. Updates customers.last_synced_at.
 *
 * All DB access is against the Insights DB via insightsPool.
 */

import cron from 'node-cron';
import { insightsPool } from '../../db/pool';
import { clientFromCustomer, outcomeFromRecord, TollringCallRecord, TollringClient } from './tollring-client';
import { createHash } from 'crypto';

function db() {
  if (!insightsPool) throw new Error('Insights database not connected (INSIGHTS_DATABASE_URL not set)');
  return insightsPool;
}

function normaliseNumber(raw: string): string {
  if (!raw) return '';
  const n = raw.replace(/\s+/g, '');
  if (n.startsWith('+44')) return '0' + n.slice(3);
  return n;
}

function makeHash(customerId: number, recordId: number): string {
  return createHash('sha256').update(`tollring|${customerId}|${recordId}`).digest('hex');
}

function parseCallDate(raw: string): Date {
  if (!raw) return new Date(NaN);
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date(raw) : d;
}

export async function ensureRawTable(): Promise<void> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS tollring_calls (
      id                    BIGSERIAL    PRIMARY KEY,
      customer_id           INTEGER      NOT NULL REFERENCES customers(id),
      record_id             BIGINT       NOT NULL,
      call_date             TIMESTAMPTZ  NOT NULL,
      extno                 TEXT,
      number_raw            TEXT,
      port                  TEXT,
      ring_time             INTEGER,
      duration              INTEGER,
      direction             TEXT,
      unanswer              TEXT,
      call_id               TEXT,
      group_no              TEXT,
      call_outcome          INTEGER,
      call_leg_id           BIGINT,
      leg_id                TEXT,
      previous_leg_id       TEXT,
      call_legs             INTEGER,
      group_position        INTEGER,
      first_group_ringpoint INTEGER,
      wait_time             INTEGER,
      total_duration        INTEGER,
      raw                   JSONB        NOT NULL,
      synced_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (customer_id, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tollring_calls_cust_date  ON tollring_calls (customer_id, call_date);
    CREATE INDEX IF NOT EXISTS idx_tollring_calls_group      ON tollring_calls (customer_id, group_no, call_date);
  `);
  try {
    await db().query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;');
  } catch (err: any) {
    console.warn('[tollring-sync] could not ALTER customers (ownership?) — assuming last_synced_at exists:', err?.message || err);
  }
}

export async function storeRaw(customerId: number, records: TollringCallRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const cols = 23;
  const chunkSize = 200;
  let added = 0;

  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const rows: string[] = [];

    chunk.forEach((r, idx) => {
      const b = idx * cols;
      const ph: string[] = [];
      for (let p = 1; p <= cols; p++) ph.push(`$${b + p}`);
      rows.push(`(${ph.join(',')})`);
      values.push(
        customerId, r.RecordId, parseCallDate(r.Call_date), r.Extno ?? null, r.Number ?? null,
        r.Port ?? null, r.Ring_time ?? null, r.Duration ?? null, r.Direction ?? null, r.Unanswer ?? null,
        r.CallId ?? null, r.Group_no ?? null, r.Call_outcome ?? null, r.Call_legId ?? null, r.LegID ?? null,
        r.PreviousLegID ?? null, r.Call_legs ?? null, r.GroupPosition ?? null, r.firstGroupRingpoint ?? null,
        r.waitTime ?? null, r.totalDuration ?? null, JSON.stringify(r), new Date(),
      );
    });

    const res = await db().query(
      `INSERT INTO tollring_calls
         (customer_id, record_id, call_date, extno, number_raw, port, ring_time,
          duration, direction, unanswer, call_id, group_no, call_outcome,
          call_leg_id, leg_id, previous_leg_id, call_legs, group_position,
          first_group_ringpoint, wait_time, total_duration, raw, synced_at)
       VALUES ${rows.join(',')}
       ON CONFLICT (customer_id, record_id) DO NOTHING`,
      values
    );
    added += res.rowCount ?? 0;
  }
  return added;
}

// Talk time was never carried onto call_events, so the journeys engine — and therefore
// OneBoard, the exports and Ask Insights — has never been able to say how long a call
// lasted. The figure is right there on the Tollring record (r.Duration); nothing had ever
// asked for it. Added 2026-09-01.
//
// Safe to ALTER here: the INSIGHTS database is not Prisma-managed, so `prisma db push`
// cannot drop it (see [[prisma-managed-column-gotcha]] — raw columns on the PORTAL pool
// are a different and much worse story).
let durationColumnReady = false;
export async function ensureDurationColumn(): Promise<void> {
  if (durationColumnReady) return;
  try {
    await db().query('ALTER TABLE call_events ADD COLUMN IF NOT EXISTS duration_secs INTEGER');
    durationColumnReady = true;
  } catch (e: any) {
    // A sync that cannot add the column must still sync. The board simply shows no call
    // length until this succeeds, which is the honest failure rather than a broken feed.
    console.error('[tollring-sync] could not add call_events.duration_secs:', e?.message || e);
  }
}

export async function deriveCallEvent(customerId: number, r: TollringCallRecord): Promise<boolean> {
  const eventDate = parseCallDate(r.Call_date);
  const dayStart  = new Date(eventDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const res = await db().query(
    `INSERT INTO call_events
       (customer_id, event_datetime, report_start, report_end, group_name, outcome,
        number_raw, number_normalised, ddi, wait_seconds, source_file, event_hash, call_id, extno, direction,
        duration_secs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (event_hash) DO UPDATE SET
       group_name        = EXCLUDED.group_name,
       outcome           = EXCLUDED.outcome,
       number_raw        = EXCLUDED.number_raw,
       number_normalised = EXCLUDED.number_normalised,
       ddi               = EXCLUDED.ddi,
       wait_seconds      = EXCLUDED.wait_seconds,
       call_id           = EXCLUDED.call_id,
       extno             = EXCLUDED.extno,
       direction         = EXCLUDED.direction,
       duration_secs     = EXCLUDED.duration_secs`,
    [
      customerId, eventDate, dayStart, dayEnd, r.Group_no || '', outcomeFromRecord(r),
      r.Number || '', normaliseNumber(r.Number || ''), r.Port || null, r.Ring_time || 0,
      'tollring-sync', makeHash(customerId, r.RecordId), r.CallId || null, r.Extno || null, r.Direction || null,
      // Talk time for THIS leg. Only the leg that actually answered carries a duration;
      // the rung-and-not-answered legs are 0, which is what makes "the answered leg's
      // duration" the right thing to average later rather than a sum across legs.
      r.Duration == null ? null : Number(r.Duration),
    ]
  );
  return (res.rowCount ?? 0) > 0;
}

export interface SyncResult {
  fetched:     number;
  rawAdded:    number;
  eventsAdded: number;
}

export const HISTORY_FLOOR = new Date('2026-01-01T00:00:00Z');

// How far past the API window's end we ask for. See the note in syncCustomer.
const API_END_PAD_MS = 3 * 60 * 60 * 1000; // 3 hours

// Tollring's first record will never sit exactly on HISTORY_FLOOR, so "have we got all the
// history?" has to allow a gap. Without this the guard below can never be satisfied and every
// single run re-backfills the first minutes of the floor day for ever — the pm2 log 2026-07-28
// showed "ensuring history from floor - backfilling 2026-01-01 00:00:00 -> 2026-01-01 00:46:36"
// on EVERY run of both customers, because the earliest record is 00:46:36.
const HISTORY_SETTLE_MS = 24 * 60 * 60 * 1000; // 1 day

async function ensureMinHistory(
  customerId: number, custName: string, client: TollringClient, target: Date
): Promise<SyncResult> {
  const r = await db().query('SELECT MIN(call_date) AS earliest FROM tollring_calls WHERE customer_id = $1', [customerId]);
  const earliest: Date | null = r.rows[0]?.earliest ? new Date(r.rows[0].earliest) : null;
  if (earliest && earliest.getTime() <= target.getTime() + HISTORY_SETTLE_MS) {
    return { fetched: 0, rawAdded: 0, eventsAdded: 0 };
  }

  const backfillEnd = earliest ?? new Date();
  const fmt = (d: Date) => d.toISOString().replace('T', ' ').substring(0, 19);
  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  let fetched = 0, rawAdded = 0, eventsAdded = 0;
  let winStart = new Date(target);

  console.log(`[tollring-sync] ${custName}: ensuring history from floor — backfilling ${fmt(target)} → ${fmt(backfillEnd)}`);
  while (winStart < backfillEnd) {
    const winEnd = new Date(Math.min(winStart.getTime() + WINDOW_MS, backfillEnd.getTime()));
    const records = await client.getCallsByDate({ startDate: fmt(winStart), endDate: fmt(winEnd) });
    fetched += records.length;
    rawAdded += await storeRaw(customerId, records);
    for (const rec of records) {
      try { if (await deriveCallEvent(customerId, rec)) eventsAdded++; } catch (err) {
        console.error(`[tollring-sync] history derive error RecordId ${rec.RecordId}:`, err);
      }
    }
    winStart = winEnd;
  }
  if (!earliest) {
    await db().query('UPDATE customers SET last_synced_at = $2 WHERE id = $1', [customerId, backfillEnd]);
  }
  console.log(`[tollring-sync] ${custName}: history backfill done — raw +${rawAdded}, events +${eventsAdded}`);
  return { fetched, rawAdded, eventsAdded };
}

export async function syncCustomer(customerId: number, fromOverride?: Date): Promise<SyncResult> {
  await ensureRawTable();
  await ensureDurationColumn();

  const custRes = await db().query(
    'SELECT id, name, icalls_api_url, icalls_api_token, icalls_api_username, last_synced_at FROM customers WHERE id = $1',
    [customerId]
  );
  const cust = custRes.rows[0];
  if (!cust) throw new Error(`Customer ${customerId} not found`);

  const client = clientFromCustomer(cust);
  if (!client) throw new Error(`Customer ${customerId} has no Tollring API credentials`);

  const target = new Date(HISTORY_FLOOR);
  const hist = await ensureMinHistory(customerId, cust.name, client, target);

  const lsRes = await db().query('SELECT last_synced_at FROM customers WHERE id = $1', [customerId]);
  const lastSynced = lsRes.rows[0]?.last_synced_at ?? null;

  const syncFrom = fromOverride
    ? fromOverride
    : lastSynced
      ? new Date(new Date(lastSynced).getTime() - 3600000)
      : target;
  const syncTo = new Date();
  const fmt = (d: Date) => d.toISOString().replace('T', ' ').substring(0, 19);

  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  let fetched = hist.fetched, rawAdded = hist.rawAdded, eventsAdded = hist.eventsAdded;
  let winStart = syncFrom;

  console.log(`[tollring-sync] ${cust.name}: backfilling ${fmt(syncFrom)} → ${fmt(syncTo)} in 7-day windows (asking the API to ${fmt(new Date(syncTo.getTime() + API_END_PAD_MS))})`);

  while (winStart < syncTo) {
    const winEnd = new Date(Math.min(winStart.getTime() + WINDOW_MS, syncTo.getTime()));
    // The end date we SEND is padded forward; the end date we RECORD (last_synced_at) is not.
    // We send a bare wall-clock string and Tollring reads it as UK local time, so an unpadded
    // end left us permanently ~1h behind through BST — confirmed from the pm2 log 2026-07-28,
    // where a run at 09:50 BST asked for "... -> 08:50" and returned nothing after ~08:45.
    // Asking for a window that runs into the future is harmless (you just get everything up
    // to now) and stays correct whichever way the API reads the string, which is why this is
    // preferred over re-formatting the timestamps into Europe/London and hoping.
    const records = await client.getCallsByDate({
      startDate: fmt(winStart),
      endDate: fmt(new Date(winEnd.getTime() + API_END_PAD_MS)),
    });
    fetched += records.length;

    rawAdded += await storeRaw(customerId, records);
    for (const r of records) {
      try {
        if (await deriveCallEvent(customerId, r)) eventsAdded++;
      } catch (err) {
        console.error(`[tollring-sync] derive error RecordId ${r.RecordId}:`, err);
      }
    }

    await db().query('UPDATE customers SET last_synced_at = $2 WHERE id = $1', [customerId, winEnd]);
    console.log(`[tollring-sync] ${cust.name}: ${fmt(winStart)} → ${fmt(winEnd)} done (+${records.length} fetched | totals: raw ${rawAdded}, events ${eventsAdded})`);

    winStart = winEnd;
  }

  console.log(`[tollring-sync] ${cust.name}: complete — raw +${rawAdded}, call_events +${eventsAdded} (of ${fetched} fetched)`);
  return { fetched, rawAdded, eventsAdded };
}

let syncRunning = false;

async function syncAllCustomers(): Promise<void> {
  if (!insightsPool) return; // Insights DB not configured — nothing to sync.
  if (syncRunning) {
    console.warn('[tollring-sync] previous run still in progress — skipping this tick');
    return;
  }
  syncRunning = true;
  try {
    const res = await db().query(`
      SELECT id FROM customers
      WHERE is_active = true
        AND icalls_api_url IS NOT NULL
        AND icalls_api_token IS NOT NULL
    `);
    for (const row of res.rows) {
      try {
        await syncCustomer(row.id);
      } catch (err) {
        console.error(`[tollring-sync] failed for customer ${row.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[tollring-sync] sync job error:', err);
  } finally {
    syncRunning = false;
  }
}

export function startTollringSync(): void {
  if (!insightsPool) { console.log('• Tollring sync not started (INSIGHTS_DATABASE_URL not set)'); return; }
  cron.schedule('*/10 * * * *', syncAllCustomers);
  console.log('✓ Tollring sync scheduler started (every 10 minutes)');
}
