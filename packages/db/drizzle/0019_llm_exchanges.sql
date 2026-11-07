CREATE TABLE "app"."llm_exchanges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid,
	"inbound_message_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"schema_name" text NOT NULL,
	"prompt_version" text NOT NULL,
	"effort" text NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"server_fallback" boolean NOT NULL,
	"system" text NOT NULL,
	"instruction" text NOT NULL,
	"document_sha256" text,
	"outcome" text NOT NULL,
	"response" jsonb,
	"raw_output" text,
	"error_code" text,
	"error_message" text,
	"finish_reason" text,
	"response_cache_hit" boolean DEFAULT false NOT NULL,
	"usage" jsonb,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."llm_exchanges" ADD CONSTRAINT "llm_exchanges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."llm_exchanges" ADD CONSTRAINT "llm_exchanges_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "app"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."llm_exchanges" ADD CONSTRAINT "llm_exchanges_inbound_message_id_inbound_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "app"."inbound_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_exchanges_tenant_at" ON "app"."llm_exchanges" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_exchanges_application" ON "app"."llm_exchanges" USING btree ("tenant_id","application_id","created_at");
--> statement-breakpoint
-- Forced RLS and minimal privileges, like `extractions`: it holds prompts and responses containing
-- document data.
-- - gow_worker only inserts: it records each model call while processing.
-- - gow_api and gow_readonly read; viewing the detail from the backoffice is audited.
-- - Nobody updates or deletes; only `app.purge_supplier` (security definer) when deleting a supplier.
ALTER TABLE app.llm_exchanges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.llm_exchanges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.llm_exchanges FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
GRANT SELECT ON app.llm_exchanges TO gow_api, gow_readonly;
--> statement-breakpoint
GRANT INSERT ON app.llm_exchanges TO gow_worker;
--> statement-breakpoint
-- Deleting a supplier also deletes its model exchanges. Same function as in 0016 with one more
-- DELETE, before the incoming messages (foreign key).
CREATE OR REPLACE FUNCTION app.purge_supplier(p_supplier uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_apps uuid[];
  v_runs text[];
  v_docs uuid[];
  v_paths text[];
  v_addr text[];
  v_clar uuid[];
  v_outcomes integer;
  v_clarifications integer;
  v_inbound integer;
  v_outbound integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'sin tenant en la transacción' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.suppliers s WHERE s.id = p_supplier AND s.tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(array_agg(a.id), '{}'), coalesce(array_agg(a.run_id) FILTER (WHERE a.run_id IS NOT NULL), '{}')
    INTO v_apps, v_runs
    FROM app.applications a WHERE a.tenant_id = v_tenant AND a.supplier_id = p_supplier;
  IF EXISTS (SELECT 1 FROM app.applications a WHERE a.id = ANY (v_apps) AND a.status IN ('received', 'extracting', 'extracted', 'deciding')) THEN
    RAISE EXCEPTION 'el proveedor tiene solicitudes en proceso' USING ERRCODE = '55006';
  END IF;

  SELECT coalesce(array_agg(d.id), '{}'), coalesce(array_agg(d.storage_path), '{}')
    INTO v_docs, v_paths
    FROM app.documents d
   WHERE d.tenant_id = v_tenant
     AND (d.supplier_id = p_supplier OR d.id IN (SELECT ad.document_id FROM app.application_documents ad WHERE ad.application_id = ANY (v_apps)))
     AND NOT EXISTS (SELECT 1 FROM app.application_documents o WHERE o.document_id = d.id AND NOT (o.application_id = ANY (v_apps)));

  SELECT coalesce(array_agg(DISTINCT c.address), '{}') INTO v_addr
    FROM app.supplier_contacts c
   WHERE c.tenant_id = v_tenant AND c.supplier_id = p_supplier
     AND NOT EXISTS (SELECT 1 FROM app.supplier_contacts o WHERE o.tenant_id = v_tenant AND o.address = c.address AND o.supplier_id <> p_supplier);

  SELECT coalesce(array_agg(c.id), '{}') INTO v_clar
    FROM app.clarifications c WHERE c.tenant_id = v_tenant AND (c.application_id = ANY (v_apps) OR c.supplier_id = p_supplier);

  -- Model exchanges: from its requests and from the messages deleted here.
  DELETE FROM app.llm_exchanges x
   WHERE x.tenant_id = v_tenant
     AND (x.application_id = ANY (v_apps)
          OR x.inbound_message_id IN (SELECT m.id FROM app.inbound_messages m WHERE m.tenant_id = v_tenant AND (m.from_address = ANY (v_addr) OR m.clarification_id = ANY (v_clar))));
  DELETE FROM app.inbound_messages m WHERE m.tenant_id = v_tenant AND (m.from_address = ANY (v_addr) OR m.clarification_id = ANY (v_clar));
  GET DIAGNOSTICS v_inbound = ROW_COUNT;
  DELETE FROM app.outbound_messages m WHERE m.tenant_id = v_tenant AND (m.destination = ANY (v_addr) OR m.clarification_id = ANY (v_clar));
  GET DIAGNOSTICS v_outbound = ROW_COUNT;
  DELETE FROM app.supplier_registrations r WHERE r.tenant_id = v_tenant AND (r.supplier_id = p_supplier OR r.application_id = ANY (v_apps) OR r.address = ANY (v_addr));
  DELETE FROM app.invoice_intakes i WHERE i.tenant_id = v_tenant AND (i.application_id = ANY (v_apps) OR i.address = ANY (v_addr));
  DELETE FROM app.corrections c WHERE c.tenant_id = v_tenant AND (c.application_id = ANY (v_apps) OR c.document_id = ANY (v_docs));
  DELETE FROM app.outcomes o WHERE o.tenant_id = v_tenant AND o.application_id = ANY (v_apps);
  GET DIAGNOSTICS v_outcomes = ROW_COUNT;
  DELETE FROM app.decisions d WHERE d.tenant_id = v_tenant AND d.application_id = ANY (v_apps);
  DELETE FROM app.clarifications c WHERE c.tenant_id = v_tenant AND c.id = ANY (v_clar);
  GET DIAGNOSTICS v_clarifications = ROW_COUNT;
  DELETE FROM app.application_documents ad WHERE ad.tenant_id = v_tenant AND ad.application_id = ANY (v_apps);
  DELETE FROM app.extractions e WHERE e.tenant_id = v_tenant AND e.document_id = ANY (v_docs);
  DELETE FROM app.documents d WHERE d.tenant_id = v_tenant AND d.id = ANY (v_docs);
  DELETE FROM app.applications a WHERE a.tenant_id = v_tenant AND a.id = ANY (v_apps);
  DELETE FROM app.supplier_contacts c WHERE c.tenant_id = v_tenant AND c.supplier_id = p_supplier;
  DELETE FROM app.suppliers s WHERE s.tenant_id = v_tenant AND s.id = p_supplier;

  RETURN jsonb_build_object(
    'application_ids', to_jsonb(v_apps),
    'run_ids', to_jsonb(v_runs),
    'storage_paths', to_jsonb(v_paths),
    'counts', jsonb_build_object(
      'applications', cardinality(v_apps),
      'documents', cardinality(v_docs),
      'outcomes', v_outcomes,
      'clarifications', v_clarifications,
      'messages', v_inbound + v_outbound
    )
  );
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_supplier(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_supplier(uuid) TO gow_api;
