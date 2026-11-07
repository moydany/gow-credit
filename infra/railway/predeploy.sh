#!/bin/sh
# Antes de cada despliegue del servicio `app` (ADR 0068): da login y contraseña a los roles de cada
# proceso y después aplica las migraciones. Las dos cosas son idempotentes.
set -eu
./node_modules/.bin/tsx packages/db/src/cli/roles.ts
./node_modules/.bin/tsx packages/db/src/cli/migrate.ts
