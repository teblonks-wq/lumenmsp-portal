import { pool } from '../../db/pool';

// ── Patch + endpoint protection, from OUR RMM agent ──────────────────────────────
// Intune tells us whether a device satisfies a COMPLIANCE POLICY. That is not the same
// question as "is this machine patched", and reporting one as the other is how a customer
// ends up reading "86% compliant" in a section headed Patch Management when not a single
// update was involved in the number. Now the agent is on the endpoints we can answer the
// patching question from the machines themselves.
//
// The rule (Terry's, Sept 2026): a device is patch-compliant when it has SCANNED in the
// last 7 days AND has zero critical/important updates outstanding. A machine that has
// never checked in is not compliant — it is unknown, and unknown is not a pass. Those are
// counted separately so the report can say so out loud rather than quietly rounding them
// into the good column.

const FRESH_DAYS = 7;          // a scan older than this tells us nothing about today
const SIG_STALE_DAYS = 7;      // Defender signatures older than this are not "updated"
const SIG_NEVER = 65535;       // Defender's sentinel for "no signatures at all", not an age

export interface RmmDevice {
  hostname: string;
  os: string;
  critical: number;
  pending: number;
  rebootRequired: boolean;
  scanAgeDays: number | null;  // null = never scanned
  compliant: boolean;
  av: string;                  // product name(s), or '' when nothing reported
  avCurrent: boolean;
}

export interface RmmPatchSummary {
  available: true;
  total: number;
  compliant: number;
  nonCompliant: number;
  notReporting: number;        // never scanned, or last scan older than FRESH_DAYS
  compliancePct: number;
  criticalOutstanding: number; // sum of critical/important updates across the estate
  pendingOutstanding: number;  // everything outstanding, third-party apps included
  rebootPending: number;
  lastScanAt: Date | null;
  // Endpoint protection
  avProtected: number;         // devices with Defender on, or a third-party AV registered
  avCurrentCount: number;      // of those, signatures fresh (third-party counts as current)
  avProducts: string[];        // distinct product names seen, most common first
  devices: RmmDevice[];
}
export interface RmmUnavailable { available: false; note: string; }

const str = (v: any) => (v == null ? '' : String(v));
const num = (v: any) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const bool = (v: any) => v === true || v === 'true' || v === 1 || v === '1';
/**
 * Microsoft's own engine, under any of the names Security Center gives it. Same test as
 * routes/assets.ts, and it has to be this precise: a bare /defender/ also matches
 * BITDEFENDER, which would file the one engine actually running as Microsoft's and report
 * the machine unprotected. Caught by the fixture test on CHO-006.
 */
const isMsAv = (n: any) => {
  const t = str(n).trim();
  return /(^|\s)(windows|microsoft)\s+defender/i.test(t) || /^microsoft\b/i.test(t);
};

/**
 * What the agent's security collector said about malware protection on one device.
 *
 * The shape this reads is the shape the agent actually sends, which is NOT what this
 * function assumed when it was written (it was lifted from lib/ce.ts, which has the same
 * bug):
 *   defender: { av_enabled, rtp_enabled, antispyware_enabled, av_sig_age_days, ... }
 *   av: [ { name, enabled, updated, present, last_update }, ... ]
 * It was reading `defender.enabled`, `defender.signatureAge` and `antivirus` - three keys
 * that do not exist - so EVERY device on the estate came back unprotected and every report
 * printed "Endpoint protection deployed on 0% of devices". routes/assets.ts is the
 * authoritative reader of this blob; the rules below match it.
 */
