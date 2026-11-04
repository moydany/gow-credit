# Criterio de calificación: perfil crediticio + política por tenant

Fecha: 2026-11-04. Reemplaza la primera versión de este documento después de leer
gowcredit.com.

## 1. Qué hace GOW Credit en realidad

GOW Credit no presta. Es **infraestructura para prestamistas**: fintechs e instituciones
financieras (hoy 4 entidades, más de 800 empresas procesadas) que originan crédito PyME.
Su producto, según el sitio:

- **Diagnóstico crediticio automatizado**: de semanas a minutos.
- **Enriquecimiento con datos verificados**: SAT, buró y **transaccional** (estados de
  cuenta). Esto confirma por qué el dataset del worksample son estados de cuenta.
- **Motor de segunda oportunidad**: convertir un rechazo en un solicitante listo para
  crédito. El "no" viene con diagnóstico y con qué hacer para cambiarlo.
- **Multi-tenant**: cada prestamista opera aislado, con su propia política.
- Indicadores que muestran en su interfaz: ingresos, capacidad de pago (%), capacidad
  de endeudamiento (línea máxima en MXN), score de buró, monto solicitado, evolución
  mensual de ingresos y capacidad, y una recomendación de IA accionable ("tienes este
  pago pendiente que afecta tu buró; si está mal reportado, acláralo aquí").

Consecuencias para el worksample:

1. **La política es del tenant, no de GOW.** El sistema debe calcular un perfil
   estándar y dejar que cada prestamista defina cómo ese perfil se convierte en decisión.
   Por eso los criterios tienen que ser personalizables desde el diseño, no después.
2. **El resultado no es sí o no.** Es un diagnóstico: perfil, decisión según la política,
   razones, y para los que no califican, **qué cambiaría el resultado**.
3. **El loop de aclaración es parte del producto**, no un parche: preguntar al dueño del
   documento es la forma de mejorar el perfil del solicitante antes de rechazarlo.
4. **Los estados de cuenta son una de tres fuentes.** El perfil se diseña para que SAT y
   buró entren después como señales adicionales sin cambiar el motor.
5. El caso del enunciado (proveedores de una cadena de distribución que quieren cobrar
   facturas antes del vencimiento) es un tenant: un prestamista o la propia cadena con un
   programa de pronto pago. La relación con el comprador sigue siendo una señal clave.

## 2. Tres capas separadas

```
Fuentes  →  Perfil crediticio (features tipadas)  →  Política del tenant (datos)  →  Decisión + diagnóstico
```

- **Perfil**: catálogo fijo de features calculadas en código, tipadas, testeadas, con la
  misma definición para todos los tenants. Es lo que GOW controla y mejora.
- **Política**: datos versionados por tenant que dicen qué features importan, con qué
  umbrales y pesos, y qué pasa en cada caso. Es lo que el prestamista controla.
- **Decisión**: el motor aplica la política al perfil y produce resultado, razones y
  diagnóstico. Determinístico, replicable, sin LLM.

## 3. Perfil crediticio: catálogo de features

Calculadas sobre el estado de cuenta (una o varias cuentas, uno o varios meses).
"Ingresos operativos" son los abonos clasificados como `customer_payment`, excluyendo
traspasos propios, préstamos recibidos y abonos con confianza baja.

| Feature | Tipo | Definición |
|---|---|---|
| `months_of_history` | int | meses completos cubiertos por los documentos |
| `document_age_days` | int | días desde la fecha de corte más reciente |
| `identity_match` | `match \| partial \| mismatch \| unknown` | titular, RFC y CLABE contra el proveedor registrado |
| `integrity_ok` | bool | saldo inicial + abonos − cargos = saldo final y movimientos = totales |
| `red_flags` | lista cerrada | `overdraft`, `returned_check`, `garnishment`, `judicial_order`, `tax_requirement` |
| `activity_count` | int | movimientos en el periodo |
| `operating_income_monthly` | MXN | ingresos operativos promedio mensual |
| `operating_expenses_monthly` | MXN | cargos operativos (proveedores, nómina, impuestos, comisiones) |
| `debt_service_monthly` | MXN | pagos a créditos |
| `new_debt_in_period` | MXN | préstamos recibidos en el periodo |
| `free_cash_flow_monthly` | MXN | ingresos operativos − gastos operativos − servicio de deuda |
| `payment_capacity_pct` | % | flujo libre / ingresos operativos. Es la "capacidad de pago" del sitio |
| `debt_capacity` | MXN | línea que el flujo libre soporta. Es la "capacidad de endeudamiento" del sitio |
| `avg_daily_balance` | MXN | saldo promedio diario |
| `low_balance_days` | int | días con saldo bajo el umbral configurado |
| `income_trend` | % | pendiente de ingresos mes a mes (requiere 3+ meses); es la "evolución" del sitio |
| `buyer_payments_count` / `buyer_payments_amount` | int / MXN | pagos del comprador identificados |
| `recurring_income_share` | % | ingresos marcados como recurrentes |
| `top_payer_concentration` | % | participación del mayor pagador |
| `existing_exposure_balance` / `existing_exposure_days_past_due` / `existing_exposure_payment_ratio` | MXN / int / % | créditos vigentes con este prestamista (adaptador `ExistingCredits`); la línea nueva se calcula sobre capacidad menos exposición y el atraso es compuerta |
| `external_debt_signal` | MXN | préstamos recibidos y pagos a otras instituciones vistos en el estado de cuenta, confirmados por buró cuando exista |
| `program_available_limit` | MXN | cupo disponible del programa del comprador, configurado por el tenant |
| `prior_applications` | lista | solicitudes previas del proveedor con este tenant: duplicados, re-solicitudes, historial |
| `buro_score`, `sat_status` | opcional | entran cuando existan los adaptadores; hoy `unknown` |

Cada feature lleva `confidence` cuando depende de clasificación (Jev o Claude) y
`provenance` (`extracted`, `owner_answer`, `analyst_answer`, `external`). Las reglas pueden exigir
confianza mínima.

## 4. Política: qué puede personalizar el tenant

Una política es un documento JSON validado por un esquema Zod cerrado. No ejecuta código:
solo compone features del catálogo con operadores conocidos. Cuatro bloques:

```jsonc
{
  "version": 3,
  "gates": [
    { "id": "doc_recent", "when": { "feature": "document_age_days", "op": "<=", "value": 90 },
      "onFail": { "status": "needs_clarification", "ask": "recent_statement" } },
    { "id": "identity", "when": { "feature": "identity_match", "op": "in", "value": ["match"] },
      "onFail": { "status": "needs_clarification", "ask": "identity_fields" },
      "onUnknown": "ask" },
    { "id": "integrity", "when": { "feature": "integrity_ok", "op": "==", "value": true },
      "onFail": { "status": "human_review" } },
    { "id": "no_red_flags", "when": { "feature": "red_flags", "op": "empty" },
      "onFail": { "status": "human_review" } },
    { "id": "no_arrears", "when": { "feature": "existing_exposure_days_past_due", "op": "<=", "value": 0 },
      "onFail": { "status": "not_qualified" }, "onUnknown": "pass" }
  ],
  "score": {
    "dimensions": [
      { "id": "capacity", "weight": 35, "feature": "operating_income_monthly",
        "relativeTo": "requested_amount", "zeroAt": 0.5, "fullAt": 3 },
      { "id": "buyer", "weight": 25, "feature": "buyer_payments_count", "zeroAt": 0, "fullAt": 2 },
      { "id": "stability", "weight": 15, "feature": "payment_capacity_pct", "zeroAt": 0.1, "fullAt": 0.5 },
      { "id": "debt", "weight": 15, "feature": "debt_service_monthly",
        "relativeTo": "operating_income_monthly", "zeroAt": 0.4, "fullAt": 0.1, "inverse": true },
      { "id": "recurrence", "weight": 10, "feature": "recurring_income_share", "zeroAt": 0.2, "fullAt": 0.6 }
    ],
    "minConfidence": 0.7
  },
  "decision": {
    "bands": [
      { "min": 70, "status": "qualified", "limit": { "pctOf": "operating_income_monthly", "pct": 50 } },
      { "min": 50, "status": "qualified_with_limit", "limit": { "pctOf": "operating_income_monthly", "pct": 25 } },
      { "min": 0,  "status": "not_qualified" }
    ],
    "caps": [ { "when": { "feature": "months_of_history", "op": "<", "value": 3 }, "maxStatus": "qualified_with_limit" } ],
    "limitFormula": "min(band, debt_capacity - existing_exposure_balance, program_available_limit)"
  },
  // limitFormula no es código: es una gramática cerrada, `min(...)` de términos donde cada
  // término es `band`, una feature numérica, o `feature - feature`. Se parsea y valida
  // contra el catálogo al guardar; cualquier otra forma se rechaza.
  // (los comentarios `//` no van en el JSON real; este bloque es jsonc ilustrativo)
  "clarification": { "maxRounds": 1, "askWhenAmountAbovePctOfIncome": 30 }
}
```

Lo que el tenant puede tocar: qué compuertas aplican y qué pasa al fallar, qué
dimensiones pesan y con qué rangos, las bandas de decisión y la fórmula de la línea, los
topes por historial, y cuándo y cuántas veces se pregunta al proveedor. Lo que no puede
tocar: la definición de las features ni agregar código. Si necesita una feature nueva, la
agrega GOW al catálogo con sus tests, y queda disponible para todos.

### Tipado del DSL

El esquema de política es una unión discriminada por `op`, y el `feature` de cada regla se
valida contra el catálogo: una regla `op: "<="` solo acepta features numéricas, `op: "in"`
solo enums, `op: "empty"` solo listas. El error aparece al guardar la política, no en
producción. En código, `evaluate(policy, profile)` es una función pura con matching
exhaustivo sobre `op` y sobre `status`.

Se evaluó `json-rules-engine` (open source, muy usado) como alternativa. Se descarta
porque sus condiciones son strings sin tipo y porque el DSL necesario es pequeño; se
anota en las decisiones de diseño.

## 5. Ciclo de vida de una política

- **Versionada e inmutable**: cada cambio crea una versión; toda decisión guarda
  `policy_version` y el perfil completo, así cualquier decisión se puede re-explicar.
- **Plantilla GOW**: cada tenant arranca clonando la política base (la de arriba). GOW
  mantiene la plantilla con lo aprendido entre tenants.
- **Simulación antes de activar**: `POST /policies/:id/simulate` reevalúa las últimas N
  solicitudes del tenant con la versión borrador y devuelve el diff: cuántas cambian de
  estado, en qué dirección, y mora observada en las que tienen outcome. Es el replay
  offline del plan de evaluación.
- **Modo sombra**: una versión se puede activar como sombra; se evalúa en cada solicitud
  y se registra sin decidir. Se promueve por flag.
- **Bitácora**: quién cambió qué, cuándo, y con qué simulación a la vista.
- **Edición**: backoffice por tenant (formulario generado del esquema Zod o JSON) y API.
  RLS garantiza que un tenant solo ve sus políticas. Ver `08`.

## 6. Salida: diagnóstico, no solo veredicto

```
status:      qualified | qualified_with_limit | not_qualified | needs_clarification | human_review
limit:       MXN
profile:     todas las features con valor, confianza y procedencia
evaluation:  por compuerta y por dimensión, con valor, umbral y puntos
reasons:     lista legible para el analista del tenant
next_steps:  para el proveedor: qué cambiaría el resultado
```

`next_steps` se calcula con **contrafactuales sobre la misma política**: para cada
compuerta fallida o dimensión baja, cuánto tendría que cambiar la feature para subir de
banda ("con 3 meses de historial el tope desaparece", "si el depósito del 15 de junio es
pago de cliente y no préstamo, la capacidad sube de 48 a 71"). Es el "motor de segunda
oportunidad" del sitio aplicado al caso. El texto final lo redacta Claude a partir de
esa lista estructurada; los números vienen del motor.

## 7. Cuándo se pregunta al dueño del documento

Según la política del tenant, pero siempre con la misma regla: solo si la respuesta puede
cambiar la banda y el proveedor puede saberla. Casos base: campos de identidad ilegibles,
documento viejo, descuadre, y abonos grandes sin clasificar o clasificados como préstamo
con confianza media. Las respuestas entran al perfil con `provenance: owner_answer` y se
ven en `reasons`.

## 8. Cómo aprende

Por tenant: outcomes contra decisiones por `policy_version`; el job nocturno propone una
versión nueva con pesos y umbrales ajustados, la deja como borrador con su simulación
adjunta, y el analista del tenant decide si la activa. Entre tenants: GOW observa qué
features predicen mora en el agregado y mejora la plantilla y el catálogo. Nada se
reentrena; lo que se aprende son umbrales y pesos de una política explicable.

## 9. Limitaciones declaradas

- Un mes de historial es poco; la política base lo topa en `qualified_with_limit`.
- Sin buró ni SAT en esta versión; el perfil ya tiene los campos y las políticas pueden
  referenciarlos cuando existan.
- La clasificación de movimientos tiene error; las reglas exigen confianza mínima y los
  casos de alto impacto se preguntan.

---

## Cambios durante la implementación

### Fase 1 (2026-11-04): contratos en `packages/contracts`

Nada de lo que sigue cambia el criterio; son precisiones que el esquema necesitaba para
poder validarse.

- **Desconocido es `null`.** Toda feature desconocida tiene `value: null` en el perfil.
  Por eso `identity_match` es `match | partial | mismatch`, sin `unknown`. Si `unknown`
  fuera un valor, la compuerta `identity` (`in ["match"]`) lo trataría como fallo y nunca
  llegaría a `onUnknown: "ask"`.
- **Operadores por tipo**: `int | money | ratio` → `< <= > >= == !=`; `bool` → `== !=`;
  `enum` → `in not_in`; listas (`red_flags`, `prior_applications`) → `empty not_empty`.
  Cualquier otra combinación se rechaza al parsear, con la ruta exacta del error.
- **`onUnknown`** acepta `ask | pass | fail | human_review`; si se omite, el default es
  `fail` (conservador). `ask` exige `onFail.ask`.
- **`requested_amount` es una feature** del catálogo (fuente `request`), porque la
  dimensión `capacity` la usa en `relativeTo`.
- **Validaciones adicionales**: los pesos de las dimensiones suman 100; `inverse: true`
  exige `zeroAt > fullAt` y viceversa; las bandas van de mayor a menor puntaje sin mejorar
  el estado y la última empieza en 0; `limit` en las bandas que califican, sobre una
  feature `money`; `band` aparece exactamente una vez en `limitFormula`, y sus términos son
  features `money`.
- **Plantilla base** en `policies/gow-base.v1.json`: la de §4 más un tope
  `buyer_payments_count == 0 → qualified_with_limit`, que pide el escenario 11 de `06`
  ("perfil sano sin pagos del comprador → máximo `qualified_with_limit`"); con solo la
  dimensión `buyer` ese escenario podía salir `qualified`.
