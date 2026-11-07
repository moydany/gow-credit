ALTER TABLE "app"."tenants" ADD COLUMN "statement_max_age_months" integer DEFAULT 3;--> statement-breakpoint
-- Maximum statement age: between 1 and 24 months, or NULL (no limit). The backoffice changes it from
-- settings: `gow_api` can only write that column of its tenant (forced RLS still limits it to its own
-- tenant). The worker already reads app.tenants.
ALTER TABLE "app"."tenants" ADD CONSTRAINT "tenants_statement_max_age_months_range" CHECK ("statement_max_age_months" IS NULL OR "statement_max_age_months" BETWEEN 1 AND 24);
--> statement-breakpoint
GRANT UPDATE (statement_max_age_months) ON app.tenants TO gow_api;
