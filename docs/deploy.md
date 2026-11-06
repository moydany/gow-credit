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
   - Correr `pnpm db:migrate` con `DATABASE_ADMIN_URL`.
   - La prueba de RLS (`pnpm test` contra esa base, en un proyecto de staging) confirma que
     ninguna tabla de negocio quedó sin política.
2. **Secretos** en Google Secret Manager, montados como variables en cada servicio:
   - `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY`;
   - una `DATABASE_URL_*` por rol;
   - `STORAGE_SIGNING_SECRET`, `BACKOFFICE_JWT_SECRET` (el JWT secret de Supabase);
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
| Backoffice con Supabase Auth | Hoy el enlace de acceso lo imprime `pnpm tenant user add` | Magic link de Supabase Auth; la API ya verifica el JWT con `BACKOFFICE_JWT_SECRET` |
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
