# Arquitectura con Mastra

> **Estado: arquitectura vigente.** Es la que se construye. `01` conserva la comparación
> de opciones; `03` a `08` detallan criterio, alucinaciones, seguridad, escenarios,
> pendientes y backoffice. Glosario y estados canónicos en `README.md`.

Fecha: 2026-11-04. Arquitectura basada en `01-investigacion-arquitectura.md`
usando Mastra como capa de agentes y workflows. Lo que Mastra reemplaza: la máquina de
estados escrita a mano, las tablas de snapshots de workflow, la instrumentación de trazas y
parte del tooling de evals. Lo que se mantiene igual: pg-boss, Drizzle para tablas de
negocio con RLS, motor de decisión tipado, Edge Functions como ingreso de webhooks, Evalite
en CI.

---

## 1. Estructura del monorepo

```
apps/
  api/        Express 5 + Zod en los límites + adaptador MastraServer (endpoints /api/agents, /api/workflows)
  worker/     proceso Node de larga vida: consume pg-boss y ejecuta workflows de Mastra
  whatsapp/   proceso Node de larga vida con el socket de Baileys: envía preguntas y encola respuestas
  web/        backoffice React + Vite en Vercel: solicitudes, revisión, aclaraciones, políticas, operación (ver 08-backoffice.md)
packages/
  contracts/  esquemas Zod compartidos: contrato de extracción, perfil, política, aclaración, API
  llm/        clientes de modelos: Anthropic, Jev (`jev.ts`) y la interfaz `Classifier` con sus dos implementaciones
  extraction/ extracción en dos pasadas, verificación (cuadre, saldo corrido, validadores), reintento dirigido
  decision/   perfil de features + motor de políticas; puro, sin dependencia de Mastra
  mastra/     instancia Mastra, agentes, workflows, tools, scorers
  db/         esquema Drizzle de negocio + migraciones (tenants, suppliers, applications, policies, outcomes...)
  channels/   `ClarificationChannel`: console, resend, baileys; y adaptadores externos simulados (`ExistingCredits`, `CreditBureau`, `TaxAuthority`, `Clock`)
supabase/
  functions/  Edge Functions en Deno: webhook de Resend (correo entrante), valida firma y encola
  migrations/ RLS, pg_cron, Vault, extensiones
evals/
  *.eval.ts         Evalite: extracción contra ground truth, inyección, fidelidad de texto
  ground-truth/     JSON por documento de desarrollo (repo privado)
scenarios/          escenarios YAML de `06` y el runner `pnpm scenario`
prompts/            prompts versionados (`extract_summary.v1.md`, ...) con CHANGELOG
data/               PDFs de desarrollo; ignorado por git, con script de descarga
docs/               estos documentos, `adr/`, `schema/` (JSON Schema publicado), `harness.md`
```

### Modos de ejecución

El mismo código corre en dos modos, elegidos por configuración:

| Modo | Para quién | Storage de Mastra | Colas | Canal de aclaración | Fuentes externas |
|---|---|---|---|---|---|
| `standalone` | evaluadores y CI: `pnpm run evaluate ./pdfs` | libSQL local | ninguna, workflow en proceso | consola o archivo de respuestas | simuladas |
| `full` | demo y producción | PostgresStore en Supabase | pg-boss | Baileys, Resend, backoffice | reales o simuladas por escenario |

`standalone` solo necesita `ANTHROPIC_API_KEY`; sin `TYPESAFE_API_KEY` el clasificador
usa Haiku y lo indica en el reporte. Detalle en `07`, sección A.

Mastra crea sus propias tablas (snapshots de workflows, scores, observabilidad) en el
mismo Postgres de Supabase, en un esquema `mastra` separado del esquema de negocio. Las
tablas de negocio siguen bajo Drizzle y RLS.

---

## 2. Instancia Mastra

```ts
export const mastra = new Mastra({
  storage: new PostgresStore({ id: 'mastra', connectionString: env.DATABASE_URL }),
  agents: { documentClassifier, statementExtractor, clarificationWriter },
  workflows: { processApplication, nightlyCalibration },
  scorers: { schemaValidity, arithmeticReconciliation, fieldAccuracy },
  observability: {
    default: {
      serviceName: 'gow-credit',
      exporters: [new LangfuseExporter({ ... }), new MastraStorageExporter()],
      requestContextKeys: ['tenantId', 'applicationId', 'promptVersion'],
    },
  },
})
```

