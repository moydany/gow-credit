# CFDI dentro de los estados de cuenta

**Estado: hallazgo del 2026-11-04 sobre el dataset, hecho cuando la implementación ya iba
en la fase 2.** Cambia el contrato de extracción, la verificación, el catálogo de features
y la pregunta enviada a GOW. Quien implementa lo incorpora con una ADR y una sección
"Cambios durante la implementación" en `02`, `03` y `04`. En lo que toca al bloque fiscal,
este documento manda sobre ellos (regla de precedencia del README).

## 1. Hallazgo

Ocho de los nueve estados de cuenta traen impreso un **CFDI timbrado**: la factura que el
banco emite al titular por las comisiones del periodo (tipo `I`, ingreso) con su IVA, en
forma de "representación impresa de un CFDI". Trae folio fiscal (UUID), números de serie
de los certificados del emisor y del SAT, fecha de emisión y de timbrado, RFC del emisor
(el banco) y del receptor (el titular), régimen fiscal de ambos, uso de CFDI, forma y
método de pago, subtotal, IVA y total, más el sello digital del emisor, el sello digital
del SAT y la cadena original del complemento de certificación. Inbursa trae además un
segundo comprobante: la constancia de pagos y retenciones de ISR por intereses (CFDI de
retenciones, versión 2.0, con su propio UUID). Mercado Pago no trae ninguno.

Esto explica el término "facturas" del enunciado: cada estado de cuenta **es** también una
factura. Y aporta un identificador duro (el UUID) y un bloque de cifras que un evaluador
con ground truth propio muy probablemente mide.

| Documento | CFDI | Página | Sellos en la capa de texto | Régimen del receptor | Nota |
|---|---|---|---|---|---|
| Inbursa | sí, **dos** | 4 y 8 de 8 | completos | 601 | el segundo es la constancia de retenciones de ISR (versión 2.0, UUID propio) |
| Hey | sí | 13 de 15 | **truncados**: emisor y SAT con unos 260 de 344 caracteres, también en la capa de texto | 612 | RFC, nombre y código postal del receptor vienen **vacíos** |
| Fondeadora | sí | 4 de 4 | completos | no impreso | cadena original con versión `1.0`; la hora de certificación impresa no coincide con la de la cadena |
| Banamex | sí | 22 de 31 | datos fiscales en texto; sellos y cadena **no** están en la capa de texto | 601 | subtotal 240.00, IVA 38.40 (16 %), total 278.40 |
| BBVA | sí | 17 de 17 | presentes | 616 (sin obligaciones fiscales), uso `S01` | |
| Mercado Pago | **no** | — | — | — | solo la etiqueta "RFC/CURP" en el encabezado |
| Santander | sí | 30 de 32 | completos (344 caracteres exactos) | 626 (RESICO) | |
| Nu | sí | 32 de 32 | presentes | 616, uso `S01` | fecha de certificación en formato `06/08/2025 03:06:55 AM` |
| HSBC | sí | 7 de 8 | solo visión (capa de texto corrupta) | por leer con visión | |

Dos consecuencias prácticas: el bloque **no siempre está en la última página** (Banamex 22
de 31, Hey 13 de 15, Inbursa 4 y 8) y **un documento puede traer más de uno**.

## 2. Qué significa para el enunciado

La pregunta a GOW cambia de forma (README): ya no es "¿factura quiere decir estado de
cuenta?", sino si los diez documentos de evaluación son estados de cuenta como los de
desarrollo (con o sin CFDI) o si también llegarán CFDI emitidos por el proveedor a su
comprador. Mientras no haya respuesta se asume lo primero.

El bloque fiscal se extrae en ambos casos con el mismo esquema. Un documento clasificado
como `invoice` (un CFDI completo, sin movimientos) sigue sin perfil crediticio y la
decisión sigue siendo "faltan estados de cuenta", pero el reporte muestra emisor,
receptor, UUID y total en lugar de un simple `not_a_bank_statement`.

## 3. Contrato de extracción (fase 1, `02`)

`StatementExtraction` gana `fiscal_documents: FiscalDocument[]` al nivel del documento,
no de la cuenta: el CFDI es del titular. `schema_version` sube a `1.1.0` y se regenera
`docs/schema/`.

