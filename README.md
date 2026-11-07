# GOW Credit: extracción y diagnóstico crediticio sobre estados de cuenta

Recibe el estado de cuenta bancario de un proveedor en PDF y hace cinco cosas:

1. Extrae encabezado, resumen, movimientos y CFDI, con página y fragmento citados por cada valor.
2. Verifica la extracción contra la aritmética del propio banco.
3. Calcula un perfil crediticio.
4. Aplica la política del prestamista (tenant) y devuelve un veredicto con diagnóstico y
   contrafactuales.
5. Pregunta al proveedor cuando un dato dudoso puede cambiar el resultado.

Con un solo comando corre sobre una carpeta de PDFs (modo standalone). El modo full agrega
Postgres, cola, WhatsApp, correo y un backoffice.

*English summary at the end.*

## Cómo correrlo en 5 minutos

Para pasarlo a otra computadora con tus llaves, los PDFs, el ground truth y la caché, sigue
[`docs/local-setup.md`](docs/local-setup.md); `pnpm doctor` dice qué falta.

**Necesitas:**

- Node 24 o posterior.
- pnpm 11: `corepack enable` lo instala con la versión fijada en `package.json`.
- Una llave de Anthropic. La de Google es opcional, pero abarata la extracción unas 5 veces.

**Instalación:**

```bash
git clone <este repositorio> gow-credit
```

```bash
cd gow-credit
```

```bash
corepack enable
```

```bash
pnpm install --frozen-lockfile
```

```bash
cp .env.example .env
```

En `.env`:

| Variable | ¿Hace falta? | Qué hace |
|---|---|---|
| `ANTHROPIC_API_KEY` | sí | Doble lectura, emergencia de extracción, clasificación de respaldo (Haiku) y redacción de preguntas. Sin llave de Google, también extrae (Claude Opus). |
| `GEMINI_API_KEY` | recomendada | Extracción con Gemini 3.8 Flash (ADR 0011). |
| `TYPESAFE_API_KEY` | opcional | Clasificación con Jev. Sin ella clasifica Haiku y el reporte lo dice. |

**Correr** sobre una carpeta con los PDFs (o sobre PDFs sueltos):

```bash
pnpm run evaluate /ruta/a/los/pdfs
```

Las rutas pueden ser absolutas o relativas a donde escribes el comando. Cada documento se
evalúa como una solicitud independiente. La consola muestra una línea por documento con su
estado, sus preguntas, sus llamadas y su costo; **nunca muestra datos del documento**.
`pnpm run evaluate --help` muestra todas las opciones.

**Dos opciones que conviene conocer:**

- **`--as-of AAAA-MM-DD`**, la fecha de cálculo del perfil, que por defecto es hoy. Contra ella
  se mide la antigüedad del estado de cuenta (`document_age_days`). La política por defecto no
  se detiene por esa antigüedad (ADR 0054): un documento viejo se analiza igual y la antigüedad
  queda en el perfil y en el reporte. Para fijar otra fecha, por ejemplo unos días posterior al
  corte del documento:

  ```bash
  pnpm run evaluate /ruta/a/los/pdfs --as-of 2026-04-15
  ```

  El reporte de cada documento dice qué fecha de cálculo se usó.
- **`--force`**. Un documento ya evaluado en la carpeta de salida no se repite: aparece como "ya
  evaluada". Con `--force` se vuelve a evaluar. Las llamadas a modelos que ya se hicieron salen de
  la caché de respuestas (`data/llm-cache/`), sin costo.

**Política.** Por defecto se usa `policies/examples/standalone-evaluation.v1.json`, y la primera
línea de la salida lo dice. Es la plantilla base sin la compuerta de antigüedad del estado de
cuenta: los documentos que se evalúan son de fecha desconocida y un corte de hace más de 90 días
no debe detenerlos (ADR 0054). Las opciones relacionadas:

- `--policy base` usa la plantilla base tal cual, con la compuerta de 90 días de un prestamista
  real.
- `--policy <archivo.json>` usa cualquier otra política.

**Datos de la solicitud.** Sin monto ni comprador, la salida da el perfil, el estado y la
**línea máxima**: el mayor monto que la política aprobaría. Para evaluar una solicitud concreta:

```bash
pnpm run evaluate /ruta/a/los/pdfs --request amount=180000,buyer="Cadena Norte"
```

