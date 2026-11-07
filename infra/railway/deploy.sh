#!/bin/sh
# Despliega en Railway (ADR 0068) exactamente un commit, no la carpeta de trabajo: `git archive` deja
# fuera lo que no está versionado (data/, .env, cambios sin commit). Sin argumentos, HEAD y los tres
# servicios; `app` primero, porque su pre-deploy aplica las migraciones.
#
#   sh infra/railway/deploy.sh                 # HEAD → app, web, whatsapp
#   sh infra/railway/deploy.sh HEAD app web    # solo esos
set -eu
ref=${1:-HEAD}
[ $# -gt 0 ] && shift
services=${*:-app web whatsapp}

commit=$(git rev-parse --short "$ref")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git archive "$ref" | tar -x -C "$tmp"

for s in $services; do
  railway up "$tmp" --path-as-root --service "$s" --detach --message "$commit" >/dev/null
  echo "$s: despliegue de $commit enviado"
done
echo "Sigue el avance con: railway service status --all  (o railway logs --service <servicio>)"
