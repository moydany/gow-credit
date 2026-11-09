# Spike 4. Suspend/resume de Mastra entre procesos

- Fecha: 2026-11-04
- Código: `spikes/src/spike4-suspend-resume.ts`
- Versiones: `@mastra/core` 1.81.0, `@mastra/libsql` 1.28.0, `@mastra/pg` 1.34.0, Postgres 17
  (contenedor local desechable)
- **Veredicto: funciona con PostgresStore y con LibSQLStore. Se encontró un detalle del
  loop de aclaración que obliga a una guarda en `askOwner`.**

## Qué probé

Un workflow con la forma de `processApplication` (`02` 3): `extract → decide →
dountil(clarificationLoop) → finalize`, con `askOwner` (con `suspendSchema` y
`resumeSchema`) dentro de un sub-workflow. Dos solicitudes:

- `ambiguous`: un depósito de 50,000 sin clasificar; debe suspender con la pregunta.
- `clear`: nada que preguntar; no debe suspender.

El proceso A (`start`) arranca ambas, guarda el `runId` y termina. El proceso B
(`resume`), otro PID, construye una instancia nueva de Mastra sobre el mismo storage, lee
el snapshot, reanuda con la respuesta "es pago de cliente" y espera `qualified`. Cada step
anota su PID para demostrar que el run cruzó de proceso.

Se corrió dos veces: con `LibSQLStore` sobre un archivo (camino de `pnpm run evaluate
--answers`) y con `PostgresStore` y `schemaName: 'mastra'` (modo full).

## Qué pasó

| | libSQL | Postgres |
|---|---|---|
| `ambiguous` en el proceso A | `suspended` en `["clarification-loop", "ask-owner"]` con el `suspendPayload` | igual |
| Snapshot leído en el proceso B antes de reanudar | `suspended` | `suspended` |
| `resume` en el proceso B | `success`, `qualified`, `rounds: 1` | igual |
| PIDs en la traza | A, A, B, B, B | A, A, B, B, B |
| `clear` | `success` sin suspender | igual |
| Tablas | archivo local | las 39 tablas de Mastra en el esquema `mastra`, ninguna en `public` |

Detalles:

- **`.dountil()` es do-until: corre el cuerpo al menos una vez.** En el caso `clear`,
  `re-decide` corrió aunque el estado ya era final. Sin una guarda, `askOwner` habría
  suspendido y preguntado al proveedor sin motivo. El spike pasa porque `askOwner` regresa
  sin suspender cuando `status !== 'needs_clarification'`.
- La ruta del step suspendido es un arreglo (`["clarification-loop", "ask-owner"]`) y
  `run.resume({ step })` la acepta tal cual. Se guarda `result.suspended[0]` junto al
  `runId` para reanudar.
- El `suspendPayload` viene indexado por el primer nivel (`{"clarification-loop": {...}}`).
  Al leer las preguntas hay que saberlo.
- `schemaName: 'mastra'` funciona: el esquema de negocio (Drizzle con RLS) queda limpio,
  como pide `02` 1.

## Decisión

1. Se confirma el diseño: el snapshot en storage es la fuente de verdad del run
   suspendido, y el worker o la CLI reanudan por `runId` en otro proceso.
2. `askOwner` lleva siempre la guarda "si no hay nada que aclarar, regresa sin suspender".
   Alternativa equivalente: un `.branch()` antes del loop. Se anota en "Cambios durante la
   implementación" de `02`.
3. En `standalone`, el estado de Mastra vive en un archivo libSQL dentro de la carpeta de
   salida de `evaluate`. Así `--answers` reanuda en otra invocación del comando.
4. Con cada suspensión se guardan el `runId` y la ruta del step suspendido (en la fila de
   `clarifications` en modo full, o en el JSON de salida en `standalone`).
