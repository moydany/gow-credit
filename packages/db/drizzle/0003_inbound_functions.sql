-- Two more security definer functions, reviewed by hand: they return only ids, never content,
-- and each is granted to a single role.
--
-- The worker sweeps unprocessed incoming messages across all tenants, then processes each one
-- inside its own tenant under RLS. That way the WhatsApp process only inserts; it enqueues nothing.
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
-- The inbound email webhook arrives with no tenant: the recipient identifies it (one sender per tenant).
CREATE OR REPLACE FUNCTION app.tenant_by_email(p_address text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT t.id FROM app.tenants t WHERE lower(t.email_from) = lower(p_address) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.tenant_by_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tenant_by_email(text) TO gow_api;