### Agentes y clasificador

| Componente | Modelo | Rol |
|---|---|---|
| `documentClassifier` (tool, no agente: interfaz `Classifier`) | **Jev** (`jev-1.13.0`, TypeSafe AI) con fallback a `anthropic/claude-haiku-5-5` | ¿Es un estado de cuenta? ¿De qué banco? ¿El texto es legible o hay que ir por visión? Ver sección 4c |
| `statementExtractor` | `anthropic/claude-opus-5-5` | Extrae encabezado, resumen y movimientos con `structuredOutput` sobre esquemas Zod de `packages/contracts` |
| `clarificationWriter` | `anthropic/claude-haiku-5-5` | Redacta la pregunta concreta al dueño del documento a partir de los `issues` detectados |

Entrada del PDF: parte de contenido `{ type: 'file', data: <base64 o URL firmada>, mimeType: 'application/pdf' }`
en el mensaje de usuario. Mastra la pasa al proveedor Anthropic como bloque `document`,
que entrega texto e imagen de cada página al modelo. Eso cubre el caso HSBC sin OCR.

Salida estructurada: `structuredOutput: { schema, errorStrategy: 'strict' }`. En CI y en
evals `strict`; en producción `fallback` con `fallbackValue` que marca la extracción como
fallida y la manda a revisión, para que un JSON inválido nunca produzca una decisión.

Caché de prompt entre las dos pasadas de extracción vía `providerOptions.anthropic`
(`cacheControl` sobre el bloque del documento). Esto hay que verificarlo en un spike de
una hora: es la única pieza donde la capa de Mastra se interpone entre el código y una
feature del SDK que importa para el costo.

### Scorers

- `schemaValidity`: determinístico, 1 si el objeto valida contra Zod.
- `arithmeticReconciliation`: determinístico, saldo inicial + abonos − cargos vs saldo
  final y suma de movimientos vs totales.
- `fieldAccuracy`: compara contra ground truth cuando existe (evals), por campo y por banco.

En producción se adjuntan al agente extractor con `sampling: { type: 'ratio', rate: 1 }`
para los determinísticos. Los scores se guardan en la tabla de scorers de Mastra y se ven
en Studio y en Langfuse.

---

## 3. Workflow `processApplication`

```ts
export const processApplication = createWorkflow({
  id: 'process-application',
  inputSchema: z.object({ applicationId: z.string(), documentId: z.string(), tenantId: z.string() }),
  outputSchema: DecisionSchema,
})
  .then(loadDocument)          // lee el PDF desde Supabase Storage, calcula hash
  .then(classifyDocument)      // agente clasificador
  .branch([
    [async ({ inputData }) => !inputData.isStatement, rejectNotStatement],
    [async ({ inputData }) => inputData.isStatement, extractStatement],
  ])
  .then(reconcile)             // código puro: cuadre aritmético, produce issues[]
  .then(decide)                // packages/decision: veredicto (ver estados canónicos en README.md)
  .dountil(clarificationLoop, async ({ inputData }) => inputData.status !== 'needs_clarification')
  .then(notifySupplier)
  .commit()
```

`extractStatement` es un sub-workflow: `extractSummary` y luego `extractTransactions` con
`.foreach` sobre bloques de páginas, reutilizando el documento en caché.

`clarificationLoop` es un sub-workflow con el paso clave:

```ts
const askOwner = createStep({
  id: 'ask-owner',
  inputSchema: z.object({ issues: z.array(IssueSchema), applicationId: z.string() }),
  suspendSchema: z.object({ questions: z.array(QuestionSchema), clarificationId: z.string() }),
  resumeSchema: z.object({ answers: z.array(AnswerSchema) }),
  outputSchema: z.object({ answers: z.array(AnswerSchema) }),
  execute: async ({ inputData, resumeData, suspend, mastra }) => {
    if (resumeData) return { answers: resumeData.answers }
    const questions = await mastra.getAgent('clarificationWriter').generate(...)
    const clarificationId = await clarifications.create({ ...questions })   // tabla Drizzle
    await channel.send(inputData.applicationId, questions)                  // Baileys / Resend / consola
    return suspend({ questions, clarificationId })
  },
})
```

