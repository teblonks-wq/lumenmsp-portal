/**
 * BitLocker scan-output parsing.
 *
 * Written the day the feature shipped and failed on the whole estate. The server's log was
 * ~180 lines of:
 *
 *     [bitlocker] ingest failed: Unexpected non-whitespace character after JSON at position 272
 *
 * The parse was `JSON.parse(output.slice(output.indexOf('{')))` — first brace to the end of
 * the string — and PowerShell puts error records on the same stream as the output. An error
 * record ECHOES THE OFFENDING LINE, and several lines of the scan script end in `{`, so the
 * old code locked on to a brace inside an error message and tried to read the error as JSON.
 *
 * Every fixture below is a shape that really happens on a Windows estate. The rule the whole
 * suite exists to hold: **anything around our object is somebody else's business, and the
 * parser's job is to find OUR object and ignore the rest.**
 *
 *   J1–J6   the junk that broke it — before, after, both, and a brace inside an error line
 *   K1–K4   the awkward content: braces and quotes inside strings, deep nesting, unicode
 *   N1–N5   refusing safely — no marker, truncated, empty, not ours
 *   S1–S4   the scan script's own guarantees
 *
 * Run: npm run test:bitlocker
 */
import { parseBitlockerPayload, looksLikeBitlockerScan, BITLOCKER_MARKER, BITLOCKER_SCAN_SCRIPT } from '../lib/bitlocker';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const good = JSON.stringify({
  marker: BITLOCKER_MARKER,
  volumes: [{
    mount: 'C:', status: 'On', lock: 'Unlocked', method: 'XtsAes128', volType: 'OperatingSystem',
    protectors: [{ id: '{4f2c1a-...}', password: '111111-222222-333333-444444-555555-666666-777777-888888' }],
  }],
});

// What a PowerShell error record actually looks like. Note the line it quotes: it ends in
// `{`, which is the brace the old parser locked on to.
const psError = [
  'Get-BitLockerVolume : The term \'Get-BitLockerVolume\' is not recognized as the name of a cmdlet.',
  'At line:4 char:20',
  '+   foreach ($v in @(Get-BitLockerVolume -ErrorAction Stop)) {',
  '+                    ~~~~~~~~~~~~~~~~~~~',
  '    + CategoryInfo          : ObjectNotFound: (Get-BitLockerVolume:String) [], CommandNotFoundException',
  '    + FullyQualifiedErrorId : CommandNotFoundException',
].join('\n');

console.log('\nThe junk that broke it');
{
  const r1 = parseBitlockerPayload(psError + '\n' + good);
  check('J1 a PowerShell error record BEFORE the json is ignored', !!r1 && r1.volumes.length === 1,
        r1 ? JSON.stringify(r1).slice(0, 80) : 'null');
  // This is the exact old failure: the quoted script line ends in '{', so indexOf('{') found it.
  check('J2 …and specifically the quoted line ending in "{" does not become the parse start',
        !!r1 && r1.marker === BITLOCKER_MARKER);

  check('J3 a warning AFTER the json is ignored',
        !!parseBitlockerPayload(good + '\nWARNING: The system cannot find the drive specified.'),
        'trailing text must not break it');

  check('J4 junk on both sides',
        !!parseBitlockerPayload(psError + '\n' + good + '\nWARNING: something else\n'),
        'both at once');

  // A second object printed after ours — the shape that gives "after JSON at position N".
  check('J5 a second object after ours does not confuse it',
        (() => { const r = parseBitlockerPayload(good + '\n{"other":true}'); return !!r && r.marker === BITLOCKER_MARKER; })());

  check('J6 leading blank lines and CRLF are fine',
        !!parseBitlockerPayload('\r\n\r\n' + good.replace(/\n/g, '\r\n') + '\r\n'));
}

