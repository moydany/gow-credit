ALTER TABLE "app"."inbound_messages" ADD COLUMN "attachment" "bytea";--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "attachment_name" text;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "attachment_media_type" text;--> statement-breakpoint
-- Statements over WhatsApp. gow_whatsapp already inserts incoming messages (all columns, including
-- the attachment ones) and still reads no business data or document storage. The worker, which
-- already reads and updates incoming messages and inserts documents, now also opens the request for
-- a document received from a verified link (as the API does with an ingest key).
GRANT INSERT ON app.applications TO gow_worker;
