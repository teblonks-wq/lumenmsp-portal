# [C] PowerAlarm as a Portal Service — design

**Status:** design agreed 2026-08-12, nothing built yet.
**Premise:** PowerAlarm stops being one desktop app and becomes a **sellable service** you switch on
per customer site. The standalone app in `D:\WinApps\PowerAlarm` stays in the arsenal unchanged.

Decisions taken (Terry, 2026-08-12):

| Question | Decision |
|---|---|
| Where detection runs | **Ported into the LumenMSP Agent** as a device role |
| Who gets texted | **Site contacts picked from the Portal** (contacts with a mobile) |
| Live alerting | **Yes** — Portal alerts while the site is dark, not just post-mortem |
| Framework scope | **Generic site services**, PowerAlarm is tenant #1 |

---

## 1. Why the agent, not the MSI

The agent already is everything PowerAlarm had to build for itself: a SYSTEM service that starts at
boot whether anyone logs on or not, a heartbeat, a command queue, a signed MSI, self-update and a
ringed rollout. Porting `OutageDetector.cs` into `LumenAgent.Service` means one install, one config,
one version to chase.

The security win is the real prize. Today a protected machine holds a Luminate SMS key. In the
service model **no customer machine holds any SMS credential at all** — the agent posts the outage
to the Portal over its existing enrolled channel, and the *Portal* sends via Luminate. Revoking a
customer is a Portal row, not a visit.

The product win is bigger still: **a single desktop app can never tell you the power is out right
now.** It is dead. The Portal is not.

---

## 2. Data model

Everything below must be declared in `schema.prisma` before it exists — `prisma db push` on deploy
drops any column it does not know about. This has bitten the agent tables twice.

```
site_services
  id, customer_id, site_id (NULL = customer-wide), service_key ('poweralarm'),
  enabled, config jsonb, product_id (billing, phase 4),
  verified_at, verified_by, maintenance_from, maintenance_to,
  created_at, updated_at
  UNIQUE (customer_id, site_id, service_key)

site_service_recipients
  id, site_service_id, contact_id, number_snapshot, added_at
  -- contact_id is the source of truth; number_snapshot is what we actually texted,
  -- so a log line stays meaningful after a contact is edited

device_roles
  id, device_id, role_key ('poweralarm'), site_service_id, config jsonb,
  assigned_at, assigned_by
  UNIQUE (device_id, role_key)

poweralarm_events
  id, device_id, site_service_id, boot_id, kind ('outage'|'dark'|'allclear'|'test'),
  outage_start, outage_end, duration_sec, detected_at, reported_at,
  verdict ('confirmed'|'suppressed'), gate_reason, alert_state, sms_ref, recipients jsonb

agent_devices.site_id   -- NEW nullable column
```

`agent_devices.site_id` is the missing link. Assets are attached to a customer but not to a site, so
"choose the agent for this site" has nothing to filter on today. Add it, make it editable on the
asset page, and it pays for itself everywhere else (site-scoped asset lists, site IT reports).

**Suppressed events are logged, not discarded.** The whole lesson of 11 August was that everything
looked healthy while nothing arrived. A blue-screen or a planned restart that was correctly gated
must still appear in the log with its `gate_reason`, or the first question a customer asks — "why
didn't I get a text on Tuesday?" — has no answer.

`device_roles` generalises the existing `is_ad_agent` boolean. That flag is the precedent and,
eventually, a candidate to fold in.

---

## 3. Surfaces

**Customer → Services tab.** The switchboard: available services, which sites have each one, health
at a glance. Red for enabled-but-never-verified.

**Site → PowerAlarm panel.**
- Pick the agent(s) — dropdown of that customer's enrolled devices, site-tagged ones first.
- Recipients — contacts with a mobile number, ticked.
- Minimum outage seconds (default 60), expected-on schedule, maintenance window.
- Message preview, rendered GSM-7, exactly as it will land.
- **Verify** button (see §5).

