# Experimento: extracción con `claude-haiku-5-5` en BBVA

- Fecha: 2026-11-04
- Pregunta: ¿cuánto se pierde si la extracción corre con Haiku en lugar de Opus?
- Documento: `EDC_05_BBVA_2025-09.pdf` (17 páginas, 161 movimientos, el banco imprime cuántos
  abonos y cargos hay, saldo solo al cierre de cada día, un CFDI).
- Referencia: la extracción con `claude-opus-5-5` de la corrida 2, que cuadra exacto y
  coincide con los conteos impresos (26 + 135). No es ground truth: eso llega en la fase 3.
- Comando: `pnpm extract data/dev/EDC_05_BBVA_2025-09.pdf --model claude-haiku-5-5 --out data/out/extractions-haiku`
  y `node scripts/compare-extractions.mjs <opus.json> <haiku.json>`.
- Mismos prompts (`extract_system.v1`, `extract_summary.v2`, `extract_transactions.v2`,
  `extract_retry_page.v1`) y mismos `effort` (resumen medium, bloques low, relectura high).

## Resultado

| | Opus 5.5 | Haiku 5.5 |
|---|---|---|
| Movimientos | 161 | 161 |
| Coinciden en fecha, monto y sentido | — | 161/161, ninguno de más |
| Saldo impreso igual | — | 28/28 |
| Página citada igual | — | 161/161 |
| Cuadre global y saldo corrido | exacto, 0 rupturas | exacto, 0 rupturas |
| Rupturas en la primera lectura | 0 | 5 páginas; se releyeron 4 (tope) y quedó en 0 |
| Encabezado y resumen | — | 21/22 iguales (`account_type` quedó vacío) |
| CFDI | — | 17/19 iguales (`kind` como `other` en lugar de `income`; Haiku sí leyó la fecha de emisión que el código de Opus no supo interpretar, ya corregido) |
| Descripciones idénticas | — | 0/161 (ver abajo) |
| Llamadas | 5 | 9 |
| Tokens de salida | 34,232 | 80,818 |
| Costo | USD 1.0018 | **USD 0.0515** (19 veces menos) |
| Duración | 101 s | 196 s |

## Lectura

- **Con la verificación aritmética, Haiku llega al mismo libro de movimientos que Opus por 5 %
  del costo.** Por sí solo no: su primera lectura rompió el saldo corrido en 5 páginas y el
  reintento dirigido lo corrigió. Es el argumento de `04` §7 medido: el cuadre atrapa al modelo
  más débil y relee solo donde falló.
- El tope de 4 páginas releídas por documento estuvo a punto de no alcanzar. En un documento
  más largo o sin saldo por fila (Nu), Haiku dejaría errores sin localizar.
- Las descripciones difieren por una **ambigüedad del prompt**, no por lectura: BBVA imprime
  código, descripción y referencia en columnas. Opus dejó todo en `description` y `reference`
  vacía; Haiku separó la referencia, que es lo que pide `extract_transactions`. El ground truth
  de la fase 3 fija la convención y la eval de descripciones debe ser difusa.
- Haiku clasificó el CFDI de comisiones como `other`. Error de lectura del modelo; los cruces
  no lo atrapan porque `kind` no tiene aritmética.

## Decisión

Ninguna todavía: **un documento no basta para cambiar el modelo por defecto** (`CLAUDE.md`:
cambio de modelo solo con evals sobre el umbral). Se deja `--model` en `pnpm extract` y en la
fase 3 los evals corren Opus y Haiku sobre los 9 documentos contra ground truth, con invención
y omisión por separado. Opciones a medir entonces:

1. Haiku en todo, con más páginas releídas por documento.
2. Haiku en la primera lectura y Opus solo en las relecturas (cascada), comparada contra la
   alternativa más simple: Opus con `effort` más bajo (ADR 0003).
3. Opus en todo (hoy, alrededor de USD 1 por documento).
