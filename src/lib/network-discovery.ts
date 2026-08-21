/**
 * Network discovery — the domain logic, kept out of the routes so it can be reasoned about
 * and tested on its own.
 *
 * These are the things on a customer's network that will NEVER have our agent: printers,
 * switches, routers, NAS, access points, cameras. They are deliberately not customer_assets
 * — every screen and every count in that table assumes an agent can eventually be installed,
 * and a printer breaks all of them.
 */

/** Expand a CIDR into addresses. Refuses anything larger than /22 — a /16 is 65k pings and
 *  a scan nobody finishes; if someone really means it, they can add four /22s and see the
 *  cost. Returns [] for anything malformed rather than throwing, because this is fed by a
 *  text box. */
export function expandCidr(cidr: string): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) return [];
  const octets = [1, 2, 3, 4].map((i) => parseInt(m[i], 10));
  const bits = parseInt(m[5], 10);
  if (octets.some((o) => o < 0 || o > 255) || bits < 22 || bits > 32) return [];
  const base = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const size = 2 ** (32 - bits);
  const net = base & (size === 4294967296 ? 0 : ~(size - 1) >>> 0);
  const out: string[] = [];
  // Skip network and broadcast on anything bigger than a /31.
  const from = size > 2 ? net + 1 : net;
  const to = size > 2 ? net + size - 2 : net + size - 1;
  for (let a = from; a <= to; a++) {
    out.push([(a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255].join('.'));
  }
  return out;
}

export function cidrSize(cidr: string): number { return expandCidr(cidr).length; }

/** Is this a plausible IPv4 address? Used to validate a hand-typed device. */
export function isIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s).trim());
  return !!m && [1, 2, 3, 4].every((i) => { const n = +m[i]; return n >= 0 && n <= 255; });
}

export const DEVICE_KINDS = ['printer', 'switch', 'router', 'firewall', 'nas', 'ap', 'camera', 'ups', 'other', 'unknown'] as const;
export type DeviceKind = typeof DEVICE_KINDS[number];

export const KIND_LABELS: Record<string, string> = {
  printer: 'Printer', switch: 'Switch', router: 'Router', firewall: 'Firewall',
  nas: 'NAS', ap: 'Access point', camera: 'Camera', ups: 'UPS',
  other: 'Other', unknown: 'Not identified',
};

/**
 * Guess what something is from whatever it told us.
 *
 * A GUESS, and labelled as one in the UI — the customer's own name for a device beats any
 * heuristic, which is why friendlyName exists and why the guess is only ever a default a
 * human can overrule. Ordered most specific first: "HP LaserJet" must not match the switch
 * rule just because HP make switches too.
 */
export function guessKind(sysDescr?: string | null, vendor?: string | null, openPorts?: number[]): DeviceKind {
  const hay = `${sysDescr || ''} ${vendor || ''}`.toLowerCase();
  const ports = openPorts || [];

  if (/laserjet|officejet|deskjet|imagerunner|bizhub|workcentre|versalink|altalink|mfp|printer|lexmark|kyocera|ricoh|brother|epson (wf|et)/.test(hay)) return 'printer';
  // 9100 is raw printing and almost nothing else uses it.
  if (ports.includes(9100) || ports.includes(631)) return 'printer';
  if (/firewall|fortigate|sonicwall|pfsense|palo alto|watchguard/.test(hay)) return 'firewall';
  if (/switch|catalyst|procurve|aruba|netgear gs|ubiquiti.*switch|unifi switch/.test(hay)) return 'switch';
  if (/access point|unifi ap|\bap\b|wireless/.test(hay)) return 'ap';
  if (/router|draytek|mikrotik|rv\d{3}|gateway/.test(hay)) return 'router';
  if (/synology|qnap|truenas|readynas|\bnas\b/.test(hay)) return 'nas';
  if (/camera|hikvision|dahua|axis communications|nvr/.test(hay)) return 'camera';
  if (/\bups\b|smart-ups|eaton|riello|apc /.test(hay)) return 'ups';
  return 'unknown';
}

/**
 * Printer-MIB (RFC 3805) supply level -> a percentage, or null.
 *
 * THE SPECIALS MATTER. The MIB uses negative sentinels, not measurements:
 *   -1 : other        -2 : unknown        -3 : some remaining, amount not measurable
 * Rendering any of those as a number is how a dashboard claims 0% toner on a printer that
 * is perfectly fine, and how somebody gets sent out with a cartridge that was not needed.
 * A max capacity of -2 means the device will not say, so a percentage cannot be computed
 * at all. When we cannot know, we return null and the UI says "reports as available"
 * rather than inventing a figure.
 */
export function supplyPercent(level: number | null | undefined, max: number | null | undefined): number | null {
  if (level == null || max == null) return null;
  if (level < 0 || max <= 0) return null;          // -1/-2/-3, or an unusable capacity
  return Math.max(0, Math.min(100, Math.round((level / max) * 100)));
}

/** How to describe a supply we cannot put a number on. */
export function supplyNote(level: number | null | undefined, max: number | null | undefined): string | null {
  if (level === -3) return 'reports as available (level not measurable)';
  if (level === -2 || max === -2) return 'the device does not report a level';
  if (level === -1) return 'reported as "other"';
  if (level != null && max != null && max <= 0) return 'no capacity reported';
  return null;
}

/** Below this, tell somebody. Toner rarely fails gracefully at 0. */
export const SUPPLY_LOW_PERCENT = 20;
