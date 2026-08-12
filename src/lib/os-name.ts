// ── What Windows actually is, versus what it calls itself ───────────────────────
// Windows 11 never updated the registry value everything reads its name from:
// HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProductName still says
// "Windows 10 Pro" on a brand-new Windows 11 machine. Microsoft left it that way
// deliberately for compatibility, and the only reliable discriminator is the build
// number - 22000 and above is Windows 11.
//
// Seen live 2026-08-12: AL-06 and AL-07, both new Dell Pro 15 laptops on 25H2
// (build 26200), both listed in the Portal as "Windows 10 Pro".
//
// This is not cosmetic. Windows 10 went out of support on 14 October 2025, so a
// Windows 11 machine labelled Windows 10 can be matched against an out-of-support
// row and fail Cyber Essentials for an operating system it is not running.

/** First Windows 11 build. 21996 was a leaked preview; 22000 is the release. */
const WIN11_MIN_BUILD = 22000;

/** Pull a build number out of whatever we were given - a bare build, or one of our
 *  own os_version strings like "25H2 build 26200" or "23H2 build 22631". */
export function buildNumberOf(...candidates: (string | number | null | undefined)[]): number | null {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return Math.trunc(c);
    const s = String(c);
    // "build 26200" wins over a leading "25H2", so look for the keyed form first.
    const keyed = s.match(/build\s*(\d{4,6})/i);
    if (keyed) return parseInt(keyed[1], 10);
    // A bare number that is plausibly a build (four to six digits, not "10" or "11").
    const bare = s.match(/\b(\d{5,6})\b/);
    if (bare) return parseInt(bare[1], 10);
  }
  return null;
}

/**
 * Correct a Windows product name using the build number.
 *
 * Only ever rewrites "Windows 10" -> "Windows 11", and only when the build says so.
 * Server names are already correct (Server 2022 is build 20348 and calls itself
 * "Windows Server 2022"), and they never contain "Windows 10", so they are untouched.
 * An LTSC release like "Windows 10 Enterprise LTSC 2021" is build 19044 and correctly
 * stays as Windows 10.
 */
export function windowsOsName(
  productName: string | null | undefined,
  ...versionHints: (string | number | null | undefined)[]
): string | null {
  const name = String(productName ?? '').trim();
  if (!name) return productName == null ? null : name || null;
  if (!/windows\s*10\b/i.test(name)) return name;      // nothing to correct
  if (/server/i.test(name)) return name;               // never touch a server edition

  const build = buildNumberOf(...versionHints);
  if (build === null || build < WIN11_MIN_BUILD) return name;

  return name.replace(/windows\s*10\b/i, (m) => (m[7] === ' ' ? 'Windows 11' : 'Windows 11'));
}

/** True when this looks like a machine mislabelled as Windows 10. Used by the backfill. */
export function isMislabelledWin10(productName: string | null | undefined, ...versionHints: (string | number | null | undefined)[]): boolean {
  const fixed = windowsOsName(productName, ...versionHints);
  return !!fixed && fixed !== String(productName ?? '').trim();
}
