#!/bin/sh
# Railway `app` service: API and worker in one container, because they share the document disk and a
# Railway volume mounts on a single service. If either exits, the container exits and Railway restarts it.
set -u
tsx=./node_modules/.bin/tsx

# No PORT for the worker, so it skips its health listener; the port belongs to the API.
env -u PORT "$tsx" apps/worker/src/main.ts &
worker=$!
"$tsx" apps/api/src/main.ts &
api=$!

stop() { kill -TERM "$worker" "$api" 2>/dev/null; }
trap stop TERM INT

while kill -0 "$worker" 2>/dev/null && kill -0 "$api" 2>/dev/null; do
  sleep 2
done
stop
wait
exit 1