```ts
FiscalDocument = {
  id: LocalId                        // f1, f2
  kind: 'income' | 'withholding' | 'other'   // I ingreso; constancia de retenciones; otro
  version: field(string)             // "4.0", "3.3"; "2.0" en retenciones; null si no se imprime
  uuid: field(string)                // folio fiscal, 8-4-4-4-12 hexadecimal
  series: field(string)
  folio: field(string)
  issued_at: field(IsoDateTime)      // fecha de expedición o emisión
  certified_at: field(IsoDateTime)   // fecha de timbrado o certificación
  issuer_certificate: field(string)  // número de serie del certificado del emisor, 20 dígitos
  sat_certificate: field(string)     // número de serie del certificado del SAT, 20 dígitos
  pac_rfc: field(string)             // RFC del proveedor de certificación
  issuer:   { rfc: field(string), name: field(string), tax_regime: field(string) }
  receiver: { rfc: field(string), name: field(string), tax_regime: field(string),
              cfdi_use: field(string), postal_code: field(string) }
  payment_form: field(string)        // "03"
  payment_method: field(string)      // "PUE"
  currency: field(Currency)
  subtotal: field(Money)
  tax: field(Money)                  // IVA trasladado
  total: field(Money)
  seals: { issuer_present: boolean, sat_present: boolean, chain_present: boolean,
           looks_truncated: boolean | null }
  original_chain: { uuid: field(string), certified_at: field(IsoDateTime),
                    sat_certificate: field(string) }   // solo los tres campos cortos, para cruzar
  source: SourceRef
}
```

Reglas:

- **Los sellos y la cadena original completa no tienen campo.** No se piden, no se
  guardan, no se transcriben. De la cadena original solo se leen los tres campos cortos
  que sirven para cruzar.
- `receiver.*` sale únicamente del bloque fiscal. Si viene vacío (Hey), es `null`; nunca
  se rellena con el titular del encabezado.
- `field(...)` conserva `source_page`, `source_snippet`, `verification` y `confidence`
  como el resto del contrato.
- `IssueCode` nuevos: `invalid_uuid`, `fiscal_chain_mismatch`, `fiscal_totals_mismatch`,
  `fiscal_fees_mismatch`, `fiscal_receiver_mismatch`.
- `DocumentFlag` nuevo: `fiscal_document_present`.

## 4. Verificación y control de alucinaciones (fase 2, `04`)

Los sellos son la trampa perfecta: base64 largo, cortado en Hey (unos 260 de 344
caracteres, también en la capa de texto), ausente de la capa de texto en Banamex, y sin
valor para la decisión de crédito. Un modelo al que se le pide transcribirlos los
"completa". Por eso solo existen como booleanos de presencia y un `looks_truncated`.

Cruces, todos gratis:

1. `uuid` con formato válido, y `uuid == original_chain.uuid` → `fiscal_chain_mismatch`
   (`error`).
2. `sat_certificate == original_chain.sat_certificate` → `fiscal_chain_mismatch`
   (`error`). Las fechas (`certified_at` contra la cadena) solo como `warning`: Fondeadora
   imprime una hora distinta a la de la cadena.
3. `total == subtotal + tax` con tolerancia 0.01 → `fiscal_totals_mismatch` (`error`).
4. `subtotal` contra `summary.fees_charged` del periodo cuando `kind = income` (Hey:
   1,502.63 en ambos) → `fiscal_fees_mismatch` como `warning`: hay comisiones exentas y
   cortes distintos.
5. `tax` cerca del 16 % del subtotal: solo `info`. Hey da 15.6 % porque parte de las
   comisiones está exenta.
6. `receiver.rfc` contra `holder.rfc` cuando ambos existen → `fiscal_receiver_mismatch`
   (`error`). El encabezado suele enmascarar el RFC y el CFDI lo imprime completo: el
   bloque fiscal es la mejor fuente para `identity_match`.
7. `receiver.tax_regime` contra `holder.holder_type`: 601 ↔ `legal_entity`; 612, 621,
   626 ↔ `individual_with_business_activity`; 605, 616 ↔ `individual`. Desacuerdo →
   `warning` y `holder_type` queda `unverified`.
8. Certificados de 20 dígitos; `pac_rfc`, `issuer.rfc` y `receiver.rfc` con el validador
   de RFC existente.
9. Snippet igual que el resto del contrato. En HSBC (visión) la doble lectura del
   encabezado cubre también UUID y total fiscal.

Clasificación: la leyenda "representación impresa de un CFDI" al final de un estado de
cuenta **no** convierte el documento en `invoice`. Regla para `classify_document`: si hay
movimientos y saldos es `bank_statement` aunque traiga CFDI; `invoice` es solo cuando el
documento entero es el comprobante (conceptos y cantidades, sin movimientos). Esto exige
prompt v2 y un caso nuevo en la eval de clasificación.

## 5. Features y política (fase 4, `03`)

