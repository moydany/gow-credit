# Documentación de diseño: GOW Credit worksample

Carpeta de diseño del sistema que recibe estados de cuenta bancarios de proveedores,
extrae su información, calcula un perfil crediticio, aplica la política del prestamista y
consulta al dueño del documento cuando algo no está claro. Todo se escribió antes de la
primera línea de código. **Quien construye empieza por `00-brief.md`.**

## Orden de lectura

| Doc | Qué contiene | Estado |
|---|---|---|
| `00-brief.md` | Brief para quien implementa: contexto, decisiones finales, orden de construcción, líneas de corte, reglas | **empezar aquí** |
| `07-pendientes-antes-de-construir.md` | Huecos detectados antes de construir: camino sin infraestructura, contrato de extracción, ground truth, privacidad, reproducibilidad, spikes | vigente |
| `02-arquitectura-con-mastra.md` | Arquitectura vigente: monorepo, modos de ejecución, Mastra, workflow, pg-boss, carga, Jev, motor, aprendizaje, evals, deploy | vigente |
| `03-criterio-de-calificacion.md` | Perfil de features, política JSON por tenant, decisión y diagnóstico con contrafactuales | vigente |
| `04-control-de-alucinaciones.md` | Cuatro capas: superficie, verificación contra el documento, generación restringida, no decidir sobre lo no verificado; métricas | vigente |
| `05-seguridad.md` | Modelo de amenazas, aislamiento multi-tenant y por WhatsApp, datos y LFPDPPP, OWASP LLM Top 10, cadena de suministro, pruebas | vigente |
| `06-escenarios-y-simulacion.md` | Escenarios YAML de punta a punta con adaptadores simulados; catálogo de 20 casos | vigente |
| `08-backoffice.md` | Backoffice: un rol y varios usuarios por tenant, pantallas, técnica, prioridades | vigente |
| `09-cfdi-en-estados-de-cuenta.md` | Hallazgo sobre el dataset: ocho de nueve estados de cuenta traen un CFDI timbrado. Bloque fiscal en el contrato, cruces de verificación, features nuevas, verificación ante el SAT | **vigente; leer antes de tocar el contrato o los prompts de extracción** |
| `01-investigacion-arquitectura.md` | Comparación de opciones y fuentes. Varias decisiones fueron superadas; su banner inicial dice cuáles | referencia |
| `Worksample Ingeniería Tech v3 ...docx` | Enunciado original (español e inglés) | fuente |

Cuando un documento contradiga a otro, manda el de número más alto, salvo `07` y `00`,
que mandan sobre todos. Si durante la implementación una decisión cambia, no se reescribe
la historia: se agrega una sección "Cambios durante la implementación" al final del
documento afectado y una ADR en `docs/adr/`.

## Glosario

| Término | Significado |
|---|---|
| **Tenant / prestamista** | Cliente de GOW: fintech, banco o cadena con programa de pronto pago. Dueño de su política y sus datos. |
| **Proveedor** | PyME que vende a una cadena y pide cobrar antes del vencimiento. Dueño del documento. |
| **Solicitud** (`application`) | Una evaluación de un proveedor para un tenant, con uno o más documentos y, opcionalmente, monto, vencimiento y comprador. |
| **Documento** | PDF subido; hoy siempre un estado de cuenta bancario. |
| **Extracción** | Salida estructurada de leer el documento, con verificación por campo. |
| **Perfil** | Catálogo fijo de features calculadas desde la extracción y fuentes externas, con confianza y procedencia. |
| **Política** | Documento JSON versionado por tenant: compuertas, dimensiones con pesos, bandas, aclaración. |
| **Veredicto** | Resultado del motor al aplicar la política al perfil. |
| **Aclaración** | Pregunta al proveedor cuando un dato dudoso puede cambiar el veredicto. |
| **Outcome** | Lo que pasó después de financiar: pagó, atraso, mora, fraude. |
| **Escenario** | Archivo YAML que describe un mundo completo para correr el sistema de punta a punta con lo externo simulado. |
| **Comprador / cadena** | La empresa a la que el proveedor factura. Sus pagos en el estado de cuenta son señal clave. |
| **CFDI** | Comprobante Fiscal Digital por Internet: la factura electrónica mexicana, timbrada ante el SAT por un PAC. Los bancos emiten uno por las comisiones del periodo y lo imprimen dentro del estado de cuenta. |
| **Folio fiscal (UUID)** | Identificador único del CFDI, asignado al timbrar. Formato 8-4-4-4-12 hexadecimal. |
| **Sello digital / cadena original** | Firmas en base64 del emisor y del SAT, y la cadena que firman. No se transcriben: solo se registra si están presentes y si se ven truncados. |
| **Régimen fiscal** | Clave del SAT que dice qué tipo de contribuyente es el titular: 601 persona moral, 612 persona física con actividad empresarial, 626 RESICO, 616 sin obligaciones fiscales. |

