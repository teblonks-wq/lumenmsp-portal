// ── The Purchase Agent's vocabulary ──────────────────────────────────────────────
// Terry, 2026-09-02, after reading the whole duplicates list with me: the point of the
// review was "so you understand how to get the Purchase Agent to use the CORRECT TERM,
// powered by logic and Claude, to be the best version of itself."
//
// Every wrong flag in that list was a VOCABULARY failure before it was a logic failure:
//
//   • a RECEIPT and its own INVOICE were called "already paid" — the agent had no word for
//     "the same purchase documented twice", so it reached for the word it had;
//   • an ACCOUNT REFERENCE (Stripe's BF13A7E2, on five months of invoices) was called an
//     "invoice number", so five separate bills looked like one paid five times;
//   • a RECURRING BILL was called a "duplicate", because the agent had no concept of a
//     billing cycle — only of two numbers being equal;
//   • the FORWARDER of an email was called the "supplier";
//   • a HARDWARE purchase was compared against a MONTHLY SERVICE average and called
//     "higher than normal".
//
// A system that reaches for the nearest word it owns will keep being confidently wrong. So
// the terms live here, once, and the detectors, the prompts and the screens all use them.
//
// ── Which half decides what ──────────────────────────────────────────────────────
// The other half of that lesson is that the wrong half was deciding.
//
//   LOGIC decides FACTS — things that are true or false and cheap to establish:
//     is this byte-identical; are these two references equal; does this reference appear on
//     three other documents; is the sender one of our own domains; does net + VAT equal
//     gross; how many days between these dates; is this payee on the ignore list.
//     Logic must be certain. Where it is certain it may VETO, and a veto is absolute.
//
//   CLAUDE decides MEANING — things that are a view and need reading:
//     what this document IS; whether two documents are the same purchase; whether an amount
//     is explained by what was bought; whether an oddity matters.
//     Claude may never overrule a fact, and must be given evidence rather than conclusions.
//
// Getting this backwards is what produced the list. Logic was deciding "this is a duplicate"
// — a judgement it cannot make — and Claude was handed the conclusion afterwards and asked
// to comment on it.

export type DocKind =
  | 'invoice'        // a demand for payment. The only kind we owe money on.
  | 'credit_note'    // money coming back
  | 'statement'      // a restatement of a balance made of invoices we already hold
  | 'notification'   // an email saying an invoice EXISTS, with no invoice on it
  | 'receipt'        // proof that something was already paid
  | 'other';

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  statement: 'Statement',
  notification: 'Notification — the invoice itself is missing',
  receipt: 'Receipt',
  other: 'Other document',
};

// ── How two documents can relate ────────────────────────────────────────────────
// The distinction the old code could not make. "Duplicate" was doing the work of all five.
export type Relation =
  | 'same_document'      // byte-identical. A fact, settled by a hash.
  | 'same_invoice'       // the same invoice, two files. Real duplication.
  | 'same_purchase'      // an invoice and its own receipt. ONE purchase, two documents.
  | 'recurring'          // the same charge in a different period. Two real bills.
  | 'coincidence';       // same amount, nothing else agrees.

export const RELATION: Record<Relation, { title: string; blurb: string; alarming: boolean }> = {
  same_document: {
    title: 'The same file again',
    blurb: 'Byte-identical to one already held. Skipped on arrival; nothing to decide.',
    alarming: false,
  },
  same_invoice: {
    title: 'The same invoice twice',
    blurb: 'Two files, one invoice. Keep one. If the other is already attached to a payment, paying this too would pay the bill twice.',
    alarming: true,
  },
  same_purchase: {
    title: 'An invoice and its receipt',
    blurb: 'The same purchase documented twice — suppliers like Stripe and Anthropic send both. Not a second bill. Keep whichever you file.',
    alarming: false,
  },
  recurring: {
    title: 'A repeat of a regular charge',
    blurb: 'The same supplier and amount in a different period. Two genuine bills, not a duplicate.',
    alarming: false,
  },
  coincidence: {
    title: 'The same amount, and nothing else',
    blurb: 'Two documents that happen to total the same. Not evidence of anything on its own.',
    alarming: false,
  },
};

// ── What a reference actually is ────────────────────────────────────────────────
// Calling an account id an "invoice number" is what made five months of Stripe bills look
// like one invoice. A reference identifies an invoice only if it is not shared.
export type RefKind = 'invoice_number' | 'account_reference' | 'unknown';

export function describeRef(kind: RefKind, value: string | null): string {
  if (!value) return 'no reference read';
  if (kind === 'account_reference') return `"${value}" is an account reference — it appears on several of this supplier's invoices, so it identifies the ACCOUNT, not this bill`;
  if (kind === 'invoice_number') return `invoice number ${value}`;
  return `reference ${value}`;
}

// ── Saying only what is known ───────────────────────────────────────────────────
// A finding must not sound more certain than the evidence behind it. "Looks ALREADY PAID"
// on an invoice-and-its-receipt was the system borrowing certainty it had not earned.
export type Confidence = 'established' | 'likely' | 'possible';

export const CONFIDENCE_PREFIX: Record<Confidence, string> = {
  established: '',                       // a fact — state it plainly, no hedge
  likely: 'Very probably: ',
  possible: 'Worth checking: ',
};

/** One sentence describing a relation at the confidence the evidence supports. */
export function phrase(rel: Relation, conf: Confidence, detail: string): string {
  const r = RELATION[rel];
  return `${CONFIDENCE_PREFIX[conf]}${r.title.toLowerCase()} — ${detail}`;
}

/** Whether a relation is worth interrupting somebody for. Only real duplication is. */
export function isAlarming(rel: Relation): boolean { return RELATION[rel].alarming; }
