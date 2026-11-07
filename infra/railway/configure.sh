#!/bin/sh
# Sets how each service of the linked Railway project (`railway link`) builds and starts. Railway no
# longer reads a per-service railway.json and its IaC needs another lockfile package, so this goes
# through the public API with the CLI. Idempotent. Variables are set apart (docs/deploy.md).
#
#   sh infra/railway/configure.sh
set -eu

status=$(railway status --json)
env_id=$(printf '%s' "$status" | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const envs = s.environments.edges.map((e) => e.node)
  const env = envs.find((e) => e.name === (process.env.RAILWAY_ENV ?? "production"))
  if (!env) process.exit(1)
  console.log(env.id)')
service_id() {
  printf '%s' "$status" | SERVICE="$1" node -e '
    const s = JSON.parse(require("fs").readFileSync(0, "utf8"))
    const svc = s.services.edges.map((e) => e.node).find((n) => n.name === process.env.SERVICE)
    if (!svc) { console.error(`no existe el servicio ${process.env.SERVICE}`); process.exit(1) }
    console.log(svc.id)'
}

update() {
  railway api 'mutation($s: String!, $e: String!, $i: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $i) }' \
    --raw-var s="$(service_id "$1")" --raw-var e="$env_id" --variables "{\"i\": $2}" >/dev/null
  echo "$1 configurado"
}

# One volume per service unless it already has one at that path (`railway volume add` is broken).
volume() {
  if railway volume list --json | SERVICE="$1" MOUNT="$2" node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8")).volumes
    process.exit(v.some((x) => x.serviceName === process.env.SERVICE && x.mountPath === process.env.MOUNT) ? 0 : 1)'; then
    echo "$1 ya tiene volumen en $2"
    return
  fi
  project_id=$(printf '%s' "$status" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).id)')
  railway api 'mutation($i: VolumeCreateInput!) { volumeCreate(input: $i) { id } }' \
    --variables "{\"i\": {\"projectId\": \"$project_id\", \"environmentId\": \"$env_id\", \"serviceId\": \"$(service_id "$1")\", \"mountPath\": \"$2\"}}" >/dev/null
  echo "$1: volumen en $2"
}
volume app /data
volume whatsapp /data/whatsapp

# API and worker together, sharing the document disk. Roles and migrations run before start.
update app '{
  "dockerfilePath": "Dockerfile",
  "preDeployCommand": ["sh infra/railway/predeploy.sh"],
  "startCommand": "sh infra/railway/app-start.sh",
  "healthcheckPath": "/healthz", "healthcheckTimeout": 120,
  "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 5,
  "ipv6EgressEnabled": true,
  "multiRegionConfig": { "us-west2": { "numReplicas": 1 } }
}'

# Static backoffice; nginx forwards /bo to app over the private network.
update web '{
  "dockerfilePath": "infra/railway/web.Dockerfile",
  "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 5,
  "multiRegionConfig": { "us-west2": { "numReplicas": 1 } }
}'

# Exactly one instance per WhatsApp number.
update whatsapp '{
  "dockerfilePath": "Dockerfile",
  "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 5,
  "ipv6EgressEnabled": true,
  "multiRegionConfig": { "us-west2": { "numReplicas": 1 } }
}'
