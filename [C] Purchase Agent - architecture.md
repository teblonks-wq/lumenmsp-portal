# Purchase Agent — architecture

**Status:** design, 2026-09-02. Supersedes nothing; read alongside
`[C] Purchase Ledger - re-model design.md` (the data model this runs on).

**Terry's brief:**
> "we need a real agent approach to this - not just a bit fancy email scanning ... forget
> everything we have I mean it, dont delete and if what we have is usful then so be it but
> dont let is cloud our vision ... make a system that is as effective as support and all
> the other modules."

---

## 0. What actually separates an agent from a scanner

A scanner reads what arrives and tells you what is missing.
**An agent goes and gets what is missing, and keeps going until the ledger balances.**

Everything below follows from that one sentence. Three properties make it true, and the
current system has none of them:

1. **State** — it knows where every purchase is up to, so it can tell "not finished yet"
   from "gone wrong". Today everything unfinished reads as an alarm; that is why the list
   hit 533.
2. **Memory that is a record, not a guess** — a supplier is a row a human confirmed once,
   not a string re-derived from a bank narrative on every pass.
3. **A job queue with retrieval in it** — when an invoice is behind a portal login, the
   agent takes a job to go and fetch it. It does not file a finding saying it could not.

---

## 1. What the real corpus says

Measured today from `Finance\Purchasing\Invoice Export\manifest.csv` — 161 messages,
342 PDFs, Feb–Aug 2026. Every number below is a design requirement, not a defect report.

| finding | number | what it forces |
|---|---|---|
| Attachments that are byte-identical copies | **40 of 124** (32%) — 84 distinct files | Dedupe must be a first-class stage. **These are convergence, not mess** — see §1a |
| Messages flagged as duplicates of another | **40 of 161** (25%) | The **message** must be an object. One invoice arriving in three mailboxes is one document with three messages |
| Emails with no attachment at all | **37 of 161** (23%) | An invoice behind a link is normal, not an error |
| Invoice is portal-only, must be downloaded | **27** — MSP360 ×18, Giacom ×7, Microsoft ×2 | Retrieval is a **job**, and it concentrates in a handful of suppliers, so it is automatable |
| No amount could be read | **47** (29%) | Reading is a stage that can fail and be retried, with its own state |
| No invoice number could be read | **63** (39%) | The invoice number cannot be the identity key. Sha256 + (supplier, period, gross) must carry it |
| Arrived in Terry's personal mailbox | **118 of 161** — only 38 in `invoices@` | The pool mailbox is not where invoices live. Multi-mailbox ingest is the baseline, not a fallback |
| Filed as "Forwarded - check" | **12** | Forwarding hides the real supplier. The sender is evidence, never identity |
| Receipts vs invoices | 88 receipts / 72 invoices | Card receipts are the majority of documents and need equal standing |
| Suppliers | 22, top five cover **101 of 161** | Confirming ~10 suppliers properly covers most of the ledger. Phase 1 is an afternoon, not a project |

## 1a. Two kinds of duplicate, and only one of them is work

Terry, 2026-09-02, correcting an earlier misreading of this corpus:

> "to be clear i imported invoices from two sources to ensure portal had access to all that
> I had to hand, this wasnt an accident."

That is the right instinct and the system must reward it, not punish it. Duplicates split
into two classes that must never be handled the same way:

**Convergence duplicates — the same document reaching us by more than one route.**
A mailbox export plus a downloads folder; `invoices@` plus a personal mailbox; a re-run of
the same import. These are the *expected* result of making sure nothing is missed. They are
**merged silently, both provenances kept, and never shown to a human as work.**
Deliberately importing the same thing twice is a supported operation, not an error.

**Supplier duplicates — the same invoice genuinely issued or sent twice**, or a second
invoice raised against one purchase. *This* is the one that can cost money; it is what the
already-paid check exists for, it stays in front of a human, and it can never be suppressed.

Measured on the two sources in this folder: the mailbox export holds 84 distinct files,
`From Downloads` holds 237, and **only 2 files are in both.** The dual import added coverage
and almost no redundancy. The 40 duplicates are *within* the mailbox export — one invoice
sitting in several mailboxes, or re-sent by the supplier — which is precisely what the
message object exists to resolve.

**Consequence for ingest:** every import path is idempotent on sha256, so re-running an
import converges instead of doubling. Sources are additive and each is recorded, so "where
did this copy come from?" is always answerable.

### No folder is an input

