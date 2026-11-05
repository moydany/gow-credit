CREATE TABLE "app"."tenant_users" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_users_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."tenant_users" ADD CONSTRAINT "tenant_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_users_email" ON "app"."tenant_users" USING btree ("email");--> statement-breakpoint
-- RLS forzada como en el resto de las tablas (docs/05 §2). La API lee la pertenencia en cada
-- petición del backoffice (así quitar un usuario surte efecto de inmediato) y puede invitar.
ALTER TABLE app.tenant_users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.tenant_users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.tenant_users FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
GRANT SELECT ON app.tenant_users TO gow_api, gow_readonly;
--> statement-breakpoint
GRANT INSERT ON app.tenant_users TO gow_api;
