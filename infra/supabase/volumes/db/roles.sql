-- NOTE: change to your own passwords for production environments
-- GOW: copy of docker/volumes/db/roles.sql (supabase/supabase@bc27d26) without the
-- supabase_functions_admin line, which webhooks.sql creates and this stack doesn't include.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
