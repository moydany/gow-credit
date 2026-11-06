-- Configuración del backoffice (docs/08 §2): el usuario del prestamista lista, crea y revoca llaves
-- de API y quita usuarios. Privilegios mínimos para `gow_api`:
-- - api_keys: lee todo menos `key_hash` (el hash nunca sale de la base salvo por resolve_api_key) y
--   solo puede escribir `revoked_at`; la llave nunca se borra, queda revocada con su fecha.
-- - tenant_users: puede borrar la pertenencia; la sesión de quien se quita se corta en la siguiente
--   petición. RLS forzada sigue aplicando a ambas.
GRANT SELECT (id, tenant_id, prefix, scopes, created_at, revoked_at) ON app.api_keys TO gow_api;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON app.api_keys TO gow_api;
--> statement-breakpoint
GRANT DELETE ON app.tenant_users TO gow_api;
