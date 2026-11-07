-- Backoffice login with Supabase Auth. GoTrue calls a "custom access token hook" when issuing each
-- access token; this one adds the `tenant_id` claim when the Auth user (`auth.users.id` = `sub`) is a
-- member of a tenant in app.tenant_users. Without membership there is no claim and the API rejects
-- the token (401), like any token without a tenant.
--
-- Same pattern as the other security definer functions (0003_inbound_functions.sql): the only one
-- that skips RLS returns just an id, and is granted to a single role. The hook itself is security
-- invoker and only builds the claims.
--
-- It lives in a migration, not a separate script, so a hosted Supabase project gets it with the same
-- `pnpm db:migrate` as everything else. The functions are always created (they're harmless on plain
-- Postgres and tests use them); the GRANTs to supabase_auth_admin, the role GoTrue runs the hook as,
-- are only made if that role exists, so the docker-compose.yml Postgres doesn't break.

-- A backoffice user's tenant. Email is unique across tenants, so in practice there is one membership
-- per user; if there were several (same id, inserted by hand), the oldest wins.
CREATE OR REPLACE FUNCTION app.backoffice_tenant_of(p_user uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT u.tenant_id FROM app.tenant_users u WHERE u.user_id = p_user ORDER BY u.created_at, u.tenant_id LIMIT 1 $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.backoffice_tenant_of(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Input and output: the GoTrue event ({user_id, claims, authentication_method}) with the claims
-- replaced. Any `tenant_id` already in the claims is always dropped: only this function sets it.
CREATE OR REPLACE FUNCTION app.custom_access_token_hook(event jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, app
  AS $$
DECLARE
  claims jsonb := coalesce(event -> 'claims', '{}'::jsonb) - 'tenant_id';
  tenant uuid;
BEGIN
  IF (event ->> 'user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    tenant := app.backoffice_tenant_of((event ->> 'user_id')::uuid);
  END IF;
  IF tenant IS NOT NULL THEN
    claims := claims || jsonb_build_object('tenant_id', tenant::text);
  END IF;
  RETURN jsonb_set(event, '{claims}', claims);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.custom_access_token_hook(jsonb) FROM PUBLIC;
--> statement-breakpoint
-- Supabase only: GoTrue connects as supabase_auth_admin. USAGE on the schema grants no table access
-- (there is no table GRANT for that role). anon, authenticated and service_role inherit nothing:
-- REVOKE ... FROM PUBLIC already excludes them and Supabase's default privileges only apply to
-- public and storage; the revoke is explicit anyway in case a project changed them.
DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA app TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION app.backoffice_tenant_of(uuid), app.custom_access_token_hook(jsonb) TO supabase_auth_admin;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.backoffice_tenant_of(uuid), app.custom_access_token_hook(jsonb) FROM %I', r);
    END IF;
  END LOOP;
END
$$;
