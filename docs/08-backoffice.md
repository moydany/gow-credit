# Backoffice

Fecha: 2026-11-04. El backoffice es la cara del sistema para los usuarios del prestamista
(tenant). Las operaciones de plataforma de GOW se hacen por CLI en esta versión (sección 3). No es para el proveedor: el proveedor interactúa por WhatsApp, correo o
la integración del prestamista. Un portal de proveedor queda fuera de alcance y se anota
como futuro.

## 1. Usuarios y rol (versión inicial)

**Un solo rol, varios usuarios por tenant.** En esta versión todo usuario del backoffice
pertenece a un tenant y puede hacer todo dentro de él: ver solicitudes, corregir en
revisión, responder aclaraciones, registrar outcomes, editar, simular y activar
políticas, invitar usuarios y emitir llaves de API. No hay distinción entre analista,
administrador y auditor todavía.

- Tabla `tenant_users(tenant_id, user_id, email, invited_by, created_at)`. Un usuario
  pertenece a un tenant. Se invita por correo desde el backoffice (Supabase Auth envía el
  enlace); al aceptar queda la membresía.
- El JWT lleva `tenant_id` como claim firmado. RLS filtra por ese claim en todas las
  tablas de negocio. No hay claim de rol que evaluar; la pertenencia al tenant es la
  autorización completa.
- **Bitácora por usuario** desde el primer día: aunque todos puedan todo, queda quién
  hizo qué. Esto es lo que permite agregar roles después sin perder historia.
- MFA disponible y recomendado; no obligatorio en esta versión.
- Las operaciones de plataforma (alta de tenant, plantilla de política, catálogo de
  features) no tienen pantalla: se hacen por CLI y seeds del repo. Un tenant no puede ver
  ni crear otros tenants.

**Cómo se agregan roles después sin rehacer nada.** Se añade una columna `role` a
`tenant_users` con valor por defecto igual al rol único actual, se incluye en el JWT y las
políticas RLS de escritura pasan a exigirlo en las tablas sensibles (`policies`,
`api_keys`, `tenant_users`). Las pantallas ocultan botones según el rol. Es un cambio de
datos y de políticas, no de arquitectura. Los roles previstos están en el apéndice.

## 2. Pantallas del tenant

**Solicitudes (bandeja).** Lista con estado (`received`, `extracting`,
`needs_clarification`, `human_review`, `qualified`, `qualified_with_limit`,
`not_qualified`, `failed`), proveedor, monto solicitado, línea, antigüedad, versión de
política. Filtros por estado y fecha. Se actualiza en tiempo real (Supabase Realtime
sobre la tabla `applications`, filtrado por RLS).

**Detalle de solicitud.** Es la pantalla central y la que se muestra en la llamada.
Tres columnas:

- El PDF (visor pdf.js con URL firmada de vida corta).
- La extracción: encabezado, resumen y movimientos. Cada valor es clicable y lleva al
  `source_page` del PDF; los valores `unverified` o `conflict` se resaltan y muestran la
  lectura alternativa cuando hubo doble lectura. Es la vista "lado a lado" del documento
  de alucinaciones.
- La decisión: perfil con confianza y procedencia, evaluación de cada compuerta y
  dimensión con valor y umbral, razones, `next_steps`, historial de aclaraciones y la
  versión de política aplicada. Botón "re-evaluar con política X" para ver qué cambiaría.

**Revisión humana.** Cola de solicitudes en `human_review` con el motivo. El analista
corrige un valor (con el PDF al lado), confirma identidad o descarta el documento. Cada
corrección se guarda como par (valor leído, valor correcto, página) y alimenta el
dataset de evals. Al resolver, la solicitud se reencola a `decide`.

**Aclaraciones.** Preguntas abiertas por solicitud, canal, fecha de envío y estado. El
analista puede responder a nombre del proveedor (queda con procedencia `analyst_answer`),
reenviar por otro canal o cerrar y mandar a revisión.

**Proveedores.** Alta y edición, contactos por canal con estado de verificación,
historial de solicitudes, créditos vigentes (del adaptador `ExistingCredits`) y
outcomes.

**Outcomes.** Registrar por solicitud financiada: pagó a tiempo, días de atraso, mora,
fraude. Es el dato que cierra el loop; sin esta pantalla no hay aprendizaje.

