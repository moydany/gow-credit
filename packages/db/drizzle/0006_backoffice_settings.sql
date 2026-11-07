-- Backoffice settings: the lender's user lists, creates and revokes API keys and removes users.
-- Minimal privileges for `gow_api`:
-- - api_keys: reads everything except `key_hash` (the hash never leaves the database except through
--   resolve_api_key) and can only write `revoked_at`; a key is never deleted, just revoked with a date.
-- - tenant_users: can delete membership; the removed user's session is cut on the next request.
-- Forced RLS still applies to both.
GRANT SELECT (id, tenant_id, prefix, scopes, created_at, revoked_at) ON app.api_keys TO gow_api;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON app.api_keys TO gow_api;
--> statement-breakpoint
GRANT DELETE ON app.tenant_users TO gow_api;
