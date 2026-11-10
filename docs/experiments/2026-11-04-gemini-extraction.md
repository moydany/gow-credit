# Experimento: extracción con `gemini-3.8-flash` en BBVA y Nu

- Fecha: 2026-11-04
- Autorización: el dueño de los datos pidió explícitamente mandar estos dos PDFs a Google
  (sin `--allow-third-party` el CLI se niega).
- Mismos prompts, esquema (`extraction_chunk.v2`), `effort` (traducido a `thinkingLevel`) y
  verificación que Opus. El clasificador siguió en Haiku. Referencia: Opus de la corrida 2.
- Comando: `pnpm extract <pdf> --model gemini-3.8-flash --allow-third-party --out data/out/extractions-gemini`.

## Resultado

| | Opus 5.5 | Gemini 3.8 Flash | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|---|
| BBVA movimientos iguales a Opus | 161 | 161/161, 0 de más | 161/161, 0 de más | 161/161, 0 de más |
| BBVA relecturas | 0 | 0 | 0 | 4 |
| BBVA encabezado / CFDI iguales | — | 22/22 / 19/19 | 21/22 / 17/19 | 21/22 / 17/19 |
| BBVA costo · tiempo | USD 1.00 · 101 s | USD 0.19 · 109 s | USD 0.50 · 64 s | USD 0.05 · 196 s |
| Nu movimientos | 332 | 332/332, 0 de más | 333 (1 inventado) | — |
| Nu cuadre | exacto | exacto | no cuadra | — |
| Nu costo · tiempo | USD 1.57 · 164 s | USD 0.32 · 157 s | USD 0.84 · 105 s | — |

En Nu, Gemini marcó los mismos 136 traspasos internos y cuadró con la misma fórmula
consolidada que Opus. Su única diferencia de encabezado fue llenar `holder_type:
individual` donde Opus lo dejó vacío; es coherente con el régimen 616 del CFDI.

## Cuidado al leer los costos

- El precio de `gemini-3.8-flash` en `models.ts` viene de agregadores y es de introducción;
  no está verificado contra la página oficial de Google y subiría al doble en 2027.
- Gemini no reportó lecturas de caché implícita (`cache_read 0`), pero cuenta muchos menos
  tokens de entrada por el PDF que Anthropic (BBVA: unos 42K en 4 llamadas contra unos 54K
  por llamada en Opus). La comparación de costo depende de esa tokenización.
- No incluye el clasificador (Haiku, centavos).

## Lectura

En estos dos documentos, Gemini 3.8 Flash empata a Opus en todo lo que la verificación mide,
incluido Nu (sin saldo por fila), donde Sonnet inventó una fila; cuesta unas 5 veces menos y
tarda lo mismo. Es el candidato más fuerte a modelo de extracción por costo.

## Decisión

Ninguna todavía. Cambiar el modelo por defecto exige (1) evals de la fase 3 sobre los 9
documentos contra ground truth, no contra Opus; (2) verificar el precio oficial; y (3) que el
dueño de los datos y GOW acepten mandar estados de cuenta a Google (LFPDPPP, `docs/05`). Si
las tres pasan, el cambio queda en el registro de decisiones.
