-- Request timeline: the API rebuilds the timeline from stored rows, including outgoing messages.
-- Until now `gow_api` didn't read `app.outbound_messages` (the outbox belongs to the WhatsApp process
-- and the worker).
--
-- Column-level privilege, metadata only: never `body` (the text the supplier receives) or
-- `destination` (their number or email). Without a whole-table SELECT, `SELECT *` or those columns
-- fail with "permission denied" even if the API code had a bug. The `tenant_isolation` policy from
-- 0001 isn't limited by role (FOR ALL, no TO) and is forced: it already applies to gow_api, so no
-- other is needed.
GRANT SELECT (id, tenant_id, clarification_id, kind, channel, status, attempts, created_at, sent_at) ON app.outbound_messages TO gow_api;