Terry, 2026-09-02: *"from download it needs sorting — this folder will not be used ongoing,
in fact no folder will."*

**There is no watched folder, ever.** Invoices reach the Portal from the mailboxes and from
supplier portals via retrieval jobs. Bulk upload stays as a deliberate human action for a
one-off catch-up; it is not a channel. Folder ingest exists once, for migration, and is then
retired. This is why `From Downloads` gets sorted and read once and never again — and it is
also the answer to how documents stop going astray: there is nowhere for them to go astray
*to*.

Related, same day: **Giacom has been asked to email invoices to `invoices@` directly.** That
removes 7 of the 27 portal-only retrievals and is the pattern to repeat with every supplier
that will do it — a supplier that emails the pool needs no retrieval job at all. Ask first,
automate second.

⚠ **`From Downloads` is not an invoice folder.** 237 files, a large share of them CVs,
candidate paperwork and other non-purchase documents carrying personal data. It goes through
classify-then-select, never bulk ingest. Nothing that is not a purchase document should ever
land in the purchase ledger.

---

**The export tool already got several things right and we should keep its concepts
wholesale:** `Sha256`, `DuplicateOfRowId`, `ManualDownloadRequired`, `PortalLink`,
`InternetMessageId`, `WebLink`, `Confidence`, `MatchReason`, and a per-supplier rules file
with `PortalOnly: true`. That is an evidence model. The Portal currently has a weaker one.

---

## 2. Objects

**Supplier** is the spine (see the ledger design doc). Six objects sit under it.

### `messages` — the email itself, first class

`mailbox`, `internet_message_id`, `graph_message_id`, `web_link`, `from_name`,
`from_address`, `subject`, `received_at`, `body_text`, `body_hash`, `supplier_id?`,
`state`, `duplicate_of_id?`.

States: `ingested → identified → documented | portal_only | forwarded | not_a_purchase | duplicate`

Why this matters: it is the only place a **duplicate** can be judged honestly, and the only
place an email with **no attachment** can be something other than a dead end.

**Duplicate detection runs at three levels, in this order:**

1. `internet_message_id` identical → the same email, seen twice (multi-mailbox ingest).
2. attachment `sha256` identical → the same file, however it arrived. *32% of this corpus.*
3. same supplier + invoice number + gross → the same invoice, re-sent as a new PDF
   (reminders, "copy invoice" requests). Vetoed by the existing invoice-number and date
   rules so a genuinely different invoice is never merged.

A duplicate is **linked, never deleted.** Terry's standing rule holds: we keep everything
for tax; the second copy just stops being a second piece of work.

### `retrieval_jobs` — the agent goes and gets it

Raised when a message is `portal_only`: `supplier_id`, `message_id`, `portal_url`,
`method` (supplier_login | api | human), `credential_id?`, `state`
(queued | running | fetched | needs_human | failed), `attempts`, `last_error`.

- `method = supplier_login` uses the Portal's existing credentials vault. MSP360 (18) and
  Giacom (7) alone are 25 of the 27, so two integrations clear >90% of them.
- `method = human` produces a **one-line task with the link in it** — a 30-second job with
  a button, not a finding to investigate.
- Every fetched document lands back on the same message, so provenance survives.

This is the single feature that most makes it an agent rather than a scanner.

### `documents` — the paper (today's `purchase_documents`, kept)

Gains `message_id`, `sha256` (already there), `superseded_by_id`, and a **read state**:
`unread → read → unreadable → read_by_human`. Reading is retried, not abandoned; 29% of
this corpus needed a second look.

### `purchases`, `purchase_allocations`, `periods`

As specified in the ledger design doc. The purchase is the unit; allocations are
many-to-many with amounts; Terry closes the month.

### `proposals`

The **only** way the agent changes the ledger — Terry's decision, 2026-09-02. Grouped by
`group_key` so one accept covers a batch. Without grouping, "always propose" is just
"check every line" with extra clicks.

---

## 3. The pipeline

```
ingest ─► identify ─► classify ─► read ─► retrieve? ─► link ─► allocate ─► propose ─► reconcile ─► close
```

Every stage writes what it saw, what it concluded, its confidence, and which rule or model
decided. That trail is what makes a bi-monthly review possible and what an auditor would
ask for.

**Division of labour, unchanged from `purchase-terms.ts`:**
**Logic decides facts and may veto absolutely. Portal-AI decides meaning and may never
overrule a fact.** It gets evidence, never conclusions.

