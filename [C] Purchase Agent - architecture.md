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
