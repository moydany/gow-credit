# Escenarios y modo simulación

Fecha: 2026-11-04. Objetivo: poder ejecutar el sistema completo, de punta a punta, con
todo lo externo simulado: desde el alta de un prestamista hasta la decisión sobre un
proveedor que ya tiene un crédito. Sirve para tres cosas a la vez: demo en la llamada,
pruebas end-to-end en CI, y simulación de políticas sobre casos conocidos.

## 1. Idea

Un **escenario** es un archivo de datos que describe un mundo completo: el tenant y su
política, los proveedores y sus contactos, los documentos que suben, lo que dirían las
fuentes externas (crédito vigente, buró, SAT), lo que respondería el proveedor por
WhatsApp, y el resultado esperado. Un comando lo ejecuta contra el sistema real (misma
base, mismas colas, mismo workflow de Mastra) con los adaptadores externos en modo
simulado, y compara el resultado con el esperado.

```
pnpm scenario run proveedor-con-credito-vigente
pnpm scenario run --all            # en CI
pnpm scenario run --policy drafts/v4.json --all   # ¿qué pasaría con otra política?
```

Nada del código de negocio sabe que está en simulación: solo cambian las
implementaciones de las interfaces externas.

## 2. Interfaces externas y sus dobles

| Interfaz | Real (después) | Simulada (ahora) |
|---|---|---|
| `ClarificationChannel` | Baileys, Resend | respuestas guionadas con retrasos; sin respuesta para probar timeout |
| `ExistingCredits` | core del prestamista | lista de créditos vigentes por proveedor: saldo, cuota, días de atraso |
| `CreditBureau` | buró de crédito | score y cuentas abiertas |
| `TaxAuthority` | SAT | RFC válido, situación fiscal, opinión de cumplimiento |
| `Clock` | reloj real | reloj controlable para vencimientos y timeouts |
| `DocumentSource` | Supabase Storage | los 9 estados de cuenta de desarrollo y PDFs sintéticos |

Los modelos (Claude y Jev) **no** se simulan en los escenarios de demo: se usan de
verdad, con caché de respuestas por hash de entrada para que la corrida sea
reproducible y barata. En CI se puede fijar la caché para que no haya llamadas.

## 3. Forma de un escenario

```yaml
id: proveedor-con-credito-vigente
tenant:
  name: Fintech Demo
  policy: base            # o ruta a un JSON de política
  whatsapp_number: "+5215500000001"
suppliers:
  - id: sup-1
    name: Distribuidora Luna SA de CV
    rfc: DLU150304AB1
    contacts: [{ channel: whatsapp, address: "+5215511111111", verified: true }]
    documents: [EDC_04_Banamex_2026-02.pdf]
    request: { amount: 180000, maturity: 2026-04-15, buyer: "Cadena Norte" }
external:
  existing_credits:
    sup-1: [{ product: linea_pronto_pago, balance: 120000, monthly_payment: 30000, days_past_due: 0 }]
  bureau: { sup-1: { score: 640, open_accounts: 3 } }
  sat:    { sup-1: { rfc_valid: true, compliance_opinion: positive } }
conversation:
  - on_question: deposit_classification
    reply: "Es un pago de cliente, de Cadena Norte"
expect:
  status: qualified_with_limit
  limit_max: 90000           # la línea se reduce por la exposición vigente
  reasons_include: [existing_exposure]
```

## 4. Catálogo de escenarios

**Alta y configuración**

1. `alta-de-tenant`: crear prestamista, clonar política base, registrar número de
   WhatsApp, emitir llave de API, dar de alta proveedores con contactos. Verifica que el
   tenant queda aislado (un segundo tenant no ve nada de él).
2. `cambio-de-politica`: mismo proveedor bajo política v1 y v2; muestra el diff de
   simulación y la activación en modo sombra.

**Perfil del proveedor**

3. `proveedor-nuevo-un-mes`: un estado de cuenta → califica con tope por historial.
4. `proveedor-tres-meses`: tres estados consecutivos → tope desaparece, aparece tendencia.
5. `proveedor-con-credito-vigente`: ya tiene línea con este prestamista, al corriente →
   la línea nueva se calcula sobre la capacidad **menos la exposición vigente**.
6. `proveedor-con-credito-en-mora`: crédito vigente con atraso → compuerta, no califica,
   `next_steps` dice cuánto regularizar.
7. `proveedor-con-deuda-externa`: sin crédito con nosotros, pero el estado de cuenta
   muestra un préstamo recibido y pagos a otra institución → sube el servicio de deuda,
   baja la capacidad; con buró simulado confirma cuentas abiertas.
8. `proveedor-solicitud-duplicada`: sube el mismo PDF dos veces → una sola solicitud.
9. `re-solicitud-tras-rechazo`: rechazado por historial, vuelve con más meses → califica.
   Es la "segunda oportunidad" en acción.

**Comprador y programa**

10. `cupo-de-programa-agotado`: la cadena tiene un cupo total para pronto pago y ya está
    comprometido → califica el proveedor pero la línea se topa por `program_available_limit`.
11. `sin-pagos-del-comprador`: perfil sano pero el comprador no aparece en el estado →
    máximo `qualified_with_limit`.

**Aclaraciones**

12. `aclaracion-respondida`: depósito grande sin clasificar → pregunta por WhatsApp →
    respuesta → reanuda y califica.
13. `aclaracion-sin-respuesta`: nadie contesta en el plazo → el reloj avanza →
    `human_review` con razón "sin respuesta".
14. `aclaracion-contradictoria`: el proveedor dice que el depósito es pago de cliente pero
    el emisor es una financiera → `human_review`.
15. `respuesta-de-numero-ajeno`: otro número intenta responder citando el folio →
    rechazada, registrada; la solicitud sigue pendiente.

