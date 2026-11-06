CREATE TYPE "app"."whatsapp_session_status" AS ENUM('starting', 'waiting_qr', 'open', 'closed', 'logged_out');--> statement-breakpoint
CREATE TABLE "app"."whatsapp_sessions" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"status" "app"."whatsapp_session_status" DEFAULT 'starting' NOT NULL,
	"qr" text,
	"qr_expires_at" timestamp with time zone,
	"linked_number" text,
	"heartbeat_at" timestamp with time zone,
	"unlink_requested_at" timestamp with time zone,
	"unlink_handled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."whatsapp_sessions" ADD CONSTRAINT "whatsapp_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Vinculación de WhatsApp desde el backoffice (ADR 0033). RLS forzada como en el resto (docs/05 §2):
-- - gow_whatsapp publica el estado de la sesión de su tenant: lee, inserta y actualiza su fila;
--   sigue sin ver nada de negocio.
-- - gow_api lee el estado (incluido el QR, que solo se entrega a usuarios del tenant) y solo puede
--   escribir `unlink_requested_at`: pedir que el proceso cierre la sesión y muestre un QR nuevo.
ALTER TABLE app.whatsapp_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.whatsapp_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app.whatsapp_sessions FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.whatsapp_sessions TO gow_whatsapp;
--> statement-breakpoint
GRANT SELECT ON app.whatsapp_sessions TO gow_api, gow_readonly;
--> statement-breakpoint
GRANT UPDATE (unlink_requested_at) ON app.whatsapp_sessions TO gow_api;
