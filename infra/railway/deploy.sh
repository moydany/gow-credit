#!/bin/sh
# Deploys one commit to Railway, never the working folder: `git archive` leaves out anything
# unversioned (data/, .env, uncommitted changes). Defaults to HEAD and all three services, `app` first
# because its pre-deploy runs the migrations.
#
#   sh infra/railway/deploy.sh                 # HEAD → app, web, whatsapp
#   sh infra/railway/deploy.sh HEAD app web    # only those
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
