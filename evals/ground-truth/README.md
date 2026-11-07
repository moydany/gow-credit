# Ground truth de los 9 documentos de desarrollo

Los JSON del ground truth **no viven aquí**: contienen movimientos reales, así que se
escriben en `data/ground-truth/<documento>.json`, que git ignora. Aquí se
versiona solo `manifest.json`, sin datos personales: hash del PDF y del ground truth,
conteos, comprobaciones aritméticas y si el documento entra al umbral de CI.

## Cómo se construyó

Nada sale del modelo que se mide.

| Parte | Fuente | Procedencia |
|---|---|---|
| Movimientos (todos, no una muestra) | capa de texto con coordenadas (pdfjs; HSBC decodificado de EBCDIC) y un parser determinístico por banco (`evals/src/ground-truth/banks.ts`) | `text_layer` |
| Árbitro de los movimientos | saldo corrido fila por fila, cuadre global, totales y conteos impresos por el banco | `bank_arithmetic` |
| Encabezado, resumen y CFDI | leídos a mano de la capa de texto (`data/ground-truth/facts/`) y comprobados por búsqueda literal en el PDF | `text_layer` |
| CFDI de HSBC | capa decodificada y contrastada con la imagen de la página 7 | `visual_review` |
| Muestra revisada por una persona | herramienta lista, revisión pendiente: ver abajo | `human_review` |

Un documento entra al umbral (`gated: true`) solo si todos sus periodos cierran: saldo
corrido (cuando el banco lo imprime), cuadre global y totales. Los 9 cierran.

## Muestra revisada por una persona

El ground truth no sale del modelo, pero sí del parser: una persona coteja una muestra contra el
PDF para cerrar ese hueco.

1. `pnpm -F @gow/evals gt:review sample` elige 8 filas por documento: al menos una por página
   con movimientos y el resto al azar, con semilla fija. Las escribe en
   `data/ground-truth/review/`, una hoja `<doc>.md` por documento, más `review.json`.
2. Quien revisa abre cada PDF en la página indicada y marca `ok: true` o `false` en
   `review.json`.
3. `pnpm -F @gow/evals gt:review record --reviewer <iniciales>` escribe
   `evals/ground-truth/human-review.json`, que se versiona y no lleva valores. Falla si alguna
   fila está mal, o si el ground truth cambió desde la muestra.

Estado: **pendiente**. La herramienta existe y la muestra (72 filas) se genera, pero todavía
nadie la ha revisado.

Reconstruir: `pnpm -F @gow/evals gt:build` (necesita `data/dev/` y `data/ground-truth/facts/`).

## Convenciones

- **Descripción y referencia.** `description` es el concepto con todas sus líneas unidas;
  `reference` solo cuando el banco la imprime en columna propia (Inbursa REFERENCIA,
  Santander FOLIO, Mercado Pago ID de la operación, HSBC Referencia/Serial). En BBVA no hay
  columna limpia y todo va en `description`. La eval compara `description + reference`
  como un solo texto, así que dónde ponga el modelo la referencia no cuenta.
- `description_head` es la primera línea del concepto: lo mínimo que una lectura correcta
  debe contener.
- **Datos redactados.** Titular, RFC, número de cuenta y CLABE vienen redactados en los
  PDFs: su valor correcto es `null`, y un valor del modelo ahí cuenta como invención.
- Montos positivos con `type`; `balance` es el saldo impreso en la fila (BBVA: saldo de
  operación, solo al cierre del día; Nu: no imprime).
- `internal_transfer` solo en Nu (cajitas y dinero de respaldo).
- Mercado Pago: un periodo, como está impreso. Santander y Banamex: la cuenta de
  inversión sin movimientos también es una cuenta.
- CFDI: sin sellos ni cadena original. Campos que el comprobante no imprime quedan en
  `null`; los de identidad del receptor se evalúan como "debe ser null", el resto no se
  evalúa cuando el ground truth es `null`.