Al suspender, Mastra guarda el snapshot del run en Postgres. El proceso puede reiniciarse
y el run sigue ahí. Cuando llega la respuesta por cualquier canal (socket de Baileys,
webhook de Resend en una Edge Function, endpoint manual del backoffice o archivo de
respuestas en modo `standalone`), se valida, se resuelve al vínculo verificado (ver `05`,
sección 2b) y se encola; el worker llama `run.resume({ resumeData: { answers } })` y el
workflow vuelve a `decide` con las respuestas incorporadas. Las respuestas se mergean sobre la extracción
como "campos aportados por el proveedor", con origen marcado, para trazabilidad.

### Canales de aclaración

Una interfaz `ClarificationChannel` con `send(question)` y un flujo de entrada que termina
siempre en la cola `application.resume`. Tres implementaciones:

| Canal | Librería | Salida | Entrada |
|---|---|---|---|
| WhatsApp | **Baileys** (WhatsApp Web, sesión por QR) | `sock.sendMessage` desde `apps/whatsapp` | evento `messages.upsert` del socket → valida con Zod → encola |
| Correo | **Resend** | API de Resend desde el worker | webhook de correo entrante en una Edge Function → encola |
| Consola / HTTP | ninguna | log | `POST /clarifications/:id/answer` → encola |

Notas de diseño para Baileys:

- Vive en su propio proceso (`apps/whatsapp`) porque mantiene un socket abierto y una
  sesión que hay que conservar. Hay **una sesión (un número) por tenant**, todas
  hospedadas en ese proceso; el par de números identifica al tenant (ver `05`, 2b). El estado de autenticación se persiste en Postgres o en
  Supabase Storage, no en disco local, para que sobreviva redeploys.
- Correlación pregunta-respuesta: cada pregunta se envía con un identificador corto y el
  número del proveedor se guarda en `clarifications`; una respuesta se liga por número y
  por el último `clarificationId` abierto. Si el texto no se puede mapear a una pregunta,
  se guarda como `unmatched` y se muestra en el backoffice.
- Es una librería no oficial y sensible a cambios de WhatsApp. Es la elección para la
  demo y las pruebas; en producción el adaptador se reemplaza por WhatsApp Cloud API sin
  tocar el workflow. Esto queda registrado como decisión y riesgo.

Estados visibles para la API y el backoffice: los del run de Mastra (`running`,
`suspended`, `success`, `failed`) más la columna `status` propia de `applications` (lista
canónica en `README.md`) que se actualiza en cada paso, para que RLS y el backoffice no
dependan del esquema interno de Mastra.

---

## 4. Dónde entra pg-boss

Mastra ejecuta el workflow en proceso. pg-boss es el que decide **cuándo y cuántos** se
ejecutan:

- La API nunca ejecuta un workflow. Recibe el documento, lo guarda en Supabase Storage,
  crea la fila en `applications` y encola `application.process` con
  `singletonKey = hash(documento) + promptVersion`.
- El worker consume `application.process` con concurrencia fija (semáforo hacia
  Anthropic), llama `createRun()` y `start()`. Si el run termina `suspended`, el job se
  completa; nadie se queda esperando.
- `application.resume` se encola desde cualquier canal de entrada (socket de Baileys,
  webhook de Resend, endpoint manual); el worker llama `createRun({ runId })` y
  `resume()`.
- Reintentos con backoff, `deadLetter` por cola, y un job de limpieza que mueve a
  revisión manual los runs suspendidos más de N días.

Mastra ofrece Inngest como motor gestionado; se descarta porque el JD pide pg-boss y
porque el loop de aprendizaje de outcomes vive en el mismo Postgres.

---

## 4b. Archivos pesados y muchos documentos a la vez

**Subida.** El cliente no manda el PDF a la API. La API devuelve una URL firmada de
Supabase Storage y el cliente sube directo. Luego avisa a la API con la ruta; la API
calcula el hash en streaming, crea la fila y encola. Así la API nunca carga un PDF en
memoria y puede escalar a cero. Límite de tamaño en la URL firmada (por ejemplo 40 MB).

**Idempotencia y deduplicación.** `singletonKey = sha256(pdf) + promptVersion`. Si el
mismo documento se sube dos veces, pg-boss no crea un segundo job y la API responde con la
solicitud existente.

**Límites del proveedor.** Claude acepta hasta 32 MB por request y 600 páginas, y cada
página cuesta entre 1,500 y 3,000 tokens. Un estado de cuenta de 32 páginas son 50K a
100K tokens, dentro del contexto de 1M. El paso `loadDocument` cuenta páginas y, si pasa
de un umbral (por ejemplo 60), divide el PDF en bloques y `extractTransactions` corre
`.foreach` sobre bloques con el documento ya subido vía Files API, para no reenviar
base64 en cada pasada. Imágenes embebidas se reducen de resolución antes de enviar.

