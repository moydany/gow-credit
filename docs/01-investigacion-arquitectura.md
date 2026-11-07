# Investigación de arquitectura y stack

> **Estado: investigación, parcialmente superada.** Este documento registra la comparación
> de opciones y las razones. Varias decisiones cambiaron después; la versión vigente está
> en los documentos indicados:
>
> | Punto de este documento | Decisión vigente | Dónde |
> |---|---|---|
> | 2.1 Anthropic SDK directo, sin framework | **Mastra** como capa de agentes y workflows; el SDK directo queda como salida de emergencia dentro de un step | `02`, sección 9 |
> | 2.2 Haiku para clasificar | **Jev** (TypeSafe AI) con fallback automático a Haiku | `02`, sección 4c |
> | 2.3 Reglas en tabla `rule_sets` | **Perfil de features + política JSON por tenant** en tabla `policies` | `03` |
> | 2.6 Edge Functions reciben webhooks de WhatsApp | WhatsApp por **Baileys** en proceso propio (socket, no webhook); Edge Functions solo para Resend | `02`, sección 3 |
> | 2.7 Estados `rejected` etc. | Lista canónica de estados de la solicitud: `received`, `extracting`, `extracted`, `deciding`, `needs_clarification`, `human_review`, `qualified`, `qualified_with_limit`, `not_qualified`, `failed` | `02` |
> | 2.9 Consola mínima | **Backoffice** con un rol y varios usuarios | `08` |
>
> Lo demás (modelo y forma de llamar, Express 5, Supabase con Drizzle, pg-boss, Evalite,
> Langfuse, Cloud Run, respuestas a las preguntas de entrevista) sigue vigente.


Fecha: 2026-11-04. Contexto: worksample de GOW Credit (ver `Worksample Ingeniería Tech v3`).
Objetivo: elegir el stack más actual y la mejor arquitectura para un sistema que recibe
estados de cuenta bancarios de proveedores, extrae su información, decide si el proveedor
califica para pronto pago y consulta al dueño del documento cuando algo no está claro.

El diseño se alinea con el job description (TypeScript estricto, Node, Express, Zod,
Supabase con RLS, pgvector, pg_cron, Vault, Edge Functions, pg-boss, Claude con structured
outputs y evals, WhatsApp, Resend, React en Vercel, logging estructurado y trazas) y con las
tres preguntas de entrevista (motor de reglas que aprende de outcomes, diagnóstico de
incidentes con LLM, plan de evaluación lean).

---

## 1. Hallazgo que condiciona todo: el dataset

Los 9 PDFs de desarrollo son **estados de cuenta bancarios** de 9 bancos mexicanos distintos
(Inbursa, Hey, Fondeadora, Banamex, BBVA, MercadoPago, Santander, Nu, HSBC), de 3 a 32
páginas. El de HSBC tiene la capa de texto corrupta (fuentes con encoding roto). Los de
evaluación pueden ser bancos nunca vistos.

Consecuencias:

- No sirve un parser por banco. Hace falta extracción con modelo multimodal y esquema fijo.
- Hace falta visión, no solo texto, para documentos como el de HSBC.
- Los documentos son largos: el costo por documento y el chunking importan.
- Hay campos redactados (RFC, CLABE). Ese es el caso natural del loop de aclaración.

---

## 2. Decisiones de stack

### 2.1 Llamadas al LLM: Anthropic SDK directo, sin framework de orquestación

Opciones evaluadas:

