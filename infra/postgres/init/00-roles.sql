-- Local dev only (docker compose): roles with login and dev passwords. Migration 0001_rls.sql
-- creates them without login if missing (Supabase), so they have to exist before it runs.
CREATE ROLE gow_api LOGIN PASSWORD 'gow_api_dev';
CREATE ROLE gow_worker LOGIN PASSWORD 'gow_worker_dev';
CREATE ROLE gow_whatsapp LOGIN PASSWORD 'gow_whatsapp_dev';
CREATE ROLE gow_readonly LOGIN PASSWORD 'gow_readonly_dev';
CREATE ROLE gow_queue LOGIN PASSWORD 'gow_queue_dev';
CREATE ROLE gow_mastra LOGIN PASSWORD 'gow_mastra_dev';
