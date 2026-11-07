# Plan de despliegue: Cloud Run, Supabase y Vercel

Fecha: 2026-11-05. El worksample no se desplegó: no hay cuentas creadas ni nada publicado.
Este documento es el plan, con lo que ya está listo en el repositorio y lo que falta para
producción.

## Piezas

```text
           Vercel                       Cloud Run (us-central1 o northamerica-south1)
┌──────────────────────┐   /bo/*    ┌────────────────────┐        ┌────────────────────┐
│ apps/web (estático)  │──rewrite──▶│ api (Express 5)    │──cola─▶│ worker (pg-boss +  │
└──────────────────────┘            │ escala a cero      │        │ Mastra), mín. 1    │
                                    └─────────┬──────────┘        └─────────┬──────────┘
 Proveedor ── WhatsApp ── whatsapp (1 instancia) ─┐  │                      │
 Proveedor ── correo ── Resend ── webhook ────────┼──┘                      │
                                                  ▼                          ▼
                              Supabase: Postgres 17 (RLS, roles por proceso), Storage, Auth
                                                  │
                         Google (Gemini) · Anthropic · TypeSafe (Jev) ◀─────┘
```

| Proceso | Dónde | Imagen o build | Escala | Rol de base |
|---|---|---|---|---|
| `api` | Cloud Run service | `Dockerfile`, `APP=api` | 0 a N; concurrencia 80 | `gow_api` |
| `worker` | Cloud Run service con CPU siempre asignada (`--no-cpu-throttling`), o worker pool | `Dockerfile`, `APP=worker` | mín. 1; el semáforo limita las llamadas a modelos | `gow_worker`, `gow_queue`, `gow_mastra` |
| `whatsapp` | Cloud Run service, 1 instancia fija | `Dockerfile`, `APP=whatsapp` | exactamente 1 por número | `gow_whatsapp` |
| `web` | Vercel | `pnpm -F @gow/web build` → `apps/web/dist` | CDN | ninguno: solo habla con `/bo/v1` |
| Base y archivos | Supabase gestionado | migraciones con `pnpm db:migrate` | plan Pro | `gow_admin` solo para migrar |

Las imágenes se construyen en CI (`.github/workflows/ci.yml`, job `images`) sin publicarse. Se
publican y se despliegan a mano con `.github/workflows/deploy.yml`, que entra a Google Cloud con
Workload Identity Federation (ver "Pipeline de despliegue"). No hay llaves de servicio de larga
vida.

## Pasos

1. **Supabase.**
   - Crear el proyecto en la región más cercana a la de Cloud Run.
   - Correr `infra/postgres/init/00-roles.sql` adaptado: en Supabase los roles se crean con
     contraseña propia, una por proceso, nunca la del dueño.
   - Como `postgres`, que no es superusuario en Supabase, darse SET sobre los dueños de los
     esquemas de pg-boss y Mastra. Sin esto, la migración 0001 falla en `CREATE SCHEMA ...
     AUTHORIZATION`:

     ```sql
     GRANT gow_queue, gow_mastra TO postgres WITH INHERIT FALSE, SET TRUE;
     ```

   - Correr `pnpm db:migrate` con `DATABASE_ADMIN_URL`, la URL del rol `postgres`.
   - Antes de tocar el proyecto real, todo esto se prueba con el Supabase local
     (`pnpm supabase:up`): ahí `postgres` tampoco es
     superusuario.
   - La prueba de RLS (`pnpm test` contra esa base, en un proyecto de staging) confirma que
     ninguna tabla de negocio quedó sin política.
   - **Auth del backoffice.** La migración 0008 crea el custom access token hook y,
     como existe `supabase_auth_admin`, le da `EXECUTE`. Después:
     - Activarlo en Authentication → Hooks → "Customize Access Token (JWT) Claims", tipo
       Postgres, función `app.custom_access_token_hook`. Si el panel no lista el esquema `app`,
       usar la Management API (`PATCH /v1/projects/{ref}/config/auth` con
       `hook_custom_access_token_enabled: true` y
       `hook_custom_access_token_uri: "pg-functions://postgres/app/custom_access_token_hook"`).
     - Apagar el registro público ("Allow new users to sign up").
     - Poner el backoffice como Site URL y `https://<backoffice>/entrar` en las Redirect URLs.
     - Configurar el SMTP propio (Resend) y la plantilla del magic link en español.
     - Dejar la llave HS256 heredada como la que firma: la API no verifica JWKS todavía.
     - Comprobar con un usuario de prueba que su token trae `tenant_id`.
     - Dejar encendida la rotación de refresh tokens con su intervalo de reúso (10 s por
       defecto): la API depende de él para peticiones en paralelo entre instancias.
