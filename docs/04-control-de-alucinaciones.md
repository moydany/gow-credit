# Control de alucinaciones

Fecha: 2026-11-04. Principio: la alucinación no se elimina, se acota. Se reduce la
superficie donde el modelo puede inventar, se verifica contra el propio documento, se
mide con evals, y nunca se decide sobre un dato no verificado.

## 1. Dónde puede inventar el sistema

| Etapa | Qué puede salir mal | Impacto |
|---|---|---|
| Extracción (Claude lee el PDF) | Movimientos inventados o duplicados, filas omitidas, cargo leído como abono, monto o fecha mal leídos, RFC o CLABE "completados", totales inventados cuando faltan páginas, mezcla de dos cuentas del mismo estado (Santander: cuenta + inversión) | Alto: cambia ingresos, capacidad de pago y la decisión |
| Clasificación (Jev) | Etiqueta válida pero equivocada (un préstamo marcado como pago de cliente); lectura literal de la pregunta; texto del documento que sesga la respuesta | Medio: infla o desinfla ingresos operativos |
| Redacción de preguntas al proveedor (Claude) | Preguntar por un problema que no existe, inventar contexto, exponer datos | Medio: confunde al proveedor y ensucia el perfil |
| Interpretación de respuestas de WhatsApp (Jev) | Atribuir la respuesta a la pregunta equivocada | Medio |
| Diagnóstico y `next_steps` (Claude redacta) | Cifras o razones que no salieron del motor; promesas | Alto en confianza del usuario, bajo en decisión (la decisión ya se tomó) |
| Inyección vía documento | Un PDF con texto dirigido al modelo | Alto si se obedece |

## 2. Capa 1: reducir la superficie

- **El LLM nunca decide.** Califica un motor determinístico. Lo que sale del modelo es un
  dato que pasa por validación antes de usarse.
- **Esquemas estrictos con permiso de no saber.** Cada campo tiene tipo, rango y enum.
  Los campos que pueden no estar son `nullable` y el prompt dice "si no está en el
  documento, devuelve null; no infieras". Forzar un valor es la primera causa de
  invención.
- **Cada valor viene con su origen.** El esquema pide `source_page` y
  `source_snippet` (el texto literal donde se leyó) para encabezado, totales y cada
  movimiento. Esto habilita la verificación de la capa 2.
- **Extracción por bloques de páginas.** Las tablas largas se extraen en bloques, con
  solapamiento de una fila y deduplicación por (fecha, descripción, monto, saldo). Los
  modelos omiten filas al final de tablas largas; los bloques lo evitan.
- **Generación restringida.** Las preguntas al proveedor y los `next_steps` se redactan
  a partir de una lista estructurada de hechos que produce el motor. El modelo parafrasea,
  no inventa. Ver capa 4.

## 3. Capa 2: verificar contra el propio documento

Los estados de cuenta tienen una propiedad valiosa: **se auto-verifican**. Cada cifra
está ligada a otras por aritmética. Es el control más fuerte y es gratis.

1. **Cuadre global**: saldo inicial + abonos − cargos = saldo final (tolerancia 1 MXN).
2. **Cuadre de totales**: suma de movimientos extraídos = totales del resumen del banco
   (abonos, cargos, número de movimientos cuando el banco lo imprime).
3. **Saldo corrido fila por fila**: saldo(n) = saldo(n−1) ± monto(n). Una fila
   inventada, una omitida o un signo invertido rompe la cadena exactamente donde ocurrió.
   Eso localiza el error a una página, y permite **reintento dirigido**: se re-extrae solo
   esa página con un prompt enfocado, no todo el documento.
4. **Validadores de formato que detectan invención**: la CLABE tiene dígito verificador
   (módulo 10 ponderado); el RFC tiene estructura y homoclave; fechas dentro del periodo
   y en orden; montos no negativos; moneda consistente. Una CLABE "completada" por el
   modelo falla el dígito verificador.
5. **Verificación del snippet**: cuando hay capa de texto, el `source_snippet` de cada
   valor debe existir en el texto de la página citada. Si no existe, el valor se marca
   `unverified`. Para páginas sin texto útil (HSBC) aplica el punto 6.
6. **Doble lectura solo donde importa**: encabezado, totales y los movimientos con monto
   mayor al 10 % de los abonos del periodo se extraen dos veces (texto y visión, o dos
   prompts distintos) y se comparan campo por campo. Desacuerdo → `unverified`. Se hace
   adaptativo: si el cuadre global pasa a la primera, no se repite nada; si falla, se
   repiten los bloques que rompen el saldo corrido. Así el costo extra solo se paga en
   los documentos problemáticos.
