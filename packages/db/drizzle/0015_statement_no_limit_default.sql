ALTER TABLE "app"."tenants" ALTER COLUMN "statement_max_age_months" DROP DEFAULT;--> statement-breakpoint
-- La antigüedad del estado de cuenta no decide por defecto (ADR 0054): un tenant nuevo queda sin límite
-- (NULL) y los que seguían con el valor por defecto de la ADR 0049 (3 meses) pasan a NULL. Cualquier otro
-- valor lo fijó alguien desde Configuración y se conserva. El rol de migraciones salta RLS (ADR 0035), así
-- que el UPDATE alcanza a todos los tenants.
UPDATE "app"."tenants" SET "statement_max_age_months" = NULL WHERE "statement_max_age_months" = 3;