2. **Secretos** en Google Secret Manager, montados como variables en cada servicio:
   - `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY`;
   - una `DATABASE_URL_*` por rol;
   - `STORAGE_SIGNING_SECRET`, `BACKOFFICE_JWT_SECRET` (el JWT secret de Supabase);
   - para el `api`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` y
     `BACKOFFICE_URL` (login por correo); opcionales, `BACKOFFICE_SESSION_MAX_HOURS`
     (12) y `BACKOFFICE_SESSION_IDLE_HOURS` (8), los límites de la sesión renovable;
   - `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`.

   Cada servicio recibe solo los suyos: el `api` no ve las llaves de modelos y el `whatsapp` no
   ve la base completa (`docs/05` §2b).
3. **Cloud Run.** Desplegar `api`, `worker` y `whatsapp` desde Artifact Registry, cada uno con
   una cuenta de servicio sin permisos de proyecto. Sin `--allow-unauthenticated` en el `worker`
   ni en el `whatsapp`. El `api` es público: su autenticación es la llave del tenant y la cookie
   del backoffice.
4. **Vercel.** Proyecto con raíz `apps/web` y un rewrite para que la cookie de sesión
   (`SameSite=Strict`, `Path=/bo`) sea del mismo origen:

   ```json
   { "rewrites": [{ "source": "/bo/:path*", "destination": "https://api.<dominio>/bo/:path*" }] }
   ```

5. **Resend.** Dominio verificado y webhook de correo entrante hacia `POST` de la API, con el
   secreto de firma.
6. **WhatsApp.** Con el servicio `whatsapp` arriba, vincular el número escaneando el QR en el
   backoffice, en Configuración. Sin terminal, el QR no se imprime en los registros. Ver
   "Falta para producción".

## Pipeline de despliegue

`.github/workflows/deploy.yml` hace los pasos 3 y 4 de arriba (Cloud Run y Vercel) y
corre `pnpm db:migrate` del paso 1. El archivo está escrito y pasa `actionlint`, pero **no se ha
ejecutado**: no hay cuentas ni recursos en la nube y nada se ha desplegado. Lo que sigue describe lo
que hará y lo que hay que crear antes.

### Flujo

```text
push o pull request ─▶ ci.yml: typecheck, lint, test, escenarios, build del backoffice,
                              imágenes de api y worker sin publicar, gitleaks, osv-scanner
                                  │
                a mano, sobre el commit que se quiere publicar
                                  ▼
        Actions ▶ deploy ▶ Run workflow     environment: staging | production
                                            services: api,worker,whatsapp,web
   plan ─▶ images ─────────▶ migrate ─────▶ deploy-api        ┐
     │     api, worker,      solo con       deploy-worker     ├ Cloud Run
     │     whatsapp          worker         deploy-whatsapp   ┘
     │     (tag = SHA)
     └──▶ web: vercel pull, build y deploy (--prod solo en production)
