DROP INDEX "app"."clarifications_application";--> statement-breakpoint
ALTER TABLE "app"."outbound_messages" ALTER COLUMN "clarification_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."outbound_messages" ADD COLUMN "kind" text DEFAULT 'question' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clarifications_round" ON "app"."clarifications" USING btree ("application_id","round");