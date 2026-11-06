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

- **`--as-of AAAA-MM-DD`**, la fecha de cálculo, que por defecto es hoy. La política pide un
  estado de cuenta de 90 días o menos a esa fecha; si el documento es más viejo, la solicitud se
  pausa y pide uno reciente. Para evaluar un documento como si se hubiera recibido al corte, usa
  una fecha unos días posterior a su corte:

  ```bash
  pnpm run evaluate /ruta/a/los/pdfs --as-of 2026-04-15
  ```

  La consola lo sugiere cuando hace falta, y el reporte de cada documento dice qué fecha se usó.
- **`--force`**. Un documento ya evaluado en la carpeta de salida no se repite: aparece como "ya
  evaluada". Con `--force` se vuelve a evaluar. Las llamadas a modelos que ya se hicieron salen de
  la caché de respuestas (`data/llm-cache/`), sin costo.

**Política.** Por defecto se usa `policies/examples/standalone-evaluation.v1.json`, y la primera
línea de la salida lo dice. Es la plantilla base con un solo cambio: una identidad que no se
puede comparar no bloquea. Esto importa porque los documentos vienen redactados y en standalone
no hay registro de proveedores (ADR 0015). Las opciones relacionadas:

- `--policy base` usa la plantilla base tal cual.
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
| `summary.md`, `summary.json` | Una fila por documento: estado, línea máxima, preguntas y costo de la corrida. |
| `answers.template.json` | Solo si alguna solicitud quedó pausada. |

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
  `prompts/` con su [changelog](prompts/CHANGELOG.md), y dependencias en `pnpm-lock.yaml`.

## Modo full

Es el mismo workflow con persistencia y canales. Corre en local con Docker:

```bash
docker compose up -d
```

```bash
pnpm db:migrate
```

```bash
pnpm tenant create --name "Prestamista demo"
```

```bash
pnpm api
```

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
| `pnpm whatsapp` | Canal de WhatsApp (Baileys). Requiere `WHATSAPP_TENANT_ID`. El número se vincula escaneando el QR en el backoffice (Configuración); en una terminal interactiva también lo imprime |

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
WhatsApp, con `WHATSAPP_TENANT_ID=<id> pnpm whatsapp` corriendo, se escanea el QR en
Configuración → Canales; ahí mismo se desvincula o se cambia de número (ADR 0033). Sin WhatsApp
vinculado, las aclaraciones se responden a mano desde el backoffice.

Para producción, el plan está en [`docs/deploy.md`](docs/deploy.md): Cloud Run, Supabase y Vercel.

## Otros comandos

| Comando | Qué hace | Costo |
|---|---|---|
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
| `prompts/` | Prompts versionados con su changelog |
| `docs/` | Diseño (`00` a `09`), [spec de una página](docs/00-spec.md), [ADRs](docs/adr/README.md), [cómo se construyó](docs/harness.md), [despliegue](docs/deploy.md), spikes y experimentos |

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
4. Add `--as-of YYYY-MM-DD` so that old statements are not flagged as stale.

Output goes to `data/out/evaluate/` as an extraction JSON, a result JSON and a Markdown report
per document. `--help` lists every option.

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
