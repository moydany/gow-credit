-- Login del backoffice con Supabase Auth (ADR 0035). GoTrue llama a un "custom access token hook"
-- al emitir cada access token; este agrega el claim `tenant_id` cuando el usuario de Auth
-- (`auth.users.id` = `sub`) es miembro de un tenant en app.tenant_users. Sin pertenencia no hay
-- claim y la API rechaza el token (401), como cualquier token sin tenant.
--
-- Mismo patrón que las otras funciones security definer (ADR 0016, 0003_inbound_functions.sql):
-- la única que salta RLS devuelve solo un id, y se otorga a un solo rol. El hook en sí es security
-- invoker y solo arma los claims.
--
-- Vive en una migración, no en un script aparte, para que un proyecto de Supabase alojado lo reciba
-- con el mismo `pnpm db:migrate` que el resto. Las funciones se crean siempre (en el Postgres simple
-- no estorban y las pruebas las usan); los GRANT a supabase_auth_admin, el rol con el que GoTrue
-- corre el hook, solo se dan si ese rol existe, así que el Postgres de docker-compose.yml no se rompe.

-- Tenant de un usuario del backoffice. El correo es único entre tenants, así que en la práctica hay
-- una pertenencia por usuario; si hubiera varias (mismo id, insertado a mano), gana la más antigua.
CREATE OR REPLACE FUNCTION app.backoffice_tenant_of(p_user uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT u.tenant_id FROM app.tenant_users u WHERE u.user_id = p_user ORDER BY u.created_at, u.tenant_id LIMIT 1 $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.backoffice_tenant_of(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Entrada y salida: el evento de GoTrue ({user_id, claims, authentication_method}) con los claims
-- reemplazados. Un `tenant_id` que viniera en los claims se descarta siempre: solo lo pone esta función.
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
-- Solo en Supabase: GoTrue conecta como supabase_auth_admin. USAGE sobre el esquema no da acceso a
-- ninguna tabla (no hay GRANT de tablas para ese rol). anon, authenticated y service_role no
-- heredan nada: REVOKE ... FROM PUBLIC ya los deja fuera y los privilegios por defecto de Supabase
-- solo aplican en public y storage; aun así se revoca explícito por si un proyecto los cambió.
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
