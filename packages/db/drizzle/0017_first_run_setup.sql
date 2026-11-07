-- Primer inicio (ADR 0060): el backoffice da de alta al primer tenant y a su administrador sin pasar
-- por `pnpm tenant create`. El rol de la API no puede crear tenants ni ver los de otros, así que
-- las dos funciones security definer (mismo patrón que `resolve_api_key` y `tenant_by_email`, ADR
-- 0016) se otorgan solo a `gow_api` y hacen una sola cosa:
--
-- - `setup_pending()` dice si todavía no existe ningún tenant. No devuelve nada más.
-- - `setup_first_tenant(...)` crea el tenant, su política base activa y su primer usuario, y solo si no
--   existe ningún tenant. Un candado consultivo de transacción serializa dos llamadas simultáneas:
--   la segunda ve el tenant de la primera y devuelve NULL. Una vez que hay un tenant, ya no hace nada.
--
-- No emite llave de API: esa se crea después desde Configuración. Corre con el dueño de la migración,
-- que salta RLS (superusuario en local, BYPASSRLS en Supabase), igual que las otras dos.
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