**Políticas.** Lista de versiones con estado (`draft`, `shadow`, `active`, `archived`).
Editor en dos modos: formulario generado del esquema Zod (compuertas, dimensiones,
bandas, aclaración) y JSON con validación en vivo. Botón **Simular**: corre la versión
borrador sobre las últimas N solicitudes del tenant y sobre los escenarios, y muestra
el diff: cuántas cambian de estado y hacia dónde, mora observada en las que tienen
outcome. **Activar en sombra** y **Promover**, con confirmación y bitácora. Las
propuestas del job nocturno aparecen aquí como borradores con su simulación adjunta.

**Configuración.** Usuarios (invitar y quitar), llaves de API (se muestran una vez), canal de
WhatsApp (vinculación por QR para Baileys o credenciales de Cloud API), cupos de
programa por comprador, retención de documentos, aviso de privacidad.

**Bitácora.** Quién vio qué solicitud, quién corrigió qué valor, quién cambió o activó
qué política, quién respondió qué aclaración. Solo lectura, exportable.

## 3. Pantallas de plataforma (GOW): no en esta versión

En la versión inicial estas operaciones se hacen por CLI y seeds; las pantallas quedan
diseñadas para cuando exista el rol de plataforma.

- **Tenants**: alta con clonado de la plantilla de política, estado, contacto, consumo.
- **Operación**: profundidad y edad de colas de pg-boss, dead letter con reintento manual,
  solicitudes atoradas, tasa de fallo de cuadre, tasa de corrección en revisión por
  versión de prompt, 429 del proveedor, pool de Postgres. Son las señales del caso de
  incidente; verlas en una pantalla es la respuesta a "qué observabilidad exigirías".
- **Costos**: tokens y costo por tenant, por documento y por versión de prompt; alerta
  por umbral.
- **Modelos y prompts**: versiones de prompt con porcentaje de tráfico y modo sombra;
  resultados de evals por versión; promoción y rollback.
- **Catálogo de features y plantilla de política**: edición con versionado; un cambio en
  la plantilla no toca las políticas ya clonadas, solo las nuevas.
- **Agregado entre tenants**: qué features predicen mora en el total, sin exponer datos
  de un tenant a otro. Es la base del "mejoramos la plantilla con lo aprendido".

## 4. Técnica

- `apps/web`: React 19 + Vite + TypeScript estricto, desplegado en Vercel. TanStack
  Router y Query, shadcn/ui con Tailwind, react-hook-form con los esquemas Zod de
  `packages/contracts` (el formulario de política se genera del mismo esquema que
  valida el motor, así que no pueden divergir).
- Acceso a datos **solo por la API** con cliente tipado generado del OpenAPI que
  produce Express con `zod-to-openapi`. Una excepción deliberada: suscripciones en tiempo
  real vía Supabase Realtime con el JWT del usuario, protegidas por RLS.
- Supabase Auth en el navegador; el JWT lleva `tenant_id` (y, cuando existan, el rol). Sin `service_role`, sin
  secretos, sin variables públicas sensibles. CSP estricta, cookies `SameSite`, sin
  `localStorage` para tokens.
- Visor de PDF con pdf.js; resaltado de página por campo a partir de `source_page`.
- Toda mutación pasa por el API y se registra en bitácora con usuario, tenant, acción y
  antes/después.
- Mastra Studio no se expone a tenants: es herramienta de desarrollo.

## 5. Prioridad para el worksample

| Nivel | Pantallas |
|---|---|
| Obligatorio para la demo | Solicitudes, Detalle de solicitud (PDF, extracción, decisión), Aclaraciones con respuesta manual |
| Debería | Revisión humana con corrección, Políticas con editor JSON y Simular, Outcomes |
| Si alcanza | Formulario generado, Proveedores completo, Configuración de WhatsApp por QR, Bitácora en pantalla |
| Después | Roles diferenciados, pantallas de plataforma |

El detalle de solicitud y la simulación de políticas son las dos pantallas que mejor
cuentan la historia en la llamada: una muestra verificación y explicabilidad, la otra
muestra personalización y el loop de aprendizaje.

## Apéndice: roles previstos para después

| Rol | Quién | Alcance |
|---|---|---|
| `platform_admin` | equipo GOW | todos los tenants: alta, plantilla de política, catálogo de features, operación, costos, versiones de prompt; cada acceso a datos de un tenant en bitácora |
| `tenant_admin` | responsable del prestamista | usuarios, llaves de API, canal de WhatsApp, activar políticas, cupos, retención |
| `tenant_analyst` | analista de crédito | solicitudes, revisión humana, aclaraciones, proveedores, outcomes, editar y simular políticas sin activar |
| `tenant_auditor` | auditoría o riesgo | solo lectura, incluida la bitácora |

---

## Cambios durante la implementación

