-- ============================================================================
-- AUDIT: internal notes that may have leaked to customers via WhatsApp/Teams
-- Bug: POST /tickets/:id/note sent on the "Send via" channel before checking
-- note_type (fixed in commit 47ddc18, 21 Jul 2026).
--
-- IMPORTANT: a successful leaked send left NO log (channel_log 'sent' rows were
-- only written for public replies / side convos). So these queries list
-- CANDIDATES — internal notes that were physically able to go out:
--   * the case had a resolvable WhatsApp number, AND
--   * the note was written within 24h of the customer's last inbound WhatsApp
--     (outside that window Meta rejects free-form text, the note was NOT saved,
--     and the engineer saw an error banner instead).
-- A candidate only actually leaked if the WhatsApp radio happened to be
-- selected when the note was posted (it sticks after a WhatsApp reply, so
-- notes added right after a WhatsApp public reply are the highest risk).
-- Confirm each one against the customer's WhatsApp thread in the Chat inbox.
--
-- Run on the server:
--   psql postgres://portal:<pw>@localhost:5432/lumenmsp_portal -f audit-internal-note-leak.sql
-- ============================================================================

-- 1) WhatsApp leak candidates -------------------------------------------------
--    Internal notes on cases with inbound WhatsApp, written inside the 24h
--    window. "mins_after_last_inbound" small + note right after an outbound
--    WhatsApp reply = highest risk.
SELECT n.id            AS note_id,
       n.created_at    AT TIME ZONE 'Europe/London' AS written_at,
       t.ticket_number,
       left(t.subject, 40)                          AS subject,
       u.display_name  AS author,
       w.peer          AS wa_number,
       round(EXTRACT(EPOCH FROM (n.created_at - w.last_inbound))/60) AS mins_after_last_inbound,
       left(regexp_replace(n.body, '<[^>]+>', ' ', 'g'), 140)        AS note_preview
FROM inbox_notes n
JOIN inbox_tickets t ON t.id = n.ticket_id
LEFT JOIN users u    ON u.id = n.user_id
JOIN LATERAL (
    SELECT m.from_email AS peer, MAX(COALESCE(m.received_at, m.created_at)) AS last_inbound
    FROM inbox_messages m
    WHERE m.ticket_id = n.ticket_id
      AND m.channel = 'whatsapp'
      AND m.message_direction = 'inbound'
      AND m.from_email IS NOT NULL
      AND COALESCE(m.received_at, m.created_at) < n.created_at
    GROUP BY m.from_email
) w ON n.created_at - w.last_inbound < interval '24 hours'
WHERE n.note_type = 'private_note'
  AND btrim(regexp_replace(n.body, '<[^>]+>', '', 'g')) <> ''
ORDER BY n.created_at DESC;

-- 2) Highest-risk subset: note written within 30 min AFTER an outbound
--    WhatsApp reply on the same case (the radio was almost certainly still
--    on WhatsApp).
SELECT n.id AS note_id,
       n.created_at AT TIME ZONE 'Europe/London' AS written_at,
       t.ticket_number,
       u.display_name AS author,
       left(regexp_replace(n.body, '<[^>]+>', ' ', 'g'), 140) AS note_preview
FROM inbox_notes n
JOIN inbox_tickets t ON t.id = n.ticket_id
LEFT JOIN users u ON u.id = n.user_id
WHERE n.note_type = 'private_note'
  AND EXISTS (
      SELECT 1 FROM channel_log cl
      WHERE cl.ticket_id = n.ticket_id
        AND cl.channel = 'whatsapp'
        AND cl.direction = 'outbound'
        AND cl.status = 'sent'
        AND n.created_at - cl.created_at BETWEEN interval '0' AND interval '30 minutes'
  )
ORDER BY n.created_at DESC;

-- 3) Teams leak candidates ----------------------------------------------------
--    Internal notes on cases holding a live Teams conversation reference.
SELECT n.id AS note_id,
       n.created_at AT TIME ZONE 'Europe/London' AS written_at,
       t.ticket_number,
       left(t.subject, 40) AS subject,
       u.display_name AS author,
       left(regexp_replace(n.body, '<[^>]+>', ' ', 'g'), 140) AS note_preview
FROM inbox_notes n
JOIN inbox_tickets t ON t.id = n.ticket_id
LEFT JOIN users u ON u.id = n.user_id
WHERE n.note_type = 'private_note'
  AND t.teams_conversation IS NOT NULL
  AND btrim(regexp_replace(n.body, '<[^>]+>', '', 'g')) <> ''
ORDER BY n.created_at DESC;

-- 4) Collateral: internal notes that were silently LOST -----------------------
--    A failed WhatsApp/Teams send aborted the request, so the note was never
--    saved. Failed sends WERE logged — their preview is the vanished note text.
--    (Public-reply failures also appear here; match the preview text to tell
--    them apart.)
SELECT cl.created_at AT TIME ZONE 'Europe/London' AS attempted_at,
       cl.channel, t.ticket_number,
       u.display_name AS author,
       cl.error,
       left(cl.preview, 140) AS lost_text
FROM channel_log cl
LEFT JOIN inbox_tickets t ON t.id = cl.ticket_id
LEFT JOIN users u ON u.id = cl.user_id
WHERE cl.direction = 'outbound'
  AND cl.status = 'failed'
  AND cl.channel IN ('whatsapp','teams')
ORDER BY cl.created_at DESC;
