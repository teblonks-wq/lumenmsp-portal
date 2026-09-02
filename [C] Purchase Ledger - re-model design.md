# Purchase Ledger — re-model

**Status:** design, agreed 2026-09-02. Nothing built yet.
**Decided by Terry, 2026-09-02:** full re-model; the agent always proposes, never acts alone; Terry closes the month.

---

## Why we are doing this

The trigger was the worklist going from 78 to 266 to 533 while the underlying business
got no worse. Terry: *"there is more to look at not less"*, and then the sentence that
matters most:

> "I dont want to have to check every line for vailidty as i may as well do it the old fashioned way."

That is not a complaint about the list. It is a complaint about the model underneath it.

### The ledger has two spines and no record of a purchase

`bank_transactions` (money) and `purchase_documents` (paper) are peers, joined by one
nullable foreign key. **Nothing in the database is called a purchase.** So every question
we ask the ledger — "have we got the invoice for this?" — is a join that can fail, and
every failed join is surfaced to a human as a line to read. The list therefore grows with
VOLUME, not with PROBLEMS. That is the whole bug.

Three consequences, all of which bit us in the week of 2026-09-01:

**1. One-to-one in a many-to-many world.**
A £2,565.00 payment to Aventis is three months of rent at £855.00, and all three invoices
were already in the pool. That needed a bespoke `findPaymentCoversSeveral` detector with a
bounded subset-sum in it. An invoice paid in two instalments still cannot be expressed at
all. Neither can a refund. Every one of these needs its own detector because the schema
cannot say "part of this money settles part of that paper".

**2. There is no supplier master.**
`normaliseCounterparty()` re-guesses the supplier from the bank narrative on every single
pass. "Amazon", "Amazon.co.uk" and "Amazon J Tf" are three different suppliers to this
system. `supplierKey` once resolved to **"terry o"** because a forwarded invoice was keyed
to the forwarder — which then had Claude writing about a conflict of interest concerning
its own user. And Aventis sat on the no-invoice-expected list as *financing*, guarded by a
`(?!.*rent)` lookahead that the actual bank narrative does not contain — which would have
permanently exempted **our landlord** from ever needing an invoice.

Almost every wrong call this system has made traces back to this single absence.

**3. Nothing can ever be finished.**
State is spread across `status`, `dupe_status`, `ai_read_status`, `doc_type`,
`archived_at`, `suggest_txn_id`, `bank_transaction_id` — plus a `purchase_anomalies` table
carrying its own independent status. No single field answers "where is this up to". And
there is no period close, so nothing is ever done and the list can only accumulate.

---

## The new shape

> **The supplier is the spine. The purchase is the unit. Money and paper are both just
> evidence attached to it.**

### `suppliers` — a real record, not a guess

| field | why |
|---|---|
| `name`, `slug` | canonical, one per real company |
| `status` | active / dormant / blocked |
| `buys` | what we buy from them (hardware, licence, connectivity, rent, fuel, subsistence, professional services) |
| `invoice_expected` | **always / sometimes / never**, with a `reason` and a `review_on` date |
| `invoice_source` | email / supplier portal / download / none |
| `cadence_days`, `billing_day` | what "on time" means for THIS supplier |
| `default_category_id` | the coding, decided once |
| `vat_treatment` | standard / exempt / reverse charge / outside scope |
| `payment_method` | DD / card / transfer / PayPal |
| `owner_user_id` | who owns the relationship |
| `confirmed_by`, `confirmed_at` | **a supplier is not trusted until a human confirms it** |

`invoice_expected = never` replaces the ignore list entirely — per supplier, with the
reason attached and a date to look at it again. Aventis could not have become "financing"
in that model, because the record would have said *landlord, Gemini House rent, quarterly,
£855/month*.

### `supplier_aliases` — the table that fixes the most

`supplier_id`, `kind` (bank_narrative | email_domain | email_address | filename | vat_number
| account_ref), `value`, `match` (exact | prefix | contains | regex), `source`
(human | claude | import), `confidence`.

Claude may **propose** an alias. A human confirming one makes it permanent. This is what
collapses Amazon / Amazon.co.uk / Amazon J Tf into one supplier, permanently, instead of
re-deciding it on every sweep.

### `purchases` — the unit of work

`supplier_id`, `period` (YYYY-MM), `description`, `kind`, `category_id`,
`expected_amount`, `invoiced_amount`, `paid_amount`, and one state:

```
expected  →  documented  →  paid  →  reconciled  →  closed
                    ↘  disputed        ↘  ignored
```

- **expected** — we know it is coming (cadence says so, or a subscription schedule does)
- **documented** — we hold the invoice, no money has moved
- **paid** — money moved, no invoice yet
- **reconciled** — paper and money agree, coded, nothing outstanding
- **closed** — inside a closed period; frozen
- **disputed / ignored** — a human said so, with a reason

