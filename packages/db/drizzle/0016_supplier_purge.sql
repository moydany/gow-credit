-- Borrar un proveedor desde el backoffice (ADR 0059): sus solicitudes, documentos, extracciones,
-- decisiones, aclaraciones, resultados de crédito, correcciones, registro, oferta y mensajes. El rol de
-- la API no recibe DELETE sobre esas tablas: solo puede borrar por esta función, que se revisa a mano
-- (docs/05 §2) y se otorga a un solo rol.
--
-- - Corre con el tenant de la transacción (`app.current_tenant()`); con FORCE ROW LEVEL SECURITY las
--   políticas siguen aplicando y, además, cada DELETE filtra por tenant.
-- - Un proveedor con una solicitud en proceso (received, extracting, extracted, deciding) no se borra:
--   el worker la está tocando. Error 55006 (object_in_use); la API contesta 409.
-- - Los mensajes se borran por la dirección de sus contactos solo si ningún otro proveedor del tenant
--   la usa, y siempre los de sus aclaraciones.
-- - Un documento que también use una solicitud de otro proveedor se queda.
-- - La bitácora no se toca: es el registro de quién hizo qué, sin contenido.
-- - Devuelve solo ids, rutas y conteos: la API encola la limpieza fuera de la base (PDFs, trabajos de
--   la cola y estado de Mastra) para el worker. Null si el proveedor no existe en este tenant.
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