- Identity, arithmetic, hashes, dates, amounts → **logic**. A different invoice number is
  a different invoice, full stop.
- "Is this the same purchase?", "is this rent or financing?", "does this line item explain
  the jump?" → **judgement**, always as a proposal.

---

## 4. Purchase orders — EST → PO → INV → PAY → REC

The sales side already has the shape: `Quote.quoteNumber` → `Invoice.invoiceNumber`
allocated at Complete. The purchase side gets its mirror.

```
Estimate/quote (EST)  ─►  PO-2026-0001  ─►  supplier invoice  ─►  payment  ─►  reconciled  ─►  closed
   what we were quoted     what we committed    what we were billed   what left    paper=money      period shut
```

`purchase_orders`: `po_number` (PO-YYYY-NNNN), `supplier_id`, `quote_id?` (the EST it came
from), `raised_by`, `approved_by?`, `state` (draft | approved | sent | part_received |
received | invoiced | closed | cancelled), `expected_total`, lines, `customer_id?` and
`ticket_id?` for cost-of-sale that belongs to a job.

This unlocks the **three-way match** — PO vs invoice vs payment — which is the actual
control every finance system is built around, and the thing that makes a price rise or an
over-delivery visible *before* the money goes, not two months after. It is also what lets
"which customer did we buy this for?" be answered, which today it cannot be.

A PO is not mandatory for everything (nobody raises a PO for a kebab). Per supplier:
`po_required: always | over_threshold | never`.

---

## 5. Supplier credit accounts → cash flow

**Confirmed by Terry, 2026-09-02 — we hold credit with exactly three suppliers:**

| account | note |
|---|---|
| **Giacom — Hardware** | the hardware account only. Giacom's cloud/licence billing (Giacom World Networks / DWS) is a **separate** relationship and must be a separate supplier account, or hardware spend and monthly licence spend pool together again — the mistake the per-kind supplier profiles already exist to prevent |
| **Adept Networks — Swindon** | |
| **All Trade** | |

Everything else is **paid at the point of purchase** — card, direct debit or transfer. That
single fact shapes more of this system than anything else in this document:

- **The payables ledger is three suppliers deep.** Cash flow "due" is knowable and small.
- **For every other supplier, invoice and payment are near-simultaneous.** So a wide date
  window is not needed to match them, and an unmatched invoice more than a few days old is
  a real question rather than normal lag.
- **"Unpaid invoice after 45 days" is only meaningful for these three.** Applied to a card
  supplier it is noise, and it was a large part of the 533.
- **Statements matter for exactly these three.** Reconciling a supplier statement against
  what we hold is how a credit account is checked, and it is the fastest way to recover a
  missing invoice — an Adept statement would produce the £423.92 from 10 June that the
  bookkeeper has down as "No Invoice", without asking anyone.
- **Purchase orders belong mainly here too.** `po_required: always` fits a credit account;
  `never` fits a card purchase.

Terms, credit limits and statement days for the three still need capturing — one short
conversation, and the cash flow module has everything it needs.

`supplier_accounts`: `supplier_id`, `account_ref`, `credit_limit`, `terms`
(net_30 | eom_30 | net_14 | on_receipt | prepay), `statement_day`, `direct_debit`,
`self_billed`, `contact`. Balance is derived, never typed.

Once POs and terms exist, cash flow falls out of data we already hold:

- **Committed** — approved POs not yet invoiced
- **Due** — invoices in `documented`, dated by supplier terms
- **Collected** — the sales side's invoices and GoCardless collections
- **Headroom** — credit limit minus current balance, per supplier

That is the cash flow module, and it needs no new data entry — only the PO and terms
fields above.

---

## 6. The bank

**Statements auto-upload** (already coming): parse into `bank_transactions` with
`source='statement'` plus `statement_id` and the line number, so every figure traces to a
page. Statement import must be **idempotent on (account, date, amount, narrative, seq)** or
a re-upload silently doubles the ledger.

**Direct access — the honest answer.** `src/lib/openbanking.ts` is already a stub adapter
naming the two realistic routes, and the sales side already carries
`gocardlessPayoutRef`, so **there is an existing GoCardless relationship to build on.**

- **GoCardless Bank Account Data** (formerly Nordigen) — free tier, UK/EU AISP, covers the
  UK high street. Cheapest path and we are already a customer.
- **TrueLayer** — better coverage and support, paid.
- Both are read-only AISP. Consent is **OAuth in the bank's own app and expires roughly
  every 90 days** — that renewal is a recurring human task and must be a scheduled
  reminder, not a surprise outage.
