CREATE TABLE "app"."invoice_intakes" (
	"application_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" "app"."channel" NOT NULL,
	"address" text NOT NULL,
	"step" text NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."invoice_intakes" ADD CONSTRAINT "invoice_intakes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "app"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoice_intakes" ADD CONSTRAINT "invoice_intakes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_intakes_open" ON "app"."invoice_intakes" USING btree ("tenant_id","channel","address","step");--> statement-breakpoint
-- Datos de la factura por WhatsApp (ADR 0039). RLS forzada como el resto (docs/05 §2); solo el worker
-- lleva la conversación. WhatsApp sigue sin ver nada de negocio.
ALTER TABLE app.invoice_intakes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.invoice_intakes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.invoice_intakes FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.invoice_intakes TO gow_worker;
--> statement-breakpoint
GRANT SELECT ON app.invoice_intakes TO gow_readonly;