| Opción | A favor | En contra |
|---|---|---|
| **Anthropic SDK directo** (`@anthropic-ai/sdk`) | `messages.parse` + `zodOutputFormat` da JSON validado contra Zod sin parseo manual. Soporte nativo de PDF (texto + imagen por página). Files API, prompt caching, Batches, OpenTelemetry nativo con convenciones `gen_ai.*`. Es lo que pide el JD. | Hay que escribir la máquina de estados y la persistencia a mano. |
| **Mastra** | Workflows con `suspend()` / `resume()` persistidos en Postgres, que calzan con el loop de aclaración. Scorers y Studio. Modelos Anthropic soportados. | Capa extra entre el código y el SDK: oculta structured outputs, caching y PDF nativo. Tablas propias en la base. Para dos personas es una dependencia grande que hay que justificar en la llamada. |
| **Vercel AI SDK** | Multi-proveedor, buen DX en apps Next.js. | La API de objetos estructurados está en transición (`generateObject` vs `Output`), y es agnóstico de proveedor cuando el JD pide Claude específicamente. |
| **LangChain.js / LangGraph.js** | Grafos de estado para multi-agente complejo. | Abstracción pesada, herencia Python-first, poco valor para un pipeline lineal con un punto de pausa. |
| **Claude Agent SDK** | Harness de agentes de Anthropic. | Orientado a agentes con filesystem y shell. No es un pipeline de extracción. |

**Decisión:** Anthropic SDK directo. El problema es un **workflow determinístico con un
punto de pausa**, no un agente abierto. La máquina de estados se escribe en TypeScript puro,
se persiste en Postgres y se ejecuta con pg-boss. Eso deja el loop de aclaración, el
versionado de prompts y el loop de aprendizaje bajo control total, que es justo lo que las
preguntas de entrevista exploran.

Mastra queda documentado como alternativa seria. Si en la llamada preguntan "¿por qué no un
framework?", la respuesta es: menos capas, acceso directo a las features del SDK que se van a
medir (extracción), y el workflow cabe en 200 líneas tipadas.

### 2.2 Modelo y forma de llamar

- **Entrada:** el PDF completo como bloque `document` (base64 o `file_id` vía Files API).
  Claude extrae el texto de cada página y además recibe la imagen de cada página, así que
  el caso HSBC queda cubierto sin OCR propio. Costo aproximado de 1,500 a 3,000 tokens por
  página. Un estado de cuenta de 32 páginas ronda 50K a 100K tokens de entrada.
- **Salida:** `client.messages.parse` con `output_config.format = zodOutputFormat(schema)`.
  El esquema Zod es la única fuente de verdad del contrato de extracción.
- **Dos pasadas con caché:** pasada 1 extrae encabezado y resumen (banco, titular, RFC,
  CLABE, periodo, saldos, totales). Pasada 2 extrae movimientos por bloques de páginas.
  El documento se marca con `cache_control` para que la segunda pasada lea de caché.
- **Validación en código:** saldo inicial + abonos − cargos = saldo final, suma de
  movimientos = totales del resumen, fechas dentro del periodo. Lo que no cuadra se marca
  como campo dudoso y alimenta el loop de aclaración.
- **Modelo:** `claude-opus-5-5` por defecto para extracción (es la métrica que se mide),
  con `output_config.effort` ajustado por evals. `claude-haiku-5-5` como segundo modelo
  para clasificación de documento y validaciones baratas. La elección final se decide con
  los evals, no a priori.
- **Refusals:** `fallbacks: "default"` activado para que una clasificación de seguridad no
  deje un documento sin procesar.
- **Batches API** para corridas masivas y evals (50% de descuento, asíncrono).

### 2.3 Motor de decisión tipado

- Reglas como datos tipados: uniones discriminadas, matching exhaustivo (`ts-pattern`),
  cada regla es una función pura `(extraction, context) => RuleResult` con
  `pass | fail | needs_clarification` y evidencia.
- Conjunto de reglas versionado (`rule_set_version`). La decisión es determinística y
  replicable offline sobre extracciones guardadas.
- Umbrales como datos en tabla, no como constantes. Esto es lo que el loop de aprendizaje
  ajusta después, sin tocar código.
- Sin LLM en la decisión final. El LLM extrae y redacta la pregunta de aclaración; la
  calificación es código.

### 2.4 API HTTP: Express 5 + Zod

