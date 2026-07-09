-- [C] 60-day personal-data retention purge  (LITS website visitor data)
-- Policy (Terry, 2026-06-25): clear all identifying info after 60 days; keep only
-- non-personal, aggregate data. Run DAILY. Reversible-by-design: it nulls identifying
-- columns rather than dropping rows, so aggregate stats (page, device, counts) survive.
--
-- Identifying data lives in TWO databases on the server:
--   * lumenmsp_portal   -> chat_visitors (raw ip, user_agent), web_views (visitor_id)
--   * lumenmsp_insights -> page_views (ip_hash), bb_lookups (ip_hash)  [used by broadband-api]
-- Run each block against its own database (see scheduling note at the bottom).
--
-- SAFETY: review against live column names before first run. If a column doesn't exist,
-- that statement errors harmlessly without touching data. Never DELETE here — only NULL.

-- ============================================================================
-- DATABASE: lumenmsp_portal
-- ============================================================================

-- Raw visitor IP + user agent: the most sensitive fields. Anonymise after 60 days,
-- keeping browser/os/device (already derived, non-identifying) and the page history.
UPDATE chat_visitors
   SET ip = NULL,
       user_agent = NULL
 WHERE last_seen < (NOW() - INTERVAL '60 days')
   AND (ip IS NOT NULL OR user_agent IS NOT NULL);

-- Optional: de-link old page views from the persistent visitor id so they become purely
-- aggregate (page + timestamp). Uncomment if you want the visitor_id removed too.
-- UPDATE web_views
--    SET visitor_id = NULL
--  WHERE created_at < (NOW() - INTERVAL '60 days')
--    AND visitor_id IS NOT NULL;

-- ============================================================================
-- DATABASE: lumenmsp_insights   (broadband-api analytics)
-- ============================================================================

-- Page-view + broadband-lookup IP hashes are pseudonymous, not raw IPs, but we still
-- clear them at 60 days to align with the policy. Page/postcode/result counts remain.
UPDATE page_views
   SET ip_hash = NULL
 WHERE created_at < (NOW() - INTERVAL '60 days')
   AND ip_hash IS NOT NULL;

UPDATE bb_lookups
   SET ip_hash = NULL
 WHERE created_at < (NOW() - INTERVAL '60 days')
   AND ip_hash IS NOT NULL;

-- ============================================================================
-- SCHEDULING (server, as lits-admin) — daily at 03:15, no Portal restart needed:
--
--   # /etc/cron.d/lits-retention-purge  (one line per DB; split this file in two if preferred)
--   15 3 * * * lits-admin psql "service=lumenmsp_portal"   -f /data/ops/retention-purge-portal.sql   >> /var/log/lits-retention.log 2>&1
--   20 3 * * * lits-admin psql "service=lumenmsp_insights" -f /data/ops/retention-purge-insights.sql >> /var/log/lits-retention.log 2>&1
--
-- Use a .pgpass / service file for credentials (don't inline passwords; URL-encode @ and !).
-- Alternatively, register a daily job inside the Portal scheduler — but that needs a Portal
-- deploy (.\deploy.ps1), which logs all staff out, so the cron route above is preferred.
-- ============================================================================
