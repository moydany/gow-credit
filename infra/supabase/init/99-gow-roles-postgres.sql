-- Local Supabase only (docker-compose.supabase.yml). Runs as supabase_admin after 98-gow-roles.sql
-- (= infra/postgres/init/00-roles.sql), when `postgres` is no longer a superuser.
--
-- On Supabase the app roles are created by `postgres` (CREATEROLE), and Postgres 16+ gives it ADMIN
-- OPTION over them, without INHERIT or SET. Here supabase_admin created them, so `postgres` gets
-- the same membership. Migration 0001 also runs CREATE SCHEMA ... AUTHORIZATION gow_queue /
-- gow_mastra, which needs SET ROLE on that role: the same GRANT must be run on a hosted Supabase
-- project before `pnpm db:migrate` (docs/deploy.md).
GRANT gow_api, gow_worker, gow_whatsapp, gow_readonly TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT gow_queue, gow_mastra TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
