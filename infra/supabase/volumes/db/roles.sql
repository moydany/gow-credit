-- NOTE: change to your own passwords for production environments
-- GOW: copia de docker/volumes/db/roles.sql (supabase/supabase@bc27d26) sin la línea de
-- supabase_functions_admin, que crea webhooks.sql y este stack no incluye (ADR 0034).
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
