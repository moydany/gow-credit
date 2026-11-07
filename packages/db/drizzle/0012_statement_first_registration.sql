ALTER TABLE "app"."suppliers" ALTER COLUMN "legal_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD COLUMN "rfc" text;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD COLUMN "holder_name" text;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD COLUMN "holder_rfc" text;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD COLUMN "corrected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."suppliers" ADD COLUMN "representative_name" text;--> statement-breakpoint
ALTER TABLE "app"."supplier_registrations" ADD CONSTRAINT "supplier_registrations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "app"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Statement-first registration: the worker creates the supplier with no identity when the PDF
-- arrives and fills it in when the supplier confirms or corrects the holder and RFC.
GRANT UPDATE ON app.suppliers TO gow_worker;
