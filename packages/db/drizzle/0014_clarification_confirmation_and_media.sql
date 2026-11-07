ALTER TABLE "app"."clarifications" ADD COLUMN "step" text DEFAULT 'asking' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "media_kind" text;--> statement-breakpoint
-- Resumen y confirmación de la aclaración, y fotos o notas de voz por WhatsApp (ADR 0051). Sin grants
-- nuevos: gow_worker ya actualiza app.clarifications (tabla completa) y gow_whatsapp ya inserta
-- app.inbound_messages (todas las columnas); app.pending_inbound solo devuelve ids.
ALTER TABLE "app"."clarifications" ADD CONSTRAINT "clarifications_step_check" CHECK ("step" IN ('asking', 'revising', 'confirming', 'confirmed'));
--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD CONSTRAINT "inbound_messages_media_kind_check" CHECK ("media_kind" IS NULL OR "media_kind" IN ('image', 'audio', 'video', 'sticker'));