**Concurrencia hacia Anthropic.** El worker consume `application.process` con
`teamSize` y `teamConcurrency` fijos y además un semáforo global de llamadas al modelo
compartido por todos los steps (una extracción en dos pasadas son varias llamadas, no una).
Ese semáforo se calibra contra el rate limit de tokens por minuto del tier de la cuenta,
no contra el número de jobs. Ante 429 el job se reintenta con backoff exponencial y jitter;
tras N reintentos va a dead letter y la solicitud queda en `failed` con razón visible.

**Backpressure y prioridad.** pg-boss soporta prioridad por job: las reanudaciones
(`application.resume`) van con prioridad alta porque ya tienen al proveedor esperando;
las cargas masivas van con prioridad baja. Para una carga masiva (un tenant sube 500
documentos) el job de ingesta encola en lotes y, si la cola pasa de un umbral, el
pipeline cambia a la **Batches API** de Anthropic: 50 % de costo, asíncrono, sin competir
por el rate limit en línea. Un job `batch.poll` recoge resultados y continúa el workflow.

**Equidad entre tenants.** Una cola por prioridad no evita que un tenant acapare el
worker. Se limita por tenant con un contador en Postgres (máximo de jobs activos por
`tenant_id`); los que exceden se reencolan con `startAfter`.

**Timeouts y memoria.** Cada job tiene `expireInSeconds` acorde a páginas (por ejemplo
60 s base más 5 s por página). El worker corre con límite de memoria en Cloud Run y no
renderiza páginas a imagen por su cuenta: eso lo hace el proveedor. Si en el spike se
necesita render propio para algún caso, se hace página por página en streaming, nunca el
PDF completo en memoria.

**Observabilidad de la cola.** Profundidad por cola, edad del job más viejo, tasa de
reintentos y tamaño del dead letter se exportan como métricas y disparan alerta. Son
exactamente las señales del caso de incidente de la entrevista.

**Qué no se hace en la primera versión.** Sharding del worker por tenant, colas
separadas por tamaño de documento y autoscaling del worker por profundidad de cola. Se
documentan como siguientes pasos.

## 4c. Jev (TypeSafe AI) para decisiones rápidas y calibradas

Jev es un modelo "System One": no genera texto, responde preguntas tipadas sobre un estado
(texto o JSON) y devuelve etiquetas con probabilidades calibradas. Tres primitivas:
**Choice** (una opción de hasta 255, con `probabilities` y `confidence`), **Score** (nivel
en una escala ordenada de 2 a 10, con distribución) y **Noul** (probabilidad 0 a 1 de que
una afirmación sea cierta). Todas las preguntas de una petición se evalúan en paralelo, así
que preguntar más cuesta casi lo mismo. Latencia de cientos de milisegundos y precio por
tokens de entrada muy por debajo de un LLM. SDK oficial `@typesafe-ai/sdk` con tipos
inferidos: `choice('...', { a: '...', b: '...' })` tipa `.choice` como `'a' | 'b'`, lo que
encaja directo con el matching exhaustivo de `ts-pattern`.

Regla de uso: **Jev decide, Claude extrae y redacta.** Jev no genera, no lee imágenes y no
hace aritmética; va donde hay que elegir entre opciones conocidas o medir una probabilidad.

### Dónde entra en el workflow

