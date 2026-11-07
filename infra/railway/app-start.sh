#!/bin/sh
# Servicio `app` en Railway (ADR 0068): la API y el worker en el mismo contenedor porque comparten el
# disco de los documentos (LocalDocumentStorage) y en Railway un volumen se monta en un solo servicio.
# Si cualquiera de los dos termina, termina el contenedor y Railway lo reinicia completo.
set -u
tsx=./node_modules/.bin/tsx

# Sin PORT, el worker no abre su listener de salud: el puerto es de la API.
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