7. **Citas nativas de Claude** para campos de encabezado: la API devuelve la página y el
   texto citado. No es compatible con structured outputs en la misma llamada, así que se
   usa en una llamada corta separada solo para titular, RFC, CLABE y periodo, y se
   contrasta con la extracción principal.

Resultado de la capa: cada campo del perfil lleva `verification: verified | unverified |
conflict` y una `confidence` derivada de los chequeos (no auto-reportada por el modelo,
que está mal calibrada).

## 4. Capa 3: clasificación y generación

**Jev.** Sus probabilidades sí están calibradas, así que se usan umbrales por acción:
una etiqueta con `confidence < 0.7` se trata como `unknown`. Toda pregunta lleva opción
`other`. Una distribución plana significa que la pregunta no se puede responder con ese
estado, no que la respuesta sea la de mayor probabilidad. Versión fijada y registrada.

**Preguntas al proveedor.** El motor produce `issues` estructurados (campo, valor leído,
página, por qué es dudoso). Claude redacta la pregunta a partir de eso con la instrucción
de no agregar hechos. Un chequeo posterior verifica que todo número y fecha en el texto
generado exista en los `issues`; si no, se descarta y se regenera. Nunca se envía sin
pasar ese filtro.

**Respuestas de WhatsApp.** Jev correlaciona con las preguntas abiertas; `confidence <
0.6` → se repregunta con opciones numeradas en lugar de adivinar. Una respuesta que
contradice el dato extraído con alta probabilidad va a revisión humana, no se mergea.

**`next_steps` y razones.** El motor calcula los contrafactuales con números. Claude
convierte la lista en prosa. Mismo filtro: cada cifra del texto debe estar en la lista
estructurada. En evals, un juez LLM compara el texto contra los hechos y mide
fidelidad; cualquier afirmación sin respaldo cuenta como fallo.

**Inyección.** El contenido del PDF y los mensajes del proveedor son datos no confiables.
El system prompt lo declara; un Noul de Jev detecta texto dirigido a un sistema
automatizado y marca el documento; el modelo nunca ejecuta acciones, solo devuelve
objetos validados.

## 5. Capa 4: nunca decidir sobre lo no verificado

La política del tenant define el impacto de cada feature. Regla fija del motor, no
configurable: una feature `unverified` o `conflict` que cambie la banda de decisión no
se usa. En su lugar:

- Si el proveedor puede aclararlo (un depósito, un dato de identidad) → `needs_clarification`.
- Si no puede (descuadre persistente, posible alteración) → `human_review`.

La cola de revisión muestra la página del PDF junto al valor extraído y el valor
alternativo cuando hubo doble lectura. Cada corrección del revisor se guarda como par
(valor leído, valor correcto) y entra al dataset de evals. Es la fuente de verdad que crece
sola.

## 6. Medir: evals y métricas en producción

**Offline, con ground truth (los 9 documentos y los que se corrijan en revisión):**

| Métrica | Qué captura |
|---|---|
| Precisión de movimientos | filas inventadas (filas extraídas que no existen) |
| Recall de movimientos | filas omitidas |
| Exactitud de monto, fecha y signo por fila | lecturas erróneas |
| Exactitud de encabezado por campo | titular, RFC, CLABE, periodo, saldos |
| Tasa de cuadre a la primera | salud general de la extracción |
| Fidelidad de texto generado | afirmaciones sin respaldo en preguntas y `next_steps` |

Cualquier cambio de prompt, modelo o `effort` pasa por estas métricas en CI con umbral.
Invención y omisión se reportan por separado porque se corrigen con medidas distintas.

**En producción, sin ground truth:** tasa de fallo de cuadre, tasa de desacuerdo entre
lecturas, fallos de validadores de formato, tasa de aclaraciones, y la más importante:
**tasa de corrección en revisión humana** por campo y por versión de prompt. Es el proxy
de alucinación en vivo y dispara alerta si sube tras un despliegue.

## 7. Qué se le dice a quien pregunta

"No confío en el modelo; confío en el cuadre. Un estado de cuenta se auto-verifica: si
una fila se inventa o se omite, el saldo corrido se rompe en esa página, y la vuelvo a
leer solo ahí. Lo que no cuadra o no se puede verificar no entra a la decisión: se le
pregunta al proveedor o va a revisión. Y mido invención y omisión por separado, en CI
contra ground truth y en producción con la tasa de corrección de los revisores."

---

## Cambios durante la implementación

### Fase 2 (2026-11-04)

- **Sellos del CFDI fuera del contrato** (`docs/09` §4, ADR 0008). Son base64 largo, a
  veces cortado (Hey) o fuera de la capa de texto (Banamex): un modelo al que se le piden
  los completa. Solo se registra si están presentes y si se ven truncados.