**Aclaraciones.** Si una solicitud se pausa, sus preguntas quedan en `<id>.md`, en `outbox/` y
en `answers.template.json`. Para contestarlas:

- desde un archivo: copia la plantilla, elige una respuesta por pregunta y reanuda con
  `--answers <archivo>`;
- en la terminal: usa `--interactive`.

### Qué sale

Todo va a `data/out/evaluate/`, o a la carpeta que indiques con `--out`. Por documento `<id>`:

| Archivo | Contenido |
|---|---|
| `<id>.extraction.json` | Extracción con el contrato `StatementExtraction` (`docs/schema/`): cuentas, periodos, movimientos y CFDI. Cada valor trae su página, su fragmento, su verificación y su confianza. |
| `<id>.result.json` | `ApplicationResult`: perfil, veredicto con diagnóstico completo, contrafactuales, aclaración y costo por propósito y modelo. |
| `<id>.md` | Reporte legible. Lo que no se verificó va marcado. |
| `<id>.llm.jsonl` | Cada llamada al modelo tal cual, una por línea: system prompt, instrucción, respuesta o salida cruda, error, tokens y costo (ADR 0064). Lleva datos del documento. |
| `summary.md`, `summary.json` | Una fila por documento: estado, línea máxima, preguntas y costo de la corrida. |
| `extraction-summary.csv`, `extraction-summary.json` | Resumen plano de la extracción, para contrastarla con una verdad de referencia: una fila por documento (y por cuenta si trae varias) con los campos de encabezado. |
| `answers.template.json` | Solo si alguna solicitud quedó pausada. |

El resumen plano trae estas columnas, con los nombres en inglés y las rutas de `StatementExtraction`:
`file, document_type, bank, holder_name, holder_rfc, account_number, clabe, currency, period_start,
period_end, opening_balance, closing_balance, total_credits, total_debits, credits_count,
debits_count, transactions_extracted, reconciled, cfdi_uuid, extraction_status`.

- Lo que el banco no imprimió va vacío; no se calcula ni se completa con otra cosa. Los totales y
  conteos son los impresos por el banco, no la suma de los movimientos extraídos.
- Con varios periodos en una cuenta (un PDF con varios meses impresos por separado), `period_start`
  y `period_end` abarcan todos, el saldo inicial es el del primero, el final el del último, y los totales y
  conteos son la suma de los periodos.
- `reconciled` es `true` si todos los periodos cuadran contra el banco y `false` si alguno no.
  `cfdi_uuid` lleva los folios fiscales separados por `;` si el documento trae varios.
- El CSV lleva encabezado, comas y comillas donde hacen falta, e importes con dos decimales. La
  consola nunca muestra estos valores.

Los estados son los canónicos de `docs/README.md`: `qualified`, `qualified_with_limit`,
`not_qualified`, `needs_clarification`, `human_review` y `failed`. Un documento que no se puede
extraer termina en `failed` con su motivo, y el comando sigue con el siguiente.

### Costo estimado

Las cifras salen de corridas reales sobre los 9 documentos de desarrollo, a
precio de lista:

| | Por documento (promedio) | 10 documentos de evaluación |
|---|---|---|
| Con `GEMINI_API_KEY` (Gemini 3.8 Flash) | USD 0.20 | unos USD 2 |
| Solo con `ANTHROPIC_API_KEY` (Claude Opus 5.5) | USD 1.02 | unos USD 10 |
| Clasificación y redacción (Jev o Haiku) | USD 0.002 | USD 0.02 |

- El costo varía con el número de páginas y de movimientos. El documento más caro fue Nu
  (332 movimientos): USD 0.32 con Gemini.
- **Gemini sube de precio el 2027-01-01**: entrada y salida al doble, de 0.75 / 3.75 a
  1.50 / 7.50 USD por millón de tokens. Las cifras de Gemini de arriba se duplican desde esa
  fecha. Los precios están en `packages/llm/src/models.ts`, verificados en la página oficial.
- Cada corrida imprime su costo real, y `<id>.result.json` lo desglosa.
- Repetir con la caché de respuestas cuesta cero. Con `--cache read` el comando no hace ninguna
  llamada nueva: si falta una respuesta, falla en lugar de pagar.

### Privacidad del dataset

