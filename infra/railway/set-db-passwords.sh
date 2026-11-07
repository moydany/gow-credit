#!/bin/sh
# Genera una contraseña por rol de base y la guarda en las variables del servicio `app` de Railway
# (ADR 0068), sin imprimirla. El siguiente despliegue de `app` se las pone a los roles en Supabase
# (infra/railway/predeploy.sh). Volver a correrlo las rota todas.
#
#   sh infra/railway/set-db-passwords.sh            # proyecto y entorno enlazados con `railway link`
set -eu
service=${RAILWAY_APP_SERVICE:-app}
for role in API WORKER WHATSAPP READONLY QUEUE MASTRA; do
  openssl rand -hex 32 | railway variable set "GOW_DB_PASSWORD_$role" --stdin --service "$service" --skip-deploys >/dev/null
  echo "GOW_DB_PASSWORD_$role guardada en $service"
done