- **Cruces fiscales** como verificación gratuita adicional (capa 2): UUID contra la cadena
  original, certificado del SAT, total = subtotal + IVA, subtotal contra comisiones del
  periodo, RFC del receptor contra el titular, régimen fiscal contra el tipo de persona.
- **Saldo corrido tolerante al orden dentro del día.** Algunos bancos aplican los
  movimientos de un día en otro orden que el impreso (Fondeadora lista intereses e ISR al
  final del día con saldos de antes del último depósito). Dentro de cada fecha se aplica
  primero la fila que encadena; si ninguna encadena, es ruptura.
- **El cuadre global manda sobre los totales impresos.** Si el saldo inicial más abonos
  menos cargos da exacto el saldo final, una diferencia contra el total impreso de cargos o
  abonos es de presentación (Fondeadora no cuenta el ISR en su total de retiros) y se
  reporta como aviso, o como dato informativo si coincide con ISR, comisiones o intereses.
- **Valor sin cita = no verificado.** Un valor extraído sin página ni texto, que tampoco se
  ubica en la capa de texto, se conserva como `unverified` (no decide) en lugar de inventar
  una cita.
- **Resúmenes consolidados con apartados** (ADR 0009). Si la fórmula directa no cuadra, el
  cuadre global prueba sin los traspasos internos (`internal_transfer`) y con conceptos del
  resumen no detallados (rendimientos, comisiones, ISR); una fórmula alternativa solo se
  acepta exacta al centavo y queda registrada.
- **Fecha de timbrado como reloj confiable** (`docs/09` §9.6): si el timbrado del CFDI
  queda a más de 30 días del fin del periodo, aviso (documento generado mucho después o
  periodo editado). El ancla de comisiones (`09` §9.1) entra en la fase 4, cuando los
  movimientos estén clasificados como `fee`.
- **Doble lectura con otra familia de modelos** (ADR 0011). Con Gemini como extractor, la
  segunda lectura de encabezado, totales y movimientos grandes (§3.6) se hace con Claude
  (`claude-haiku-5-5`; `claude-opus-5-5` si el router sube el `effort`). Dos familias
  comparten menos sesgos que dos prompts del mismo modelo: un acuerdo vale más y un
  desacuerdo marca `unverified` igual que antes. Las citas nativas de Claude (§3.7) quedan
  solo en el camino de emergencia.
- **Métricas de §6 implementadas** (ADR 0012, `evals/`). Filas emparejadas en dos rondas
  (exacta por fecha, monto y sentido; luego un solo campo mal leído), así que invención,
  omisión y lectura errónea se cuentan aparte. Un valor en un campo que el PDF trae
  redactado (titular, RFC, CLABE, receptor del CFDI) cuenta como invención. Descripción
  difusa: `description + reference` contra la fila del banco. Umbrales por documento en
  `evals/src/thresholds.ts`: precisión ≥ 99.5 %, recall ≥ 99 %, monto y sentido ≥ 99.5 %,
  fecha y saldo ≥ 99 %, descripción ≥ 90 %, encabezado ≥ 90 %, CFDI ≥ 85 %, documento
  cuadrado. El cuadre a la primera se reporta sin bloquear. La fidelidad del texto generado
  (preguntas y `next_steps`) llega con la fase 5, que es donde se genera ese texto.

### Fase 4 (2026-11-04): capa 4 en el motor (ADR 0014)

- **§5 implementado como regla fija de `evaluate`.** Una dimensión cuya feature es `unverified`,
  `conflict` o de confianza baja no suma, y un tope sobre ella aplica. El motor evalúa también
  el mejor caso; si la banda cambia, no decide. La confianza baja en la clasificación de abonos
  se pregunta al proveedor; identidad, antigüedad e historia también. Un valor no verificado
  contra el documento va a revisión humana. Una compuerta sobre un dato dudoso ni pasa ni
  reprueba.
- **En el perfil, un movimiento no verificado nunca suma.** Si lo que quedó fuera es material,
  la feature queda `unverified` para que el motor aplique la regla anterior.
- Un test de propiedades lo comprueba: con un dato no verificado fuera de la fórmula de línea,
  cambiar su valor no cambia el estado.

### Fase 5 (2026-11-05): capa 3 en el workflow (ADR 0015)

- **Filtro de cifras implementado** (`packages/mastra/src/figures.ts`):
  - Revisa números, fechas en palabras e ISO, y números escritos con palabras de "dos" en
    adelante. "mil" y "millón" se rechazan.
  - Lo permitido sale de los hechos de cada pregunta o paso, con sus redondeos y, para
    proporciones, su porcentaje.
  - Un texto que falla se regenera una vez, indicándole al modelo qué cifras se rechazaron. Si
    vuelve a fallar queda la plantilla del código, que siempre pasa.