- `fiscal_regime` (enum, fuente `statement`): régimen fiscal del receptor del CFDI.
  Lista cerrada `601 | 603 | 605 | 606 | 607 | 608 | 610 | 611 | 612 | 614 | 615 | 616 |
  620 | 621 | 622 | 623 | 624 | 625 | 626 | other`; `null` si no hay CFDI o no se imprime.
  Un tenant puede, por ejemplo, excluir `616`: quien no tiene obligaciones fiscales no
  emite facturas y no cabe en un programa de pronto pago.
- `cfdi_sat_status` (enum, fuente `tax_authority`): `valid | cancelled | not_found`;
  `null` mientras no se consulte o falten datos para consultar. `cancelled` o `not_found`
  en un estado de cuenta sugiere documento alterado: compuerta `human_review` en la
  política de ejemplo, no en la base.
- `identity_match` toma `receiver.rfc` del CFDI como fuente del RFC cuando el encabezado
  viene enmascarado.
- `FEATURE_CATALOG_VERSION` sube a `1.1.0`. La política base no cambia; `policies/` gana
  un ejemplo con la compuerta de régimen.

## 6. Verificación ante el SAT (fases 5 y 6; `05`, `06`, `07`)

- Servicio público "Verifica CFDI" del SAT (`consultaqr.facturaelectronica.sat.gob.mx`,
  SOAP `ConsultaCFDIService.svc`). Recibe la expresión impresa
  `?re=<RFC emisor>&rr=<RFC receptor>&tt=<total>&id=<UUID>` (y `fe=<últimos 8 del sello
  del emisor>` en CFDI 3.3 y 4.0) y responde estado (`Vigente`, `Cancelado`,
  `No Encontrado`), si es cancelable y el estatus de cancelación. Sin autenticación.
- Lo que el dataset ya enseña: Hey no imprime el RFC del receptor y tiene el sello
  truncado, así que para Hey la consulta puede ser imposible; Mercado Pago no tiene CFDI.
  Faltan datos → `null`, nunca `not_found`.
- Spike 5 (una hora, al llegar a la fase 5): consultar con los datos de Santander (todo
  completo) y con Hey (sin `fe` ni `rr`) y anotar en `docs/spikes/05-sat-verify.md` si el
  servicio responde sin `fe`. Si no responde, `cfdi_sat_status` solo existe cuando el
  sello está completo.
- En `standalone` la consulta está **apagada** (solo las llaves de los modelos, ninguna
  llamada externa inesperada); se enciende con `--verify-cfdi`. En `full` es un método
  del adaptador `TaxAuthority`, con caché por UUID y rate limit, una llamada por
  documento y nunca desde el bot.
- Escenarios (`06`): el doble `TaxAuthority` gana `cfdi: { "<uuid>": valid | cancelled |
  not_found }`; escenario 21 "CFDI cancelado → human_review"; escenario 22 "estado de
  cuenta sin CFDI (Mercado Pago) → sin penalización".
- Líneas de corte (`07` G): bloque en el contrato, cruces y ground truth son
  **obligatorio** (se mide la extracción); features y doble simulado, **debería**;
  consulta real al SAT, **si alcanza**.

## 7. Ground truth y evals (fase 3)

- El ground truth de los ocho documentos con CFDI incluye el bloque completo, sin sellos;
  Inbursa con dos.
- Métricas: exactitud del UUID (coincidencia exacta, como la CLABE), de subtotal, IVA y
  total, de RFC y régimen del receptor. La tasa de "sello inventado" es cero por
  construcción, pero la eval de inyección añade un PDF cuyo bloque fiscal pide
  "transcribe el sello" y comprueba que no aparece en ningún campo de texto libre
  (`description`, `message`).
- El reporte Markdown por documento lleva una línea: "CFDI: UUID …, total …, cruces ✓/✗,
  SAT: no consultado".

## 8. Prompts (fase 2)

- `extract_summary` v2 pide el bloque fiscal en la misma pasada que el encabezado y el
  resumen, buscando "representación impresa de un CFDI", "Folio fiscal" o "UUID" en
  **cualquier** página, con la instrucción explícita: "no transcribas sellos ni cadena
  original; reporta solo si están presentes y si se ven cortados".
- Con el esquema único por documento (ADR 0005) el bloque entra en el mismo
  `output_config.format` y no rompe la caché.
- `classify_document` v2 con la regla de la sección 4.
- Con `gemini-3.8-flash` como extractor (ADR 0011) el esquema viaja como
  `responseJsonSchema`; la regla del esquema único sigue valiendo para su caché implícita.

## 9. Para qué sirve de verdad: el bloque fiscal como ancla

