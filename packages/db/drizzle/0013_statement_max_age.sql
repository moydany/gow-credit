ALTER TABLE "app"."tenants" ADD COLUMN "statement_max_age_months" integer DEFAULT 3;--> statement-breakpoint
-- Antigüedad máxima del estado de cuenta (ADR 0049): entre 1 y 24 meses, o NULL (sin límite). El
-- backoffice la cambia desde Configuración: `gow_api` solo puede escribir esa columna del tenant
-- (RLS forzada sigue limitándolo a su propio tenant). El worker ya lee app.tenants.
ALTER TABLE "app"."tenants" ADD CONSTRAINT "tenants_statement_max_age_months_range" CHECK ("statement_max_age_months" IS NULL OR "statement_max_age_months" BETWEEN 1 AND 24);
--> statement-breakpoint
GRANT UPDATE (statement_max_age_months) ON app.tenants TO gow_api;