- **Los PDFs salen de tu máquina hacia tres proveedores:**

  | Proveedor | Cuándo | Qué recibe |
  |---|---|---|
  | Google (Gemini API de pago) | con `GEMINI_API_KEY` | el PDF completo, para extraer |
  | Anthropic | siempre | el PDF en la doble lectura, en la emergencia de extracción y, sin llave de Google, en la extracción; el texto de las primeras páginas y las descripciones de los movimientos cuando clasifica Haiku |
  | TypeSafe AI (Jev) | con `TYPESAFE_API_KEY` | el texto de las primeras páginas y las descripciones de los movimientos |

  Las condiciones de uso de datos de cada uno están en
  [`docs/05-seguridad.md`](docs/05-seguridad.md), en la sección "Cambios durante la
  implementación".
- **Nada de esto se versiona.** `data/` está en `.gitignore`: PDFs, extracciones, ground truth,
  caché de respuestas y salidas. Lo único que se versiona son PDFs adversarios sintéticos y sus
  respuestas, para la eval de inyección.
- **Los logs y la consola no llevan datos personales.** Muestran estados, conteos, costos y
  nombres de campo.

### Qué reproducibilidad se promete

- **Mismo PDF y misma caché: la misma salida.** La caché de respuestas usa como llave el hash del
  modelo, el prompt, el esquema y el documento, así que una repetición devuelve exactamente lo
  mismo y cuesta cero. El perfil y el veredicto salen de un motor puro: la misma extracción, la
  misma política y la misma fecha de cálculo dan el mismo veredicto.
- **Una llamada nueva al modelo no es determinista.** Lo que sí se garantiza es que toda
  extracción pase por el contrato, los validadores y el cuadre contra los saldos impresos. Una
  diferencia entre dos lecturas aparece como bandera o pregunta, nunca en silencio.
- **Versiones fijadas**: modelos en `packages/llm/src/models.ts`, prompts versionados en
  `prompts/` con su [changelog](prompts/CHANGELOG.md), y dependencias en `pnpm-lock.yaml`. En modo
  full los prompts también viven en la base: la página Prompts del backoffice crea versiones y elige
  la activa, sin evals hasta que pasan a `prompts/` (ADR 0065). `pnpm run evaluate` y las evals
  leen siempre los archivos.

## Modo full

Es el mismo workflow con persistencia y canales.

### Todo con un comando (recomendado)

Levanta Supabase, las migraciones, la API, el worker, WhatsApp y el backoffice con docker compose
(ADR 0061). Necesitas Docker y Node; la primera vez construye la imagen y descarga las de Supabase:

```bash
pnpm stack:up
```

Abre `http://127.0.0.1:5173`: el wizard del primer inicio crea al prestamista y a su administrador
(ADR 0060) y termina con el QR para vincular WhatsApp. No hay nada más que configurar. Para que el
worker extraiga documentos nuevos pon tus llaves en el `.env` de la raíz (`cp .env.example .env`); sin
ellas solo corre lo que esté en caché. Los enlaces de acceso de Supabase Auth llegan por Resend si el
`.env` trae `RESEND_API_KEY` (ADR 0063); si no, se leen en Inbucket, `http://127.0.0.1:54343`.

| Comando | Qué hace |
|---|---|
| `pnpm stack:up` | Genera los secretos de desarrollo si faltan, construye y levanta todo |
| `pnpm stack:ps` | Estado de los servicios |
| `pnpm stack:logs` | Registros de la API, el worker y WhatsApp |
| `pnpm stack:down` | Detiene; los datos se conservan |
| `pnpm stack:reset` | Detiene y borra base, sesión de WhatsApp y documentos |

### Procesos a mano

Lo mismo, cada proceso en su terminal (para desarrollar). Corre en local con Docker:

```bash
docker compose up -d
```

```bash
pnpm db:migrate
```

```bash
pnpm api
```

En un sistema vacío, abre el backoffice (`pnpm web`, `http://127.0.0.1:5173`): el wizard del primer inicio crea al prestamista y a su administrador y te deja vincular WhatsApp (ADR 0060). Por terminal también se puede: `pnpm tenant create --name "Prestamista demo"`, que además imprime la llave de API; con el wizard, la llave (la que pide `pnpm demo:load --key`) se crea en Configuración.

