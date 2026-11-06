-- Solo Supabase local (docker-compose.supabase.yml, ADR 0034). Corre como supabase_admin después de
-- 98-gow-roles.sql (= infra/postgres/init/00-roles.sql), cuando `postgres` ya no es superusuario.
--
-- En Supabase, quien crea los roles de la app es `postgres` (CREATEROLE), y Postgres 16+ le da
-- ADMIN OPTION sobre ellos, sin INHERIT ni SET. Aquí los creó supabase_admin, así que se le da a
-- `postgres` esa misma membresía. Además, la migración 0001 hace CREATE SCHEMA ... AUTHORIZATION
-- gow_queue / gow_mastra, que exige poder hacer SET ROLE a ese rol: es el mismo GRANT que en un
-- proyecto de Supabase hay que correr antes de `pnpm db:migrate` (docs/deploy.md).
GRANT gow_api, gow_worker, gow_whatsapp, gow_readonly TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT gow_queue, gow_mastra TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
