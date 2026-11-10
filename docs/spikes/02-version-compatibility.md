# Spike 2. Compatibilidad de versiones

- Fecha: 2026-11-04
- Código: `spikes/src/spike2-versions.ts`, `spikes/src/spike2.eval.ts`
- **Veredicto: conviven. Versiones fijadas abajo; una sola concesión de tipos en los
  paquetes que componen workflows de Mastra.**

## Qué probé

Que Zod 4, `@anthropic-ai/sdk` (`zodOutputFormat`), Mastra (Standard Schema) y Evalite
funcionen juntos en runtime, no solo en el typecheck:

1. `z.toJSONSchema` nativo (para `docs/schema/`) con `null`, enums y arrays anidados.
2. Que un esquema Zod 4 exponga `~standard` con `jsonSchema` (lo que consume Mastra).
3. `zodOutputFormat` del SDK con Zod 4: forma `json_schema` y parseo de ida y vuelta.
4. `createTool`, `createStep` y `createWorkflow` de Mastra con esquemas Zod 4, y una
   corrida en memoria.
5. Que Mastra rechace en runtime una entrada que no cumple el esquema.
6. Un eval de Evalite con scorer determinístico, junto al Vitest del monorepo.

## Qué pasó

Todo pasó. Detalles que importan:

- **TypeScript 6.0.3, no 7.** TS 7.0.2 (la versión nativa) es `latest`, pero
  `typescript-eslint` 8.72 exige `typescript <6.1.0`. Se fija 6.0.3 y se revisa cuando
  `typescript-eslint` soporte 7.
- **Vitest 4.1.12, no 5.1.** Evalite 0.19.0 depende de `@vitest/runner` y `@vitest/utils`
  `^4` e importa `vitest` sin declararlo. Con Vitest 5 habría dos runners distintos. Con 4.1
  hay uno solo y `evalite run` funciona (2/2 evals al 100 %).
- **Evalite 0.19.0 (estable), no 1.0.0-beta.16.** La beta no se ha movido desde febrero;
  la estable cubre lo que necesitamos. Trae `better-sqlite3` nativo, que se compila en la
  instalación (permitido en `pnpm-workspace.yaml`).
- **Mastra lanza en lugar de devolver `failed`** cuando la entrada de un workflow no cumple
  el esquema: `MastraError` con id `WORKFLOW_SCHEMA_VALIDATION_FAILED`. El código que llama
  a `run.start()` debe atraparlo y convertirlo en `failed` con razón.
- **`exactOptionalPropertyTypes` choca con los tipos de Mastra**: un sub-workflow no se
  puede usar como step porque `Workflow.description` es `string | undefined` y
  `Step.description` es `string`. Tampoco se arregla pasando `description`. Además, la
  condición de `.dountil()` tras un sub-workflow llega como `any`, y tiparla a mano hace
  que TypeScript elija una sobrecarga que rechaza el sub-workflow. Ver la decisión.
- Algunos paquetes (`@anthropic-ai/sdk`, `evalite`) no exportan `package.json`; el script
  de versiones lo busca por ruta.

## Versiones fijadas

Regla de cadena de suministro: `minimumReleaseAge: 4320` (3 días) en `pnpm-workspace.yaml`,
versiones exactas sin `^` y lockfile en git.

| Paquete | Versión | Nota |
|---|---|---|
| Node | 24.17 (`engines >=24`, `.nvmrc`) | `process.loadEnvFile` nativo |
| pnpm | 11.20.0 (`packageManager`) | |
| typescript | 6.0.3 | 7.x bloqueado por typescript-eslint |
| zod | 4.6.7 | |
| @anthropic-ai/sdk | 1.3.0 | 1.4.0 tiene menos de 3 días |
| @mastra/core | 1.81.0 | 1.82.0 tiene menos de 3 días |
| @mastra/libsql | 1.28.0 | |
| @mastra/pg | 1.34.0 | requiere core >=1.80 |
| @ai-sdk/anthropic | 4.0.94 | AI SDK v7 (provider 4.0.x) |
| evalite | 0.19.0 | |
| vitest | 4.1.12 | alineado con Evalite |
| eslint / typescript-eslint | 10.13.0 / 8.72.1 | |
| @typesafe-ai/sdk | 0.7.0 | ver spike 3 |

## Decisión

- Se fijan las versiones de la tabla.
- `exactOptionalPropertyTypes` se mantiene en `tsconfig.base.json` (contratos, decisión,
  extracción, API) y se apaga solo en los paquetes que componen workflows de Mastra
  (`spikes`, y `packages/mastra` cuando exista), con un comentario en su `tsconfig.json`.
- La condición de un loop tras un sub-workflow se escribe con cast local al esquema Zod
  conocido, no con un parámetro tipado.
