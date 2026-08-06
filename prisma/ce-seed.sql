-- ── LumenMSP Portal — seed data ────────────────────────────────────────────────
-- Safe to run more than once: every insert is guarded, so a second run changes nothing.
-- Run it AFTER `npx prisma db push`, so the tables exist.
--
--   psql "$DATABASE_URL" -f ce-seed.sql
--
-- Two things in here:
--   1. the two default patch policies (still outstanding from the patching work)
--   2. the starting end-of-life list for Cyber Essentials
--
-- The end-of-life list is ours to maintain — dates move, vendors extend, and an entry
-- with a stale date turns into a job nobody needed to do. Edit it in the Portal at
-- /ce/eol rather than here once it is in.

BEGIN;

-- ── 1. Default patch policies ──────────────────────────────────────────────────
-- Both ship DISABLED. Nothing installs an update until someone deliberately turns a
-- policy on, which is the only safe default for a thing that can reboot a server.

INSERT INTO patch_policies
  (name, device_class, is_default, enabled, install_scope, window_days, window_start,
   window_minutes, reboot_mode, reboot_deferrals, reboot_deadline_hours, notify_minutes, notify_message)
SELECT 'Default Windows Desktop', 'workstation', true, false, 'security',
       '1,2,3,4,5', '12:30', 180, 'prompt', 3, 72, 15,
       'Updates have been installed and this PC needs to restart. You can put it off a few times, but please save your work and restart when you can.'
WHERE NOT EXISTS (SELECT 1 FROM patch_policies WHERE is_default = true AND device_class = 'workstation');

INSERT INTO patch_policies
  (name, device_class, is_default, enabled, install_scope, window_days, window_start,
   window_minutes, reboot_mode, reboot_deferrals, reboot_deadline_hours, notify_minutes, notify_message)
SELECT 'Default Windows Server', 'server', true, false, 'security',
       '0', '02:00', 240, 'never', 0, 0, 30,
       'Server updates have been installed. A restart is outstanding and will be done by hand at an agreed time.'
WHERE NOT EXISTS (SELECT 1 FROM patch_policies WHERE is_default = true AND device_class = 'server');

-- ── 2. End-of-life list ────────────────────────────────────────────────────────

CREATE TEMP TABLE _eol_seed (
  category text, vendor text, name text, match_type text, match_value text,
  version_max text, eol_date date, severity text, action text, replacement text,
  guidance text, ce_control text
) ON COMMIT DROP;

INSERT INTO _eol_seed VALUES
-- Operating systems matched on their name (server editions, and clients old enough to
-- have a unique caption). Windows 10 and 11 are matched on build number below.
('os', 'Microsoft', 'Windows Server 2008 / 2008 R2', 'contains', 'Server 2008', NULL, '2020-01-14', 'fail', 'replace', 'Windows Server 2022',
 'Out of support since January 2020 and unpatchable. It fails the assessment on its own — plan the replacement before anything else on this machine is worth fixing.', 'patch'),
('os', 'Microsoft', 'Windows Server 2012 / 2012 R2', 'contains', 'Server 2012', NULL, '2023-10-10', 'fail', 'replace', 'Windows Server 2022',
 'Out of support since October 2023. Extended Security Updates are available through Azure Arc but are chargeable and time-limited — replacement is the answer.', 'patch'),
('os', 'Microsoft', 'Windows Server 2016', 'contains', 'Server 2016', NULL, '2027-01-12', 'fail', 'upgrade', 'Windows Server 2022',
 'In extended support only — security fixes, nothing else, and the clock runs out in January 2027.', 'patch'),
('os', 'Microsoft', 'Windows Server 2019', 'contains', 'Server 2019', NULL, '2029-01-09', 'fail', 'upgrade', 'Windows Server 2022', NULL, 'patch'),
('os', 'Microsoft', 'Windows Server 2022', 'contains', 'Server 2022', NULL, '2031-10-14', 'fail', 'upgrade', NULL, NULL, 'patch'),
('os', 'Microsoft', 'Windows 7', 'contains', 'Windows 7', NULL, '2020-01-14', 'fail', 'replace', 'Windows 11',
 'Out of support since January 2020. If it is still here it is because something on it will not move — that is the conversation to have, not the patch level.', 'patch'),
('os', 'Microsoft', 'Windows 8.1', 'contains', 'Windows 8.1', NULL, '2023-01-10', 'fail', 'replace', 'Windows 11', NULL, 'patch'),