- Neither can move money, which is correct: the Portal should never be able to pay.

Practical order: statement upload now (works today, no dependencies) → GoCardless keys and
a one-time consent → the `syncOpenBanking` TODO wired to upsert like the CSV path. The
existing CSV import stays as the fallback for ever.

---

## 6b. QuickBooks IS the bank feed — statement import is dropped

Terry, 2026-09-02: *"if you can see the already linked bank we dont need to import statements."*

Correct, and it removes a whole subsystem. QuickBooks already has the live bank feed, and
every **accepted** feed line exists as a queryable QB transaction. So the Portal stops
importing bank data and starts **reading it from QuickBooks** — `bank_transactions` is
populated from QB (Purchase, Deposit, Transfer, BillPayment on the bank accounts) rather than
from CSV or a statement PDF, keyed on the QB transaction id so the sync is idempotent.

What this deletes from the plan:

- **Bank statement import** — not needed. The Starling statement PDFs sitting in
  `From Downloads` were a manual workaround for exactly this.
- **Open banking / GoCardless Bank Account Data** — demoted from a phase to an *option*. Its
  only remaining value is a live cash view **ahead of** the bookkeeper accepting feed lines.
  Worth doing later for cash flow; not needed for reconciliation at all. That also removes
  the 90-day AISP consent renewal from the critical path.
- **CSV import** stays as the fallback for a bank QuickBooks is not connected to.

⚠ **What is NOT dropped: supplier statements.** Different thing entirely. A bank statement is
a list of money that moved — QuickBooks has that. A *supplier* statement from Giacom Hardware,
Adept or All Trade is a list of what **they** think we owe, and reconciling it against the
Bills we hold is the only way a credit account gets checked, and the fastest way to name a
missing invoice. Those are still ingested, still parsed, still reconciled.

### The one limitation, stated plainly

**Only accepted transactions are visible.** Anything still sitting in QuickBooks' "For Review"
queue cannot be read — Intuit does not expose it, because the feed data is bought from Plaid
and Yodlee and an open API would let it be extracted without paying them. This is a firm
product boundary, not a gap in our integration, and no amount of design gets around it.

So the Portal's picture of the bank is **whatever the bookkeeper has accepted**, and it lags
her by however long she takes. For attaching paperwork and reconciling, that is fine — the
paperwork is not late, it is just applied slightly after the entry appears. For a live cash
position it is not fine, and that is the one thing open banking would later buy us.

*(A second route exists for the lag: QuickBooks accepts receipts and bills forwarded by email
into its Receipts inbox, where QB itself matches them to feed lines. It would put paperwork
against For Review items without API access — but QB does the matching, so we lose our own
provenance and control. Keep it in reserve, do not build on it.)*

---

## 6a. QuickBooks — closing the loop

Terry, 2026-09-02: *"we do need to collect the invoices and have them add to and then bank
payments reconcile accounts - we would need to influence QB as well."*

The whole loop, end to end:

```
collect  ─►  read  ─►  match to payment  ─►  categorise  ─►  push to QB with the invoice attached  ─►  reconciled  ─►  month closed
```

QuickBooks is the accounting record and the bookkeeper works in it. **The Portal's job is to
make QB correct without anyone re-keying, and with the invoice attached to the entry.** Get
that right and nobody has to chase us for paperwork, because the paperwork is already in the
system they are looking at.

### What already works

`lib/quickbooks.ts` is further along than expected: OAuth with token refresh, expense and
bank account lookup, `createPurchase`, `attachToPurchase` via the Attachable multipart
endpoint, and `getPurchaseHistory` feeding category learning. `bank_transactions.qb_purchase_id`
is stored on push, so **it is already idempotent** — a pushed transaction cannot be pushed
twice. Keep all of it.

### Three real gaps

**1. No vendor.** `createPurchase` puts the payee in `PrivateNote` and sets no `VendorRef`,
so QuickBooks holds no supplier link at all — supplier reporting inside QB cannot work, and
neither can any per-supplier check the accountant runs. Once the supplier master exists it
maps to QB **Vendors**, and the Portal's supplier becomes the same object the accountant
sees. `supplier.qb_vendor_id` alongside the aliases.

**2. Credit accounts are being posted as if paid on the spot.** A QB `Purchase` means money
already gone — correct for card and DD, which is nearly everything we buy. But the three
credit accounts (Giacom Hardware, Adept Networks Swindon, All Trade) create a liability when
the invoice arrives and settle it later. In QuickBooks that is a **Bill**, then a
**BillPayment** against it. Posting those as Purchases understates payables and makes the
supplier statement impossible to reconcile.

