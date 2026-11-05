-- Dos funciones security definer más, revisadas a mano (docs/05 §2): solo devuelven ids, nunca
-- contenido, y cada una se otorga a un solo rol.
--
-- El worker barre los mensajes entrantes sin procesar de todos los tenants y después procesa cada
-- uno dentro de su tenant con RLS. Así el proceso de WhatsApp solo inserta; no encola nada.
CREATE OR REPLACE FUNCTION app.pending_inbound(p_limit integer)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT m.id, m.tenant_id FROM app.inbound_messages m WHERE m.processed_at IS NULL ORDER BY m.received_at LIMIT p_limit $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.pending_inbound(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.pending_inbound(integer) TO gow_worker;
--> statement-breakpoint
-- El webhook de correo entrante llega sin tenant: el destinatario lo identifica (un remitente por tenant).
CREATE OR REPLACE FUNCTION app.tenant_by_email(p_address text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT t.id FROM app.tenants t WHERE lower(t.email_from) = lower(p_address) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.tenant_by_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tenant_by_email(text) TO gow_api;
