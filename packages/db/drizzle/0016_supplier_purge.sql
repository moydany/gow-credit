-- Deleting a supplier from the backoffice: its requests, documents, extractions, decisions,
-- clarifications, credit results, corrections, registration, offer and messages. The API role gets no
-- DELETE on those tables: it can only delete through this function, which is reviewed by hand and
-- granted to a single role.
--
-- - Runs under the transaction's tenant (`app.current_tenant()`); with FORCE ROW LEVEL SECURITY the
--   policies still apply, and each DELETE also filters by tenant.
-- - A supplier with a request in progress (received, extracting, extracted, deciding) isn't deleted:
--   the worker is touching it. Error 55006 (object_in_use); the API answers 409.
-- - Messages are deleted by their contacts' address only if no other supplier in the tenant uses it,
--   and always those of its clarifications.
-- - A document also used by another supplier's request stays.
-- - The audit log is untouched: it records who did what, with no content.
-- - Returns only ids, paths and counts: the API enqueues cleanup outside the database (PDFs, queue
--   jobs and Mastra state) for the worker. Null if the supplier doesn't exist in this tenant.
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
