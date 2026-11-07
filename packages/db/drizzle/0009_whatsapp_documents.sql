ALTER TABLE "app"."inbound_messages" ADD COLUMN "attachment" "bytea";--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "attachment_name" text;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "attachment_media_type" text;--> statement-breakpoint
-- Estados de cuenta por WhatsApp (ADR 0037). gow_whatsapp ya inserta entrantes (todas las columnas,
-- incluidas las del adjunto) y sigue sin leer nada de negocio ni el almacenamiento de documentos.
-- El worker, que ya lee y actualiza entrantes e inserta documentos, ahora también abre la solicitud
-- de un documento recibido de un vínculo verificado (como hace la API con una llave de ingesta).
GRANT INSERT ON app.applications TO gow_worker;