**Asset → PowerAlarm tab.** Appears only when the device carries the role.
Protected since / last check-in / last boot; outage history; suppressed events with reason; the
numbers that would be texted right now; Send test; Remove role.

**`/poweralarm` estate view.** The one offered before and deferred for the tray: every protected
machine across every customer, last check-in, last outage, unverified sites in red.

---

## 4. Portal becomes a Luminate SMS client

The Portal has no SMS client today — this is the first one. `src/lib/sms.ts`, thin: key from `.env`,
`priority:"high"` always (power alerts must beat quiet hours), `ref` on every send so the gateway's
`(source, ref, to_number)` dedupe carries the idempotency, and **never** retry an `unknown`.

Refs: `pa-outage-<deviceId>-<bootId>`, `pa-dark-<siteServiceId>-<windowStart>`,
`pa-verify-<siteServiceId>-<ts>`. The standalone app uses `outage-<bootId>` — different namespace, so
a machine running both can never double-text.

**Fix first, on the Luminate side:** `/api/sms/health` returns 200 with `{configured:false}` when
CloudNumbering is unconfigured, and a client that checks only the status code is told "you're fine"
by a gateway that physically cannot send. Make it non-2xx. The Portal is about to become the client
that trusts it.

---

## 5. Nothing is "protected" until it has proved it

Enabling the service does not make a site green. **Verify** does, and it walks the entire path to a
human: recipients resolve → every number normalises → the Luminate key works *and* reports itself
configured → a real test SMS goes out → `verified_at` stamped with who ran it.

A monthly cron re-verifies; over 35 days goes amber. This is the 11 August lesson written into the
product: proving a credential works is not proving the alert works.

---

## 6. Live "site went dark" — and the trap in it

Portal cron, every minute. A site is dark when every role-carrying device at it has missed its
heartbeat past the threshold. Then text — worded honestly:

> Site went dark 14:32 — power or connectivity. Will confirm when machines return.

Not "power cut". A dead broadband line is indistinguishable from a dead building, and a confidently
wrong text is worse than no text. The agent's post-mortem confirms which it was on the way back, and
the all-clear carries the verdict: *"back 15:58 — confirmed power outage, 1h 26m"*.

**The trap: a machine switched off at 18:00 looks exactly like a machine that lost power at 18:00.**
Get this wrong and every customer gets a false alarm every evening, and the service is dead on
arrival. Three defences, all needed:

1. **A shutdown beacon.** The agent posts "I am stopping cleanly" from its service-stop handler. A
   power cut produces no beacon. This is the discriminator, and it is cheap.
2. **An expected-on schedule** per role (default 24/7) — outside it, no live alert.
3. **Process-uptime grace.** No dark alerts in the first 5 minutes after the Portal starts, or a
   deploy restart texts the entire estate at once.

Single-device sites get a longer threshold and softer wording — one machine going quiet is weak
evidence. Two or more going quiet together is strong.

---

## 7. Phasing

**Phase 1 — Portal only, no agent build.** Services framework, site enablement, recipients, verify,
`sms.ts`, asset tab shell, `/poweralarm`. Ships on its own; the tab just says "no events yet".

**Phase 2 — Agent role.** Port `OutageDetector.cs` and its gates into `LumenAgent.Service`, role
config in the bootstrap payload, event reporting with retry (there is no network at boot after an
outage — it must keep trying), shutdown beacon, tray banner. Bump `Directory.Build.props`, build,
ringed rollout.

**Phase 3 — Live dark detection.** Cron, all-clear, maintenance windows, expected-on schedules.

**Phase 4 — Commercial.** Product/package line so enabling a site creates the billing line; customer
visibility in `/my`.

---

## 8. Standing risks

- Portal deploy **logs everyone out** — as always, batch it.
- `prisma db push` drops undeclared columns. Declare first.
- A UPS'd machine never reports an outage; that is the premise, but say it to customers out loud.
- Contacts leave. A recipient whose contact is archived must surface as a warning on the site, not
  silently drop off the list.