```bash
LLM_CACHE_MODE=read pnpm worker
```

| Comando | Qué hace |
|---|---|
| `docker compose up -d` | Postgres 17 con los roles de `docs/05` §2 |
| `pnpm db:migrate` | Tablas con RLS forzada por tenant |
| `pnpm tenant create --name ...` | Imprime la llave de API del tenant |
| `pnpm api` | API: subida por URL firmada, solicitudes, aclaraciones, políticas y outcomes |
| `pnpm worker` | pg-boss y el workflow de Mastra. Con `LLM_CACHE_MODE=read` solo usa respuestas guardadas: costo cero, y si falta una, falla |
| `pnpm whatsapp` | Canal de WhatsApp (Baileys). Descubre solo al tenant (el único que exista, y espera a que el wizard lo cree); `WHATSAPP_TENANT_ID` solo con varios tenants o en producción. El número se vincula escaneando el QR en el backoffice (Configuración); en una terminal interactiva también lo imprime |

**Backoffice:**

```bash
pnpm tenant user add --tenant <id> --email <correo>
```

```bash
pnpm demo:load --key <llave>
```

```bash
pnpm web
```

El primero imprime el enlace de acceso y el segundo carga `data/dev` por la API. Para vincular
WhatsApp, con `pnpm whatsapp` corriendo (sin variables: encuentra solo al tenant), se escanea el QR en
Configuración → Canales; ahí mismo se desvincula o se cambia de número (ADR 0033). Sin WhatsApp
vinculado, las aclaraciones se responden a mano desde el backoffice.

La página Prompts muestra los prompts de los modelos con sus versiones (ADR 0065). Son globales: crear y
activar versiones lo pueden los correos de `BACKOFFICE_PROMPT_EDITORS` (o `*`) y, sin esa variable,
cualquier usuario mientras haya una sola institución crediticia. El worker toma la versión activa en
unos 15 segundos.

### Modo full con Supabase local

El mismo modo full contra un Supabase autohospedado y recortado (ADR 0034). Incluye Postgres,
Auth, PostgREST, Storage, Studio, el gateway Envoy e Inbucket para los correos. Ahí `postgres` no
es superusuario, igual que en un proyecto de Supabase. Convive con `docker-compose.yml`: usa otros
puertos y otros volúmenes.

1. Genera los secretos de desarrollo. Escribe `infra/supabase/.env` y `infra/supabase/app.env`,
   ignorados por git; si `.env` ya existe, lo conserva:

   ```bash
   pnpm supabase:env
   ```

2. Levanta el stack y espera a que todo esté sano (la primera vez descarga unos 6.5 GB):

   ```bash
   pnpm supabase:up
   ```

3. Carga el entorno de la app en tu shell. Gana sobre el `.env` de la raíz, que no se toca:

   ```bash
   set -a; . infra/supabase/app.env; set +a
   ```

4. Desde esa misma shell, migra, prueba y corre lo que necesites:

   ```bash
   pnpm db:migrate
   ```

   ```bash
   pnpm test
   ```

   ```bash
   pnpm scenario run --all --mode full
   ```

   ```bash
   pnpm tenant create --name "Prestamista Supabase"
   ```

   ```bash
   pnpm api
   ```

   ```bash
   pnpm worker
   ```

   `app.env` trae `LLM_CACHE_MODE=read`, así que el worker no gasta en modelos. Para `pnpm web`
   no hace falta el entorno: Vite manda `/bo` a la API en `127.0.0.1:3000`.

| Dirección | Qué es |
|---|---|
| `127.0.0.1:54340` | Postgres. Migraciones con `postgres`, procesos con `gow_*` |
| `http://127.0.0.1:54341` | Gateway (`SUPABASE_URL`): `/auth/v1`, `/rest/v1`, `/storage/v1`, con `apikey` |
| `http://127.0.0.1:54342` | Studio, sin contraseña porque solo escucha en local |
| `http://127.0.0.1:54343` | Inbucket: los correos de Auth, como los magic links |

#### Entrar al backoffice con tu correo

Con `app.env` cargado, el backoffice entra con Supabase Auth (ADR 0035). Un hook de la migración
0008 agrega `tenant_id` al token de quien es miembro de un tenant; por eso `pnpm db:migrate` va
antes. Sin registro público: la cuenta se crea al dar de alta al usuario.