So the posting rule follows straight from the supplier record:

| supplier | QB object |
|---|---|
| pays at point of purchase (card, DD, transfer) | `Purchase` + attachment — as today |
| on credit (the three) | `Bill` on invoice → `BillPayment` on payment, both attached |

**3. The bank feed owns every bank line. CONFIRMED by Terry, 2026-09-02: bank feeds are
live in QuickBooks.** That settles the posting design, and it settles it as one rule:

> **The Portal never creates anything in QuickBooks that has a bank line.**

| QB object | has a bank line? | who creates it |
|---|---|---|
| `Bill` (the three credit accounts) | no — a Bill is a liability, nothing has left the bank | **Portal creates it** |
| `Purchase` (card, DD, transfer — nearly everything) | yes | **the bank feed creates it.** Portal never posts one |
| `BillPayment` (settling a credit account) | yes | **the bank feed**, matched against the open Bill |

For everything with a bank line the Portal's job changes from *create* to **enrich**: once the
feed line has been accepted and exists as a QB transaction, the Portal finds it by
account + date + amount, **sets the expense account and attaches the invoice PDF.** A
background sweep, running behind whatever the bookkeeper is already doing.

This is a better outcome than posting, not a compromise:

- **Duplicates become structurally impossible.** Not "unlikely if the matcher behaves" —
  impossible, because only one system ever creates a bank line.
- **The bookkeeper's workflow does not change at all.** She accepts feed lines in QB exactly
  as she does today, and the receipts simply appear on the entries behind her. Nothing to
  learn, nothing to adopt, no reason to resist it.
- **The chasing stops for the right reason** — not because we send her a list, but because
  the paperwork is already attached to the entry she is looking at.

The only cost is a lag: the Portal can only enrich a transaction after the feed line is
accepted. Unaccepted feed items sit in QuickBooks' "For Review" queue, which **the Accounting
API does not expose** — so there is no way around this, and no point designing one. The sweep
simply runs continuously and picks each entry up shortly after it lands.

⚠ **Check before anything else ships:** `createPurchase` is wired to the Submit button on the
reconcile screen (behind the `purchases.qb_push_enabled` setting). With feeds live, every
Purchase it posted is a candidate duplicate of a feed line — QuickBooks offers "Match" but a
person can just as easily click "Add", and then the expense is in twice. **Confirm whether
that flag has ever been on, and if so spot-check QB for double entries over that period.**
Once the rule above is implemented, that push is removed rather than fixed.

### Managing the credit accounts — Portal in front of QB, never instead of it

Terry, 2026-09-02: *"we don't need purchase orders to go QB, but if we're managing credit
accounts on Portal what is the best way forward."*

Agreed on POs — they stay Portal-only. QuickBooks purchase orders add friction for the
bookkeeper and nothing for us. But that raises the real risk in this whole design:

> **Two systems must never both keep the payables balance.** The moment the Portal holds a
> liability figure of its own, it is a second set of books, and second sets of books drift.

So the split is by *kind of fact*, and it is absolute:

| | owns |
|---|---|
| **QuickBooks** | the **liability**. Bills, BillPayments, the AP balance, VAT, year end. Statutory, and the bookkeeper's and accountant's record |
| **Portal** | the **operational layer QB has no idea about** — the PO, what was ordered and received, the invoice document itself, statement reconciliation, credit headroom, disputes, and which customer or job the spend belongs to |

The Portal computes nothing it cannot check. **Credit headroom is `credit_limit` minus the
open Bill balance read back from QuickBooks** — not a running total the Portal keeps for
itself. If the Portal's expectation and QB's balance disagree, that disagreement is an
exception raised to a human. It is never quietly reconciled away.

### The flow for a credit supplier

```
PO raised in Portal            (never sent to QB — internal authorisation, budget, job link)
   ↓
invoice arrives, matched to the PO
   ↓
Portal proposes → Terry accepts → Bill created in QB
        VendorRef, expense account, invoice PDF attached,
        PO number carried in DocNumber/Memo so the chain survives into QB
   ↓
payment leaves the bank, matched
   ↓
BillPayment against that Bill      (part-payments work natively — the reason to use Bills)
   ↓
monthly statement reconciled against the Bills we hold
```