`documented` and `paid` are **normal intermediate states, not problems.** This is the
central point: most of the 533 were never exceptions, they were purchases mid-flight being
reported as faults.

### `purchase_allocations` — many-to-many, with amounts

`purchase_id`, `transaction_id?`, `split_id?`, `document_id?`, `amount`,
`kind` (payment | refund | credit_note | invoice), `allocated_by` (human | claude | rule),
`confidence`, `reason`, `allocated_at`.

One table replaces: the invoice hack on `bank_transaction_splits`, `dupe_paid_txn_id`,
`suggest_txn_id`, the whole `covers_several` detector, instalments, part-payments and
refunds. Everything becomes the same sentence — *allocate £X of this to that* — and the
arithmetic (`sum(allocations) == invoiced_amount`) is what proves a purchase is straight.

### `periods` — so a month can be finished

`year`, `month`, `status` (open | closing | closed), `closed_by`, `closed_at`,
`reopened_reason`. **Terry closes the month.** A closed period raises no findings and
accepts no new allocations without an explicit reopen that records who and why. The close
screen shows exactly what is blocking it.

### `proposals` — because the agent always proposes

`kind` (create_supplier | add_alias | allocate | categorise | split | set_invoice_expected
| close_period), `payload`, `confidence`, `evidence`, `state`, and critically:

**`group_key`** — proposals that share it arrive as ONE card with **Accept all**.
Fourteen Amazon allocations are one decision. This is the mechanism that makes
"always propose" survivable; without it, always-propose IS checking every line.

### `purchase_exceptions` — replaces `purchase_anomalies`

Raised **only** when the state machine is genuinely stuck:

- a purchase in `paid` for longer than its own supplier's normal invoice lag, **and**
  that supplier's `invoice_expected = always`
- a purchase in `documented` past its due date with no payment
- allocations that do not add up (`paid ≠ invoiced`)
- two purchases claiming the same document
- a supplier billing outside its own established range for that KIND of spend
- a period that cannot close

"Payment with no invoice" stops being an exception and becomes a *state*. That alone is
most of the current list.

---

## What the screens become

1. **Today** — the proposal queue, grouped. Should be short. If it is not short, the model
   is wrong and we fix the model, not the screen.
2. **Pipeline** — purchases by state, filtered by period and supplier. A work surface, not
   an alarm. This is where the backlog lives and it is allowed to be long.
3. **Suppliers** — the master. Aliases, what we buy, cadence, coding, invoice expectation,
   spend history, open exceptions.
4. **Periods** — close the month; see what is blocking it.
5. **Exceptions** — things that are actually wrong. Should be tiny, and if it is not, that
   is real information.

---

## Migration — additive, nothing is deleted

**Phase 0 — build alongside.** New tables only. The existing screens keep working
untouched. No behaviour change, so it cannot break month-end.

**Phase 1 — the supplier master.** Derive candidates from `purchase_supplier_profiles`
plus every confirmed match, ranked by spend. Terry confirms the top suppliers by value in
one sitting; the tail can be confirmed as it comes up. *This is the highest-value hour
anyone will spend on this project.* Aliases are seeded from the bank narratives and email
domains already observed on confirmed matches — evidence we already have, never guesses.

**Phase 2 — backfill purchases.** Every currently attached document+payment pair becomes a
`reconciled` purchase (safe: a human or the matcher already agreed them). Every unmatched
payment becomes `paid`. Every unmatched document becomes `documented`. Nothing is
discarded, nothing is invented.

**Phase 3 — switch the screens over**, old ones left readable for a while.

**Phase 4 — retire** `dupe_status`, `suggest_txn_id`, `purchase_anomalies` and the ignore
list, once the new path has run a full month.

⚠ **Prisma:** every new column must be in `schema.prisma`. `prisma db push` DROPS columns
it does not know about on every deploy.

---

## Standing rules this design must not break

- **Every invoice is kept for tax reasons** unless a supplier explicitly expects none.
  Nothing is ever deleted on intake — only classified, archived, or marked not-expected.
- **`already_paid` can never be suppressed.** Paying a bill twice is the one finding no
  standing instruction may hide.
- **Logic decides facts and may veto absolutely. Claude decides meaning and may never
  overrule a fact.** Claude gets evidence, not conclusions. (`purchase-terms.ts`)
- **A human confirming something is the best training signal the agent gets** — every
  confirmation trains the supplier record, exactly as an automatic match does.
- The agent never says it will progress a payment. It cannot pay anything.

---

## Open questions

- Multi-currency: do we need it, or is everything GBP?
- Purchase orders — is there a step before the invoice worth modelling, or does the
  purchase start at the invoice?
- Does Natalie need a different view from Terry, or the same one?
- Sales side: this same shape should invert for the sales agent. Worth designing once and
  using twice.
