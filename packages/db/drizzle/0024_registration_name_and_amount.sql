ALTER TABLE "app"."supplier_registrations" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD COLUMN "requested_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD COLUMN "pending_document_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD CONSTRAINT "supplier_registrations_pending_document_id_documents_id_fk" FOREIGN KEY ("pending_document_id") REFERENCES "app"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Registration asks the contact name and the amount before the statement (ADR 0070). A PDF that
-- arrives first is stored and waits in pending_document_id; purge_supplier already deletes the
-- registration before the documents, so the foreign key does not block it.