**Documentos difíciles**

16. `documento-ilegible-hsbc`: texto corrupto → ruta por visión → extracción válida.
17. `documento-viejo`: corte de hace 120 días → se pide uno reciente.
18. `no-es-estado-de-cuenta`: se sube otra cosa → rechazo con razón.
19. `pdf-con-instrucciones-ocultas`: texto inyectado → extracción idéntica al documento
    limpio. Es la prueba de inyección.

**Ciclo de aprendizaje**

20. `outcomes-y-calibracion`: se cargan resultados (pagó, mora) de varios escenarios →
    el job nocturno propone una política borrador con su simulación adjunta.

## 5. Features nuevas que esto exige

Se agregan al catálogo del perfil (doc 03):

| Feature | Fuente | Uso en política |
|---|---|---|
| `existing_exposure_balance` | `ExistingCredits` | la línea se calcula sobre capacidad menos exposición |
| `existing_exposure_days_past_due` | `ExistingCredits` | compuerta: con atraso no califica |
| `existing_exposure_payment_ratio` | `ExistingCredits` | cuota vigente sobre flujo libre |
| `external_debt_signal` | extracción + buró | préstamos recibidos y pagos a terceros |
| `program_available_limit` | tenant (cupo del comprador) | tope de línea |
| `prior_applications` | base propia | re-solicitud, duplicados, historial con nosotros |

La política base incorpora: compuerta `no_arrears` sobre `existing_exposure_days_past_due`,
y fórmula de línea `min(banda, debt_capacity − existing_exposure_balance, program_available_limit)`.

## 6. Cómo se usa en la llamada

Se corre `alta-de-tenant` y luego `proveedor-con-credito-vigente` en vivo, con Studio
abierto para ver el workflow, la pausa de aclaración y la reanudación. Después se corre
`cambio-de-politica` para mostrar el diff. Son tres comandos y cubren alta, decisión,
aclaración y personalización.

## 7. Cómo se usa en CI

Todos los escenarios corren con caché de modelos fijada y aserciones sobre estado,
línea y razones. Un cambio en reglas, prompts o políticas base que mueva un resultado
esperado falla el build y obliga a actualizar el escenario a propósito.

---

## Cambios durante la implementación

### Fase 2 (2026-11-04)

`docs/09` agrega escenarios que entran al catálogo cuando se construyan las fases 4 a 6:
21 "CFDI cancelado → human_review", 22 "estado de cuenta sin CFDI (Mercado Pago) → sin
penalización", 23 "mismo UUID presentado a otro tenant hace 3 días → human_review", 24
"pagador principal en 69-B definitivo → not_qualified", 25 "RESICO con ingresos
anualizados sobre el tope → pregunta al dueño". El doble `TaxAuthority` gana
`cfdi: { "<uuid>": valid | cancelled | not_found }`.

### Fase 4 (2026-11-04): modo unitario (ADR 0014)

- **Los escenarios corren en modo `unit`** sin LLM ni base: `scenarios/catalog/*.yaml` con el
  formato de §3 más `statements`, estados de cuenta sintéticos generados en código con
  descripciones de banco. Pasan por la clasificación por reglas, el perfil, los dobles
  simulados y el motor reales. El modo `full` (PDFs, workflow, caché de modelos) es de la
  fase 6; `modes` dice cuál aplica.
- **Formato**: `as_of` fija el reloj, el comprador acepta texto u objeto (`name`, `rfc`,
  `aliases`) y `expect` admite `status`, `limit`, `limit_min`, `limit_max`, `reasons_include`
  (códigos estables, por ejemplo `existing_exposure`), `next_steps_include` (features),
  `clarification_topics` y `features` exactas. El bloque `external` gana `cfdi`, `sat_lists`,
  `program` e `history`.
- **Contrato**: el esquema está en `@gow/contracts` (`Scenario`) y publicado en
  `docs/schema/scenario.schema.json`.
- **Catálogo hoy**: 3, 4, 5, 6, 7, 10, 11 y 17 con la política base; 21 a 25 con
  `policies/examples/fiscal-anchors.v1.json`.
- **Ejemplo de §3**: en el escenario 5, la línea queda en unos 46 mil (máximo esperado 90 mil)
  porque la fija la capacidad menos la exposición vigente.
- `pnpm scenario run <id>|--all [--policy <json>]`. Con `--policy`, imprime qué pasaría con
  otra política, sin comparar con `expect`.

### Fase 6 (2026-11-05): modo full (ADR 0018)

- **Qué es real**: `pnpm scenario run --all --mode full` corre la API, pg-boss, el worker (Mastra en
  Postgres) y el relay de WhatsApp sobre una base nueva por escenario.
- **Qué se simula**:
  - las fuentes externas, con los datos del YAML;
  - el teléfono del proveedor, que recibe del buzón y contesta el guion;
  - los modelos, con caché fija y sin llamadas. Movimientos por reglas y redacción con
    plantillas.
- **§2, `DocumentSource`**: los estados sintéticos se suben como `.synthetic.json`, que solo
  aceptan la API y el worker de los escenarios; los PDF salen de `data/dev` o de la eval de
  inyección (`adversarial:<id>`).
- **Formato**: la conversación acepta `from` (otro número), y `expect.full` comprueba:
  - estado de la solicitud;
  - resoluciones de los entrantes;
  - aislamiento de otro tenant;
  - ruta, movimientos, banderas y montos ausentes de la extracción.

  Una solicitud lleva un documento.
- **Catálogo full**: 1, 5, 6, 12, 15, 16 y 19. El 16 necesita `data/dev` y se salta sin él; el 19
  corre en CI. Los demás de §4 (2, 8, 9, 13, 14, 18, 20) siguen sin escenario.