1. Desde la shell con `app.env`, da de alta tu correo en el tenant. Crea la pertenencia y la
   cuenta de Auth con el mismo id (también imprime el enlace de desarrollo, que sigue sirviendo):

   ```bash
   pnpm tenant user add --tenant <id del tenant> --email tu@correo.mx
   ```

2. Arranca `pnpm api` en esa shell y `pnpm web` en otra.
3. Abre `http://127.0.0.1:5173/entrar`, escribe tu correo y pulsa "Mandar enlace".
4. El correo llega a Inbucket, en `http://127.0.0.1:54343`, buzón con la parte de tu correo antes
   de la `@`. Abre "Sign in" en el mismo navegador: GoTrue te regresa a `/entrar` y entras.

Notas:

- La sesión se renueva sola (ADR 0036) mientras uses el backoffice: hasta 12 h desde que
  entraste (`BACKOFFICE_SESSION_MAX_HOURS`) o hasta 8 h sin usarlo
  (`BACKOFFICE_SESSION_IDLE_HOURS`). Después vuelves a pedir el enlace. Salir cierra también la
  sesión de Supabase Auth.
- GoTrue manda un correo por dirección cada 60 s; uno pedido antes no llega.
- Un correo sin cuenta recibe la misma respuesta y ningún correo.
- Desde Configuración, invitar a alguien crea su cuenta y le manda el enlace.
- El enlace de Inbucket regresa a `http://127.0.0.1:5173`. Si la web corre en otro puerto,
  agrégalo a `ADDITIONAL_REDIRECT_URLS` en `infra/supabase/.env` y cambia `BACKOFFICE_URL` en
  `app.env`.

`BACKOFFICE_JWT_SECRET` es el JWT secret del proyecto, así que el enlace de `pnpm tenant user
add` y los tokens de Supabase Auth los firma la misma llave. Falta por conectar el adaptador de
Supabase Storage: Storage corre, pero los documentos siguen en disco, en `data/storage-supabase`.

`pnpm supabase:down` detiene el stack y conserva los datos. Para empezar de cero:

```bash
docker compose -f docker-compose.supabase.yml --env-file infra/supabase/.env down -v
```

```bash
pnpm supabase:env --force
```

Para producción, el plan está en [`docs/deploy.md`](docs/deploy.md): Cloud Run, Supabase y Vercel.

## Otros comandos

| Comando | Qué hace | Costo |
|---|---|---|
| `pnpm doctor` | Revisa herramientas, llaves de `.env` (sin mostrarlas) y datos de esta máquina | 0 |
| `pnpm typecheck` | TypeScript estricto en todo el monorepo | 0 |
| `pnpm lint` | ESLint con reglas estrictas con tipos | 0 |
| `pnpm test` | Pruebas unitarias. Las de Postgres se saltan si no está arriba | 0 |
| `pnpm eval` | Evals de extracción contra el ground truth y umbral por banco; inyección y clasificador. Necesita `data/` y su caché, que no se versionan | 0 desde caché |
| `pnpm scenario run --all` | Escenarios de punta a punta de `docs/06` en modo unitario. Con `--mode full`, con Postgres | 0 |
| `pnpm extract <pdf\|carpeta>` | Solo la extracción, con tokens y costo por documento | pagado |
| `pnpm decide <extracción.json>` | Perfil y veredicto sobre una extracción ya hecha | 0 |
| `pnpm simulate --policy <json>` | Política borrador contra la vigente sobre un conjunto de perfiles | 0 |
| `pnpm corrections:export --tenant <id>` | Correcciones del analista a `data/corrections/`; `pnpm -F @gow/evals corrections` las mide contra el modelo actual | 0 |
| `pnpm -F @gow/evals gt:review sample` | Muestra del ground truth para revisar a mano contra el PDF; `record --reviewer <iniciales>` guarda el resultado sin valores | 0 |
| `pnpm data:pack` / `pnpm data:unpack` | Paquete cifrado con `data/dev`, el ground truth y la caché, para pasarlos a otra máquina (`EVAL_BUNDLE_KEY`) | 0 |

Los 9 PDFs de desarrollo no están en el repositorio. Con el enlace compartido, se descargan y se
verifican contra su manifiesto de hashes:

```bash
scripts/download-dev-data.sh
```

## Resultados sobre los documentos de desarrollo

Los resultados vienen del ground truth de 9 documentos, con 1,513 movimientos; su procedencia
está en la ADR 0001.

| | Gemini 3.8 Flash | Claude Opus 5.5 |
|---|---|---|
| Movimientos extraídos | 1,513 / 1,513 | 1,513 / 1,513 |
| Movimientos inventados y omitidos | 0 y 0 | 0 y 0 |
| Encabezado y resumen | 120 / 120 campos | 120 / 120 campos |
| CFDI | 104 / 107 campos | 106 / 107 campos |
| Cuadran | 9 / 9 | 9 / 9 |
| Costo de los 9 | USD 1.80 | USD 9.16 |

El detalle por banco está en
[`docs/experiments/2026-11-04-phase3-ground-truth-eval.md`](docs/experiments/2026-11-04-phase3-ground-truth-eval.md).

## Estructura

| Carpeta | Qué hay |
|---|---|
| `packages/contracts` | Contratos Zod: extracción, perfil, política, veredicto, solicitud. JSON Schema en `docs/schema/` |
| `packages/extraction` | Extracción: router de modelos, pasadas, validadores, cuadre, bloque fiscal |
| `packages/llm` | Modelos y precios, cliente estructurado (Mastra + AI SDK), caché de respuestas, clasificadores |
| `packages/decision` | Perfil, motor de políticas puro, contrafactuales y simulación |
| `packages/mastra` | Workflow `processApplication` y el comando `evaluate` |
| `packages/db`, `packages/platform`, `packages/channels` | Modo full: Drizzle y RLS, pg-boss, correo y WhatsApp |
| `apps/api`, `apps/worker`, `apps/whatsapp`, `apps/web` | Procesos del modo full y el backoffice |
| `evals/`, `scenarios/` | Evals con Evalite y escenarios de `docs/06` |
| `prompts/` | Prompts versionados con su changelog; se siembran en la base en cada `pnpm db:migrate` |
| `docs/` | Diseño (`00` a `09`), [spec de una página](docs/00-spec.md), [ADRs](docs/adr/README.md), [cómo se construyó](docs/harness.md), [otra máquina](docs/local-setup.md), [despliegue](docs/deploy.md), spikes y experimentos |

## English summary

GOW Credit takes a supplier's Mexican bank statement (PDF) and:

1. extracts header, summary, transactions and the bank's own CFDI (tax receipt), citing a page
   and a snippet for every value;
2. checks the extraction against the bank's own arithmetic (balances, totals, running
   balance);
3. computes a credit profile;
4. applies the lender's (tenant's) JSON policy, returning a verdict with full diagnostics and
   counterfactual next steps;
5. asks the supplier for clarification when a doubtful value could change the outcome.

**Quick start.**

1. Use Node 24+ and run `corepack enable`, then `pnpm install --frozen-lockfile`.
2. Put `ANTHROPIC_API_KEY` in `.env`. `GEMINI_API_KEY` is optional but recommended.
3. Run `pnpm run evaluate <folder>`.
4. Optionally add `--as-of YYYY-MM-DD` to set the calculation date. Statement age does not
   block a decision by default (ADR 0054).

Output goes to `data/out/evaluate/` as an extraction JSON, a result JSON and a Markdown report
per document, plus `extraction-summary.csv` and `.json`: one flat row per document (and per
account) with the header fields, to compare against a reference truth. `--help` lists every
option.

**Cost and privacy.**

- Extraction costs about USD 0.20 per document with Gemini 3.8 Flash and about USD 1.02 with
  Claude Opus 5.5. Gemini prices double on 2027-01-01.
- PDFs are sent to Google (extraction), to Anthropic (double read, fallback, classification)
  and, with a TypeSafe key, page text goes to Jev.
- Nothing under `data/` is ever committed, and logs carry no personal data.

**Accuracy.** On the 9 development statements (1,513 transactions), both models extract every
transaction with none invented or missed, and all 9 reconcile.

**Where to read more.**

- Design and decisions: `docs/00-spec.md`, which links to the ADRs.
- How it was built with a coding agent: `docs/harness.md`.
- Deployment plan: `docs/deploy.md`.
- Setting it up on another machine: `docs/local-setup.md`.
