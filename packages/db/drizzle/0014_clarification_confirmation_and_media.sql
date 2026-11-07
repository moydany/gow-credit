ALTER TABLE "app"."clarifications" ADD COLUMN "step" text DEFAULT 'asking' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "media_kind" text;--> statement-breakpoint
-- Clarification summary and confirmation, and photos or voice notes over WhatsApp. No new grants:
-- gow_worker already updates app.clarifications (whole table) and gow_whatsapp already inserts
-- app.inbound_messages (all columns); app.pending_inbound only returns ids.
ALTER TABLE "app"."clarifications" ADD CONSTRAINT "clarifications_step_check" CHECK ("step" IN ('asking', 'revising', 'confirming', 'confirmed'));
--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD CONSTRAINT "inbound_messages_media_kind_check" CHECK ("media_kind" IS NULL OR "media_kind" IN ('image', 'audio', 'video', 'sticker'));