## Estados canónicos

Usar exactamente estos valores en código, base y documentación.

**`application.status`** (ciclo de vida de la solicitud)

```
received → extracting → extracted → deciding → needs_clarification → deciding → ...
                                             ↘ human_review
                                             ↘ qualified | qualified_with_limit | not_qualified
cualquier estado → failed (error no recuperable, con razón)
```

**Veredicto del motor** (`decision.status`): `qualified | qualified_with_limit |
not_qualified | needs_clarification | human_review`. Los tres primeros son finales; los
dos últimos piden algo antes de decidir.

**Versión de política** (`policy_version.status`): `draft | shadow | active | archived`.

**Aclaración** (`clarification.status`): `open | answered | expired | rejected`.

**Verificación de un campo extraído**: `verified | unverified | conflict`.

**Procedencia de un valor**: `extracted | owner_answer | analyst_answer | external`.

**Clasificación de documento**: `bank_statement | credit_card_statement | invoice | other`.

**Clasificación de movimiento**: `customer_payment | own_transfer | loan_disbursement |
loan_payment | payroll | supplier_payment | tax | fee | interest | other`. (`loan_payment` se
agregó en la fase 4, ADR 0013.)

## Dataset de desarrollo

Carpeta compartida por GOW en Google Drive ("Modelo Facturas worksample"). El enunciado
dice 10 documentos; hay 9. Ya están descargados en `data/dev/` (ignorado por git) y se
pueden volver a bajar con `scripts/download-dev-data.sh`, que verifica los hashes contra
`scripts/dev-data.MANIFEST.sha256`.

| Archivo | Banco | Tamaño | Páginas | Nota |
|---|---|---|---|---|
| EDC_01_Inbursa_2025-01.pdf | Inbursa | 184 KB | 8 | texto limpio |
| EDC_02_Hey_2025-04.pdf | Hey Banco | 141 KB | 15 | persona física con actividad empresarial |
| EDC_03_Fondeadora_2025-10.pdf | Fondeadora | 77 KB | 4 | SPEI |
| EDC_04_Banamex_2026-02.pdf | Banamex | 597 KB | 31 | cuenta negocios |
| EDC_05_BBVA_2025-09.pdf | BBVA | 651 KB | 17 | empieza con aviso de RFC genérico |
| EDC_06_MercadoPago_2026-06a09.pdf | Mercado Pago | 103 KB | 17 | **tres meses**, montos negativos para cargos |
| EDC_07_Santander_2025-04.pdf | Santander | 224 KB | 32 | **dos productos** (cuenta PyME e inversión) |
| EDC_08_Nu_2025-07.pdf | Nu | 140 KB | 32 | formato distinto (cajitas, dinero reservado) |
| EDC_09_HSBC_2026-03.pdf | HSBC | 1.5 MB | 8 | **capa de texto corrupta**: solo visión |

Contienen datos personales y financieros reales parcialmente redactados: `data/`
nunca se versiona.

Ocho de los nueve traen impreso el CFDI que el banco emite por sus comisiones (Mercado Pago
no); el detalle por documento, con páginas y estado de los sellos, está en
`09-cfdi-en-estados-de-cuenta.md`.

## Pregunta enviada a GOW Credit

Una sola, por escrito. Los estados de cuenta de desarrollo traen impreso el CFDI que el
banco emite por sus comisiones, así que "factura" en el enunciado puede referirse a ellos
mismos. La pregunta: si los diez documentos de evaluación son estados de cuenta como los
de desarrollo (con o sin CFDI) o si también llegarán CFDI emitidos por el proveedor a su
comprador. Mientras no haya respuesta, se asume lo primero; el bloque fiscal se extrae en
ambos casos (`09`). Todo lo demás se decidió y está documentado como supuesto.