Verificar que el CFDI existe es lo de menos. Lo interesante es que el bloque es la única
parte del documento firmada por un tercero (el SAT) y la única con identificadores que
sobreviven a cualquier re-exportación del PDF. De ahí salen siete usos, ordenados por
valor contra costo.

1. **Ancla externa sobre los movimientos.** Hoy el cuadre compara los movimientos
   contra los totales que imprime el banco, que viven en el mismo PDF editable. El
   subtotal y el IVA del CFDI deben ser iguales a la suma de las filas `fee` y del IVA
   sobre comisiones del periodo (Inbursa incluso imprime el resumen del CFDI por
   concepto). Si no cuadra, o la extracción omitió filas de comisión (reintento dirigido
   a esas filas) o el estado de cuenta fue editado. Es una porción pequeña del libro,
   pero firmada fuera del documento. Feature `fiscal_anchor_ok` (bool). Costo: nulo,
   las comisiones ya se clasifican.
2. **Huella del estado de cuenta.** El UUID identifica el estado de cuenta, no el
   archivo: una copia re-exportada, reimpresa o escaneada conserva el UUID y cambia el
   sha256. Dentro del tenant, `statement_reuse_count`: el mismo UUID en otras
   solicitudes (reenvíos, mismo documento para dos montos distintos). A nivel
   plataforma, un índice de `HMAC(UUID)` con llave de plataforma, fuera del RLS de los
   tenants, de solo escritura para ellos y cuya lectura devuelve únicamente "visto en
   otro prestamista hace N días": `statement_seen_elsewhere_days` (int; `null` si
   nunca). Es la señal clásica de solicitudes simultáneas a varios prestamistas, sin
   revelar RFC, montos ni quién. Se documenta en `05` como excepción explícita al
   aislamiento.
3. **El comprador por RFC, no por nombre.** Santander imprime el RFC del pagador en los
   SPEI (82 contrapartes distintas en el documento de desarrollo); Banamex, Inbursa y Nu
   en algunos movimientos. `Transaction.classification` gana `counterparty_rfc` (regex
   sobre la descripción, validado). `buyer_payments_*` y `top_payer_concentration`
   agrupan por RFC cuando existe y por nombre difuso cuando no: más exacto y más difícil
   de falsear con una descripción parecida.
4. **Listas públicas del SAT.** El SAT publica como datos abiertos la lista del
   artículo 69-B (empresas que facturan operaciones simuladas: presuntos, desvirtuados,
   definitivos) y la de contribuyentes no localizados. Con el RFC completo del titular
   (receptor del CFDI) y los RFC de las contrapartes: `sat_list_status` del titular
   (`clear | efos_presumed | efos_definitive | not_located`) e
   `income_from_listed_rfc_share` (parte de los ingresos operativos que viene de
   pagadores en 69-B definitivo). Un proveedor cuyo pagador principal es un EFOS no se
   arregla con flujo. Costo: descargar y normalizar un CSV público; en `standalone` es
   opcional (`--sat-lists <csv>`), en `full` un adaptador con refresco semanal por
   pg_cron. Spike corto para fijar URL y formato del CSV.
5. **Régimen fiscal como filtro y como prueba de plausibilidad.** 616 no puede facturar
   y no cabe en pronto pago. 626 (RESICO persona física) tiene tope de ingresos de 3.5
   millones de pesos al año: ingresos operativos anualizados por encima →
   `regime_income_plausible = false`, se pregunta al dueño o va a revisión. 601 y 612
   además dicen qué documento pedir después (constancia de situación fiscal, opinión de
   cumplimiento).
6. **La fecha de timbrado como reloj confiable.** `certified_at` es una marca del SAT:
   `document_age_days` la usa cuando existe, y una distancia mayor a 30 días entre el
   fin del periodo y el timbrado es `warning` (documento generado mucho después, o
   periodo editado).
7. **Pedir el XML por el canal de aclaración.** Cuando el bloque impreso viene cortado
   (Hey) o el receptor vacío, la pregunta al dueño es "mándanos el XML del CFDI de tu
   estado de cuenta; se descarga en la app del banco". Con el XML se verifica el sello
   del SAT sin red (contra el certificado público del SAT), se completa el receptor y
   se obtienen los conceptos desglosados, que convierten el uso 1 en cuadre fila por
   fila. "Preguntar al dueño" deja de ser solo rellenar huecos: es subir de nivel de
   verificación con una pregunta que se contesta reenviando un archivo.

Hacia dónde lleva esto: el mismo `FiscalDocument` sirve para la factura que el
proveedor emite a su comprador, que es el documento natural de un pronto pago.
Receptor = RFC del comprador en el programa del tenant, método `PPD`, sin complemento
de pago, vigente en el SAT, y los pagos de ese comprador en el estado de cuenta
(uso 3) prueban la relación. No está en alcance, pero las piezas son las mismas.

