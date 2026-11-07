#!/bin/sh
# pnpm stack:up | stack:down | stack:reset | stack:logs | stack:ps   (ADR 0061)
#
# La pila completa en local con docker compose: Supabase, migración, API, worker, WhatsApp y backoffice.
# Antes de levantar, genera los secretos de desarrollo si faltan (scripts/supabase-env.sh, que conserva
# los que ya existen) y construye la imagen. Los puertos se cambian con GOW_WEB_PORT y GOW_API_PORT.
set -eu

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
ENV_FILE=infra/supabase/.env
compose() {
  docker compose -f docker-compose.supabase.yml -f docker-compose.stack.yml --env-file "$ENV_FILE" "$@"
}

# Valor de una variable del .env de la raíz (sin cargar el archivo entero ni mostrar nada).
envval() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | head -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Correo de acceso de Supabase Auth (ADR 0063): con RESEND_API_KEY en el .env de la raíz, GoTrue manda
# los enlaces por el SMTP de Resend; sin ella, quedan en Inbucket (http://127.0.0.1:54343).
MAIL_VIA="Inbucket (http://127.0.0.1:54343)"
RESEND_KEY=$(envval RESEND_API_KEY)
if [ -n "$RESEND_KEY" ]; then
  from=$(envval RESEND_FROM)
  # Sin dominio verificado, Resend solo deja mandar desde su remitente de pruebas, y solo al dueño de la cuenta.
  from=${from:-"GOW Credit <onboarding@resend.dev>"}
  addr=$(printf '%s' "$from" | sed -n 's/.*<\(.*\)>.*/\1/p')
  [ -n "$addr" ] || addr=$from
  name=$(printf '%s' "$from" | sed -n 's/^\(.*\)<.*/\1/p' | sed 's/ *$//')
  GOW_SMTP_HOST=smtp.resend.com
  GOW_SMTP_PORT=465
  GOW_SMTP_USER=resend
  GOW_SMTP_PASS=$RESEND_KEY
  GOW_SMTP_ADMIN_EMAIL=$addr
  GOW_SMTP_SENDER_NAME=${name:-GOW Credit}
  export GOW_SMTP_HOST GOW_SMTP_PORT GOW_SMTP_USER GOW_SMTP_PASS GOW_SMTP_ADMIN_EMAIL GOW_SMTP_SENDER_NAME
  MAIL_VIA="Resend (remitente $addr)"
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker no está corriendo: ábrelo (Docker Desktop) y vuelve a intentar." >&2
  exit 1
fi

cmd=${1:-up}
[ $# -gt 0 ] && shift

case "$cmd" in
  up)
    if [ ! -f "$ENV_FILE" ]; then
      command -v node >/dev/null 2>&1 || { echo "Falta Node (solo para generar los secretos la primera vez)." >&2; exit 1; }
      sh scripts/supabase-env.sh
    fi
    compose up -d --build --wait "$@"
    web=${GOW_WEB_PORT:-5173}
    echo
    echo "Listo."
    echo "  Backoffice  http://127.0.0.1:$web   (la primera vez abre el wizard: crea al prestamista y vincula WhatsApp)"
    echo "  API         http://127.0.0.1:${GOW_API_PORT:-3000}"
    echo "  Studio      http://127.0.0.1:54342"
    echo "  Enlaces de acceso: por $MAIL_VIA"
    ;;
  down)
    compose down "$@"
    ;;
  reset)
    echo "Esto borra la base, la sesión de WhatsApp y los documentos de la pila local."
    compose down -v "$@"
    ;;
  logs)
    compose logs -f --tail=100 api worker whatsapp "$@"
    ;;
  ps)
    compose ps "$@"
    ;;
  *)
    echo "uso: pnpm stack:up | stack:down | stack:reset | stack:logs | stack:ps" >&2
    exit 64
    ;;
esac