- **Haiku como clasificador de movimientos**: su confianza autoreportada no entra a ningún
  umbral (spike 3). Ver ADR 0015 §8.
- **Respuesta que contradice el documento**: el umbral de "alta probabilidad" quedó en 0.8 de la
  clasificación existente (regla o modelo).
- **Fidelidad del texto generado (§6)**: el filtro es la guarda en línea. La métrica con juez
  LLM sigue pendiente.

### Robustez documental (2026-11-07): doble lectura del encabezado sin texto (§3.6)

Spec `docs/specs/2026-11-07-robustez-documental.md`, sección V. §3.6 prometía una segunda lectura
de encabezado, totales y movimientos grandes para los documentos sin texto; hasta hoy solo se
releían las páginas que rompen el saldo corrido, y un PDF escaneado dejaba todo el encabezado en
`unverified` porque no hay capa de texto contra qué comparar (§3.5). Se hizo así:

- **Dónde.** `packages/extraction/src/double-read.ts`, llamada desde un bloque de `extract.ts`
  justo después de ensamblar el resumen de la pasada 1. **Solo en la ruta `vision_only`**
  (capa `corrupt` o `absent`); con texto local no corre, porque §3.5 ya verifica ese encabezado
  gratis.
- **Qué lee.** Repite la pasada 1 tal cual (mismo prompt, mismo esquema, misma instrucción con la
  nota de visión; sin cambio de prompts ni de esquema, así que la caché no se invalida) con el
  modelo de `plan.doubleRead`, la otra familia de la ADR 0011, a `effort` medio. La llamada
  queda en `extraction.calls` con `purpose: double_read`, su costo y su acierto de caché.
- **Qué compara.** `bank_name`, `holder_name`, `holder_rfc`; por cuenta `account_number` y `clabe`;
  por periodo `period_start`, `period_end`, `statement_date`, `opening_balance`, `closing_balance`,
  `total_credits`, `total_debits`, `credits_count` y `debits_count`. Ambas lecturas se normalizan con
  el mismo código (fechas ISO, montos al centavo, conteos enteros); en identificadores se ignoran
  espacios, puntos y guiones; en el titular, acentos, mayúsculas y puntuación; el nombre del banco
  puede venir con o sin su razón social. Cuentas y periodos se emparejan por `ref` y, si la segunda
  lectura los nombró distinto pero trae la misma forma, por posición. Un dígito distinto es
  desacuerdo.
- **Resultado por campo.** Coinciden: `verified`, con la página y el `source_snippet` de la primera
  lectura y confianza de al menos 0.9 (menos que el 0.95 de una cita comprobada en la página). Difieren:
  `conflict`, confianza máxima 0.3 e issue `header_read_conflict` (`warning`, `path` al campo,
  `details: { first, second }`; el mensaje nombra el campo y no repite valores). Solo la primera lo
  leyó: queda como estaba. Un campo sin cita (el contrato exige fuente para un valor
  `verified`) no se verifica aunque coincida. Bandera de documento `header_double_read` cuando la
  segunda lectura se hizo.
- **Quién manda.** Los validadores de formato y el cuadre corren después y no se tocan: una CLABE que
  no pasa el dígito verificador queda `unverified` aunque las dos lecturas coincidan, y los saldos
  y totales de un periodo que cuadra exacto quedan `verified` (confianza 1) aunque la segunda lectura
  haya discrepado, porque la aritmética del propio documento es más fuerte que una segunda opinión.
  El issue `header_read_conflict` se conserva en ambos casos. Un valor que ya se verificó contra el
  texto (HSBC con la capa EBCDIC reparada también es `vision_only`) no se vuelve a juzgar, y si todos
  lo están no se hace la llamada.
- **Si falla.** Proveedor caído, sin llave, sin respuesta en caché (`--cache read`) o una respuesta
  sin resumen: issue `block_failed` informativo, sin bandera y sin conflictos; la extracción sigue
  como antes. Tampoco se llama si el modelo de la segunda lectura es el mismo que leyó primero (sin
  llave de Google, o tras la caída del proveedor, el principal ya es Opus): con la misma entrada la
  caché devolvería la primera respuesta y el "acuerdo" no probaría nada. Queda el mismo aviso informativo.
- **Lo que no hace.** Los movimientos grandes de §3.6 no se releen aquí (siguen releyéndose solo
  las páginas que rompen el saldo, §3.3) y no hay nota por campo: el contrato `Field` no tiene
  dónde ponerla, así que la evidencia de que un valor salió de una doble lectura es la bandera
  `header_double_read` más la llamada `double_read` de `extraction.calls`.
- **Costo.** Una llamada más del tamaño de la pasada 1 (el PDF y el resumen, sin movimientos) por
  documento escaneado, en serie después de ella.
