CREATE TABLE "app"."prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_name" text NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"file_version" integer,
	"text" text NOT NULL,
	"sha256" text NOT NULL,
	"note" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_versions_name_version" UNIQUE("prompt_name","version"),
	CONSTRAINT "prompt_versions_name_id" UNIQUE("prompt_name","id"),
	CONSTRAINT "prompt_versions_source" CHECK (("app"."prompt_versions"."source" = 'file' AND "app"."prompt_versions"."file_version" IS NOT NULL) OR ("app"."prompt_versions"."source" = 'backoffice' AND "app"."prompt_versions"."file_version" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."prompts" (
	"name" text PRIMARY KEY NOT NULL,
	"code_default_file_version" integer NOT NULL,
	"active_version_id" uuid,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_name_prompts_name_fk" FOREIGN KEY ("prompt_name") REFERENCES "app"."prompts"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."prompts" ADD CONSTRAINT "prompts_active_version_fk" FOREIGN KEY ("name","active_version_id") REFERENCES "app"."prompt_versions"("prompt_name","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_name_file" ON "app"."prompt_versions" USING btree ("prompt_name","file_version");--> statement-breakpoint
-- Prompts in the database. Global: no tenant_id, the same for every lender. Forced RLS like all of
-- `app`, with policies that don't split by tenant:
-- - gow_api, gow_worker and gow_readonly read everything (the worker loads the active versions).
-- - Only gow_api writes: it inserts backoffice versions and changes which is active. Who may do so
--   is decided by the API (BACKOFFICE_PROMPT_EDITORS); the database only limits the columns.
-- - File versions are seeded by the migration owner (`syncPromptFiles`).
-- - No version is modified or deleted, not even by an admin: a trigger rejects it.
ALTER TABLE app.prompts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.prompts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.prompt_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.prompt_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY global_read ON app.prompts FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY api_activate ON app.prompts FOR UPDATE TO gow_api USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY global_read ON app.prompt_versions FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY api_create ON app.prompt_versions FOR INSERT TO gow_api WITH CHECK (source = 'backoffice' AND file_version IS NULL);
--> statement-breakpoint
GRANT SELECT ON app.prompts, app.prompt_versions TO gow_api, gow_worker, gow_readonly;
--> statement-breakpoint
GRANT INSERT ON app.prompt_versions TO gow_api;
--> statement-breakpoint
GRANT UPDATE (active_version_id, activated_at, activated_by) ON app.prompts TO gow_api;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.prompt_versions_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'las versiones de un prompt son inmutables: crea una nueva' USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE OR DELETE ON app.prompt_versions
  FOR EACH ROW EXECUTE FUNCTION app.prompt_versions_immutable();
--> statement-breakpoint
-- Without BACKOFFICE_PROMPT_EDITORS, editing prompts is allowed only on an install with a single
-- lender (the local demo): the API has to be able to tell without reading `tenants`.
GRANT EXECUTE ON FUNCTION app.sole_tenant() TO gow_api;
