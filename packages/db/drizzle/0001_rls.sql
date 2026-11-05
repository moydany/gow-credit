-- Aislamiento por tenant (docs/05 §2 y §2b, ADR 0016). Migración escrita a mano: roles, RLS
-- forzada en todas las tablas de `app`, privilegios mínimos por rol y la única función
-- security definer (resolver una llave de API antes de conocer el tenant).
--
-- Los roles se crean sin login si no existen. En local, docker compose los crea antes con login
-- y contraseña de desarrollo (infra/postgres/init); en Supabase la contraseña se asigna aparte.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['gow_api', 'gow_worker', 'gow_whatsapp', 'gow_readonly', 'gow_queue', 'gow_mastra'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
-- pg-boss y Mastra en sus propios esquemas, con roles que no alcanzan `app`.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION gow_queue;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS mastra AUTHORIZATION gow_mastra;
--> statement-breakpoint
REVOKE ALL ON SCHEMA app FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
--> statement-breakpoint
-- El tenant de la transacción: lo fija cada request o job con set_config('app.tenant_id', ..., true).
-- Sin él, las políticas comparan contra NULL y no hay filas.
CREATE OR REPLACE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO gow_api, gow_worker, gow_whatsapp, gow_readonly;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant() TO gow_api, gow_worker, gow_whatsapp, gow_readonly;
--> statement-breakpoint
ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.tenants FOR ALL USING (id = app.current_tenant()) WITH CHECK (id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.api_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.api_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.api_keys FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.suppliers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.suppliers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.suppliers FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.supplier_contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.supplier_contacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.supplier_contacts FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.documents FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.applications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.applications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.applications FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.application_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.application_documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.application_documents FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.extractions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.extractions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.extractions FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.policies FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.policy_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.policy_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.policy_versions FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.decisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.decisions FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.clarifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.clarifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.clarifications FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.outbound_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.outbound_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.outbound_messages FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.inbound_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.inbound_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.inbound_messages FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.outcomes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.outcomes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.outcomes FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.audit_log FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
GRANT SELECT ON app.tenants, app.api_keys, app.suppliers, app.supplier_contacts, app.documents, app.applications, app.application_documents, app.extractions, app.policies, app.policy_versions, app.decisions, app.clarifications, app.outbound_messages, app.inbound_messages, app.outcomes, app.audit_log TO gow_readonly;
--> statement-breakpoint
GRANT SELECT ON app.tenants, app.suppliers, app.supplier_contacts, app.documents, app.applications, app.application_documents, app.extractions, app.policies, app.policy_versions, app.decisions, app.clarifications, app.inbound_messages, app.outcomes, app.audit_log TO gow_api;
--> statement-breakpoint
GRANT INSERT ON app.suppliers, app.supplier_contacts, app.documents, app.applications, app.application_documents, app.policies, app.policy_versions, app.inbound_messages, app.outcomes, app.audit_log, app.api_keys TO gow_api;
--> statement-breakpoint
GRANT UPDATE ON app.suppliers, app.supplier_contacts, app.applications, app.policy_versions, app.clarifications TO gow_api;
--> statement-breakpoint
GRANT SELECT ON app.tenants, app.suppliers, app.supplier_contacts, app.documents, app.applications, app.application_documents, app.extractions, app.policies, app.policy_versions, app.decisions, app.clarifications, app.outbound_messages, app.inbound_messages, app.outcomes, app.audit_log TO gow_worker;
--> statement-breakpoint
GRANT INSERT ON app.documents, app.application_documents, app.extractions, app.decisions, app.clarifications, app.outbound_messages, app.audit_log TO gow_worker;
--> statement-breakpoint
GRANT UPDATE ON app.applications, app.clarifications, app.outbound_messages, app.inbound_messages TO gow_worker;
--> statement-breakpoint
-- WhatsApp solo ve su buzón de salida y solo puede encolar entrantes (docs/05 §2b, radio de daño).
GRANT SELECT, UPDATE (status, attempts, sent_at) ON app.outbound_messages TO gow_whatsapp;
--> statement-breakpoint
GRANT SELECT (id), INSERT ON app.inbound_messages TO gow_whatsapp;
--> statement-breakpoint
-- La API recibe una llave antes de saber el tenant: esta función (revisada a mano) devuelve el
-- tenant y el hash para que la API compare en tiempo constante. No expone otras filas.
CREATE OR REPLACE FUNCTION app.resolve_api_key(p_prefix text)
  RETURNS TABLE (tenant_id uuid, key_hash text, scopes text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT k.tenant_id, k.key_hash, k.scopes FROM app.api_keys k WHERE k.prefix = p_prefix AND k.revoked_at IS NULL $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_api_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_api_key(text) TO gow_api;
