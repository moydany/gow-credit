# Spikes de la fase 0

Los cuatro spikes de `docs/07` sección H. El código está en `spikes/src/` y se corre con
`pnpm -F @gow/spikes <script>`. Ninguno usa los PDFs reales salvo la parte en vivo del
spike 1, que solo los manda a la API de Anthropic.

| # | Pregunta | Veredicto | Nota |
|---|---|---|---|
| 1 | ¿PDF como `document`, `cacheControl` y salida estructurada nativa a través de Mastra? | Sí; Mastra se queda. La caché pega solo con **el mismo esquema de salida** en todas las pasadas (medido en vivo) | [01](01-mastra-pdf-cache-structured-output.md) |
| 2 | ¿Conviven Zod 4, el SDK de Anthropic, Mastra y Evalite? | Sí, con TS 6.0.3 y Vitest 4.1; `exactOptionalPropertyTypes` se apaga solo en paquetes de Mastra | [02](02-version-compatibility.md) |
| 3 | ¿Jev con `choice` tipado? | Tipado y cable verificados; sin `TYPESAFE_API_KEY` el camino es el fallback a Haiku | [03](03-jev.md) |
| 4 | ¿Suspend/resume entre procesos con PostgresStore? | Sí, con Postgres y con libSQL. `askOwner` necesita una guarda porque `.dountil` corre el cuerpo al menos una vez | [04](04-suspend-resume-across-processes.md) |

Costo de los spikes en API: USD 0.28 (parte en vivo del spike 1). El spike 3 sigue sin
llamada real a Jev por falta de `TYPESAFE_API_KEY`.