-- Windows 10 / 11, by build number. Add a row when a new feature update ships.
('os', 'Microsoft', 'Windows 10 21H2', 'os_build', '19044', NULL, '2024-06-11', 'fail', 'upgrade', 'Windows 11',
 'This feature update stopped receiving security fixes in June 2024. Check the hardware against the Windows 11 requirements — if it fails them, this is a replacement, not an upgrade.', 'patch'),
('os', 'Microsoft', 'Windows 10 22H2', 'os_build', '19045', NULL, '2025-10-14', 'fail', 'upgrade', 'Windows 11',
 'The last Windows 10 release; support ended 14 October 2025. Consumer ESU buys a year at a time and is a stopgap, not a plan.', 'patch'),
('os', 'Microsoft', 'Windows 11 21H2', 'os_build', '22000', NULL, '2023-10-10', 'fail', 'upgrade', 'a current Windows 11 feature update',
 'A feature update behind. Windows Update will offer the current release — if it does not, the machine is usually blocked on a driver.', 'patch'),
('os', 'Microsoft', 'Windows 11 22H2', 'os_build', '22621', NULL, '2024-10-08', 'fail', 'upgrade', 'a current Windows 11 feature update',
 'Home and Pro went out of support in October 2024 (Enterprise and Education a year later). Take the current feature update.', 'patch'),
('os', 'Microsoft', 'Windows 11 23H2', 'os_build', '22631', NULL, '2025-11-11', 'fail', 'upgrade', 'a current Windows 11 feature update',
 'Home and Pro out of support since November 2025.', 'patch'),
('os', 'Microsoft', 'Windows 11 24H2', 'os_build', '26100', NULL, '2026-10-13', 'fail', 'upgrade', 'a current Windows 11 feature update',
 'Supported for now — the date is the one to plan against.', 'patch'),

-- .NET runtimes. The regex matches both Microsoft.NETCore.App and Microsoft.AspNetCore.App.
('runtime', 'Microsoft', '.NET Core 3.1', 'regex', 'App 3\.1$', NULL, '2022-12-13', 'fail', 'upgrade', '.NET 8',
 'Uninstall it once nothing depends on it. Applications built against 3.1 need rebuilding, not just a newer runtime alongside.', 'patch'),
('runtime', 'Microsoft', '.NET 5', 'regex', 'App 5\.0$', NULL, '2022-05-10', 'fail', 'upgrade', '.NET 8', NULL, 'patch'),
('runtime', 'Microsoft', '.NET 6', 'regex', 'App 6\.0$', NULL, '2024-11-12', 'fail', 'upgrade', '.NET 8', NULL, 'patch'),
('runtime', 'Microsoft', '.NET 7', 'regex', 'App 7\.0$', NULL, '2024-05-14', 'fail', 'upgrade', '.NET 8', NULL, 'patch'),
('runtime', 'Microsoft', '.NET 8 (LTS)', 'regex', 'App 8\.0$', NULL, '2026-11-10', 'fail', 'upgrade', '.NET 10', NULL, 'patch'),
('runtime', 'Microsoft', '.NET 9', 'regex', 'App 9\.0$', NULL, '2026-05-12', 'warn', 'upgrade', '.NET 10',
 'A standard-term release — eighteen months, not three years. Fine on a build machine, worth avoiding on anything a customer depends on.', 'patch'),

-- Applications an assessor will find
('app', 'Oracle', 'Java 7', 'contains', 'Java 7', NULL, '2015-04-14', 'fail', 'remove', NULL,
 'Uninstall it. Nothing has legitimately needed Java 7 for a decade.', 'patch'),
('app', 'Oracle', 'Java 8', 'contains', 'Java 8', NULL, '2022-03-31', 'fail', 'remove', 'OpenJDK 17 or 21 where an application genuinely needs Java',
 'Public updates ended in 2022. If an application still needs it, that is a supplier conversation — and the browser plugin should be gone regardless.', 'patch'),
('app', 'Adobe', 'Adobe Flash Player', 'contains', 'Flash Player', NULL, '2020-12-31', 'fail', 'remove', NULL,
 'Dead and blocked by every browser. Uninstall it.', 'patch'),