Hono es más moderno y tipa mejor, pero el JD pide Express. Express 5 ya maneja errores
async de forma nativa y con Zod en los límites (`zod-express-middleware` o validación
manual) más `zod-to-openapi` se obtiene contrato y documentación desde el mismo esquema.
Las rutas se aíslan en un adaptador delgado para que el framework sea reemplazable.

### 2.5 Base de datos: Supabase Postgres + Drizzle

- **Drizzle ORM**: SQL-first, soporte de políticas RLS en el esquema (`pgPolicy`),
  migraciones con `drizzle-kit`. Encaja con RLS multi-tenant mejor que Prisma.
- **RLS multi-tenant**: toda tabla de negocio lleva `tenant_id`; políticas por
  `auth.jwt()` o por `set_config` en el worker.
- **Vault** para secretos (claves de WhatsApp, Resend, Anthropic) leídos por funciones
  `security definer`.
- **pg_cron** para evals nocturnos, ingesta de outcomes y limpieza de colas.
- **pgvector** opcional: embeddings de la primera página para recuperar ejemplos del mismo
  banco como few-shot y para detectar documentos duplicados.

Tablas núcleo: `tenants`, `suppliers`, `documents`, `extractions` (JSON + `prompt_version`
+ modelo + tokens + latencia + costo), `decisions` (`rule_set_version`, resultado, razones),
`clarifications` (pregunta, canal, respuesta, estado), `outcomes` (pagó a tiempo, mora,
fraude), `prompt_versions`, `rule_sets`, `eval_runs`.

### 2.6 Colas: pg-boss v12 en un worker Node

- `pg-boss` 12.x: `SKIP LOCKED`, reintentos con backoff, `deadLetter` por cola,
  `singletonKey` para idempotencia (hash del documento + versión de prompt).
- Colas: `document.extract`, `application.decide`, `clarification.send`,
  `clarification.answered`, `outcome.ingest`.
- Concurrencia limitada hacia Anthropic (semáforo por worker) para absorber 429.
- **Supabase Queues (pgmq) + Edge Functions** se evaluó: el límite de tiempo de una Edge
  Function (150 s en plan free) no alcanza para extraer un PDF de 32 páginas en dos pasadas.
  Las Edge Functions en Deno quedan como **ingreso delgado**: reciben webhooks de WhatsApp
  y Resend, validan firma, encolan y responden 200.

### 2.7 Loop de aclaración (human in the loop)

- Una regla o la validación aritmética genera una `Clarification` con pregunta concreta,
  campo afectado y opciones de respuesta cuando aplique.
- Máquina de estados de la solicitud: `received → extracting → extracted →
  needs_clarification → deciding → qualified | rejected | failed`.
- Canal por adaptador detrás de una interfaz única (`ClarificationChannel`):
  **WhatsApp con Baileys** (cliente de WhatsApp Web, sesión por QR) y **correo con Resend**
  para la demo y las pruebas; consola y endpoint HTTP para desarrollo y evaluación. Baileys
  es una librería no oficial: en producción el adaptador se reemplaza por WhatsApp Cloud
  API sin tocar el resto. La respuesta entrante se valida con Zod, se guarda y reencola
  `application.decide`. Con Baileys la entrada llega por eventos del socket en un proceso
  de larga vida; con Resend llega por webhook.
- Toda respuesta queda ligada a la decisión que afectó (trazabilidad).

### 2.8 Evals y observabilidad

- **Evalite** (basado en Vitest, archivos `.eval.ts`, umbrales que fallan el build en CI)
  con scorers propios: exactitud por campo, exactitud por banco, cuadre aritmético, tasa de
  JSON inválido. Ground truth de los 9 documentos de desarrollo en `evals/ground-truth/`.
- **Langfuse** (open source, OpenTelemetry nativo) para trazas, datasets y comparación por
  versión de prompt. El SDK de Anthropic emite spans OTel con `gen_ai.*`, así que no hace
  falta instrumentación extra. Promptfoo se descartó por su adquisición por OpenAI;
  Braintrust por costo.
