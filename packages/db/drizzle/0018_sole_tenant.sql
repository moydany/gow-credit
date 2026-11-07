-- The WhatsApp process discovers its tenant on its own: in an install with a single lender
-- `WHATSAPP_TENANT_ID` isn't needed. The `gow_whatsapp` role can't read `tenants`, so the only way to
-- know is this security definer function (same pattern as `resolve_api_key`), granted to one role:
--
-- - Returns the tenant id when exactly one exists; NULL if there are none or more than one (with
--   several, the process requires `WHATSAPP_TENANT_ID`: choosing for it would be guessing).
-- - Returns only an id, never content.
CREATE OR REPLACE FUNCTION app.sole_tenant()
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT CASE WHEN (SELECT count(*) FROM app.tenants) = 1 THEN (SELECT id FROM app.tenants) END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sole_tenant() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sole_tenant() TO gow_whatsapp;
