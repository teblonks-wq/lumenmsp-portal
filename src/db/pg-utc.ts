import { types as pgTypes } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────────
// Making node-pg agree with Prisma about what a `timestamp` column means.
//
// Prisma maps every `DateTime` to `timestamp(3)` WITHOUT time zone, and those columns
// hold UTC — confirmed 2026-08-04 and never in doubt since. But a bare `timestamp` is
// just wall-clock digits with no zone attached, so both halves of the Portal have to
// AGREE on how to read them, and they did not:
//
//   • Prisma reads `2026-08-19 07:43` as 07:43 UTC.               (right)
//   • node-pg reads the same text as 07:43 LOCAL, and this server runs Europe/London,
//     so during BST it hands back a Date meaning 06:43 UTC.       (one hour behind)
//
// That is why a note typed at 08:43 appeared on the case page as 07:43. The July fix
// (adding `timeZone: 'Europe/London'` to the formatting calls) was correct and is what
// stopped it being TWO hours out — but no amount of care in the formatter can rescue a
// Date that was already wrong when it arrived. The bug is in the parse, not the print.
//
// The write direction is the same disagreement in reverse, and it is the part that
// makes a read-only fix dangerous. node-pg serialises a JS Date using the LOCAL offset
// ('2026-08-19T08:43:12.000+01:00'); Postgres, casting that to a zone-less `timestamp`,
// simply DISCARDS the offset and stores 08:43 — an hour ahead of what Prisma would have
// stored for the same instant. Setting the session time zone does not help, because the
// wall-clock digits are already local by the time the server sees them. So today the
// rows written through Prisma read an hour early, and the rows written through raw pg
// read correctly by accident — two wrongs that happen to cancel. Fixing only the read
// side would leave the raw-pg rows an hour LATE, which is the same bug wearing a hat.
//
// Hence both directions here, on the Portal pool only. The Insights pool is deliberately
// untouched: its schema and its sync are their own argument, and quietly shifting call
// timestamps under the journey builder is not a side effect worth risking.
// ─────────────────────────────────────────────────────────────────────────────────

/** `timestamp` without time zone. `timestamptz` (1184) carries its own zone and is already right. */
const TIMESTAMP_OID = 1114;

/**
 * Read `2026-08-19 07:43:12.345` as UTC, because that is what is in the column.
 * `infinity` is passed through as the extreme Dates node-pg itself uses, and anything
 * unparseable is handed back as-is rather than silently becoming an Invalid Date.
 */
export function parseUtcTimestamp(value: string | null): Date | string | null {
  if (value == null) return null;
  if (value === 'infinity') return new Date(8640000000000000);
  if (value === '-infinity') return new Date(-8640000000000000);
  const d = new Date(value.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? value : d;
}

/** Pass as `types` when constructing a Pool. Every other OID keeps node-pg's own parser. */
export const utcTimestampTypes = {
  getTypeParser(oid: number, format?: any): any {
    if (oid === TIMESTAMP_OID) return parseUtcTimestamp;
    return (pgTypes as any).getTypeParser(oid, format);
  },
};

/**
 * Send a JS Date as UTC. `.toISOString()` ends in Z, and Postgres discards the zone the
 * same way it does for a local offset — the difference is that the digits in front of it
 * are now UTC, which is what the column is documented to hold.
 */
export function toUtcParam(v: any): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toUtcParam);
  return v;
}

const PATCHED = Symbol.for('lumen.pg.utcParams');

/**
 * Convert Date parameters on the way out, for a Pool or a checked-out Client.
 *
 * Done here rather than at the call sites on purpose. There are 151 files issuing raw
 * queries and 56 places that check a client out of the pool; a rule that has to be
 * remembered 200 times is a rule that will be missed, and the failure is silent — a row
 * an hour out looks exactly like a row.
 */
export function withUtcDateParams<T extends { query: any; connect?: any }>(target: T): T {
  const t = target as any;
  if (!t || t[PATCHED]) return target;

  const query = t.query.bind(t);
  t.query = function (config: any, values?: any, cb?: any) {
    if (Array.isArray(values)) values = values.map(toUtcParam);
    else if (config && typeof config === 'object' && Array.isArray(config.values)) {
      config = { ...config, values: config.values.map(toUtcParam) };
    }
    return query(config, values, cb);
  };

  // Clients checked out with pool.connect() bypass pool.query entirely, so they need the
  // same treatment. The symbol guard makes re-patching a recycled client a no-op.
  if (typeof t.connect === 'function') {
    const connect = t.connect.bind(t);
    t.connect = function (cb?: any) {
      if (typeof cb === 'function') {
        return connect((err: any, client: any, release: any) =>
          cb(err, client ? withUtcDateParams(client) : client, release));
      }
      return connect().then((client: any) => withUtcDateParams(client));
    };
  }

  t[PATCHED] = true;
  return target;
}
