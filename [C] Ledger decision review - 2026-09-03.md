# Every automated decision on the ledger — reviewed

**Reviewed 2026-09-03.** 22 automatic matches: 4 made by Claude, 18 by the rules engine.
**Verdict: 10 right, 3 probably right but unverifiable, 9 WRONG.**

A 41% error rate on the ones that were acted on automatically. Every wrong one shares a
single cause, and it is not the AI — it is the rule underneath it.

---

## The rule that is doing the damage

Seventeen of the eighteen rules matches carry this reason, word for word:

> *"invoice total matches the payment exactly and no other payment in the window matches that total"*

That rule checks **the amount and nothing else.** Not the supplier. Not the date. Not
whether the document is even an invoice. Not whether that document has already been used on
a different payment. Amount alone is not evidence — it is a coincidence with a number
attached, and on a ledger full of £11.99 subscriptions and £855 rents, coincidences are the
normal case rather than the exception.

---

## Where I disagree

| # | Payment | Attached | Why it is wrong |
|---|---|---|---|
| 574 | **Daniel O'Kelly £90.00**, coded **Wages** | `Invoice-TXPMYYAL-0004.pdf` — an **Anthropic** receipt | Wrong supplier entirely. A wages payment now carries an AI-subscription invoice. Payroll should never take an invoice at all |
| 521 | **Disney Plus £14.99** | a **20i hosting invoice** (9555049) | Wrong supplier — and Disney Plus is personal spend that should not be in the business account at all |
| 517 | **Starlink £100.00** | `Statement 15-02-2026 14-03-2026.pdf` | A **statement**, not an invoice. Statements must be excluded from matching outright — that rule already exists for intake and was never applied here |
| 593 | **Aventis £855.00**, 18 Aug | rent invoice **INV-2119 dated 16 February** | Six months apart. The rent is £855 *every* month, so "exact amount, nothing else matches" picks whichever it finds first. Worse, INV-2119 is one of the three the £2,565 payment already covers — so it is now counted twice |
| 561 | **Ubiquiti £29.00**, 7 Aug | a **Stripe** receipt dated **7 April** | Wrong supplier, four months out, and its "invoice number" is `BF13A7E2` — the Stripe account id we already know is not an invoice number |
| 594 | **Paddle £7.10**, 18 Aug | CrashPlan receipt dated **19 April** | Right supplier, four months out. A monthly subscription matched to the wrong month |
| 592 | **Zoho £42.24**, 18 Aug | Zoho invoice dated **18 June** | Right supplier, two months out |
| 566 | **PayPal £6.99** | `6.99.pdf` | A file named after its own amount, matched to a payment of that amount, through a processor that hides the real supplier. There is no supplier evidence here whatsoever |
| 553 | **Anthropic £180.00**, 4 Aug — *Claude, 92%* | receipt dated **4 July** | Claude reasoned "one month later, consistent with the following billing cycle". It is not: a card subscription receipt is issued on the day it is charged, so the 4 July receipt belongs to the 4 July payment. The August payment has its own receipt |

## Where I agree

| # | Payment | Why it is sound |
|---|---|---|
| 520 | GoCardless £314.10 → Pi Accountancy invoice 5164 | Followed the reference `PIACCOUNTANC-DM9NS` through the processor to the real supplier. Six days apart. Exactly right |
| 164 | 20i £11.99 — *Claude, 91%* | Claude **rejected** the June charge as "the wrong period" and took July. Period reasoning, not amount reasoning — this is the standard the rest should meet |
| 195 | Paddle £7.15 → CrashPlan | "supplier matches and the USD/GBP conversion is in range". Sound FX reasoning on a small foreign charge |
| 285 | Giacom £1,421.24 — *Claude, 95%* | Invoice 11 May, DD collected 25 May. Right supplier, sensible collection lag |
| 351 | Giacom £4,540.44 — *Claude, 92%* | Correct match — but see the contamination note below |
| 573 | DWS £785.28 → `PKL28945-909978.pdf` | The bank reference `PKL28945` is in the filename. Strong corroboration |
| 565, 524 | Giacom £4,859.77 and £1,495.69 | Right supplier, 13 days invoice-to-collection both times |
| 550, 541 | FastSpring → MSP360 receipts | One day apart, processor correctly followed to MSP360 |

**Probably right, unverifiable:** 587, 511 (20i) and 571 (Atera). Right supplier and amount,
but 20i has several identical charges and nothing in the reason distinguishes them.

---

## Two things found while reviewing

**Profile contamination.** Claude's reasoning on payment 351 says: *"The learned supplier
facts note that 'anthropic' is the bank descriptor"* — while matching a **Giacom** invoice.
Anthropic's bank descriptor has been learned onto Giacom's supplier profile. It reached the
right answer despite its own notes, which is luck, not judgement. The profiles need rebuilding
once the supplier master is confirmed.

**Another personal subscription.** Disney Plus £14.99 is on the business account. It did not
appear on yesterday's personal list because it had been (wrongly) matched to an invoice, so it
looked complete.

---

## The rules that would have prevented all nine

1. **One document, one payment.** A document already attached elsewhere can never be offered
   again. This alone kills the Aventis double-count.
2. **Amount is never sufficient.** A match needs the amount **and** corroboration — supplier
   alias, bank reference, or the invoice number in the filename.
3. **Date proximity, by payment method.** Card 0–3 days, direct debit 0–30, transfer 0–45.
   **Nothing matches across more than 60 days, ever.** That is five of the nine.
4. **Recurring fixed amounts get no amount-only match at all.** Where a supplier bills the
   same figure repeatedly — rent, subscriptions — the date decides, or nobody does.
5. **Statements never match.** `doc_type = 'statement'` is excluded from the candidate pool
   outright, not merely deprioritised.
6. **Processors resolve to the real supplier first.** PayPal, Stripe, FastSpring, GoCardless
   and Paddle must match through the reference. Where the underlying supplier cannot be
   established, no match.
7. **A filename that is only an amount is not evidence.** `6.99.pdf` corroborates nothing.
8. **Cross-supplier matches are vetoed absolutely.** If the document's supplier is known and
   differs from the payee's, logic refuses — Claude does not get a vote. Wages against an
   Anthropic receipt, and Disney Plus against a 20i invoice, both die here.
9. **Payroll takes no invoice.** Wages are evidenced by payroll records.
10. **Personal payees are never matched** — they are justified, or moved off the account.

Rules 1, 3, 5 and 8 are pure logic and can be enforced as absolute vetoes today. They account
for **all nine** wrong decisions on their own.