function avOf(securityJson: any): { name: string; protected: boolean; current: boolean } {
  let f: any = {};
  try { f = typeof securityJson === 'string' ? JSON.parse(securityJson || '{}') : (securityJson || {}); }
  catch { return { name: '', protected: false, current: false }; }

  const def = f.defender || {};
  const reg: any[] = Array.isArray(f.av) ? f.av : [];

  // present === false is a registration left behind by an uninstall: Security Center still
  // lists the product, its files are gone, it protects nothing. Counting one is how a
  // machine was reported as running OpenText months after it was removed (18 Aug). Drop
  // them before anything else looks at the list.
  const live = reg.filter((p) => p && p.present !== false);
  const thirdParty = live.filter((p) => !isMsAv(p.name) && bool(p.enabled));

  if (thirdParty.length) {
    // Security Center holds several registrations for the same product after a reinstall,
    // so collapse by name - four Webroot rows is one antivirus, not four.
    const names = Array.from(new Set(thirdParty.map((p) => str(p.name).trim()).filter(Boolean)));
    // A third-party engine does not publish a signature age; Windows registering it as up
    // to date is the only reading there is, so take it - but take it per product, not as a
    // blanket true. `updated` missing means the agent did not say, which is not a failure.
    const current = thirdParty.every((p) => p.updated !== false);
    return { name: names.join(', '), protected: true, current };
  }

  // No third-party engine on the box: Defender is the protection, if it is switched on.
  if (!bool(def.av_enabled)) return { name: '', protected: false, current: false };
  const age = num(def.av_sig_age_days);
  // 65535 is Defender's "no signatures at all" sentinel, seen in the wild on machines where
  // a third-party engine has taken over. Treated as a real age it reads as 179 years stale
  // and is meaningless; treated as unknown it would read as fine. It is neither - it means
  // not updated.
  const current = age == null ? true : (age >= SIG_NEVER ? false : age <= SIG_STALE_DAYS);
  return { name: 'Microsoft Defender', protected: true, current };
}

/**
 * Patch + endpoint position for one customer, straight from the agent estate.
 * Excluded and revoked devices are out — an excluded machine is one we have agreed not to
 * patch, and counting it against the percentage would make the report argue with itself.
 */
export async function getRmmPatchSummary(customerId: number): Promise<RmmPatchSummary | RmmUnavailable> {
  let rows: any[];
  try {
    rows = (await pool.query(
      `SELECT ad.hostname, ad.os, ad.patch_pending, ad.patch_critical, ad.reboot_required,
              ad.patch_scan_at, ad.security_json,
              EXTRACT(EPOCH FROM (NOW() - ad.patch_scan_at)) / 86400 AS scan_age_days
         FROM agent_devices ad
        WHERE ad.customer_id = $1
          AND COALESCE(ad.revoked, false) = false
          AND COALESCE(ad.patch_excluded, false) = false
        ORDER BY ad.patch_critical DESC NULLS LAST, ad.hostname`,
      [customerId])).rows;
  } catch (e: any) {
    return { available: false, note: 'patch data could not be read (' + str(e.message).slice(0, 80) + ')' };
  }
  if (!rows.length) return { available: false, note: 'no LumenMSP Agent devices enrolled for this customer' };

  const devices: RmmDevice[] = [];
  const productCount = new Map<string, number>();
  let compliant = 0, notReporting = 0, criticalOutstanding = 0, pendingOutstanding = 0;
  let rebootPending = 0, avProtected = 0, avCurrentCount = 0;
  let lastScanAt: Date | null = null;

  for (const r of rows) {
    const ageRaw = num(r.scan_age_days);
    const scanAgeDays = ageRaw == null ? null : Math.floor(ageRaw);
    const fresh = scanAgeDays != null && scanAgeDays <= FRESH_DAYS;
    const critical = num(r.patch_critical) ?? 0;
    const pending = num(r.patch_pending) ?? 0;
    const isCompliant = fresh && critical === 0;
    const av = avOf(r.security_json);

    if (isCompliant) compliant++;
    if (!fresh) notReporting++;
    criticalOutstanding += critical;
    pendingOutstanding += pending;
    if (bool(r.reboot_required)) rebootPending++;
    if (av.protected) { avProtected++; if (av.current) avCurrentCount++; }
    if (av.name) for (const n of av.name.split(', ')) productCount.set(n, (productCount.get(n) || 0) + 1);
    if (r.patch_scan_at && (!lastScanAt || new Date(r.patch_scan_at) > lastScanAt)) lastScanAt = new Date(r.patch_scan_at);

    devices.push({
      hostname: str(r.hostname) || '—', os: str(r.os), critical, pending,
      rebootRequired: bool(r.reboot_required), scanAgeDays, compliant: isCompliant,
      av: av.name, avCurrent: av.current,
    });
  }

  const total = rows.length;
  return {
    available: true,
    total, compliant, nonCompliant: total - compliant, notReporting,
    compliancePct: total ? Math.round((compliant / total) * 100) : 0,
    criticalOutstanding, pendingOutstanding, rebootPending, lastScanAt,
    avProtected, avCurrentCount,
    avProducts: [...productCount.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
    devices,
  };
}
