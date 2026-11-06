# Plan de despliegue: Cloud Run, Supabase y Vercel

Fecha: 2026-11-05. El worksample no se desplegó: no hay cuentas creadas ni nada publicado.
Este documento es el plan, con lo que ya está listo en el repositorio y lo que falta para
producción. Decisión en `docs/00-brief.md` §2 (fila "Deploy") y ADR 0030.

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

Las imágenes se construyen en CI (`.github/workflows/ci.yml`, job `images`) sin publicarse.
Para publicar, se agrega un job con Workload Identity Federation hacia Artifact Registry. No hay
llaves de servicio de larga vida.

## Pasos

1. **Supabase.**
   - Crear el proyecto en la región más cercana a la de Cloud Run.
   - Correr `infra/postgres/init/00-roles.sql` adaptado: en Supabase los roles se crean con
     contraseña propia, una por proceso, nunca la del dueño.
   - Como `postgres`, que no es superusuario en Supabase, darse SET sobre los dueños de los
     esquemas de pg-boss y Mastra. Sin esto, la migración 0001 falla en `CREATE SCHEMA ...
     AUTHORIZATION` (ADR 0034):

     ```sql
     GRANT gow_queue, gow_mastra TO postgres WITH INHERIT FALSE, SET TRUE;
     ```

   - Correr `pnpm db:migrate` con `DATABASE_ADMIN_URL`, la URL del rol `postgres`.
   - Antes de tocar el proyecto real, todo esto se prueba con el Supabase local
     (`pnpm supabase:up`, README "Modo full con Supabase local"): ahí `postgres` tampoco es
     superusuario.
   - La prueba de RLS (`pnpm test` contra esa base, en un proyecto de staging) confirma que
     ninguna tabla de negocio quedó sin política.
   - **Auth del backoffice (ADR 0035).** La migración 0008 crea el custom access token hook y,
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
       defecto): la API depende de él para peticiones en paralelo entre instancias (ADR 0036).
2. **Secretos** en Google Secret Manager, montados como variables en cada servicio:
   - `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY`;
   - una `DATABASE_URL_*` por rol;
   - `STORAGE_SIGNING_SECRET`, `BACKOFFICE_JWT_SECRET` (el JWT secret de Supabase);
   - para el `api`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` y
     `BACKOFFICE_URL` (login por correo, ADR 0035); opcionales, `BACKOFFICE_SESSION_MAX_HOURS`
     (12) y `BACKOFFICE_SESSION_IDLE_HOURS` (8), los límites de la sesión renovable (ADR 0036);
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
   backoffice, en Configuración (ADR 0033). Sin terminal, el QR no se imprime en los registros. Ver
   "Falta para producción".

## Falta para producción

| Hueco | Por qué importa | Qué hacer |
|---|---|---|
| Almacenamiento en Supabase Storage | Hoy `LocalDocumentStorage` escribe al disco del contenedor, que en Cloud Run se pierde | Adaptador de Storage detrás de la interfaz existente (ADR 0018), con bucket privado por tenant |
| Sesión de Baileys persistente | `WHATSAPP_AUTH_DIR` es un directorio local; un reinicio obliga a volver a escanear el QR | Guardar el estado de autenticación cifrado en Postgres o en un volumen (Cloud Storage FUSE) |
| WhatsApp no probado contra el servicio real | El número no se ha vinculado; todo el flujo se probó con el doble de los escenarios | Vincular un número de prueba y correr los escenarios 12 a 15 contra él |
| Backoffice con Supabase Auth (hecho en parte, ADR 0035 y 0036) | Enlace por correo, hook de `tenant_id`, alta de cuentas y sesión renovable probados contra el Supabase local | Hecho: renovación de sesión del lado de la API (ADR 0036). Falta: plantilla del correo en español, verificación con JWKS si el proyecto firma con llaves asimétricas y límites de enlaces compartidos entre instancias |
| Logs con pino y trazas | Hoy hay una línea JSON sin PII por evento; Langfuse no está conectado (ADR 0027) | pino con redacción, exportador de trazas de Mastra con PII filtrada |
| Equidad entre tenants y Batches API | Un tenant con mil documentos puede acaparar el worker | Cola por tenant con cuota; Batches API para cargas masivas (`docs/02` §4b) |
| Verificación ante el SAT | Apagada; `cfdi_sat_status` queda en `null` | Adaptador de "Verifica CFDI" con caché y límite de ritmo (`docs/09` §6) |
| Contratos con proveedores de modelos | Los documentos salen a Google, Anthropic y TypeSafe | Acuerdos de tratamiento de datos y aviso de privacidad (`docs/05` §3) |
| Respaldos y retención | Sin política aplicada | Backups diarios de Supabase (PITR en Pro); purga de PDFs con pg_cron según el plazo de `docs/05` §3 |
| Pentest | ASVS 5.0 nivel 2 es la meta (ADR 0032) | Checklist y prueba externa antes de abrir a tenants reales |

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