```

1. **`plan`** valida `services` (`api`, `worker`, `whatsapp`, `web`, separados por coma) y decide qué
   jobs corren; los demás se saltan sin fallar. Un nombre desconocido o una lista vacía detienen el
   workflow.
2. **`images`** construye con el `Dockerfile` existente (`APP=api|worker|whatsapp`) y publica
   `<región>-docker.pkg.dev/<proyecto>/<repositorio>/gow-<servicio>:<SHA del commit>`. Todas las
   imágenes terminan antes de migrar o desplegar: si una falla, no se despliega nada.
3. **`migrate`** corre solo si `worker` está en `services`: `pnpm db:migrate` con el secreto
   `DATABASE_ADMIN_URL` del environment. Si corrió, `api` y `whatsapp` esperan a que termine; si
   falla, ningún servicio se despliega.
4. **`deploy-api`, `deploy-worker` y `deploy-whatsapp`** (un job por servicio) llaman a
   `google-github-actions/deploy-cloudrun` con los parámetros de la tabla siguiente. Los servicios
   se llaman `gow-<servicio>-<entorno>`, por ejemplo `gow-api-staging`.
5. **`web`** instala con el mismo pnpm y Node que CI, escribe en el `vercel.json` de la corrida (no en
   el versionado) el destino de `/bo/*` hacia `API_PUBLIC_URL`, y corre `vercel pull`, `vercel build`
   y `vercel deploy --prebuilt`. `--prod` solo en `production`; `staging` queda como preview.

Reglas del workflow:

- **Identidad.** Cada job que habla con Google pide un token OIDC (`id-token: write`) y
  `google-github-actions/auth` lo cambia por credenciales de corta vida de la cuenta de servicio del
  despliegue. No hay llaves JSON. Los jobs que bajan el repositorio tienen `contents: read`, los
  `deploy-*` solo el token OIDC y `plan` ningún permiso.
- **Un despliegue por entorno a la vez.** El segundo espera, no cancela al primero.
- **Aprobaciones.** Un environment con revisores obligatorios pide aprobación en cada job que lo
  usa, y los jobs corren por tandas (imágenes y backoffice, migración, despliegues). Conviene ponerlos
  solo en `production`.
- **Marcha atrás.** Las imágenes llevan el SHA. Para volver, se manda el tráfico a la revisión
  anterior (`gcloud run services update-traffic gow-api-production --region=<región>
  --to-revisions=<revisión>=100`); mientras el tráfico esté fijado así, los despliegues nuevos no lo
  reciben hasta pasar `--to-latest`. Las migraciones no se deshacen: tienen que ser compatibles con
  el código anterior.

### Parámetros de Cloud Run

| Servicio | Acceso | Instancias | CPU y memoria |
|---|---|---|---|
| `gow-api-<entorno>` | público (`--allow-unauthenticated`) | de 0 a 10, concurrencia 80 | 1 vCPU, 1 GiB |
| `gow-worker-<entorno>` | sin acceso público | mínimo 1, máximo 3, `--no-cpu-throttling` | 1 vCPU, 1 GiB |
| `gow-whatsapp-<entorno>` | sin acceso público | exactamente 1 (mínimo 1, máximo 1), `--no-cpu-throttling` | 1 vCPU, 1 GiB |

Vienen de este documento: el acceso, el mínimo y la CPU siempre asignada del worker, la instancia fija
de WhatsApp y el tamaño del worker (1 vCPU, 1 GiB). Los puso el pipeline y se cambian en `deploy.yml`:
el máximo del api (10) y del worker (3, que acota las llamadas simultáneas a los modelos porque el
semáforo es por proceso), la memoria del api y de WhatsApp, y la CPU siempre asignada de WhatsApp
(Baileys mantiene su socket fuera de cualquier petición). Cada servicio corre con su propia cuenta de
servicio de ejecución.

Valores fijos en el workflow: `LLM_CACHE_MODE=off` en el worker (el disco del contenedor se pierde y
las respuestas de modelos llevan datos del cliente) y `WHATSAPP_AUTH_DIR=/tmp/whatsapp-auth` en
WhatsApp (la sesión se pierde en cada reinicio: hueco "Sesión de Baileys persistente").

### Secretos y variables

Se configuran en *Settings > Environments* de GitHub, una vez por `staging` y otra por `production`.
Si falta alguno, el job lo dice con su nombre antes de llamar a la nube.

| Nombre | Tipo | Lo usa | Qué es |
|---|---|---|---|
| `DATABASE_ADMIN_URL` | secreto | `migrate` | URL del rol `postgres` del Supabase del entorno. Los runners de GitHub no tienen IPv6: usar el pooler en modo sesión (puerto 5432), no la conexión directa |
| `VERCEL_TOKEN` | secreto | `web` | Token de Vercel con acceso al proyecto |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | secreto | `web` | Los dos ids de `.vercel/project.json` que deja `vercel link` |
| `GCP_PROJECT_ID` | variable | `images`, `deploy-*` | Proyecto de Google Cloud del entorno |
| `GCP_REGION` | variable | `images`, `deploy-*` | Región de Artifact Registry y Cloud Run (`us-central1` o `northamerica-south1`) |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | variable | `images`, `deploy-*` | `projects/<número>/locations/global/workloadIdentityPools/<pool>/providers/<proveedor>` |
| `GCP_DEPLOYER_SERVICE_ACCOUNT` | variable | `images`, `deploy-*` | Correo de la cuenta de servicio que despliega |
| `ARTIFACT_REGISTRY_REPOSITORY` | variable | `images`, `deploy-*` | Nombre del repositorio Docker de Artifact Registry |
| `API_SERVICE_ACCOUNT`, `WORKER_SERVICE_ACCOUNT`, `WHATSAPP_SERVICE_ACCOUNT` | variable | su `deploy-*` | Correo de la cuenta de servicio con la que corre cada servicio |
| `API_PUBLIC_URL` | variable | `deploy-api`, `deploy-worker`, `web` | URL https pública del api. Firma las URL de subida y es el destino del rewrite `/bo/*` |
| `BACKOFFICE_URL` | variable | `deploy-api` | URL del backoffice: enlace de acceso y Site URL de Supabase |
| `SUPABASE_URL` | variable | `deploy-api` | URL del proyecto de Supabase |
| `RESEND_FROM` | variable, opcional | `deploy-worker` | Remitente de los correos de aclaración; sin él, el worker no manda correo |
| `WHATSAPP_TENANT_ID` | variable | `deploy-whatsapp` | Tenant dueño del número de WhatsApp |
| `WHATSAPP_SELF_REGISTRATION` | variable, recomendada `false` | `deploy-worker` | Encendido por defecto: cualquier número puede registrarse como proveedor. En un despliegue real, fíjalo en `false` en el worker (hoy el workflow no lo pasa) |

Los secretos de los servicios no pasan por GitHub: viven en Secret Manager y Cloud Run los monta como
variables. El nombre es `gow-<entorno>-<variable en minúsculas y con guiones>`; por ejemplo,
`DATABASE_URL_API` en staging es `gow-staging-database-url-api`. Cada servicio recibe solo los suyos:

| Servicio | Secretos |
|---|---|
| `api` | `DATABASE_URL_API`, `DATABASE_URL_QUEUE`, `STORAGE_SIGNING_SECRET`, `BACKOFFICE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `RESEND_WEBHOOK_SECRET` |
| `worker` | `DATABASE_URL_WORKER`, `DATABASE_URL_QUEUE`, `DATABASE_URL_MASTRA`, `STORAGE_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY`, `RESEND_API_KEY` |
| `whatsapp` | `DATABASE_URL_WHATSAPP` |

Todos tienen que existir, aunque sea con un valor de relleno, antes del primer despliegue: Cloud Run
no crea la revisión si falta uno.

### Qué falta crear para que corra

Nada de esto existe. El orden es el de la lista.

1. **Proyecto de Google Cloud** (uno por entorno, o uno compartido: los servicios y los secretos ya
   llevan el entorno en el nombre) con las APIs `run`, `artifactregistry`, `secretmanager`,
   `iamcredentials` y `sts` habilitadas.
2. **Repositorio de Artifact Registry** de tipo Docker en la región elegida.
3. **Workload Identity Federation y la cuenta de servicio que despliega.** Es la referencia, sin
   probar; sustituye lo que va entre `<>`:

   ```sh
   gcloud iam workload-identity-pools create github --project=<proyecto> --location=global
   gcloud iam workload-identity-pools providers create-oidc gow-credit \
     --project=<proyecto> --location=global --workload-identity-pool=github \
     --issuer-uri="https://token.actions.githubusercontent.com" \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment" \
     --attribute-condition="assertion.repository == '<organización>/<repositorio>'"
   # Solo los jobs del environment `production` pueden usar la cuenta de producción.
   gcloud iam service-accounts add-iam-policy-binding <despliegue>@<proyecto>.iam.gserviceaccount.com \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/<número>/locations/global/workloadIdentityPools/github/attribute.environment/production"
   ```

   A la cuenta que despliega: `roles/run.admin` en el proyecto (despliega y fija
   `--allow-unauthenticated`), `roles/artifactregistry.writer` sobre el repositorio y
   `roles/iam.serviceAccountUser` sobre las tres cuentas de ejecución.
4. **Tres cuentas de servicio de ejecución** (`api`, `worker`, `whatsapp`) sin roles de proyecto, cada
   una con `roles/secretmanager.secretAccessor` solo sobre sus secretos.
5. **Los secretos de Secret Manager** de la tabla anterior.
6. **Los environments `staging` y `production` de GitHub** con sus secretos y variables. En
   `production`: revisores obligatorios y `main` como única rama permitida.
7. **El proyecto de Vercel** con *Root Directory* `apps/web` y un token.
8. **El Supabase de cada entorno**, con lo del paso 1 de "Pasos" (roles con contraseña propia y el
   `GRANT` a `postgres`). Las migraciones las corre el workflow.

Qué no está probado y se comprueba en la primera corrida en `staging`: que `vercel build` lanzado
desde la raíz respete el *Root Directory* del proyecto, que el pooler en modo sesión acepte las
migraciones, y que `deploy-cloudrun` acepte los flags tal como están escritos.

### Bloqueos en el código

Dos de los tres se cerraron al integrar el pipeline; el tercero sigue en "Falta para producción".

| Bloqueo | Estado |
|---|---|
| El `api` escuchaba solo en `127.0.0.1` | Hecho: escucha en `HOST` (`127.0.0.1` por defecto); el workflow pasa `HOST=0.0.0.0` |
| El `worker` y `whatsapp` no abrían ningún puerto | Hecho: con `PORT` definido (Cloud Run siempre lo define) levantan un listener mínimo de salud en todas las interfaces; sin `PORT` (local), nada |
| Los documentos se guardan en disco local | Pendiente: adaptador de Supabase Storage (ver abajo) |

## Falta para producción

| Hueco | Por qué importa | Qué hacer |
|---|---|---|
| Almacenamiento en Supabase Storage | Hoy `LocalDocumentStorage` escribe al disco del contenedor, que en Cloud Run se pierde | Adaptador de Storage detrás de la interfaz existente, con bucket privado por tenant |
| Sesión de Baileys persistente | `WHATSAPP_AUTH_DIR` es un directorio local; un reinicio obliga a volver a escanear el QR | Guardar el estado de autenticación cifrado en Postgres o en un volumen (Cloud Storage FUSE) |
| WhatsApp no probado contra el servicio real | El número no se ha vinculado; todo el flujo se probó con el doble de los escenarios | Vincular un número de prueba y correr los escenarios 12 a 15 contra él |
| Backoffice con Supabase Auth (hecho en parte) | Enlace por correo, hook de `tenant_id`, alta de cuentas y sesión renovable probados contra el Supabase local | Hecho: renovación de sesión del lado de la API. Falta: plantilla del correo en español, verificación con JWKS si el proyecto firma con llaves asimétricas y límites de enlaces compartidos entre instancias |
| Logs con pino y trazas | Hoy hay una línea JSON sin PII por evento; Langfuse no está conectado | pino con redacción, exportador de trazas de Mastra con PII filtrada |
| Equidad entre tenants y Batches API | Un tenant con mil documentos puede acaparar el worker | Cola por tenant con cuota; Batches API para cargas masivas (`docs/02` §4b) |
| Verificación ante el SAT | Apagada; `cfdi_sat_status` queda en `null` | Adaptador de "Verifica CFDI" con caché y límite de ritmo (`docs/09` §6) |
| Contratos con proveedores de modelos | Los documentos salen a Google, Anthropic y TypeSafe | Acuerdos de tratamiento de datos y aviso de privacidad (`docs/05` §3) |
| Respaldos y retención | Sin política aplicada | Backups diarios de Supabase (PITR en Pro); purga de PDFs con pg_cron según el plazo de `docs/05` §3 |
| Pentest | ASVS 5.0 nivel 2 es la meta | Checklist y prueba externa antes de abrir a tenants reales |

## Costos de operación (orden de magnitud)

- **Modelos**: unos USD 0.20 por documento con Gemini 3.8 Flash, hasta el 2026-12-31; desde el
  2027-01-01, el doble (README, "Costo estimado").
- **Cloud Run**:
  - el `worker` con una instancia mínima, de 1 vCPU y 1 GiB, cuesta unos USD 50 al mes;
  - el `api` y el `whatsapp`, a escala baja, menos de USD 20 entre los dos.
- **Supabase Pro**: USD 25 al mes, más cómputo.
- **Vercel Pro**: USD 20 al mes por miembro.

Son precios de lista a la fecha del documento. Se verifican antes de comprometer un
presupuesto.

## Demo en Railway (ADR 0068)

Para que una persona pruebe el backoffice con su correo, sin el pipeline de Cloud Run: base y Auth en
Supabase (`gow-demo`, `us-west-2`) y los procesos en Railway (`gow-credit`, `us-west2`). Todo lo de
Railway está en `infra/railway/`.

| Servicio | Qué corre | Volumen | Dominio |
|---|---|---|---|
| `app` | API y worker juntos (`app-start.sh`): comparten el disco de los documentos | `/data` | público: API, subidas firmadas |
| `web` | backoffice estático con nginx (`web.Dockerfile`), `/bo/` va a `app.railway.internal:3000` | — | público: lo que abre la persona |
| `whatsapp` | `APP=whatsapp`, una instancia | `/data/whatsapp` | ninguno |

`app` y `whatsapp` salen por IPv6 a la conexión directa de Supabase (`db.<ref>.supabase.co:5432`).

### Pasos

1. `railway link` al proyecto y `sh infra/railway/configure.sh`: construcción, arranque, pre-deploy,
   healthcheck, IPv6 de salida y volúmenes. Es idempotente.
2. Variables sin secretos (ya puestas en `gow-credit`): en `app`, `HOST=::`, `PORT=3000`,
   `RAILWAY_RUN_UID=0` (el volumen se monta como root), `STORAGE_DIR=/data/storage`,
   `LLM_CACHE_DIR=/data/llm-cache`, `LLM_CACHE_MODE=off`, `API_PUBLIC_URL`, `BACKOFFICE_URL`,
   `SUPABASE_URL` y las seis `DATABASE_URL_*` con la contraseña por referencia
   (`postgresql://gow_api:${{GOW_DB_PASSWORD_API}}@db.<ref>.supabase.co:5432/postgres?sslmode=no-verify`);
   en `web`, `PORT=8080` y `API_UPSTREAM=app.railway.internal:3000`; en `whatsapp`, `APP=whatsapp`,
   `PORT=3000`, `RAILWAY_RUN_UID=0`, `WHATSAPP_AUTH_DIR=/data/whatsapp` y `DATABASE_URL_WHATSAPP` con
   `${{app.GOW_DB_PASSWORD_WHATSAPP}}`.
3. Contraseñas de los roles: `sh infra/railway/set-db-passwords.sh`. Las genera y las guarda sin
   imprimirlas; el pre-deploy de `app` se las pone a los roles (`pnpm -F @gow/db db:roles`).
4. Secretos en `app`, a mano desde el panel de Railway:
   - `DATABASE_ADMIN_URL`: Supabase → Connect → Direct connection, con la contraseña de la base y
     `?sslmode=no-verify` al final.
   - `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`: Supabase → Settings → API Keys (las heredadas).
   - `BACKOFFICE_JWT_SECRET`: Supabase → Settings → JWT Keys, el secreto heredado (HS256).
   - `STORAGE_SIGNING_SECRET`: una cadena aleatoria larga (`openssl rand -hex 32`).
   - `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `RESEND_API_KEY` y `RESEND_FROM` (`Nombre <correo@dominio>`).
5. `sh infra/railway/deploy.sh`: sube el commit (`git archive`, nada sin versionar) a `app`, `web` y
   `whatsapp`. El pre-deploy de `app` corre `db:roles` y `db:migrate`.
6. Auth en el panel de Supabase:
   - Authentication → Hooks → Customize Access Token (JWT) Claims: Postgres, `app.custom_access_token_hook`.
   - Authentication → Sign In / Providers: apagar "Allow new users to sign up".
   - Authentication → URL Configuration: Site URL = `BACKOFFICE_URL`; Redirect URLs =
     `<BACKOFFICE_URL>/entrar`.
   - Authentication → SMTP: `smtp.resend.com`, puerto 465, usuario `resend`, contraseña = la llave de
     Resend, remitente del dominio verificado.
   - Authentication → Emails → Magic Link: texto en español.
7. Tenant y usuario, con `railway ssh --service app`: `pnpm tenant create --name "..."` (imprime una
   sola vez la llave de API del tenant) y `pnpm tenant user add --tenant <id> --email <correo>`.
8. Probar el acceso con un correo propio antes de dar de alta a la persona.

Huecos de la demo: TLS hacia Supabase sin verificar el certificado, API y worker escalan juntos y
`WHATSAPP_SELF_REGISTRATION` queda con su valor por defecto (encendido, ADR 0062).
