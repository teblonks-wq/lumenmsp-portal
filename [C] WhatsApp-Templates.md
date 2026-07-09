# WhatsApp message templates — for Meta approval

These let staff start a **new** WhatsApp message (or message a customer **outside the 24-hour window**), which Meta only allows via a pre-approved template. Create each one in **Meta Business Suite → WhatsApp Manager → Message templates → Create template**.

**Settings for every template below**
- **Category:** `Utility` (these are service/support messages tied to an existing support relationship — Utility is approved fastest and is the correct category; do **not** pick Marketing or these will be rejected/limited).
- **Language:** `English (UK)` — `en_GB`.
- **Name:** use the exact `name` given (lowercase + underscores) — the portal composer will reference these names, so they must match.
- **Footer** (same on all): `Lumen IT Solutions`
- Leave header **off** unless noted. No media header needed.
- Variables are numbered `{{1}}`, `{{2}}`… — fill Meta's "sample content" boxes with the examples shown so approval isn't held up.

> Tip: submit all of them in one sitting. Approval is usually minutes to a few hours. Once "Active", they appear in the portal's new-message composer with the fields below.

---

## 1. `case_update` — general update on an open case
**Body**
```
Hi {{1}}, an update on your support case {{2}} with Lumen IT: {{3}}

Reply here if there's anything else you need.
```
- `{{1}}` first name — e.g. *Rob*
- `{{2}}` case number — e.g. *CASE-1042*
- `{{3}}` the update — e.g. *your new laptop has shipped and should arrive tomorrow*

## 2. `awaiting_response` — chasing a reply so we can progress
**Body**
```
Hi {{1}}, we're waiting on your reply to progress support case {{2}}. When you have a moment, please reply here and we'll pick it straight back up.
```
- `{{1}}` first name — *Rob* · `{{2}}` case number — *CASE-1042*

## 3. `info_request` — we need more information
**Body**
```
Hi {{1}}, to progress your support case {{2}} we need a little more information: {{3}}

Please reply here whenever you're ready.
```
- `{{1}}` *Rob* · `{{2}}` *CASE-1042* · `{{3}}` what's needed — e.g. *the serial number on the base of the device*

## 4. `engineer_visit` — confirm / arrange an on-site visit
**Body**
```
Hi {{1}}, confirming your Lumen IT engineer visit for case {{2}} on {{3}} at {{4}}.

Reply CONFIRM to accept, or reply here to rearrange.
```
- `{{1}}` *Rob* · `{{2}}` *CASE-1042* · `{{3}}` date — *Mon 6 Jul* · `{{4}}` time — *10:00*

## 5. `support_callback` — we tried to reach you
**Body**
```
Hi {{1}}, this is Lumen IT Support about case {{2}}. We tried to reach you and would like to keep things moving. Please reply here, or call us on {{3}}.
```
- `{{1}}` *Rob* · `{{2}}` *CASE-1042* · `{{3}}` phone — *01235 000000*

## 6. `case_resolved` — case closed / satisfaction check
**Body**
```
Hi {{1}}, we've marked your support case {{2}} as resolved. If everything's working as expected there's nothing more to do — if not, just reply here and we'll reopen it.
```
- `{{1}}` *Rob* · `{{2}}` *CASE-1042*

## 7. `support_message` — flexible general opener
**Body**
```
Hi {{1}}, this is Lumen IT Support. {{2}}

Please reply here and we'll help.
```
- `{{1}}` first name — *Rob* · `{{2}}` free-text message — *we noticed your backup last ran on Friday and wanted to check in.*

---

## How this plugs into the portal
- Every message a customer sends opens a fresh **24-hour window** in which staff reply freely (no template needed).
- **Outside** that window, or to **start** a conversation, staff pick one of the above templates in the composer, fill the fields, and send. The message is tagged to a case like any other.
- Template **names must match exactly** — if you rename any in Meta, tell me and I'll update the composer.
- If Meta rejects one, it's almost always a category issue (must be **Utility**) or missing sample content — re-submit with the examples above.
