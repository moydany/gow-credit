# Spike 1. PDF, caché y salida estructurada a través de Mastra

- Fecha: 2026-11-04
- Código: `spikes/src/spike1-wire-capture.ts` (sin red), `spikes/src/spike1-live-cache.ts` (con red)
- Versiones: `@mastra/core` 1.81.0, `@ai-sdk/anthropic` 4.0.94, `@anthropic-ai/sdk` 1.3.0, `zod` 4.6.7
- **Veredicto: Mastra se queda para la extracción; no se usa la salida de emergencia.**
  La caché funciona solo si todas las llamadas sobre el documento usan **el mismo esquema
  de salida**: `output_config.format` forma parte del prefijo cacheado (medido en vivo,
  ver abajo y ADR 0005).

## Qué probé

Las tres preguntas de `07` H.1, viendo el request HTTP real y no la documentación. El
proveedor de AI SDK se apuntó a un servidor local (`spikes/src/lib/capture-server.ts`) que
imita `POST /v1/messages`, guarda headers y cuerpo y responde con JSON enlatado en modo
normal o SSE. El PDF es sintético (`lib/synthetic-pdf.ts`), así que ningún dato de `data/`
salió de `data/`.

1. `agent.generate()` dos veces con el mismo PDF como parte `file` con
   `providerOptions.anthropic.cacheControl`, cada una con un esquema Zod distinto (resumen,
   luego movimientos).
2. El mismo agente sin opciones (`structuredOutputMode` por defecto).
3. `agent.stream()` con salida estructurada, que es como deben correr las pasadas largas.
4. Lo mismo con el SDK de Anthropic directo (`client.beta.messages.parse` +
   `zodOutputFormat`), que es la salida de emergencia, para comparar.

## Qué pasó

| Pregunta | Resultado por Mastra |
|---|---|
| ¿El PDF llega como `document`? | Sí. `{"type":"document","source":{"type":"base64","media_type":"application/pdf"}}` |
| ¿Llega `cache_control` al bloque? | Sí, `{"type":"ephemeral"}` en el bloque `document` |
| ¿Se reutiliza el prefijo entre pasadas? | Sí: `system` + bloque `document` + `thinking` son idénticos byte a byte entre la pasada 1 y la 2, que es la condición para que la caché pegue |
| ¿Salida estructurada nativa? | Sí. Va como `output_config.format` (`json_schema`), sin la herramienta `json` ni `tool_choice` forzado, también en modo `auto` |
| `thinking`, `effort`, `fallbacks` | `thinking: {type: "adaptive"}`, `output_config.effort`, `fallbacks: "default"` llegan tal cual; el header `server-side-fallback-2026-07-01` se agrega solo |
| `temperature` | No se manda |
| Uso de tokens | `result.usage` trae `cachedInputTokens` y `cacheCreationInputTokens`; `providerMetadata.anthropic.usage` trae el objeto crudo de la API. Suficiente para costo por llamada |
| Streaming | `agent.stream()` manda `stream: true`, `await stream.object` valida contra el esquema y `await stream.usage` trae la caché |

Diferencias con el SDK directo y cosas a cuidar:

- **`max_tokens` por defecto = 128,000 sin streaming.** Si no se pasa
  `modelSettings.maxOutputTokens`, AI SDK manda el máximo del modelo en una llamada no
  streaming, con riesgo de timeout HTTP. Regla: siempre `maxOutputTokens` explícito, y
  `agent.stream()` para las pasadas de movimientos.
- **Versión de API**: AI SDK manda `anthropic-version: 2023-06-01` y el beta obsoleto
  `pdfs-2024-09-25`; el SDK directo manda `2026-10-21`. Las funciones que usamos están
  detrás de betas o son GA, así que funciona igual. Se registra por si una función nueva
  exige la versión nueva.
- **Conversión de Zod a JSON Schema**: Mastra mueve restricciones no soportadas
  (`.min(1)`) a `description` y valida del lado del cliente; `zodOutputFormat` genera
  `$defs` para strings con descripción. Ambos esquemas son válidos y conservan `null`,
  enums y `required`.
- El modelo se pasa como instancia de `createAnthropic()` y no como el string del router
  de Mastra (`'anthropic/claude-opus-5-5'`). Así controlamos la versión del proveedor, el
  `baseURL` (para tests) y que no herede un `ANTHROPIC_BASE_URL` ajeno.
- La API Files y los bloques por página (`02` 4b) no se probaron aquí; entran cuando un
  documento pase del umbral de páginas.

### Parte en vivo (2026-11-04)

`pnpm -F @gow/spikes spike1:live` y `spike1-cache-variants.ts` sobre
`EDC_03_Fondeadora_2025-10.pdf` (4 páginas, unos 11K tokens de documento), con
`claude-opus-5-5`:

| Corrida | Pasada 1 | Pasada 2 |
|---|---|---|
| Mastra, **esquemas distintos** por pasada | escribe 11,080 en caché, USD 0.057 | **vuelve a escribir** 10,938, USD 0.056 |
| Mastra, **mismo esquema**, otra instrucción | escribe 11,027, USD 0.056 | **lee 11,027 de caché**, USD 0.003 |
| SDK directo, esquemas distintos | escribe 10,964 | vuelve a escribir 10,934 |

- La diferencia entre las dos escrituras de la primera corrida (142 tokens) coincide con la
  diferencia de tamaño entre los dos esquemas: el esquema de `output_config.format` entra
  al prefijo antes del documento.
- El SDK directo se comporta igual que Mastra: es la API, no la capa de Mastra. La salida
  de emergencia no lo resolvería.
- Con el mismo esquema, la segunda pasada cuesta 18 veces menos. En un documento de 31
  páginas (unos 80K tokens) son unos USD 0.02 por bloque leído contra unos USD 0.40 por
  bloque reescrito.
- La llave de este entorno no está ligada a un workspace; la API exige el header
  `anthropic-workspace-id`. Se agregó `ANTHROPIC_WORKSPACE_ID` opcional: si existe, se
  manda el header.
- Costo total de los spikes en vivo: USD 0.28.

## Decisión

1. La extracción corre como agente de Mastra con `structuredOutput` nativo:
   `structuredOutputMode: 'outputFormat'`, `errorStrategy: 'strict'` en CI y evals.
2. Opciones fijas por llamada: `thinking: {type: 'adaptive'}`, `effort` explícito (el
   default de Opus 5.5 es `medium`), `fallbacks: 'default'`, `maxOutputTokens` explícito y
   `cacheControl` en el bloque del documento.
3. Las pasadas de movimientos van por `agent.stream()`.
4. **Un solo esquema de salida por documento** para todas las llamadas de extracción
   (resumen, bloques de movimientos, reintentos por página): cada pasada llena su parte y
   deja la otra vacía. ADR 0005.
5. La salida de emergencia queda documentada y probada en el cable, pero no hace falta.
