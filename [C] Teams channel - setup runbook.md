# [C] Teams as a customer channel — setup runbook

How to make two-way Teams work on the LumenMSP Portal helpdesk, using your **dedicated support
Office 365 account** + Power Automate. The portal side is already built and deployed; everything
below is configured in Microsoft 365 / Azure, then four values get pasted into the portal.

> **Reality check first (important):** Teams is *not* a bulk/announcement channel for external
> customers. You can only Teams-chat a customer's user if **external access (federation)** is on
> for both tenants, and outbound 1:1 only works to people who can be reached as guests/federated
> contacts — you cannot blast your whole DB over Teams any more than over WhatsApp. For a one-off
> "we're now reachable on Teams/WhatsApp" announcement, send it by **email**. Teams shines for
> ongoing back-and-forth with business customers who already use Teams with you.

---

## 0. Names used below

- **Support account** = your dedicated O365 user, e.g. `support@lumensolutions.co.uk`.
- **Portal inbound webhook** = `https://portal.lumenmsp.co.uk/webhooks/teams`
- **Inbound secret** / **Outbound secret** = two long random strings you invent (e.g. from a
  password manager). They stop anyone else POSTing to the portal or your flow.

---

## 1. Prerequisites (Teams admin)

1. **Enable external access (federation)** — Teams admin centre → *Users → External access* →
   allow the domains of the customers you'll chat with (or "all domains" if you accept anyone).
   Without this, external customers can't start a chat with the support account at all.
2. Make sure the **support account is licensed for Teams** and signed in at least once.

---

## 2. Portal settings (do this once the secrets exist)

Portal → **Settings → Integrations → Microsoft Teams (customer channel)**:

- **Inbound secret** → paste your inbound secret.
- **Outbound relay URL** → paste the Power Automate "HTTP request" URL from step 3 (come back
  after you've built that flow).
- **Outbound secret** → paste your outbound secret.
- **Bot display name** → e.g. `Lumen IT`.

The page also shows the **inbound webhook URL** to use in step 4.

---

## 3. OUTBOUND flow — portal → customer's Teams (easy, do this first)

This lets the **Teams** pill in the case composer actually send, posting as the support account.

1. Power Automate (signed in **as the support account**) → **Create → Instant cloud flow** →
   trigger **"When a HTTP request is received"**.
2. Set the request body JSON schema to:
   ```json
   { "type":"object","properties":{
     "to_email":{"type":"string"},
     "text":{"type":"string"},
     "conversation":{"type":"object"}
   }}
   ```
3. Add a **Condition**: check the inbound header `X-Relay-Secret` equals your **outbound secret**
   (use `triggerOutputs()?['headers']?['X-Relay-Secret']`). If it doesn't match → **Terminate**.
4. On the "yes" branch add **Microsoft Teams → Post message in a chat or channel**:
   - **Post as:** *User*
   - **Post in:** *Chat with Flow bot*? No — choose **Group chat** and set **Recipient** to
     `to_email` from the trigger (Teams treats a 1:1 as a group chat of one when posting as a user).
   - **Message:** the `text` field.
5. Add **Response** action → status `200`.
6. **Save**, then copy the flow's **HTTP POST URL** → paste it into the portal's *Outbound relay URL*.

Now in a case, set the composer pill to **Teams** and send — it posts to the customer as the
support account, and logs to **Admin → Comms log**.

---

## 4. INBOUND — customer's Teams → portal (pick ONE route)

Power Automate has **no reliable automatic trigger** for incoming 1:1 chat messages, so inbound
needs one of these. The portal endpoint is the same for all of them:

**Inbound contract** — POST to `https://portal.lumenmsp.co.uk/webhooks/teams`
- Header `X-Relay-Secret: <inbound secret>`
- Body:
  ```json
  { "message_id":"<unique id>", "from_email":"customer@theirco.com",
    "from_name":"Jane Doe", "text":"their message",
    "conversation":{ "chatId":"…", "serviceUrl":"…" } }
  ```
The portal matches `from_email` to a contact, raises/appends a case, stores `conversation` for
replies, and logs it.

### Option A — Manual "selected message" flow (stopgap, no extra licensing)
Power Automate Teams trigger **"For a selected message"** → an engineer taps a customer message →
flow POSTs the contract above to the portal. Works today, but it's manual per message. Fine for
piloting; not for volume.

### Option B — Graph change-notification subscription (proper, automatic) — RECOMMENDED
A background subscription on the support account's chats pushes every new message to the portal.
- Needs **admin consent** and Microsoft's **"protected API" access request** to read Teams chat
  messages app-only (`ChatMessage.Read.All` / `Chat.Read.All`). Microsoft reviews this.
- Subscriptions expire (~1 hour for chat messages) so they must be auto-renewed by a cron.
- This is the cleanest hands-off inbound. It's a portal-side build once the API access is granted.

### Option C — Azure Bot registered as a Teams app
Customers message a published Lumen support **app/bot**; Microsoft pushes each activity to the
portal endpoint. Most robust + gives proper conversation references, but heaviest setup (Azure Bot
resource + Teams app manifest + per-customer app install/approval).

**Recommendation:** ship **Option A** now to prove the flow end-to-end, then pursue **Option B**
(Graph subscription) for automatic inbound — it reuses the same support account and webhook.

---

## 5. Test plan

1. **Outbound:** open a case that has a contact email → composer pill **Teams** → send → confirm the
   message lands in that person's Teams as the support account, and a "Sent via Teams" row appears
   in Admin → Comms log.
2. **Inbound (Option A):** have a test customer message the support account in Teams → run the
   selected-message flow on it → confirm a case is raised/updated and the message shows in the feed
   with a Teams chip, plus an inbound row in Comms log.
3. **Reply round-trip:** reply from the case → confirm the customer receives it in the same chat.

---

## 6. What's already done in the portal (no action needed)

- `POST /webhooks/teams` inbound endpoint (secret-verified, contact-match by email, raise/append
  case, store conversation reference, dedupe, log).
- Composer **Teams** pill → sends via the outbound relay (by `to_email` and/or conversation ref).
- `teams_conversation` column on tickets; **Comms log** captures Teams in/out.
- Settings panel for the four values above.