- **Backoffice.** `apps/web` y `/bo/v1` en `apps/api`:
  - **Hecho.** Solicitudes (bandeja con filtros y búsqueda), Detalle en tres paneles (PDF con
    resaltado del fragmento citado, extracción con valores sin verificar rayados, decisión con
    compuertas, dimensiones, contrafactuales y perfil), Aclaraciones con respuesta manual, Revisión
    humana (cola con motivo), Políticas con editor JSON, **Simular**, sombra y promover, Outcomes y
    Bitácora con el usuario.
  - **Distinto al plan.** La sesión es una cookie `HttpOnly` que sale de un JWT (Supabase Auth en
    producción, enlace de `pnpm tenant user add` en desarrollo); el PDF se sirve por la API; las listas
    se refrescan por sondeo y no por Realtime.
  - **Pendiente.** Formulario de política generado del esquema, Proveedores, Configuración y modo oscuro.
- **Corrección en revisión humana.** El analista corrige titular, CLABE, cifras del
  resumen y movimientos con el PDF al lado; cada corrección se guarda como par (leído, correcto, página) y la
  solicitud se reevalúa sin modelos con las correcciones aplicadas encima de la extracción inmutable.
  Descartar un documento y exportar los pares al ground truth de las evals quedan pendientes.

- **Pantallas que faltaban.**
  - **Proveedores.** Lista con número de solicitudes y la última; detalle con RFC, CLABEs,
    contactos por canal con su verificación, historial de solicitudes y outcomes. Alta y edición
    de razón social, RFC y CLABEs, validadas con los mismos contratos que la API. Abrir un
    proveedor entra a la bitácora, como abrir una solicitud.
  - **Distinto al plan, en Proveedores:**
    - Los contactos son de solo lectura: los vínculos verificados siguen entrando por `/v1`.
    - "Créditos vigentes" no aparece: el adaptador `ExistingCredits` no tiene tabla todavía.
  - **Configuración.**
    - **Usuarios**: invitar, con el enlace de acceso visible una sola vez, y quitar; nadie puede
      quitarse a sí mismo.
    - **Llaves de API**: crear (se muestra una sola vez y se guarda como hash) y revocar; la API
      no puede leer el hash.
    - **Solo lectura**: el estado de WhatsApp, con la instrucción para vincularlo, la retención y
      el aviso de privacidad.
  - **Revisión humana: descartar el documento** con un motivo cerrado. La solicitud cierra en
    `not_qualified` sin reevaluar.
    **Avisa al proveedor por WhatsApp** con el motivo (ADR 0069); sin contacto verificado queda en la bitácora.
  - **Revisión humana: exportar las correcciones** a las evals (`pnpm corrections:export`) y
    medirlas contra el modelo actual (`pnpm -F @gow/evals corrections`).
  - **Sigue pendiente**: el formulario de política generado del esquema, la vinculación de
    WhatsApp por QR desde la pantalla y el modo oscuro.
  - **WhatsApp por QR desde Configuración (2026-11-06).** Ya no es de solo lectura.
    La tarjeta muestra, según el estado:
    - el QR para escanear, con los pasos en el teléfono, actualizado cada 2 s;
    - el número vinculado, con "Desvincular", que cierra la sesión y deja un QR nuevo para
      vincular este u otro número;
    - cómo arrancar el proceso si no corre;
    - qué hacer si la sesión se cerró desde el teléfono.

    Ver el QR y pedir desvincular quedan en la bitácora. El menú de usuario, Solicitudes y
    Aclaraciones usan el número vinculado. Sale de "Sigue pendiente".
  - **Login con Supabase Auth (2026-11-06).** Con `SUPABASE_URL` y
    `SUPABASE_SERVICE_ROLE_KEY`, la pantalla de acceso pide el correo y Supabase Auth manda el
    enlace. La respuesta es la misma tenga o no cuenta. Un custom access token hook agrega
    `tenant_id` al token de quien es miembro. Cambios:
    - Invitar desde Configuración crea la cuenta de Auth y le manda el enlace; ya no muestra un
      enlace para compartir.
    - Quitar a un usuario solo quita la pertenencia.
    - La sesión dura lo que el access token (una hora por defecto) y no se refresca.

    Sin Supabase sigue el enlace con el JWT de `pnpm tenant user add`.
  - **La sesión se renueva sola (2026-11-06).** Con Supabase Auth, `/entrar` manda
    también el refresh token; la API lo guarda cifrado en una cookie `HttpOnly` y renueva el
    access token cuando le quedan menos de 5 min o ya venció. Las consultas que se refrescan solas
    mantienen viva la sesión. Cambios:
    - Dura hasta 12 h desde que se entra, o hasta 8 h sin usar el backoffice; después se pide otro
      enlace. Las dos se configuran (`BACKOFFICE_SESSION_MAX_HOURS`, `BACKOFFICE_SESSION_IDLE_HOURS`).
    - Salir cierra también la sesión de Supabase Auth.
    - Quitar a un usuario lo saca en su siguiente petición y cierra su sesión de Supabase Auth en
      ese momento.

    Sin Supabase nada cambia.

