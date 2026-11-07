-- Recorrido de una solicitud (ADR 0067): la API reconstruye la línea de tiempo con filas ya guardadas, y
-- entre ellas los mensajes salientes. Hasta ahora `gow_api` no leía `app.outbound_messages` (docs/05 §2b:
-- el buzón de salida es del proceso de WhatsApp y del worker).
--
-- Privilegio POR COLUMNA y solo metadatos: nunca `body` (el texto que recibe el proveedor) ni
-- `destination` (su número o correo). Sin SELECT de tabla completa, `SELECT *` o esas columnas fallan con
-- "permission denied" aunque el código de la API tuviera un error. La política `tenant_isolation` de
-- 0001 no se limita por rol (FOR ALL, sin TO) y está forzada: ya aplica a gow_api, así que no hace falta otra.
GRANT SELECT (id, tenant_id, clarification_id, kind, channel, status, attempts, created_at, sent_at) ON app.outbound_messages TO gow_api;
