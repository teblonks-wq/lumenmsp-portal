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

/** What the agent's security collector said about malware protection on one device. */
function avOf(securityJson: any): { name: string; protected: boolean; current: boolean } {
  let f: any = {};
  try { f = typeof securityJson === 'string' ? JSON.parse(securityJson || '{}') : (securityJson || {}); }
  catch { return { name: '', protected: false, current: false }; }
  const def = f.defender || {};
  const av: any[] = Array.isArray(f.antivirus) ? f.antivirus : [];
  const thirdParty = av.filter((p) => !/windows defender/i.test(str(p.name))).map((p) => str(p.name)).filter(Boolean);
  const defenderOn = bool(def.enabled);
  if (thirdParty.length) {
    // A third-party product does not publish its signature age through Security Center;
    // Windows registering it as up to date is the only reading there is, so take it.
    return { name: thirdParty.join(', '), protected: true, current: true };
  }
  if (!defenderOn) return { name: '', protected: false, current: false };
  const age = num(def.signatureAge);
  return { name: 'Microsoft Defender', protected: true, current: age == null ? true : age <= SIG_STALE_DAYS };
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
