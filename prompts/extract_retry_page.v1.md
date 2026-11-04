<!--
prompt: extract_retry_page
version: 1
model: claude-opus-5-5
used_by: packages/extraction, reintento dirigido y doble lectura de una página
variables: page, accounts, problem
-->
Relectura: llena `transactions` con todos los movimientos de la página {{page}}, y deja
`summary` en null. Una lectura anterior de esta página no cuadró con la aritmética del estado
de cuenta: {{problem}}

Lee la página con cuidado, fila por fila, comparando cada monto con el saldo impreso. Revisa
en especial filas omitidas, filas duplicadas, montos con dígitos cambiados y cargos leídos como
abonos. No ajustes ninguna cifra para que cuadre: transcribe lo que está impreso.

Cuentas y periodos del documento (usa estos `account_ref` y `period_ref`):
{{accounts}}

Mismas reglas de la pasada de movimientos: sin renglones de saldo o totales, descripción en
una línea, `balance` como está impreso en la fila o vacío.