- **Logs** con pino, JSON, `correlation_id` por solicitud, sin PII en logs.
- Métricas mínimas por versión de prompt: tokens, costo, latencia p50/p95, 429, respuestas
  vacías, profundidad de cola, uso del pool de Postgres. Son las señales de la pregunta de
  incidentes.

### 2.9 Frontend y deploy

- React + Vite + TypeScript en Vercel: consola mínima para ver solicitudes, extracción,
  decisión y contestar aclaraciones a mano.
- Backend: API y worker como contenedores. Recomendación: Google Cloud Run (API con
  escalado a cero, worker con `min-instances=1`). Alternativa equivalente: Fly.io.
- CI/CD en GitHub Actions: typecheck, lint, tests unitarios, evals con umbral, build de
  imagen, deploy a staging por PR y a producción por tag. Migraciones con `drizzle-kit`
  en el pipeline.

---

## 3. Cómo este diseño responde las preguntas de entrevista

**Reglas → sistema que aprende (6 semanas, 2 personas).** Las reglas ya son datos
versionados con umbrales en tabla. La tabla `outcomes` cierra el loop: pg_cron calcula cada
noche precisión por regla y por versión, y un job propone nuevos umbrales que se despliegan
en modo sombra (se calcula pero no decide) antes de activarse. Prompts y reglas se publican
con versión y porcentaje de tráfico.

**Incidente (latencia x3, gasto x2, 429, pool al máximo).** Hipótesis: el nuevo prompt
dispara más tokens de salida o más reintentos; la concurrencia escalada supera el rate limit;
los reintentos agresivos amplifican. Chequeos: tokens por respuesta por versión en Langfuse,
tasa de 429 por worker, `pg_stat_activity`. Mitigación: bajar concurrencia, rollback de
prompt por flag, circuit breaker ante 429. Largo plazo: presupuesto de tokens por job,
pool de conexiones compartido (`pgbouncer` de Supabase), alertas por versión.

**Plan de evaluación lean.** Offline: replay de extracciones históricas con el nuevo
conjunto de reglas y comparación contra outcomes reales. Online: canary por tenant o por
hash de proveedor, con métricas de tasa de aprobación, mora a 30 días, costo por documento
y latencia p95. Guardrails: no más de X% de cambio en tasa de aprobación, costo por
documento bajo umbral, rollback automático por flag.

---

## 4. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Bancos no vistos en evaluación | Esquema genérico, prompt sin supuestos de layout, few-shot por similitud si hay tiempo |
| Tablas de movimientos muy largas | Extracción por bloques de páginas con caché del documento; cuadre contra totales |
| Costo por documento | Dos modelos, effort ajustado por evals, Batches para corridas masivas |
| Reproducibilidad | Modelo y prompt fijados por versión, effort fijo, caché de respuestas en evals |
| Sobreinvertir en UI | Frontend al final y mínimo |

---

## 5. Fuentes

- Comparativas de frameworks TS 2026: Langfuse, Speakeasy, Coder Legion, Developers Digest.
- pg-boss 12.x y dead letter queues: releases en GitHub, tutorial de producción (mayo 2026).
- Supabase Queues con Edge Functions y límites de tiempo: docs oficiales de Supabase.
- Supabase Vault, pg_cron y pg_net: guía oficial de scheduling de Edge Functions.
- Claude PDF support (texto + imagen por página, 1,500–3,000 tokens por página, Files API,
  caching): docs de platform.claude.com.
- Structured outputs con `messages.parse` y `zodOutputFormat`: referencia del SDK TS.
- OpenTelemetry en el SDK de Anthropic (`gen_ai.*`): docs de platform.claude.com.
- Evalite v1 beta (Vitest, umbrales en CI): evalite.dev.
- Mastra workflows `suspend/resume` y scorers: docs de mastra.ai.
- Drizzle vs Prisma y RLS: comparativas 2026 (ZenStack, ecosire).
- Express 5 vs Hono en Node 24: OpenReplay, PkgPulse.
- Herramientas de evals y observabilidad 2026: Confident AI, Latitude, roadmap.sh.
