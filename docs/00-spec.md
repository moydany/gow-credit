# Spec en una página

Qué hace el sistema, qué se supuso y dónde está cada decisión. El detalle está en `02` a `09`.

## Qué hace

Un proveedor pide pronto pago a un prestamista (tenant) y entrega su estado de cuenta bancario
en PDF. El sistema hace cinco cosas:

1. **Extrae** cuentas, periodos, movimientos y el CFDI que el banco timbra. Cada valor trae su
   página y su fragmento. Modelo: Gemini 3.8 Flash; Claude Opus de emergencia.
2. **Verifica** la extracción contra la aritmética del propio banco:
   - cuadre global, totales y conteos, y saldo corrido;
   - CLABE, RFC y fechas;
   - cruces del CFDI.

   Lo que no cuadra se relee por página y, si sigue sin cuadrar, se marca.
3. **Calcula un perfil** con un catálogo fijo de features.
4. **Aplica la política JSON del tenant** con un motor puro. El veredicto trae su diagnóstico
   completo y contrafactuales.
5. **Pregunta al proveedor** cuando un dato dudoso puede cambiar el resultado. Es una sola ronda,
   por consola o archivo en standalone, o por WhatsApp o correo en full.
   Después decide.

Estados: `qualified`, `qualified_with_limit`, `not_qualified`, `needs_clarification`,
`human_review` y `failed`. Los tres primeros son veredictos finales; `needs_clarification` y
`human_review` piden algo antes de decidir (una respuesta del proveedor o la revisión de un
analista); `failed` es un error no recuperable de la solicitud.

## Supuestos

| Supuesto | Consecuencia |
|---|---|
| Los documentos son estados de cuenta, no facturas: el "CFDI" del enunciado es el que trae el propio estado de cuenta | El bloque fiscal se extrae siempre y sirve de ancla, pero los sellos nunca se transcriben (`09`) |
| Los documentos de evaluación vienen redactados como los de desarrollo (titular, RFC, CLABE) | En standalone, la identidad que no se puede comparar no bloquea; un desajuste real sí |
| Los PDFs no traen datos de la solicitud (monto, plazo, comprador) | Sin ellos la salida es perfil, estado y **línea máxima**; con `--request`, veredicto completo |
| Los documentos de evaluación son de fecha desconocida: la antigüedad del estado de cuenta no decide | La política por defecto de standalone no tiene la compuerta de 90 días (`--policy base` la conserva) y `document_age_days` queda en el perfil y en el reporte; `--as-of` fija la fecha de cálculo, por defecto hoy |
| Los periodos se extraen como los imprime el banco (Mercado Pago: uno de tres meses) | Los meses los cuenta el perfil, no la extracción |
| Los traspasos internos (apartados, cajitas de Nu) no son ingreso | Se marcan `internal_transfer` y se excluyen del cuadre consolidado |
| Una respuesta del dueño no se adivina: lo que no se entiende se declina | Las categorías se eligen de una lista; nunca hay texto libre en standalone |
| Ningún modelo decide | Los modelos extraen, clasifican y redactan; el veredicto sale del motor (`04` §5) |

## Decisiones principales

| Tema | Decisión |
|---|---|
| Modelo de extracción | Gemini 3.8 Flash. Por proveedor caído, Opus rehace el documento; por calidad, Opus relee el bloque. Doble lectura con Claude |
| Esquema del modelo | Distinto del contrato: montos como texto y valores citados en listas, por los límites de la API; el código traduce |
| Ground truth | Parser determinístico por banco sobre la capa de texto, arbitrado por la aritmética del banco, sin pasar por el modelo medido |
| Orquestación | Mastra con suspend y resume; SDK directo como salida de emergencia |
| Clasificación | Reglas primero; Jev o Haiku solo para lo que las reglas no resuelven |
| Decisión | Catálogo cerrado, política JSON validada, motor puro con contrafactuales |
| Modo full | Express 5, Postgres con RLS forzada, pg-boss y el mismo workflow |
| Backoffice | React y Vite, un rol por tenant, correcciones del analista como pares inmutables |
| Calidad | Evals con umbral por banco antes de cambiar prompts o modelos; inyección en CI sin llaves |
| Despliegue | Cloud Run, Supabase y Vercel (plan, no ejecutado; ver `deploy.md`) |

## Resultado en desarrollo

Sobre los 9 documentos de desarrollo:

- **Extracción**: los 1,513 movimientos, sin inventar ni omitir ninguno. 120 de 120 campos de
  encabezado y 104 de 107 del CFDI.
- **Cuadre**: los 9 documentos cuadran.
- **Costo**: USD 1.80 en total con Gemini, unos USD 0.20 por documento.

## Fuera de alcance o pendiente

- **Sin construir**: verificación ante el SAT (apagada), buró, Langfuse y pino, Batches API y
  equidad entre tenants, pantallas Proveedores y Configuración.
- **Sin probar en real**: WhatsApp contra el servicio real.
- **Sin hacer**: el despliegue.

La lista completa con su motivo está en `deploy.md`, "Falta para producción".
