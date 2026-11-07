CREATE TABLE "app"."supplier_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" "app"."channel" NOT NULL,
	"address" text NOT NULL,
	"step" text NOT NULL,
	"legal_name" text,
	"supplier_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD CONSTRAINT "supplier_registrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD CONSTRAINT "supplier_registrations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "app"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_registrations_address" ON "app"."supplier_registrations" USING btree ("tenant_id","channel","address");--> statement-breakpoint
-- Supplier registration over WhatsApp for the demo. Forced RLS like the rest. Only the worker runs
-- the registration conversation; WhatsApp still sees no business data.
ALTER TABLE app.supplier_registrations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.supplier_registrations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.supplier_registrations FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.supplier_registrations TO gow_worker;
--> statement-breakpoint
GRANT SELECT ON app.supplier_registrations TO gow_readonly;
--> statement-breakpoint
-- When registration finishes, the worker creates the supplier and its contact, verified by possession of the number.
GRANT INSERT ON app.suppliers, app.supplier_contacts TO gow_worker;