// ── The exact shape the server was failing on ──────────────────────────────────
// Reproduced from the log: "after JSON at position N" means the object at the first brace
// parsed CLEANLY and something followed it. The positions seen on the estate line up with
// the length of our own object plus one, which pins it precisely:
//   position 45   -> {"marker":"LUMEN_BITLOCKER_V1","volumes":[]}  (a machine with no BitLocker)
//   position ~272 -> one C: volume with one recovery protector
//   position 3704 -> a machine with several volumes
// So every scan RAN and produced good json; a trailer after it was throwing all of them away.
console.log('\nThe exact server failure');
{
  const empty = JSON.stringify({ marker: BITLOCKER_MARKER, volumes: [] });
  check('X0 the empty-volume object is 44 chars, so the old parser threw at position 45',
        empty.length === 44, String(empty.length));

  const trailers = ['\nCommand completed with exit code 0', '\nWARNING: drive not found', '\n{"x":1}', '\r\nDone.'];
  let reproduced = 0, recovered = 0;
  for (const t of trailers) {
    const raw = good + t;
    try { JSON.parse(raw.slice(raw.indexOf('{'))); } catch (e: any) {
      if (/Unexpected non-whitespace character after JSON/.test(e.message)) reproduced++;
    }
    const r = parseBitlockerPayload(raw);
    if (r && r.marker === BITLOCKER_MARKER && r.volumes.length === 1) recovered++;
  }
  check('X1 the OLD slice-to-end parse throws the server\'s exact error on every trailer',
        reproduced === trailers.length, `${reproduced}/${trailers.length}`);
  check('X2 the new parser reads all of them correctly',
        recovered === trailers.length, `${recovered}/${trailers.length}`);
  check('X3 an empty-volume machine still parses (and stores its "no BitLocker here" row)',
        (() => { const r = parseBitlockerPayload(empty + '\nCommand completed'); return !!r && Array.isArray(r.volumes) && r.volumes.length === 0; })());
}

console.log('\nAwkward content');
{
  // A KeyProtectorId is literally brace-wrapped, and it lives INSIDE a json string. A parser
  // that counts braces without understanding strings stops in the middle of the object.
  const r = parseBitlockerPayload(psError + '\n' + good);
  check('K1 braces inside a string (the KeyProtectorId) do not end the object early',
        !!r && r.volumes[0].protectors[0].id === '{4f2c1a-...}',
        r ? String(r.volumes?.[0]?.protectors?.[0]?.id) : 'null');

  const quoted = JSON.stringify({ marker: BITLOCKER_MARKER, volumes: [{ mount: 'D:', method: 'a "quoted" label {x}', protectors: [] }] });
  const r2 = parseBitlockerPayload('noise\n' + quoted + '\nmore noise');
  check('K2 escaped quotes inside a string survive', !!r2 && r2.volumes[0].method === 'a "quoted" label {x}',
        r2 ? String(r2.volumes?.[0]?.method) : 'null');

  const backslash = JSON.stringify({ marker: BITLOCKER_MARKER, volumes: [{ mount: '\\\\?\\Volume{abc}\\', protectors: [] }] });
  check('K3 a Windows volume path with backslashes and braces survives',
        (() => { const x = parseBitlockerPayload(backslash + '\ntrailer'); return !!x && x.volumes[0].mount === '\\\\?\\Volume{abc}\\'; })());

  const many = JSON.stringify({ marker: BITLOCKER_MARKER, volumes: Array.from({ length: 6 }, (_, i) => ({ mount: `${String.fromCharCode(67 + i)}:`, protectors: [{ id: `{p${i}}`, password: 'x' }] })) });
  check('K4 a machine with six volumes parses whole', (() => { const x = parseBitlockerPayload(psError + '\n' + many); return !!x && x.volumes.length === 6; })());
}

console.log('\nRefusing safely');
{
  check('N1 no marker at all returns null, never throws', parseBitlockerPayload('just some output') === null);
  check('N2 empty output returns null', parseBitlockerPayload('') === null);
  check('N3 null/undefined return null', parseBitlockerPayload(null) === null && parseBitlockerPayload(undefined) === null);
  // Truncated output must be null rather than a throw: an exception here becomes "could not
  // be stored" with no reason, which is exactly the silent hole this all came out of.
  check('N4 a truncated object returns null rather than throwing',
        parseBitlockerPayload(good.slice(0, good.length - 12)) === null);
  check('N5 the marker with no object around it returns null',
        parseBitlockerPayload('LUMEN_BITLOCKER_V1 appeared in a log line') === null);
  check('N6 looksLikeBitlockerScan still gates cheaply',
        looksLikeBitlockerScan(good) && !looksLikeBitlockerScan('Get-ChildItem output'));
}

console.log('\nThe scan script itself');
{
  const src = BITLOCKER_SCAN_SCRIPT;
  // Continue PRINTS error records onto the output stream; SilentlyContinue keeps going
  // without printing. Both survive a bad volume — only one keeps the output machine-readable.
  check('S1 errors are not printed onto the output stream', /SilentlyContinue/.test(src) && !/'Continue'/.test(src));
  check('S2 it still keeps going past a bad volume (try/catch per volume)', (src.match(/catch/g) || []).length >= 2);
  check('S3 it emits compressed json, so the object is one line', /ConvertTo-Json[^\n]*-Compress/.test(src));
  check('S4 only RecoveryPassword protectors are collected', /RecoveryPassword/.test(src));
  // The whole feature is pointless if the marker moves without the parser following.
  check('S5 the script emits the marker the parser looks for', src.indexOf(BITLOCKER_MARKER) >= 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
