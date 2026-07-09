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

export async function deriveCallEvent(customerId: number, r: TollringCallRecord): Promise<boolean> {
  const eventDate = parseCallDate(r.Call_date);
  const dayStart  = new Date(eventDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const res = await db().query(
    `INSERT INTO call_events
       (customer_id, event_datetime, report_start, report_end, group_name, outcome,
        number_raw, number_normalised, ddi, wait_seconds, source_file, event_hash, call_id, extno, direction)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (event_hash) DO UPDATE SET
       group_name        = EXCLUDED.group_name,
       outcome           = EXCLUDED.outcome,
       number_raw        = EXCLUDED.number_raw,
       number_normalised = EXCLUDED.number_normalised,
       ddi               = EXCLUDED.ddi,
       wait_seconds      = EXCLUDED.wait_seconds,
       call_id           = EXCLUDED.call_id,
       extno             = EXCLUDED.extno,
       direction         = EXCLUDED.direction`,
    [
      customerId, eventDate, dayStart, dayEnd, r.Group_no || '', outcomeFromRecord(r),
      r.Number || '', normaliseNumber(r.Number || ''), r.Port || null, r.Ring_time || 0,
      'tollring-sync', makeHash(customerId, r.RecordId), r.CallId || null, r.Extno || null, r.Direction || null,
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

async function ensureMinHistory(
  customerId: number, custName: string, client: TollringClient, target: Date
): Promise<SyncResult> {
  const r = await db().query('SELECT MIN(call_date) AS earliest FROM tollring_calls WHERE customer_id = $1', [customerId]);
  const earliest: Date | null = r.rows[0]?.earliest ? new Date(r.rows[0].earliest) : null;
  if (earliest && earliest <= target) return { fetched: 0, rawAdded: 0, eventsAdded: 0 };

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

  console.log(`[tollring-sync] ${cust.name}: backfilling ${fmt(syncFrom)} → ${fmt(syncTo)} in 7-day windows`);

  while (winStart < syncTo) {
    const winEnd = new Date(Math.min(winStart.getTime() + WINDOW_MS, syncTo.getTime()));
    const records = await client.getCallsByDate({ startDate: fmt(winStart), endDate: fmt(winEnd) });
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
  cron.schedule('0 * * * *', syncAllCustomers);
  console.log('✓ Tollring sync scheduler started (hourly)');
}
