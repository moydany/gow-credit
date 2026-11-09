# Pendientes antes de construir

Fecha: 2026-11-04. Revisión de los documentos 01 a 06 contra los entregables del
enunciado, las preguntas de entrevista y el escenario real de evaluación (ellos corren el
sistema sobre 10 PDFs que no vimos). Orden por impacto.

## A. Lo que ellos van a ejecutar: un camino sin infraestructura

Los evaluadores no van a levantar Supabase, escanear un QR de WhatsApp ni pedir acceso a
Jev. Si el único camino es el completo, no lo corren.

- **Comando de evaluación autónomo**: `pnpm run evaluate ./carpeta-de-pdfs --out ./resultados`.
  Lee PDFs, extrae, verifica, calcula perfil, aplica la política base y escribe un JSON
  por documento más un reporte legible. Solo necesita `ANTHROPIC_API_KEY`.
- **Sin Postgres para ese camino**: Mastra con libSQL local y el workflow ejecutado en
  proceso, sin pg-boss. El camino completo (Supabase, pg-boss, Baileys) es el mismo
  código con otros adaptadores, y se documenta con docker-compose para quien quiera.
- **Aclaración en modo CLI**: si una solicitud se pausa, el comando imprime las preguntas
  y acepta `--answers archivo.json` o un modo interactivo. Así ellos pueden ejercitar el
  loop sin WhatsApp.
- **Jev opcional**: sin `TYPESAFE_API_KEY` el clasificador cae a Haiku automáticamente y
  lo dice en el reporte. El acceso a Jev está en lista de espera; hay que solicitarlo hoy.
- **Datos de la solicitud opcionales**: sin monto ni comprador, la salida es línea
  máxima y perfil; con `--request amount=...,buyer=...` es decisión completa.

## B. El contrato de extracción es el entregable medido: fijarlo primero

Es lo único que califican con número y todavía no está escrito. Antes del código:

- Esquema canónico en `packages/contracts/statement.ts` y publicado como JSON Schema en
  `docs/schema/`. Fechas ISO 8601, montos como número con dos decimales, moneda explícita.
- Un documento puede traer **varias cuentas** (Santander: cuenta más inversión) y
  **varios periodos** (Mercado Pago: tres meses). El esquema es `document → accounts[] →
  periods[] → transactions[]`, no una cuenta plana.
- Movimientos con `amount` positivo y `type: credit | debit`, porque cada banco usa una
  convención distinta (Mercado Pago negativos, otros en columnas).
- Campos opcionales que pueden faltar son `null`, nunca inventados; cada uno con
  `source_page`.
- Titular: persona física con actividad empresarial o persona moral; tipo de cuenta
  (cheques, inversión, tarjeta de crédito). Un estado de tarjeta de crédito podría llegar
  en evaluación y el clasificador debe decir qué es, aunque no se evalúe.

## C. Ground truth de los 9 documentos: es trabajo y hay que planearlo

Sin ground truth no hay evals ni medición de alucinación. Son hasta 32 páginas por
documento. Plan: extracción inicial con el sistema, verificación por cuadre, revisión
manual de encabezados, totales y una muestra de movimientos por página; corrección a
mano de lo que no cuadre; se guarda como JSON con el mismo esquema. Estimado: 3 a 4 horas.
Es la tarea más cara del proyecto y la que más vale.

## D. Privacidad del dataset: el repo no puede ser público

Los PDFs tienen nombres, RFC parciales, CLABE parciales y movimientos reales. Ni los
PDFs ni el ground truth van a un repositorio público. Repo privado con acceso para los
evaluadores, PDFs fuera del repo (`data/` ignorado, con script de descarga desde el
Drive compartido), ground truth en el repo privado. Esto se dice en el README.

## E. Reproducibilidad: decir qué se garantiza y qué no

Los modelos no son determinísticos y la API ya no acepta temperatura. Lo que sí:
modelo, versión de prompt y `effort` fijados; salida estructurada validada; cuadre
aritmético que fuerza re-extracción cuando falla; caché de respuestas por hash de entrada
para los 9 documentos de desarrollo, incluida en el repo privado, para que una corrida
sobre ellos sea idéntica. Para documentos nuevos se promete estabilidad a nivel de campo,
no igualdad byte a byte, y el reporte incluye la varianza de dos corridas. Esto se escribe
en el README para que no parezca una omisión.

## F. Entregables de proceso que aún no tienen diseño

- **Harness**: `CLAUDE.md` con instrucciones del repo, `.claude/` con skills o agentes
  usados, `docs/harness.md` describiendo herramientas (Claude Code, conector de Drive,
  navegador integrado), configuración y cómo se trabajó. Esta conversación de diseño se
  exporta y se guarda como artefacto.
- **Prompts y artefactos**: carpeta `prompts/` versionada con changelog; los artefactos
  intermedios (análisis, borradores) en `docs/artefactos/`.
- **Decisiones de diseño**: carpeta `docs/adr/` con una ADR por decisión ya tomada:
  Mastra sobre SDK directo y LangGraph, Jev, Baileys sobre Cloud API, Express 5 sobre
  Hono, pg-boss sobre Supabase Queues, Drizzle sobre Prisma, Evalite, Cloud Run. Hoy
  están repartidas en los documentos; una ADR por decisión es lo que esperan.
- **Spec**: `docs/00-spec.md` con qué se entendió, supuestos y alcance. Se escribe antes
  del código, en una página, a partir de lo ya documentado. El punto de partida para
  quien construye es `docs/00-brief.md` (índice en `docs/README.md`).
