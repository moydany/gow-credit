# Spike 3. Jev (TypeSafe AI) con `choice` tipado

- Fecha: 2026-11-04
- Código: `spikes/src/spike3-jev.ts`
- SDK: `@typesafe-ai/sdk` 0.7.0
- **Veredicto: no hay `TYPESAFE_API_KEY`, así que el fallback a `claude-haiku-5-5` es el
  camino. La integración con Jev queda tipada y probada en el cable, sin llamada real.**

## Qué probé

1. El cuestionario de `classifyDocument` de `02` 4c como preguntas del SDK:
   `choice` de tipo de documento (`bank_statement | credit_card_statement | invoice |
   other`) y dos `noul` (texto legible en español; texto con instrucciones a un sistema
   automatizado).
2. Que `.choice` quede tipado como la unión exacta de etiquetas: una función que solo
   acepta esa unión recibe la respuesta, y compila.
3. Cómo falla el SDK sin llave.
4. Qué mandaría Jev: request capturado en el servidor local.
5. El clasificador de respaldo: mismo cuestionario como salida estructurada de Haiku por
   el SDK de Anthropic, request capturado.

## Qué pasó

- **Tipado**: `res.answers.documentType.choice` se infiere como
  `'bank_statement' | 'credit_card_statement' | 'invoice' | 'other'`. Compila contra la
  unión del README de estados canónicos. `probabilities` queda indexado por las mismas
  etiquetas.
- **Sin llave**: el constructor `new TypeSafeClient()` lanza `TypeSafeError` ("No API key
  was provided...") antes de tocar la red. La regla del fallback es revisar la variable
  antes de construir el cliente; la excepción es la red de seguridad.
- **Cable**: `POST /v1/systemone` con `model: "jev-1.13.0"` y las preguntas por tipo
  (`choice`, `noul`). Cuerpo de unos 1.2 KB para una página de texto; el SDK comprime con
  zstd a partir de 1 KiB. `defaultModel` debe fijarse a `jev-1.13.0`: el default del SDK
  es `jev-latest`.
- **Haiku**: `claude-haiku-5-5` con `output_config.format` (`json_schema`) y `effort: low`.
  Sin `fallbacks`: Haiku 5.5 no tiene fallback del lado del servidor y una lista de modelos
  da 400. El thinking adaptativo viene encendido por defecto.
- **Cambio frente a `02` 4c**: el SDK 0.7 ya acepta imágenes (experimental, header
  `TypeSafe-Danger-Zone-Images`). El diseño dice "Jev solo texto"; se mantiene así porque es
  experimental, pero se anota.

## Diferencia que importa entre Jev y Haiku

Jev devuelve probabilidades calibradas; Haiku solo puede autoreportar una confianza, y
`04` 3 dice que la confianza autoreportada está mal calibrada. Con Haiku:

- La etiqueta se usa para rutear y etiquetar, nunca para descartar un documento.
- La "confianza" de Haiku no alimenta umbrales de la política. Las features que dependen de
  clasificación de movimientos llevan `confidence` derivada de chequeos (cuadre, doble
  lectura), no de lo que diga el modelo.
- El reporte dice qué clasificador corrió (`classifier: haiku-fallback`).

## Decisión

- `Classifier` con dos implementaciones (`JevClassifier`, `ClaudeClassifier`) en
  `packages/llm`. La elección se hace al arrancar: `TYPESAFE_API_KEY` presente → Jev; si
  no, Haiku y una bandera en el reporte.
- Jev se fija a `jev-1.13.0` y se registra `res.model` en la traza.
- Cuando llegue la llave, este mismo script hace la llamada real
  (`pnpm -F @gow/spikes spike3`) y los evals comparan ambos clasificadores sobre los 9
  documentos antes de dejar Jev como default (`02` 4c, riesgos).

## Actualización (2026-11-04): llamada real

Con `TYPESAFE_API_KEY` en `.env`, la corrida por defecto sobre BBVA clasificó con
`jev-1.13.0`: `bank_statement`, banco `bbva`, confianza 1, 210 ms, 1,403 tokens de entrada y
216 de salida. El clasificador por defecto pasa a Jev cuando hay llave, como estaba diseñado;
Haiku queda de respaldo. Falta fijar el precio de Jev en `models.ts` (hoy se registra como
costo 0) y comparar Jev contra Haiku en los 9 documentos en la fase 3.

