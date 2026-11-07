ALTER TABLE "app"."tenants" ALTER COLUMN "statement_max_age_months" DROP DEFAULT;--> statement-breakpoint
-- Statement age doesn't decide by default: a new tenant has no limit (NULL), and those still on the
-- old default (3 months) move to NULL. Any other value was set by someone in settings and is kept.
-- The migration role skips RLS, so the UPDATE reaches every tenant.
UPDATE "app"."tenants" SET "statement_max_age_months" = NULL WHERE "statement_max_age_months" = 3;