('app', 'Adobe', 'Adobe Shockwave Player', 'contains', 'Shockwave', NULL, '2019-04-09', 'fail', 'remove', NULL, 'Uninstall it.', 'patch'),
('app', 'Microsoft', 'Microsoft Silverlight', 'contains', 'Silverlight', NULL, '2021-10-12', 'fail', 'remove', NULL,
 'Uninstall it. If a line-of-business web app still needs it, that app is the finding.', 'patch'),
('app', 'Apple', 'QuickTime for Windows', 'contains', 'QuickTime', NULL, '2016-04-14', 'fail', 'remove', NULL,
 'Abandoned on Windows with known unpatched holes. Uninstall it.', 'patch'),
('app', 'Microsoft', 'Microsoft Office 2010', 'contains', 'Office Professional Plus 2010', NULL, '2020-10-13', 'fail', 'upgrade', 'Microsoft 365 Apps', NULL, 'patch'),
('app', 'Microsoft', 'Microsoft Office 2013', 'contains', 'Office Professional Plus 2013', NULL, '2023-04-11', 'fail', 'upgrade', 'Microsoft 365 Apps', NULL, 'patch'),
('app', 'Microsoft', 'Microsoft Office 2016', 'contains', 'Office Professional Plus 2016', NULL, '2025-10-14', 'fail', 'upgrade', 'Microsoft 365 Apps',
 'Support ended October 2025. It keeps working, which is exactly why it gets missed.', 'patch'),
('app', 'Microsoft', 'Microsoft Office 2019', 'contains', 'Office Professional Plus 2019', NULL, '2025-10-14', 'fail', 'upgrade', 'Microsoft 365 Apps', NULL, 'patch'),
('app', 'Python Software Foundation', 'Python 2', 'contains', 'Python 2.', NULL, '2020-01-01', 'warn', 'remove', 'Python 3',
 'Usually dragged in by another product. Check what put it there before removing it.', 'patch'),
('app', 'OpenJS', 'Node.js 18 or older', 'contains', 'Node.js', '18.99.99', '2025-04-30', 'warn', 'upgrade', 'Node.js 22 LTS', NULL, 'patch'),

-- Databases and server products
('database', 'Microsoft', 'SQL Server 2012', 'contains', 'SQL Server 2012', NULL, '2022-07-12', 'fail', 'upgrade', 'SQL Server 2022', NULL, 'patch'),
('database', 'Microsoft', 'SQL Server 2014', 'contains', 'SQL Server 2014', NULL, '2024-07-09', 'fail', 'upgrade', 'SQL Server 2022', NULL, 'patch'),
('database', 'Microsoft', 'SQL Server 2016', 'contains', 'SQL Server 2016', NULL, '2026-07-14', 'fail', 'upgrade', 'SQL Server 2022',
 'Out of extended support since July 2026 — one to raise with the application supplier now, not when it breaks.', 'patch'),
('database', 'Microsoft', 'SQL Server 2017', 'contains', 'SQL Server 2017', NULL, '2027-10-12', 'fail', 'upgrade', 'SQL Server 2022', NULL, 'patch'),
('server', 'Microsoft', 'Exchange Server 2013', 'contains', 'Exchange Server 2013', NULL, '2023-04-11', 'fail', 'replace', 'Exchange Online',
 'An unpatched internet-facing Exchange server is the single worst thing on a network. Migrate it.', 'patch'),
('server', 'Microsoft', 'Exchange Server 2016 / 2019', 'regex', 'Exchange Server 201[69]', NULL, '2025-10-14', 'fail', 'replace', 'Exchange Online or Exchange Server SE',
 'Out of support since October 2025. If it is only there for SMTP relay, that can be solved without an Exchange server.', 'patch');

INSERT INTO eol_products
  (category, vendor, name, match_type, match_value, version_max, eol_date, severity, action, replacement, guidance, ce_control, active)
SELECT s.category, s.vendor, s.name, s.match_type, s.match_value, s.version_max, s.eol_date,
       s.severity, s.action, s.replacement, s.guidance, s.ce_control, true
  FROM _eol_seed s
 WHERE NOT EXISTS (
   SELECT 1 FROM eol_products e
    WHERE e.match_type = s.match_type AND e.match_value = s.match_value AND e.name = s.name);

COMMIT;

-- What went in:
--   SELECT category, count(*) FROM eol_products GROUP BY category ORDER BY category;
--   SELECT name, device_class, enabled FROM patch_policies WHERE is_default;
