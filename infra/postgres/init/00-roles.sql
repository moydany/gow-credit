-- Solo desarrollo local (docker compose): roles con login y contraseña de desarrollo. La
-- migración 0001_rls.sql los crea sin login si no existen (Supabase), así que aquí van antes.
CREATE ROLE gow_api LOGIN PASSWORD 'gow_api_dev';
CREATE ROLE gow_worker LOGIN PASSWORD 'gow_worker_dev';
CREATE ROLE gow_whatsapp LOGIN PASSWORD 'gow_whatsapp_dev';
CREATE ROLE gow_readonly LOGIN PASSWORD 'gow_readonly_dev';
CREATE ROLE gow_queue LOGIN PASSWORD 'gow_queue_dev';
CREATE ROLE gow_mastra LOGIN PASSWORD 'gow_mastra_dev';
