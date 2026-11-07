-- Tenant isolation. Hand-written migration: roles, forced RLS on every `app` table, minimal
-- privileges per role, and the only security definer function (resolving an API key before the
-- tenant is known).
--
-- Roles are created without login if missing. Locally, docker compose creates them first with login
-- and a dev password (infra/postgres/init); on Supabase the password is set separately.
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
-- pg-boss and Mastra in their own schemas, with roles that can't reach `app`.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION gow_queue;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS mastra AUTHORIZATION gow_mastra;
--> statement-breakpoint
REVOKE ALL ON SCHEMA app FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
--> statement-breakpoint
-- The transaction's tenant: each request or job sets it with set_config('app.tenant_id', ..., true).
-- Without it the policies compare against NULL and no rows come back.
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
-- WhatsApp sees only its outbox and can only enqueue incoming messages, to limit the blast radius.
GRANT SELECT, UPDATE (status, attempts, sent_at) ON app.outbound_messages TO gow_whatsapp;
--> statement-breakpoint
GRANT SELECT (id), INSERT ON app.inbound_messages TO gow_whatsapp;
--> statement-breakpoint
-- The API receives a key before it knows the tenant: this function (reviewed by hand) returns the
-- tenant and the hash so the API can compare in constant time. It exposes no other rows.
CREATE OR REPLACE FUNCTION app.resolve_api_key(p_prefix text)
  RETURNS TABLE (tenant_id uuid, key_hash text, scopes text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$ SELECT k.tenant_id, k.key_hash, k.scopes FROM app.api_keys k WHERE k.prefix = p_prefix AND k.revoked_at IS NULL $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_api_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_api_key(text) TO gow_api;
