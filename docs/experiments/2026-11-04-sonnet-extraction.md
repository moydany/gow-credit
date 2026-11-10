# Experimento: extracción con `claude-sonnet-5-5` en BBVA y Nu

- Fecha: 2026-11-04
- Pregunta: ¿Sonnet 5.5, a la mitad del precio de Opus, extrae igual?
- Documentos: BBVA (161 movimientos, saldo al cierre de cada día, conteos impresos) para
  comparar los tres modelos, y Nu (32 páginas, **sin saldo por fila**, traspasos con cajitas)
  como el caso más difícil para un modelo más barato: el cuadre detecta un error pero no
  puede ubicar la página.
- Referencia: Opus de la corrida 2 (ambos cuadran exacto; no es ground truth).
- Mismos prompts y `effort` que Opus; Sonnet con `fallbacks: "default"` (Haiku no lo tiene).

## Resultado

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| **BBVA** movimientos iguales a Opus | 161 | 161/161, ninguno de más | 161/161, ninguno de más |
| BBVA cuadre | exacto | exacto | exacto |
| BBVA relecturas necesarias | 0 | 0 | 4 (5 páginas rotas en la primera lectura) |
| BBVA costo / duración | USD 1.00 / 101 s | USD 0.50 / 64 s | USD 0.05 / 196 s |
| **Nu** movimientos | 332 | 333: los 332 de Opus y **un cargo de 500.00 duplicado** en el cambio de página 13 a 14 | — |
| Nu cuadre | exacto (consolidado) | **no cuadra** (diferencia 500 sobre la fórmula consolidada) | — |
| Nu traspasos internos marcados | 136 | 136, mismos montos | — |
| Nu costo / duración | USD 1.57 / 164 s | USD 0.84 / 105 s | — |

Otras diferencias contra Opus: en BBVA Sonnet llenó `holder_type` donde Opus lo dejó vacío,
y tanto Sonnet como Haiku clasificaron el CFDI de comisiones como `other` en lugar de
`income`; en Nu, 22/22 campos de encabezado iguales.

## Lectura

- **Sonnet iguala a Opus cuando hay saldo por fila**, por la mitad del costo y más rápido, sin
  necesitar relecturas (Haiku sí las necesitó).
- **En Nu Sonnet inventó una fila** (duplicó un cargo en el cambio de página). La verificación
  lo detectó: el documento quedó `not_reconciled` y los 333 movimientos `unverified`, así que
  no habría entrado a una decisión (`04` §5). Pero no lo corrigió: sin saldo por fila no hay
  página que releer.
- Opus no ha inventado ni omitido filas en ninguno de los 9 documentos de desarrollo según el
  cuadre; eso es lo que se paga con el doble de precio.

## Mejora que esto sugiere (no implementada)

Localizar por residuo cuando no hay saldo corrido: si la mejor fórmula de cuadre deja un
residuo igual al monto de una o pocas filas (aquí 500.00), releer las páginas de esas filas.
Es genérica, barata y beneficia a cualquier modelo en documentos como Nu.

## Decisión

Ninguna todavía: el modelo por defecto sigue siendo Opus hasta los evals de la fase 3, que
corren los tres modelos contra ground truth en los 9 documentos.