| Paso | Pregunta a Jev | Tipo | Qué hace el código con la respuesta |
|---|---|---|---|
| `classifyDocument` | ¿Qué documento es? (`bank_statement`, `credit_card_statement`, `invoice`, `other`) | Choice | Rama del workflow. `confidence < 0.7` → clasificador Claude. |
| `classifyDocument` | ¿Qué banco? (lista conocida + `other`) | Choice | Selecciona few-shot y reglas por banco si existen. |
| `classifyDocument` | "El texto extraído es legible y está en español" | Noul | Si es bajo (caso HSBC), el texto está corrupto y la extracción va solo por visión; no se manda texto basura al prompt. |
| `routeExtraction` | Score de complejidad del documento (páginas, densidad de tablas, multi-cuenta) | Score | Elige modelo y `effort` para la extracción: documentos simples a Sonnet, complejos a Opus. Es el patrón `ModelRouter` del post de LangChain. |
| `classifyTransactions` | Por movimiento: `customer_payment`, `own_transfer`, `loan_disbursement`, `payroll`, `supplier_payment`, `tax`, `fee`, `interest`, `other` | Choice | Alimenta las reglas: separa ingresos operativos de préstamos recibidos o traspasos propios que inflan los depósitos. Se mandan lotes de 20 a 30 movimientos como estado JSON y una pregunta por fila. |
| `classifyTransactions` | "Este abono es ingreso recurrente de un cliente" | Noul | Feature de recurrencia para la regla de cobertura. |
| `reconcile` | Por `issue`: `ask_owner`, `auto_resolve`, `human_review` | Choice | Evita preguntar al proveedor por cosas que el código puede resolver, y manda a revisión lo que ninguna respuesta del proveedor arreglaría. |
| `clarificationLoop` (entrada por Baileys) | ¿A qué pregunta abierta responde este mensaje? (ids de preguntas + `none`) | Choice | Correlación de respuesta libre de WhatsApp con la pregunta. `confidence < 0.6` → se repregunta con opciones numeradas. |
| `clarificationLoop` | "La respuesta es afirmativa", "pide hablar con una persona", "contradice el dato extraído" | Noul | Valida la respuesta antes de mergearla; contradicción alta → `human_review`. |
| Guardrail de entrada | "El texto contiene instrucciones dirigidas a un sistema automatizado" | Noul | Los PDFs y los mensajes del proveedor son contenido no confiable. Si es alto, el documento se marca y no se usa como contexto de prompt sin revisión. |

### Cómo se conecta con el motor de decisión y el loop de aprendizaje

