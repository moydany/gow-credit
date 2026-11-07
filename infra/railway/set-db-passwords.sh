#!/bin/sh
# Generates one password per database role and stores it in the Railway `app` variables without
# printing it. The next `app` deploy applies them in Supabase (predeploy.sh). Rerunning rotates them all.
#
#   sh infra/railway/set-db-passwords.sh            # project and environment from `railway link`
set -eu
service=${RAILWAY_APP_SERVICE:-app}
for role in API WORKER WHATSAPP READONLY QUEUE MASTRA; do
  openssl rand -hex 32 | railway variable set "GOW_DB_PASSWORD_$role" --stdin --service "$service" --skip-deploys >/dev/null
  echo "GOW_DB_PASSWORD_$role guardada en $service"
done
