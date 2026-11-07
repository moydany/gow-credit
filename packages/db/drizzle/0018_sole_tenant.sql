-- El proceso de WhatsApp descubre su tenant solo (ADR 0060, "Cambios"): en una instalación con un único
-- prestamista no hace falta `WHATSAPP_TENANT_ID`. El rol `gow_whatsapp` no puede leer `tenants`, así que
-- la única forma de saberlo es esta función security definer (mismo patrón que `resolve_api_key`, ADR
-- 0016), otorgada a un solo rol:
--
-- - Devuelve el id del tenant cuando existe exactamente uno; NULL si no hay ninguno o si hay más de
--   uno (con varios, el proceso exige `WHATSAPP_TENANT_ID`: elegir por él sería adivinar).
-- - Solo devuelve un id, nunca contenido.
CREATE OR REPLACE FUNCTION app.sole_tenant()
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT CASE WHEN (SELECT count(*) FROM app.tenants) = 1 THEN (SELECT id FROM app.tenants) END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sole_tenant() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sole_tenant() TO gow_whatsapp;
