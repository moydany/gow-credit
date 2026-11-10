# Evals de la fase 3: Gemini 3.8 Flash y Opus 5.5 contra ground truth

- Fecha: 2026-11-04
- Pregunta: ¿se confirma `gemini-3.8-flash` como modelo de extracción al medirlo
  contra ground truth independiente en los 9 documentos, y no contra Opus?
- Ground truth: parser determinístico de la capa de texto + aritmética del banco
  (1,513 movimientos, los 9 documentos cierran). Nada sale de un modelo.
- Comando: `pnpm extract data/dev --model <modelo>` llena la caché; `pnpm eval` la reproduce,
  puntúa y aplica umbrales (`evals/src/thresholds.ts`). Mismos prompts, esquema y `effort`.
- Alcance acordado con el dueño: Gemini y Opus en los 9. Sonnet (2 de 9 en caché, de la fase 2)
  y Haiku (sin caché vigente: desde el cambio a Gemini sus relecturas van con Opus) no se corrieron.

## Resultado

| | Gemini 3.8 Flash | Opus 5.5 |
|---|---|---|
| Movimientos extraídos / ground truth | 1,513 / 1,513 | 1,513 / 1,513 |
| Inventados / omitidos | 0 / 0 | 0 / 0 |
| Monto, sentido, saldo | 100 % | 100 % |
| Fecha | 100 % salvo Mercado Pago 99.1 % (2 filas un día antes, pág. 13) | 100 % |
| Descripción difusa | 100 % salvo Banamex 97.8 % | 100 % salvo Banamex 97.8 % |
| Encabezado y resumen por campo | 120 / 120 | 120 / 120 |
| CFDI por campo | 104 / 107 | 106 / 107 |
| Cuadran / a la primera | 9 / 9, 9 / 9 | 9 / 9, 8 / 9 (Banamex releyó 1 página) |
| Costo de los 9 (precio de lista) | USD 1.80 | USD 9.16 |
| Umbral por banco | pasa en los 9 | pasa en los 9 |

Diferencias de CFDI: Gemini no tomó el RFC del emisor que Inbursa y HSBC imprimen al pie de la
página del comprobante (Opus tampoco en HSBC) y leyó mal un dígito del certificado del SAT de
HSBC (un dígito distinto), el documento que va solo por visión.

Inyección (PDFs sintéticos): los dos modelos ignoran las instrucciones, no transcriben el sello
y marcan el texto dirigido al sistema. Clasificador: Jev 32/33 (Mercado Pago como `other`),
Haiku 33/33; Jev cuesta un tercio y es unas 8 veces más rápido.

## Lectura

- Gemini empata a Opus en todo lo que pesa (filas, montos, sentido, saldos, cuadre) a una
  quinta parte del costo, y cuadra a la primera en los 9.
- Sus tres lecturas erróneas (dos fechas, un dígito de certificado) no las atrapa la
  verificación: la fecha no tiene aritmética y el certificado no se cruzó porque en visión no
  hay capa de texto contra qué buscarlo. Son errores pequeños y por debajo del umbral, pero
  muestran qué falta: comprobar fechas contra la capa de texto cuando existe, y cruzar el
  certificado del SAT con el de la cadena original también en visión.
- Opus sigue sin una sola fila mal en los 9: es buen camino de emergencia.

## Decisión

Se confirma el cambio: `gemini-3.8-flash` queda como modelo de extracción; ningún banco cae
bajo el umbral, así que ninguno se enruta a Opus.
