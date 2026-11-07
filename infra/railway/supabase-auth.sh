#!/bin/sh
# Configures Supabase Auth for the Railway demo through the Management API: access token hook, sign-ups
# off, site and redirect URLs, Resend as SMTP and the magic link email in Spanish. The Supabase MCP
# can't change Auth config. The Resend key and sender are read from the Railway `app` variables and
# nothing secret is printed. Needs a personal access token (supabase.com/dashboard/account/tokens),
# asked for if SUPABASE_ACCESS_TOKEN isn't set.
#
#   sh infra/railway/supabase-auth.sh
set -eu
# From the repository root: the email template is read from infra/supabase/templates.
cd "$(dirname "$0")/../.."
ref=${SUPABASE_PROJECT_REF:-vicuzdllbwnxfckhawak}
service=${RAILWAY_APP_SERVICE:-app}

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  printf 'Token personal de Supabase (no se muestra): '
  stty -echo; read -r SUPABASE_ACCESS_TOKEN; stty echo; echo
fi
export SUPABASE_ACCESS_TOKEN

# Builds the payload from the Railway variables without echoing them.
payload=$(railway variable list --service "$service" --json | SERVICE="$service" node -e '
  const v = JSON.parse(require("fs").readFileSync(0, "utf8"))
  for (const k of ["BACKOFFICE_URL", "RESEND_API_KEY", "RESEND_FROM"]) {
    if (!v[k]) { console.error(`falta ${k} en ${process.env.SERVICE ?? "app"}`); process.exit(1) }
  }
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(v.RESEND_FROM)
  const site = v.BACKOFFICE_URL.replace(/\/$/, "")
  process.stdout.write(JSON.stringify({
    hook_custom_access_token_enabled: true,
    hook_custom_access_token_uri: "pg-functions://postgres/app/custom_access_token_hook",
    disable_signup: true,
    site_url: site,
    uri_allow_list: `${site}/entrar`,
    smtp_host: "smtp.resend.com",
    smtp_port: "465",
    smtp_user: "resend",
    smtp_pass: v.RESEND_API_KEY,
    smtp_admin_email: m ? m[2] : v.RESEND_FROM.trim(),
    smtp_sender_name: m && m[1] ? m[1] : "GOW Credit",
    mailer_subjects_magic_link: "Tu enlace para entrar a GOW Credit",
    // The link goes to /entrar#token_hash=…: the session opens on the click, not on opening it.
    mailer_templates_magic_link_content: require("fs").readFileSync("infra/supabase/templates/magic-link.html", "utf8"),
  }))')

api="https://api.supabase.com/v1/projects/$ref/config/auth"
code=$(printf '%s' "$payload" | curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$api" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' --data-binary @-)
if [ "$code" != "200" ]; then
  echo "Supabase respondió $code: revisa el token y que tenga acceso al proyecto $ref"
  exit 1
fi

# Shows what was applied, without secrets.
curl -sS "$api" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | node -e '
  const c = JSON.parse(require("fs").readFileSync(0, "utf8"))
  for (const k of ["hook_custom_access_token_enabled", "hook_custom_access_token_uri", "disable_signup", "site_url",
    "uri_allow_list", "smtp_host", "smtp_port", "smtp_admin_email", "smtp_sender_name", "mailer_subjects_magic_link"])
    console.log(`${k}: ${c[k]}`)'
