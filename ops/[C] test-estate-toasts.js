/**
 * Estate toast behaviour — the top-right cards for "new device enrolled" and
 * "Bitdefender installed".
 *
 * Driven in a REAL browser because every rule worth having here is a DOM rule: does a
 * second machine collapse into the existing card or spawn another, does a confirmation
 * upgrade the row it already has, does the X actually forget the card, does a hostile
 * hostname stay text. None of that is provable by reading the function.
 *
 * The socket is stubbed and the handler driven directly, so no server is needed.
 *
 * Run from the Portal folder (needs Playwright + a Chromium, so it wants network the
 * first time):
 *     npx playwright install chromium
 *     node "ops/[C] test-estate-toasts.js"
 */
const { chromium } = require('playwright');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));
  await page.goto('file://' + path.join(__dirname, '[C] test-estate-toasts.html'));
  await page.waitForFunction(() => !!window.__ws, null, { timeout: 5000 });

  const send = async (m) => { await page.evaluate(m => window.__deliver(m), m); await page.waitForTimeout(30); };
  const cards = () => page.$$eval('#lmEstateToasts > div', els => els.map(e => e.innerText));
  const nCards = async () => (await cards()).length;

  console.log('\nEnrolment');
  await send({ type: 'estate', kind: 'enrolled', hostname: 'LVG-RECEPTION', customer: 'Larkmead', customerId: 7 });
  let c = await cards();
  check('E1 one card appears', c.length === 1, String(c.length));
  check('E2 it names the MACHINE', /LVG-RECEPTION/.test(c[0] || ''), c[0]);
  check('E3 it names the CUSTOMER', /Larkmead/.test(c[0] || ''), c[0]);
  check('E4 singular wording for one device', /New device enrolled/.test(c[0] || ''), c[0]);

  await send({ type: 'estate', kind: 'enrolled', hostname: 'LVG-POD', customer: 'Larkmead', customerId: 7 });
  c = await cards();
  check('E5 second machine COLLAPSES into the same card', c.length === 1, 'cards=' + c.length);
  check('E6 the card counts up', /2 devices enrolled/.test(c[0] || ''), c[0]);
  check('E7 both machines listed', /LVG-RECEPTION/.test(c[0]) && /LVG-POD/.test(c[0]), c[0]);

  await send({ type: 'estate', kind: 'enrolled', hostname: 'PRS-01', customer: 'Purely Recruitment', customerId: 9 });
  c = await cards();
  check('E8 a DIFFERENT customer gets its own card', c.length === 2, 'cards=' + c.length);
  check('E9 customers do not bleed into each other',
        !/Purely/.test(c[0]) && !/Larkmead/.test(c[1]), c.join(' || '));

  console.log('\nRollout volume');
  for (let i = 0; i < 36; i++) {
    await send({ type: 'estate', kind: 'enrolled', hostname: 'LVG-WS' + i, customer: 'Larkmead', customerId: 7 });
  }
  c = await cards();
  check('E10 38 machines is still ONE card, not 38', c.length === 2, 'cards=' + c.length);
  check('E11 count is right', /38 devices enrolled/.test(c[0] || ''), (c[0] || '').split('\n')[0]);
  check('E12 only the last few are named, rest summarised', /\+34 more/.test(c[0] || ''), c[0]);

  console.log('\nDismissal');
  await page.click('#lmEstateToasts > div:first-child button[aria-label="Dismiss"]');
  await page.waitForTimeout(30);
  check('E13 the X closes that card', (await nCards()) === 1);
  await send({ type: 'estate', kind: 'enrolled', hostname: 'LVG-NEW', customer: 'Larkmead', customerId: 7 });
  c = await cards();
  check('E14 a dismissed customer can raise a FRESH card (not resurrect the old count)',
        c.length === 2 && /New device enrolled/.test(c.find(x => /Larkmead/.test(x)) || ''),
        c.join(' || '));

  console.log('\nBitdefender');
  await page.evaluate(() => { document.querySelectorAll('#lmEstateToasts > div button[aria-label="Dismiss"]').forEach(b => b.click()); });
  await page.waitForTimeout(30);
  check('E15 board clears', (await nCards()) === 0);

  await send({ type: 'estate', kind: 'endpoint', hostname: 'AMR-008', customer: 'Amryn', customerId: 3, confirmed: false });
  c = await cards();
  check('E16 says installed, not protected', /Bitdefender installed/.test(c[0] || '') && !/protected/i.test(c[0] || ''), c[0]);
  check('E17 machine and customer both named', /AMR-008/.test(c[0]) && /Amryn/.test(c[0]), c[0]);
  // The whole reason the early signal is safe to show: it states what it does not yet know.
  check('E18 says plainly that GravityZone has not confirmed', /awaiting GravityZone/i.test(c[0] || ''), c[0]);

  await send({ type: 'estate', kind: 'endpoint', hostname: 'AMR-008', customer: 'Amryn', customerId: 3, confirmed: true });
  c = await cards();
  check('E19 confirmation UPGRADES the same card, does not add a second', c.length === 1, 'cards=' + c.length);
  check('E20 the machine gains a tick', /✓ AMR-008/.test(c[0] || ''), c[0]);
  check('E21 the awaiting note goes once nothing is pending', !/awaiting GravityZone/i.test(c[0] || ''), c[0]);

  await send({ type: 'estate', kind: 'endpoint', hostname: 'AMR-009', customer: 'Amryn', customerId: 3, confirmed: false });
  c = await cards();
  check('E22 a new pending machine brings the note back', /awaiting GravityZone/i.test(c[0] || ''), c[0]);
  check('E23 confirmed machine KEEPS its tick alongside a pending one',
        /✓ AMR-008/.test(c[0]) && /· AMR-009/.test(c[0]), c[0]);

  console.log('\nSeparation and safety');
  await send({ type: 'estate', kind: 'enrolled', hostname: 'AMR-010', customer: 'Amryn', customerId: 3 });
  c = await cards();
  check('E24 enrolment and Bitdefender are separate cards for the same customer', c.length === 2, 'cards=' + c.length);

  await send({ type: 'estate', kind: 'enrolled', hostname: '<img src=x onerror=alert(1)>', customer: '<b>Evil</b>', customerId: 99 });
  const html = await page.$eval('#lmEstateToasts', e => e.innerHTML);
  // The right test is whether the browser BUILT an element, not whether the word appears —
  // correctly-escaped text still contains the string "onerror", so asserting on the string
  // alone fails on safe output and would have been a false alarm.
  const injected = await page.$$eval('#lmEstateToasts img, #lmEstateToasts b', els => els.length);
  check('E25 a hostile hostname builds NO element', injected === 0, 'elements=' + injected);
  check('E25b it is escaped in the markup', /&lt;img/.test(html), html.slice(0, 120));
  check('E26 a hostile customer name is escaped too', /&lt;b&gt;Evil/.test(html));

  console.log('\nBackstop');
  for (let i = 20; i < 26; i++) {
    await send({ type: 'estate', kind: 'enrolled', hostname: 'M' + i, customer: 'Cust' + i, customerId: 100 + i });
  }
  check('E27 the card stack is capped', (await nCards()) <= 4, 'cards=' + (await nCards()));

  check('E28 no page errors throughout', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