Jev **no** califica al proveedor. Las reglas siguen siendo funciones puras. Lo que cambia
es que las reglas reciben features con probabilidad (por ejemplo "porcentaje de depósitos
clasificados como ingreso de clientes con `confidence > 0.8`") y los umbrales de esas
probabilidades viven en la **política del tenant** (`policies`, ver `03`) como datos. El
workflow `nightlyCalibration` propone ajustes a esos umbrales contra `outcomes`. Esa es la unión entre "reglas estáticas" y "sistema que
aprende" de la pregunta de entrevista: las probabilidades calibradas son la señal, los
outcomes son la etiqueta, y el umbral es lo que se aprende, sin reentrenar nada.

### Integración técnica

- `packages/llm/jev.ts`: cliente único con `TypeSafeClient({ defaultModel: 'jev-1.13.0' })`.
  Versión fijada; `jev-latest` cambia y mueve las probabilidades. Se registra el campo
  `model` de cada respuesta en la traza.
- Interfaz `Classifier` con dos implementaciones, `JevClassifier` y `ClaudeClassifier`
  (Haiku con `structuredOutput`). Permite correr los evals con ambas y tener fallback si la
  API no está disponible (el acceso directo está en lista de espera; también se puede
  acceder por Vercel AI Gateway).
- Dentro de Mastra se expone como `createTool` con `inputSchema` y `outputSchema` Zod, y
  los steps lo llaman como cualquier tool; las llamadas quedan en la traza del step.
- Límites a respetar: 64K tokens de estado más preguntas por petición, 1,200 peticiones
  por minuto. Los lotes de movimientos se dimensionan para no pasar de ~8K tokens.
- Umbrales de `confidence` por acción según el costo de equivocarse: bajo para elegir
  few-shot, alto para descartar un documento o cerrar una aclaración.

### Riesgos

- Benchmarks auto-reportados y acceso en lista de espera: por eso existe el fallback y los
  evals comparan Jev contra Haiku en los 9 documentos antes de dejarlo como default.
- Solo texto: todo lo que dependa de la imagen (HSBC) pasa por Claude.
- Estado adversarial: el documento puede contener texto que sesgue la respuesta. Se usa
  el guardrail de inyección y nunca se toma una decisión irreversible solo con Jev.
- Lee literal: las preguntas se redactan sin negaciones ni ambigüedad y se versionan junto
  con los prompts.

## 5. Motor de decisión

`packages/decision` es TypeScript puro, sin Mastra, en dos mitades (detalle en
`03-criterio-de-calificacion.md`):

- **Perfil**: catálogo fijo de features tipadas calculadas desde la extracción
  (ingresos operativos, capacidad de pago, capacidad de endeudamiento, estabilidad,
  deuda, relación con el comprador, tendencia), con confianza y procedencia.
- **Política**: documento JSON por tenant, validado con un esquema Zod cerrado
  (compuertas, dimensiones con pesos, bandas de decisión, reglas de aclaración),
  versionado e inmutable en la tabla `policies`. `evaluate(policy, profile)` es una
  función pura con matching exhaustivo. Soporta simulación sobre solicitudes pasadas y
  modo sombra antes de activar una versión.

El paso `decide` del workflow carga la política activa del tenant y la aplica al perfil.
La salida incluye el diagnóstico con contrafactuales (`next_steps`) para el proveedor.
Esto mantiene la decisión determinística, replicable offline, testeable sin LLM ni base
de datos, y personalizable por prestamista sin tocar código.

---

## 6. Loop de aprendizaje

- Tabla `outcomes` (Drizzle): pagó a tiempo, mora, fraude, fecha.
- Workflow `nightlyCalibration` en Mastra, disparado por pg_cron → pg_net → endpoint
  interno → pg-boss: lee decisiones con outcome por tenant, calcula precisión por
  compuerta y dimensión por `policy_version`, propone umbrales y pesos nuevos y los guarda
  como una versión `draft` de la política con su simulación adjunta (ver `03`, 5 y 8).
- Una política en `shadow` se evalúa en cada decisión y se registra, pero no decide. Un
  usuario del tenant la promueve desde el backoffice cuando la simulación lo justifica.
- Versiones de prompt: tabla `prompt_versions` con porcentaje de tráfico; el agente
  extractor lee la versión activa por `RequestContext` y la etiqueta en las trazas.

---

## 7. Evals y observabilidad

- **CI:** Evalite ejecuta los 9 documentos contra ground truth con los scorers de
  `fieldAccuracy` y `arithmeticReconciliation`, umbral que falla el build. Se puede
  reutilizar el mismo scorer de Mastra dentro del `.eval.ts`.
- **Producción:** scorers vivos de Mastra sobre cada extracción, trazas de agente, paso
  y `MODEL_INFERENCE` con tokens, exportadas a Langfuse con `tenantId`,
  `applicationId` y `promptVersion` como metadata.
- **Studio** en desarrollo: sirve para la demo de la llamada (ver el run suspendido,
  reanudarlo a mano, ver scores).
- Logs de aplicación con pino, `correlation_id = runId`, sin PII.
- Métricas para el caso de incidente: tokens y costo por versión de prompt (Langfuse),
  429 por worker, profundidad de colas de pg-boss, pool de Postgres de Supabase.

---

## 8. Deploy y CI/CD

- `apps/api` y `apps/worker` como imágenes Docker en Cloud Run (API escala a cero, worker
  con `min-instances=1`). Studio no se despliega.
- Supabase gestionado: Postgres, Storage, Edge Functions, Vault, pg_cron.
- `apps/web` en Vercel.
- GitHub Actions: typecheck, lint, unit, Evalite con umbral, build, migraciones Drizzle y
  Supabase, deploy a staging por PR y a producción por tag.

---

## 9. Trade-offs frente al diseño sin framework

| Ganas | Pagas |
|---|---|
| Suspend/resume persistido sin escribir máquina de estados ni tablas de snapshot | Tablas y esquema propios de Mastra en tu Postgres |
| Trazas de agente, paso y modelo con tokens, exportadas a Langfuse sin instrumentar | El proveedor Anthropic pasa por la capa de AI SDK: caché de prompt, `fallbacks` y `effort` se configuran vía `providerOptions` y hay que verificar que llegan |
| Scorers vivos y Studio para la demo | Mastra está en 1.x con cambios frecuentes: fijar versión |
| Agentes y workflows tipados con Zod de punta a punta | Dos motores en juego (pg-boss y el engine de Mastra): pg-boss decide cuándo y cuántos; Mastra ejecuta (sección 4) |

Riesgo a cerrar en el primer spike: confirmar que el PDF como `file` part llega como
bloque `document` a Anthropic, que `cacheControl` reduce tokens en la segunda pasada, y
que `structuredOutput` usa el modo nativo del proveedor (`jsonPromptInjection: 'auto'`).
Si alguna de las tres falla, el paso de extracción llama al SDK de Anthropic directamente
dentro del `execute` del step y Mastra sigue orquestando. Esa es la salida de emergencia y
no cambia el resto del diseño.

---

## Cambios durante la implementación

### Fase 0 (2026-11-04), a partir de los spikes de `docs/spikes/`

- **Modelo como instancia del proveedor, no como string del router.** Los agentes reciben
  `createAnthropic()(...)` de `@ai-sdk/anthropic` en lugar de `'anthropic/claude-opus-5-5'`.
  Así se fija la versión del proveedor, se puede apuntar a un servidor de pruebas y no se
  hereda un `ANTHROPIC_BASE_URL` ajeno. (Spike 1)
- **Salida estructurada nativa.** La sección 9 menciona `jsonPromptInjection: 'auto'`; en
  Mastra 1.81 lo nativo es el default (sin `jsonPromptInjection`) y además se fuerza con
  `providerOptions.anthropic.structuredOutputMode: 'outputFormat'`. Verificado en el cable:
  llega `output_config.format`. (Spike 1)
- **`maxOutputTokens` siempre explícito y `agent.stream()` en las pasadas largas.** Sin
  `maxOutputTokens`, AI SDK manda `max_tokens: 128000` en una llamada no streaming. (Spike 1)
- **Guarda en `askOwner`.** `.dountil()` corre el cuerpo al menos una vez, así que
  `clarificationLoop` se ejecuta aunque la decisión ya sea final. `askOwner` regresa sin
  suspender si `status !== 'needs_clarification'`. Sin la guarda se le preguntaría al
  proveedor sin motivo. (Spike 4)
- **Errores de esquema en la entrada del workflow.** `run.start()` lanza `MastraError`
  (`WORKFLOW_SCHEMA_VALIDATION_FAILED`) en lugar de devolver `failed`; quien lo llama lo
  convierte en `application.status = failed` con razón. (Spike 2)
- **`exactOptionalPropertyTypes`** se apaga solo en `packages/mastra` por incompatibilidad
  de tipos de Mastra con sub-workflows. ADR 0004. (Spikes 2 y 4)
- **Jev y las imágenes.** `@typesafe-ai/sdk` 0.7 ya acepta imágenes (experimental). Se
  mantiene "Jev solo texto" de la sección 4c mientras sea experimental. (Spike 3)

### Fase 2 (2026-11-04)

- **Un solo esquema de salida por documento.** `output_config.format` forma parte del
  prefijo cacheado: con un esquema distinto por pasada, cada pasada vuelve a escribir el
  documento en caché. Todas las llamadas de extracción usan el mismo esquema y solo cambia
  la instrucción final. Medido en vivo en el spike 1; ADR 0005.
- **`ANTHROPIC_WORKSPACE_ID` opcional.** Las llaves de usuario sin workspace exigen el
  header `anthropic-workspace-id`; si la variable existe, el cliente lo manda.
- **Bloque fiscal (CFDI) en la pasada 1** (`docs/09`, ADR 0008). `StatementExtraction`
  1.1.0 gana `fiscal_documents`; el esquema del modelo pasa a `extraction_chunk.v2` con los
  campos fiscales en la misma lista citada, así que no rompe la caché (ADR 0005). Los sellos
  y la cadena original completa no se piden ni se guardan.

### Modelo de extracción (2026-11-04, ADR 0011)

- **`statementExtractor` corre en `gemini-3.8-flash`**, no en `claude-opus-5-5`. Mismo
  puerto `StructuredLlm`, mismo prompt y esquema (`extraction_chunk.v2`), misma
  verificación; cambia `EXTRACTION_MODEL` y Gemini deja de ser experimental: desaparece
  `--allow-third-party` y mandar el documento a Google es el comportamiento por defecto,
  dicho en el README. Evidencia en `docs/experiments/2026-11-04-gemini-extraction.md`.
- **Emergencia en dos niveles**: `gemini-4-carbon` repite el bloque cuando Flash falla por
  calidad (salida que no valida dos veces seguidas, descuadre que el reintento dirigido no
  resuelve); `claude-opus-5-5` toma el documento cuando falla el proveedor (cuota, error o
  caída tras los reintentos). Lo decide el router (ADR 0003), no un flag, y cada bloque
  registra qué modelo lo produjo.
- **Lo que era de Anthropic y ya no aplica a la extracción por defecto**: `cacheControl`,
  `fallbacks: "default"`, thinking adaptativo por `effort` (Gemini usa `thinkingLevel`),
  citas nativas. La sección 2 describe ahora el camino de emergencia.
- **`standalone` necesita dos llaves**: `GOOGLE_GENERATIVE_AI_API_KEY` y
  `ANTHROPIC_API_KEY` (clasificación de respaldo, aclaraciones, doble lectura, emergencia).

### Fase 4 (2026-11-04, ADR 0013 y 0014)

- **`packages/decision` está construido** como dice la sección 5: puro, sin Mastra. El paso
  `decide` del workflow (fase 5) llamará a `decide()`, que arma el perfil, aplica la política y
  agrega la pregunta por abonos grandes inciertos de `docs/03` §7.
- **`classifyTransactions` (sección 4c)** sigue siendo de la fase 5. Mientras tanto, el perfil
  clasifica con reglas (`rules-v1`) lo que llegue sin clasificar; Jev entra encima. La lista de
  4c gana `loan_payment` (pago a un crédito).
- **Puertos de fuentes externas** (`ExistingCredits`, `CreditBureau`, `TaxAuthority`,
  `Program`, `ApplicationHistory`) y sus dobles simulados viven en
  `packages/decision/src/external/` hasta que exista `packages/channels` (fase 6). El perfil
  recibe un `ExternalSnapshot` ya armado, así que sigue siendo puro.
- **`scenarios/`** es un paquete del workspace (`@gow/scenarios`) con el runner del modo `unit`.

### Fase 5 (2026-11-05, ADR 0015)

- **`packages/mastra` existe en modo standalone.** Tiene el workflow, los canales, la redacción,
  el reporte y el CLI `evaluate`. La instancia de §2 (PostgresStore, agentes registrados,
  scorers, Langfuse) es de la fase 6. Aquí Mastra corre con libSQL en
  `<salida>/.state/mastra.db` y las llamadas a modelos pasan por el puerto `StructuredLlm` de
  `packages/llm`, no por agentes registrados.
- **§3, forma real del workflow**: `extract → classify-transactions → decide →
  dountil(ask-owner → apply-answers → re-decide) → explain`. No hay `reconcile` aparte: la
  verificación está dentro de la extracción. `notifySupplier` es de la fase 6.
- **§3, el estado viaja en el snapshot.** Lleva extracciones clasificadas, veredicto, preguntas
  y respuestas. Al reanudar, `ask-owner` parte del payload de suspensión.
- **§3, canales**: `OutboxChannel` (archivo con el mensaje) y la consola interactiva del CLI. La
  entrada siempre llega como respuestas cerradas validadas con Zod.
- **§4c, `classifyTransactions`**:
  - Solo van al modelo los movimientos que las reglas dejan bajo 0.85. Lotes de 25, opciones
    por sentido.
  - La confianza de Jev se usa. La de Haiku no (spike 3): queda en 0.8 si coincide con una regla
    con palabra clave y en 0.6 si no.
  - Las respuestas de Jev quedan en caché en `data/llm-cache/transactions`.
  - La caché de clasificación de documentos pasó a `packages/llm`.
- **§4c, filas de la tabla sin construir.** No existen Jev para `reconcile` (`ask_owner`,
  `auto_resolve`, `human_review`), el Noul de recurrencia ni la correlación de respuestas de
  WhatsApp. Las dos últimas llegan con la fase 6.

### Fase 6 (2026-11-05, ADR 0016 a 0018)

- **§1**: existen `packages/db` (Drizzle), `packages/channels` (conversación, Resend, Svix),
  `packages/platform` (pg-boss y almacenamiento), `apps/api`, `apps/worker` y `apps/whatsapp`.
  `packages/channels` no tiene los dobles externos: siguen en `packages/decision` (fase 4).
- **§2, instancia de Mastra**: el worker usa `PostgresStore` en el esquema `mastra` con su propio
  rol, compartido entre trabajos. Los agentes siguen siendo el puerto `StructuredLlm`.
- **§3, canales**: una pregunta a la vez y solo abonos por WhatsApp o correo (ADR 0017). La
  correlación de respuestas es determinística (número, opción o palabras clave, y si no, se
  repregunta); Jev para eso queda para cuando haya varias preguntas abiertas por número.
- **§3, correo entrante**: en `POST /v1/webhooks/resend` de la API, con firma Svix, no en una Edge
  Function.
- **§4, colas**: `application.process` con `singletonKey` en política `exclusive`; en `standard`
  la llave no deduplica. Reintentos con backoff y `application.dead`. No hay limpieza de runs
  suspendidos ni equidad por tenant todavía.
- **§4b**: subida por URL firmada con almacenamiento local detrás de la interfaz. Sin Files API ni
  Batches API.
