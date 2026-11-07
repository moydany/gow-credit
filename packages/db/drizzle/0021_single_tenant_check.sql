-- Fixes 0020: `app.sole_tenant()` returns the only tenant's id and belongs to the WhatsApp role alone
-- (0018, with a test enforcing it). The API only needs to know whether the install has a single
-- lender, to allow editing prompts without BACKOFFICE_PROMPT_EDITORS: if there is one, it is the
-- user's. A separate function that returns a boolean and nothing else.
REVOKE EXECUTE ON FUNCTION app.sole_tenant() FROM gow_api;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.single_tenant_installation()
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT (SELECT count(*) FROM app.tenants) = 1 $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.single_tenant_installation() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.single_tenant_installation() TO gow_api;
