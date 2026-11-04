<!--
prompt: extract_transactions
version: 2
changes: agrega internal_transfer (traspasos con apartados o cajitas de la misma cuenta)
model: claude-opus-5-5
used_by: packages/extraction, pasada 2 (un bloque de páginas por llamada)
variables: first_page, last_page, accounts
-->
Pasada 2: llena `transactions` con todos los movimientos que aparecen físicamente en las
páginas {{first_page}} a {{last_page}}, en el orden en que están impresos, y deja `summary` en
null. Los de otras páginas se extraen en otras llamadas.

Cuentas y periodos del documento (usa estos `account_ref` y `period_ref`):
{{accounts}}

- Una fila de movimiento es una operación con monto. No incluyas renglones que solo repiten
  un saldo o un total (saldo anterior, saldo final, totales del periodo, subtotales por día).
- Si la descripción ocupa varias líneas, únelas con un espacio en `description`.
- `reference`: referencia, folio o clave de rastreo cuando el banco la imprime en su propia
  columna; si no, vacía.
- `settlement_date`: solo si el banco imprime una fecha de liquidación aparte de la de
  operación; si no, vacía.
- `balance`: el saldo impreso en esa fila después del movimiento; vacío si esa fila no lo trae.
- `internal_transfer`: true solo para traspasos entre la cuenta y sus propios apartados,
  cajitas o reservas que el mismo estado de cuenta muestra (por ejemplo "Depósito en Cajita",
  "Retiro de apartado"). Un traspaso a otra cuenta, aunque sea del mismo titular, es false.
- Si una tabla sigue de una página a otra, cada fila pertenece a la página donde está
  impresa.
