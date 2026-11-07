-- First run: the backoffice creates the first tenant and its administrator without going through
-- `pnpm tenant create`. The API role can't create tenants or see others', so the two security
-- definer functions (same pattern as `resolve_api_key` and `tenant_by_email`) are granted only to
-- `gow_api` and do one thing each:
--
-- - `setup_pending()` says whether no tenant exists yet. Returns nothing else.
-- - `setup_first_tenant(...)` creates the tenant, its active base policy and its first user, only if
--   no tenant exists. A transaction-level advisory lock serializes two simultaneous calls: the
--   second sees the first's tenant and returns NULL. Once a tenant exists it does nothing.
--
-- It issues no API key: that is created later from settings. Runs as the migration owner, which skips
-- RLS (superuser locally, BYPASSRLS on Supabase), like the other two.
CREATE OR REPLACE FUNCTION app.setup_pending()
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT NOT EXISTS (SELECT 1 FROM app.tenants) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.setup_pending() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.setup_pending() TO gow_api;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.setup_first_tenant(p_name text, p_whatsapp text, p_policy jsonb, p_user uuid, p_email text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_policy uuid := gen_random_uuid();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('app.setup_first_tenant'));
  IF EXISTS (SELECT 1 FROM app.tenants) THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  INSERT INTO app.tenants (id, name, whatsapp_number) VALUES (v_tenant, p_name, p_whatsapp);
  INSERT INTO app.policies (id, tenant_id, name) VALUES (v_policy, v_tenant, 'principal');
  INSERT INTO app.policy_versions (tenant_id, policy_id, version, status, document, activated_at)
    VALUES (v_tenant, v_policy, 1, 'active', p_policy, now());
  INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES (v_tenant, p_user, lower(p_email));
  INSERT INTO app.audit_log (tenant_id, actor, action, subject, details)
    VALUES (v_tenant, 'user:' || p_user::text, 'tenant.setup', v_tenant::text, '{}'::jsonb);
  RETURN v_tenant;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.setup_first_tenant(text, text, jsonb, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.setup_first_tenant(text, text, jsonb, uuid, text) TO gow_api;