- **Antigüedad máxima del estado de cuenta.**
  - **Configuración → Análisis**: 1, 2, 3, 6 o 12 meses, o sin límite (3 por defecto). Se cambia con
    `PATCH /bo/v1/settings`, queda en la bitácora y aplica a lo que se analice desde ese momento y a
    las reevaluaciones.
  - Un estado de cuenta más viejo se analiza igual: el panel de decisión muestra "Estado de cuenta
    antiguo" con la antigüedad y el límite, y la lista de solicitudes lo etiqueta "Estado antiguo".
  - Una solicitud fallida por PDF con contraseña o por un escaneado ilegible lo dice en su motivo.

- **Borrar un proveedor.** Proveedores → detalle → Borrar se lleva al proveedor con sus
  solicitudes, documentos, decisiones, aclaraciones, resultados de crédito, registro y mensajes
  (`DELETE /bo/v1/suppliers/:id`). Con una solicitud en proceso contesta 409. Los PDFs, el estado de
  Mastra y los trabajos de la cola los borra el worker con `supplier.purge`. La bitácora guarda solo
  los conteos.

- **Wizard del primer inicio.** Con el sistema vacío, `/entrar` lleva a
  `/configuracion-inicial`: crea el tenant, su política base y al administrador (`POST /bo/v1/setup`) y
  sigue con la tarjeta de WhatsApp de Configuración. Sin código ni límites: pensado para correr solo en
  local; antes de exponer la API hay que cerrarlo.

- **Llamadas al modelo en la bitácora.** Bitácora tiene dos pestañas: Movimientos (quién
  hizo qué) y Llamadas al modelo. La segunda lista cada llamada con propósito, modelo, resultado,
  tokens, costo y tiempo, filtrable por solicitud y por error; el detalle muestra el system prompt, la
  instrucción, la respuesta o la salida cruda y el error, y se copia o descarga como JSON. Abrir un
  detalle queda en Movimientos como "Vio una llamada al modelo". El detalle de una solicitud tiene el
  botón "Llamadas al modelo".

- **Prompts.** Página nueva "Prompts", después de Políticas y con el mismo patrón:
  - Lista de los diez prompts del catálogo con su versión activa.
  - Versiones de cada uno con origen (`prompts/` o backoffice), autor, nota y la marca "Sin evals".
  - Editor que guarda una versión nueva, nunca cambia una existente.
  - Activación con confirmación y comparación línea por línea contra cualquier otra versión.
  - Los prompts son globales. Todos los usuarios los ven; crear y activar lo pueden los editores de
    prompts (`BACKOFFICE_PROMPT_EDITORS`) o, sin esa variable, los usuarios de una instalación con una
    sola institución crediticia.
  - Cada cambio queda en la bitácora de quien lo hizo, sin el texto.

- **Configuración agrupa Políticas, Prompts y Bitácora.** Salen de la barra principal y quedan como
  secciones de Configuración, junto a General (usuarios, canales y análisis), con un submenú arriba:
  `/configuracion/politicas`, `/configuracion/prompts` y `/configuracion/bitacora`. Las rutas anteriores
  (`/politicas`, `/prompts`, `/bitacora`) redirigen a las nuevas con sus filtros.

- **Domicilio del proveedor.** El detalle del proveedor muestra el domicilio que trae su estado de
  cuenta más reciente que lo incluye; la extracción lo muestra en el bloque del titular. La referencia externa
  ya no se muestra en el backoffice (sigue en la base y en la API de integración).

- **Recorrido de una solicitud (2026-11-07).** El detalle de la solicitud tiene el enlace
  "Ver recorrido", que abre `/solicitudes/$id/recorrido`: una vista 3D con una placa por capa (proveedor,
  canal, cola, workflow, modelos, motor y analista) y una línea de tiempo con capítulos para avanzar paso
  a paso. Se reconstruye al pedirla con lo que ya hay, sin datos nuevos; los eventos sólidos son exactos,
  los punteados derivados y los rayados inferidos. Los tramos sin actividad se comprimen y se rotulan con
  su duración real. No muestra textos, teléfonos ni montos, y sin WebGL queda la línea de tiempo 2D.
