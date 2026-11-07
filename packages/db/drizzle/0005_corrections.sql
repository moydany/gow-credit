CREATE TABLE "app"."corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"target" jsonb NOT NULL,
	"read_value" jsonb,
	"value" jsonb NOT NULL,
	"page" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."corrections" ADD CONSTRAINT "corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."corrections" ADD CONSTRAINT "corrections_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "app"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."corrections" ADD CONSTRAINT "corrections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corrections_application" ON "app"."corrections" USING btree ("tenant_id","application_id","created_at");
--> statement-breakpoint
-- Forced RLS and minimal privileges: the API inserts and reads analyst corrections; the worker only
-- reads them to re-evaluate; nobody updates or deletes them.
ALTER TABLE app.corrections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.corrections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.corrections FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
GRANT SELECT ON app.corrections TO gow_api, gow_worker, gow_readonly;
--> statement-breakpoint
GRANT INSERT ON app.corrections TO gow_api;