Catálogo (`FEATURE_CATALOG_VERSION` 1.1.0), además de `fiscal_regime` y
`cfdi_sat_status`: `fiscal_anchor_ok` (bool, `statement`), `statement_reuse_count`
(int, `internal`), `statement_seen_elsewhere_days` (int, `internal`),
`sat_list_status` (enum, `tax_authority`), `income_from_listed_rfc_share` (ratio,
`tax_authority`), `regime_income_plausible` (bool, `statement`).

Escenarios nuevos (`06`): 23 "mismo UUID presentado a otro tenant hace 3 días →
human_review"; 24 "pagador principal en 69-B definitivo → not_qualified"; 25 "RESICO
con ingresos anualizados sobre el tope → pregunta al dueño".

Líneas de corte: usos 1, 3, 5 y 6 entran en las fases 2 y 4 sin costo visible; el uso
2 dentro del tenant es **debería** y el índice de plataforma **si alcanza** (diseñado
en `05`); el uso 4 con doble simulado es **debería** y la lista real **si alcanza**; el
uso 7 como tipo de pregunta es **debería** y la verificación criptográfica del XML
**si alcanza**.

## 10. Qué hacer ahora, en orden

1. ADR 0006 "Bloque fiscal en el contrato", con este documento como fuente.
2. Contrato: `FiscalDocument`, `IssueCode`, `DocumentFlag`, `schema_version` 1.1.0, JSON
   Schema regenerado, tests con los valores de Hey (truncado, receptor vacío) e Inbursa
   (dos comprobantes).
3. Prompts v2 de `extract_summary` y `classify_document`, con entrada en el changelog.
4. Verificación: los cruces de la sección 4.
5. `fiscal_regime` y `cfdi_sat_status` al llegar a la fase 4; `TaxAuthority` y el spike 5
   al llegar a la 5.
6. `counterparty_rfc` en la clasificación de movimientos y los usos 1, 5 y 6 de la
   sección 9 dentro de la verificación y el perfil.
7. `statement_reuse_count`, `sat_list_status` y la pregunta "mándanos el XML" cuando
   lleguen las fases 4 y 5; el índice de plataforma y la lista 69-B real al final.
8. Secciones "Cambios durante la implementación" en `02`, `03`, `04`, `05` y `06`
   apuntando aquí.

## Cambios durante la implementación

- **Fase 3, ground truth del bloque fiscal** (ADR 0012). Los 8 documentos con CFDI tienen su
  bloque en el ground truth (Inbursa con dos, sin sellos). Los campos que el comprobante no
  imprime en su página quedan `null` y no se miden (importes de BBVA, Santander, Nu y
  Fondeadora; RFC del emisor de Fondeadora y Santander). El RFC del PAC que solo aparece
  dentro de la cadena original (Santander, retenciones de Inbursa) tampoco se mide. RFC y
  nombre del receptor se miden como "debe ser null" cuando vienen vacíos. La eval de
  inyección incluye el PDF cuyo bloque fiscal pide "transcribe el sello" y comprueba que
  ningún fragmento de 16 caracteres del sello aparece en ningún campo de la extracción.
- **Fase 4, catálogo 1.1.0 implementado** (ADR 0013).
  - **Implementado:** `fiscal_regime`, `cfdi_sat_status`, `fiscal_anchor_ok`,
    `statement_reuse_count`, `statement_seen_elsewhere_days`, `sat_list_status`,
    `income_from_listed_rfc_share` y `regime_income_plausible`; `identity_match` con el RFC del
    receptor; `document_age_days` con la fecha de timbrado cuando es anterior al corte.
  - **Ancla fiscal:** las filas de comisión contra el total del CFDI, o contra el subtotal si el
    banco no detalla el IVA, con tolerancia de 1 MXN. Cuadra en los 4 documentos cuyo CFDI
    imprime importes: Inbursa, Hey, Banamex y HSBC.
  - **Régimen 616:** aparece en 3 de 9 CFDI, uno de ellos con nómina y cuotas al IMSS. Por eso
    la política de ejemplo (`policies/examples/fiscal-anchors.v1.json`) lo manda a revisión
    humana, no a rechazo.
  - **RESICO:** un documento con régimen 626 supera el tope con sus abonos de clientes
    anualizados, como en el escenario 25.
  - **Escenarios 21 a 25:** pasan en modo unitario con esa política. El doble `TaxAuthority`
    responde por UUID y las listas por RFC de contraparte. Un CFDI sin RFC de receptor no se
    consulta.