The PO number riding in the Bill's `DocNumber`/`Memo` is what gives us EST → PO → INV → PAY
visible inside QuickBooks **without pushing a single PO object.** That is the whole answer to
"we don't need POs in QB": the *number* goes, the *object* stays here.

Because Terry's standing decision is that the agent always proposes, and creating a Bill
writes into an external accounting system, **every Bill and BillPayment is a proposal he
accepts.** Grouped per supplier per statement period, so accepting a month of Giacom Hardware
is one action.

### What this needs building in `lib/quickbooks.ts`

Today it has `createPurchase` and `attachToPurchase` only. New:

- `getVendors` / `createVendor`, and `supplier.qb_vendor_id` on the supplier master
- `createBill` (VendorRef, line to expense account, DocNumber = supplier's invoice number,
  Memo = our PO number) + attachment
- `createBillPayment` (against one or several Bills — part-payment and one-payment-covers-
  several both fall out for free, which is the Aventis case solved properly rather than by a
  subset-sum detector)
- `getVendorBalance` / open Bills per vendor — so headroom and drift are read, never assumed
- `qb_bill_id` and `qb_bill_payment_id` stored alongside the existing `qb_purchase_id`, so
  every push stays idempotent

### Statement reconciliation — the payoff for the credit accounts

For the three credit suppliers, a monthly statement is the check: every line on the
supplier's statement should meet a Bill we hold. Anything on their statement we do not hold
is a **missing invoice we can name and request** — and anything we hold that is not on their
statement is a query for them. This is how the Adept £423.92 gets found without asking
anybody, and it is why statements are ingested as statements rather than ignored as
not-invoices.

---

## 7. "Ask Portal", not "Ask Claude"

Terry, 2026-09-02: *"we need to interchange the work Claude for Portal all over — like Ask
Portal or Ask Insights, it will always be ask Portal or insights for time being."*

75 occurrences across 26 view files. It is **not** a search-and-replace, because two
different things are called Claude today:

- **A Portal feature that happens to use AI** → rename. "Ask Claude" → **Ask Portal**;
  inside Insights → **Ask Insights**. "Improve with Claude" → "Improve with Portal".
  "Review with Claude" → "Review with Portal". Claude's read of a script → "the Portal's
  read".
- **The actual Claude app connecting in from outside** (MCP tokens, the Admin page reading
  "who can point Claude at the Portal") → **stays Claude**, because that is literally what
  it is.

One shared label constant so it changes in one place next time, and so the two meanings
can never drift back together.

---

## 8. Phases

**Phase 1 — the supplier master.** Derive from the 22 suppliers in the export plus the
existing profiles, ranked by spend. Terry confirms the top ten; aliases seed from the
sender patterns in `invoice-rules.json` and the bank narratives on confirmed matches.
Everything downstream is unreliable until this exists.

**Phase 2 — messages, dedupe, retrieval.** Multi-mailbox ingest across the eleven mailboxes
in `mailboxes.json`; three-level dedupe; portal-only becomes a retrieval job. MSP360 and
Giacom first — they are 25 of the 27.

**Phase 3 — import the corpus.** 342 PDFs and 161 messages in, deduped, read, and mapped to
purchases. This is the moment the ledger stops being a sample and becomes the record.

**Phase 4 — purchases, allocations, periods.** The re-model proper. Close a month.

**Phase 5 — POs and credit accounts.** EST → PO → INV → PAY → REC, three-way match.

**Phase 6 — cash flow, then open banking.**

**Running throughout — the rename.**

⚠ **Prisma:** every new column goes in `schema.prisma`. `prisma db push` DROPS anything it
does not know about, on every deploy.

---

## 9. What we keep from what exists

Terry said not to let the current system cloud the vision, and not to delete it. These
survive on merit, not sunk cost:

- **`purchase-terms.ts`** — the logic/judgement division. It is the constitution.
- **Duplicate detection** — `sha256`, the invoice-number veto, the shared-reference guard.
  Hard-won and correct; it moves up to the message level.
- **The reply-and-rule loop** — replying to a finding and having it become a standing rule
  is the right interaction. It becomes reply-to-a-proposal.
- **`aiReadInvoiceDoc`** — native PDF reading with no OCR install.
- **The export tool's evidence columns** — adopt them wholesale.
- **The decision log** — every change already lands somewhere reviewable.

What goes: the anomaly list as a work queue, `dupe_status`/`suggest_txn_id` as scattered
state, the ignore list (becomes `invoice_expected` on the supplier), and one-to-one
matching.
