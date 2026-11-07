-- Corrige 0020 (ADR 0065): `app.sole_tenant()` devuelve el id del único tenant y es solo del rol de
-- WhatsApp (0018, con prueba que lo exige). La API solo necesita saber si la instalación tiene una sola
-- institución crediticia para permitir editar prompts sin BACKOFFICE_PROMPT_EDITORS: si hay una sola,
-- es la del usuario. Función propia que devuelve un booleano y nada más.
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