- **Git desde el primer commit**, con mensajes que cuenten la historia: el historial es
  parte de la evidencia del proceso.

## G. Alcance realista: líneas de corte

El diseño es grande para 72 horas. Se define ahora qué es obligatorio y dónde se corta:

| Nivel | Contenido |
|---|---|
| Obligatorio | contrato de extracción, CLI de evaluación, extracción en dos pasadas con verificación, perfil y motor de políticas con política base, aclaración por CLI, ground truth y evals en CI, README, spec, ADRs, prompts, harness, pipeline de CI, plan de deploy |
| Debería | workflow en Mastra con suspend/resume, esquema Supabase con RLS y tests de aislamiento, pg-boss, Jev con fallback, 6 a 8 escenarios, backoffice con solicitudes, detalle y aclaraciones |
| Si alcanza | Baileys y Resend reales, resto del backoffice (revisión, políticas con simulador, outcomes, operación), Langfuse, catálogo completo de escenarios, calibración nocturna |

Baileys se muestra con un video corto o capturas si no se puede probar en vivo durante la
evaluación.

## H. Spikes de una hora antes del código de verdad

1. Mastra con `file` part PDF hacia Anthropic: ¿llega como `document`? ¿`cacheControl`
   reduce tokens en la segunda pasada? ¿`structuredOutput` usa modo nativo? Si falla, el
   step llama al SDK de Anthropic directo.
2. Compatibilidad de versiones: Zod 4, `@anthropic-ai/sdk` (`zodOutputFormat`), Mastra
   (`StandardJSONSchemaV1`), Evalite. Fijar versiones que convivan.
3. Jev: acceso y una llamada real con `choice` tipado.
4. Mastra suspend/resume entre procesos distintos (API y worker) con PostgresStore.

## I. Detalles técnicos pequeños que si faltan duelen

- Normalización de fechas mexicanas y mixtas ("del 13 de June al 11 de septiembre").
- Coincidencia difusa de razón social (acentos, "SA de CV" vs "S.A. DE C.V.").
- Validadores de CLABE (dígito verificador) y RFC (estructura y homoclave).
- Deduplicación de movimientos en el solape entre bloques de páginas.
- Degradación elegante: si un bloque falla tras reintentos, salida parcial con banderas,
  nunca un crash sobre un documento desconocido.
- Reporte legible por documento (Markdown) además del JSON, para que el evaluador
  entienda la decisión sin leer JSON.
- Idioma: código e identificadores en inglés, documentación y README en español con
  resumen en inglés (el enunciado es bilingüe).
- Estimación de costo por documento y por corrida de evaluación en el README (orden de
  magnitud: menos de un dólar por documento, unos cinco por los diez de evaluación).

## J. Lo que no se va a hacer y se declara

Buró y SAT reales, Cloud API de WhatsApp, autoscaling por cola, sharding por tenant,
cifrado de columna, pentest. Todo está diseñado y priorizado en los documentos 02 y 05.

## Cambios durante la implementación

- **Dos llaves en `standalone`** (ADR 0011, 2026-11-04). La sección A dice que el camino
  sin infraestructura solo necesita `ANTHROPIC_API_KEY`; desde que la extracción corre
  en `gemini-3.8-flash`, necesita también `GOOGLE_GENERATIVE_AI_API_KEY`. El costo por
  documento de la sección I baja a unos USD 0.20 a 0.35.
- **C y E, ground truth y caché** (ADR 0012, 2026-11-04). C proponía partir de la
  extracción del sistema; la ADR 0001 lo prohíbe y el ground truth sale de un parser
  determinístico de la capa de texto validado por la aritmética del banco (3 a 4 horas,
  como se estimó). E decía que la caché de los 9 documentos iría "en el repo privado"; la
  regla de que nada de `data/` se versiona manda: la caché queda en `data/llm-cache/` y CI
  la restaura desde almacenamiento privado. Solo se versiona la de los PDFs sintéticos.
- **A e I, comando de evaluación** (ADR 0015, 2026-11-05):

  ```
  pnpm run evaluate <carpeta|pdf>... [--out] [--request k=v,...|archivo.json] [--answers] [--as-of] [--policy] [--interactive] [--cache read] [--force]
  ```

  - **Salida por documento**: el JSON de la extracción, el `ApplicationResult` y un Markdown;
    además `summary.md` y la plantilla de respuestas.
  - **Consola**: solo estados, conteos y costo.
  - **Sin monto**: la salida es la línea máxima y el perfil, como pedía A.
  - **Llaves**: la extracción sigue necesitando las dos del cambio anterior. Sin
    `TYPESAFE_API_KEY`, los movimientos los clasifica Haiku y el reporte lo dice.
  - **`--cache read`**: corre sin ninguna llamada con lo que haya en `data/llm-cache`.
- **A, documentos redactados** (ADR 0015 §20 a §22, 2026-11-05):
  - **El problema**: sin registro de proveedores ni identidad legible, la política base nunca
    pasa la compuerta de identidad.
  - **La salida**: para evaluar sin ese bloqueo está
    `--policy policies/examples/standalone-evaluation.v1.json`, que solo deja pasar la identidad
    que no se puede comparar. `evaluate` la sugiere cuando hace falta.
  - **El resumen**: muestra la línea máxima junto al estado.
- **H.4 y el modo full** (ADR 0018, 2026-11-05): el suspend/resume entre procesos que probó el spike 4
  ya es el camino real del worker (`PostgresStore`, otra instancia de Mastra al reanudar). En
  local, `docker compose up -d` y `pnpm db:migrate`; los escenarios full no necesitan llaves.
