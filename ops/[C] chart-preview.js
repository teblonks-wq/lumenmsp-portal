#!/usr/bin/env node
/**
 * [C] chart-preview.js — wrap a chart/board preview in an UNMISSABLE "SAMPLE DATA"
 * stamp, unless the caller proves the figures are real.
 *
 * WHY THIS EXISTS (2026-08-24). A preview of a new OneBoard chart was rendered from a
 * fixture, labelled "Didcot" and "231 days of history", and sent to Terry. It looked
 * exactly like Larkmead's data. He asked "is this real data — inside the platform the
 * worst time is 08:00-10:00", which it was not: the 09:00 peak was invented to give the
 * renderer something to draw. Ten minutes were spent reasoning about a number that came
 * out of a fixture.
 *
 * The rule is not "remember to say it's a mock". A rule that depends on remembering has
 * already failed once. The stamp is the DEFAULT here and has to be switched off on
 * purpose, so the failure mode is a real chart wearing a SAMPLE banner — embarrassing,
 * not misleading — rather than a fake one passing as truth.
 *
 * Usage:
 *   node "ops/[C] chart-preview.js" in.html out.html                 # stamped SAMPLE DATA
 *   node "ops/[C] chart-preview.js" in.html out.html --real "Larkmead, 1 Jan-23 Aug 2026"
 *
 * The --real flag takes a SOURCE, not a boolean. If you cannot name where the numbers
 * came from, they are not real enough to send.
 */
const fs = require('fs');

const [, , inPath, outPath, ...rest] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: chart-preview.js <in.html> <out.html> [--real "<where the data came from>"]');
  process.exit(2);
}

const realIx = rest.indexOf('--real');
const source = realIx >= 0 ? String(rest[realIx + 1] || '').trim() : '';
if (realIx >= 0 && !source) {
  console.error('--real needs a source: --real "Larkmead production, 1 Jan-23 Aug 2026"');
  process.exit(2);
}

const html = fs.readFileSync(inPath, 'utf8');

const SAMPLE_BANNER = `
<div style="position:sticky;top:0;z-index:9999;background:#7f1d1d;color:#fff;font:700 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;padding:9px 16px;letter-spacing:.02em;">
  SAMPLE DATA &mdash; invented figures for checking the drawing only. NOT Lumen or customer data. Every number below is made up.
</div>`;

// A repeating diagonal wash across the whole page. Deliberately visible: it has to
// survive being screenshotted and cropped, because that is how these end up in chat.
const SAMPLE_WASH = `
<style>
  body { position: relative; }
  body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 9998;
    background-image: repeating-linear-gradient(-30deg,
      rgba(127,29,29,.055) 0 190px, rgba(127,29,29,0) 190px 380px);
  }
  .sample-mark {
    position: fixed; pointer-events: none; z-index: 9998;
    font: 800 26px/1 system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: rgba(127,29,29,.16); transform: rotate(-30deg); white-space: nowrap;
    letter-spacing: .12em;
  }
</style>
<div class="sample-mark" style="top:18%;left:4%;">SAMPLE DATA</div>
<div class="sample-mark" style="top:46%;left:34%;">SAMPLE DATA</div>
<div class="sample-mark" style="top:74%;left:12%;">SAMPLE DATA</div>`;

const realBanner = (src) => `
<div style="position:sticky;top:0;z-index:9999;background:#065f46;color:#fff;font:600 12.5px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;padding:8px 16px;">
  REAL DATA &mdash; ${String(src).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}
</div>`;

const inject = source ? realBanner(source) : SAMPLE_BANNER + SAMPLE_WASH;
const out = /<body[^>]*>/i.test(html)
  ? html.replace(/(<body[^>]*>)/i, `$1${inject}`)
  : inject + html;

fs.writeFileSync(outPath, out);
console.log(source ? `stamped REAL (${source}) -> ${outPath}` : `stamped SAMPLE DATA -> ${outPath}`);
