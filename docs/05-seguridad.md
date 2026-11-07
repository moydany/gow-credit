# Seguridad del sistema

Fecha: 2026-11-04. Marco de referencia: OWASP ASVS 5.0 (mayo 2025) como estándar de
verificación, nivel 2 como objetivo; OWASP Top 10 para aplicaciones con LLM (edición
2025) para los riesgos propios del modelo; LFPDPPP (nueva ley publicada en el DOF el 20
de marzo de 2025) para datos personales y financieros en México. GOW opera para
prestamistas y su sitio promete "software de nivel bancario" y aislamiento multi-tenant,
así que el diseño asume que un cliente va a pedir evidencia de esto.

## 1. Modelo de amenazas

**Activos**: estados de cuenta (datos financieros y personales: RFC, CLABE, nombre,
movimientos), decisiones de crédito y su explicación, políticas de cada prestamista
(secreto comercial), credenciales (Anthropic, TypeSafe, Resend, sesión de WhatsApp,
Supabase), y la integridad del motor (que nadie altere una decisión).

**Actores**: proveedor malicioso (sube un PDF alterado o con instrucciones ocultas),
tenant curioso (intenta ver datos de otro prestamista), atacante externo (API, webhooks,
cadena de suministro de npm), insider (acceso a base o a logs), y el propio proveedor
de LLM (retención de datos).

**Fronteras de confianza**: navegador y WhatsApp del proveedor → API; API → cola y
worker; worker → Anthropic y TypeSafe; Edge Functions → base; backoffice del tenant → API.
Todo lo que cruza una frontera se valida con Zod y se autentica.

## 2. Identidad, acceso y aislamiento multi-tenant

- **Backoffice**: Supabase Auth con JWT; el `tenant_id` va en el JWT como claim firmado,
  nunca como parámetro. Un solo rol en esta versión: la pertenencia al tenant es la
  autorización completa, con bitácora por usuario desde el primer día para poder
  introducir roles después. MFA disponible y recomendado; obligatorio cuando existan
  roles con permiso de activar políticas.
- **API programática**: llaves por tenant, con alcance (`ingest`, `read`, `policies`),
  guardadas como hash, rotables y revocables; se muestran una sola vez.
- **RLS en todas las tablas de negocio**, sin excepción, con prueba automatizada: un
  test crea dos tenants y verifica, tabla por tabla, que A no lee ni escribe filas de B.
  Las políticas usan `(select auth.uid())` por rendimiento. Un `pg_tables` check en CI
  falla si una tabla nueva no tiene RLS.
- **`service_role` solo en servidor** (worker, migraciones), nunca en Edge Functions
  expuestas ni en el frontend. Las Edge Functions validan el JWT o la firma del webhook
  antes de tocar la base. Las funciones `security definer` se revisan una por una.
- **Roles de base mínimos**: `api_role` (lectura y escritura acotadas), `worker_role`
  (colas y extracciones), `readonly_role` (analítica). pg-boss opera en su propio
  esquema con su rol.
- **Mastra** escribe sus tablas en un esquema separado con un rol que no alcanza el
  esquema de negocio.

## 2b. Aislamiento por canal: un número de WhatsApp no ve datos de otro

Principio: **el número de teléfono no es una identidad; la identidad es un vínculo
verificado entre tenant, proveedor y número.** Nada que llegue por WhatsApp entra al
sistema hasta que se resuelve a ese vínculo, y el proceso de WhatsApp no tiene acceso a
ningún dato de negocio.

### Vínculo verificado

- Tabla `supplier_contacts(tenant_id, supplier_id, channel, address, verified_at,
  verification_method)`. El número lo registra el tenant desde su onboarding (KYC) o lo
  verifica el proveedor con un código de un solo uso enviado por otro canal (correo con
  Resend o un enlace del backoffice). Un número sin `verified_at` no recibe ni envía nada.
- WhatsApp ya autentica que el mensaje viene de ese número (verificación de SIM). Lo que
  no garantiza es quién está detrás del número; por eso existe el vínculo y por eso las
  respuestas de alto impacto (confirmar identidad, RFC, CLABE) exigen además un enlace de
  un solo uso por correo, no solo WhatsApp. Esto cubre SIM swap.

### Un número de WhatsApp por tenant

Cada prestamista tiene su propio número (una sesión de Baileys por tenant hoy; un
`phone_number_id` por tenant con Cloud API mañana). El par (nuestro número, su número)
identifica al tenant de forma estructural, antes de cualquier lógica. Un proveedor que
trabaja con dos prestamistas habla con dos números distintos y nunca hay que
"desambiguar entre tenants" con información que podría filtrarse.

### Resolución de cada mensaje entrante

1. Llega un mensaje de N al número del tenant T.
2. Se buscan los vínculos verificados (T, N). Si no hay ninguno: respuesta genérica fija
   ("No tenemos una solicitud pendiente para este número") y registro. Sin enumerar nada.
3. Con vínculos, se cargan **solo las aclaraciones abiertas** de esos proveedores. Ese es
   el conjunto candidato que ve Jev para correlacionar la respuesta. Jev nunca ve
   aclaraciones de otros proveedores; el filtro ocurre antes del modelo.
4. Si el mensaje menciona un folio o un dato que no está en el conjunto candidato, se
   ignora: **el texto del mensaje nunca es autorización**. "Respondo a la solicitud
   4821" no vale si la 4821 no está abierta para ese número.
5. Un número vinculado a varios proveedores (un contador que lleva varias empresas) recibe
   una lista numerada para elegir, mostrando solo nombre comercial del proveedor, nunca
   datos financieros.
6. La respuesta validada se guarda con `tenant_id` y `supplier_id` ya resueltos y se
   encola `application.resume`. El worker, al reanudar, vuelve a verificar que la
   aclaración pertenece a esa solicitud y a ese tenant (RLS con `app.tenant_id`).

### El bot no contesta preguntas

El canal es de una sola dirección en cuanto a datos: el sistema pregunta, el proveedor
responde. No hay "¿cuál es mi saldo?" ni "¿cómo va mi solicitud?" por WhatsApp en esta
versión. Cualquier texto que no sea respuesta a una pregunta abierta recibe un mensaje
fijo y se registra. Si en el futuro se agrega consulta de estado, cada sesión exige un
código de un solo uso.

### Salida: el adaptador no acepta destinatarios

`channel.send(clarificationId)` carga el destino desde la fila de la aclaración, que se
copió del vínculo verificado al crearla. Ningún código, prompt ni modelo puede pasar un
número arbitrario. Los mensajes salientes no contienen RFC, CLABE ni saldos; un depósito
se referencia por fecha y monto redondeado.

### Radio de daño si el proceso de WhatsApp se compromete

`apps/whatsapp` corre con un rol de base propio que solo puede leer la vista
`clarification_outbox` (id, destino, texto) e insertar en `clarification_inbound`. No
puede leer documentos, extracciones, decisiones ni políticas. Si un fork malicioso de
Baileys o una sesión robada toma ese proceso, lo máximo que obtiene son los textos de
las preguntas pendientes y la capacidad de encolar respuestas falsas, que de todos modos
pasan por la resolución anterior y, en los casos de alto impacto, por el segundo factor.

### RLS también para procesos internos

El worker y la API no usan `service_role` para operar. Cada job establece
`set_config('app.tenant_id', ...)` al inicio y las políticas RLS lo exigen, así que una
consulta sin tenant devuelve cero filas aunque haya un bug en el código. `service_role`
queda solo para migraciones.

### Límites y detección

Rate limit por número (mensajes por minuto y por día), bloqueo temporal tras N mensajes
sin correspondencia, y alerta cuando un número intenta referenciar folios que no le
pertenecen. Todo mensaje entrante, resuelto o no, queda en bitácora con el número en
columna cifrada.

### Pruebas automatizadas

- El número A responde citando el folio de B: se rechaza y se registra.
- Un número sin vínculo escribe: respuesta genérica, nada encolado.
- Un número con dos proveedores: recibe lista y la elección se respeta.
- El rol `whatsapp_role` intenta `SELECT` sobre `documents`: error de permisos.
- Una consulta del worker sin `app.tenant_id`: cero filas.

## 3. Datos: protección, privacidad y cumplimiento

- **Minimización**: al modelo solo va lo necesario. Para clasificar movimientos se
  manda descripción y monto, no el titular ni la CLABE. En trazas (Langfuse) el modo
  por defecto es solo metadatos; el contenido completo solo en entornos de evaluación
  con datos de prueba.
- **Cifrado**: TLS en tránsito; Supabase cifra en reposo; RFC y CLABE además con
  cifrado a nivel de columna (Vault / pgsodium) para que un volcado de tabla no los
  exponga en claro. Los PDFs en Storage con acceso solo por URL firmada de vida corta
  (minutos) y bucket privado.
- **Retención**: el PDF original se borra a los N días (configurable por tenant, por
  defecto 90) y se conserva la extracción; las decisiones se conservan el tiempo que
  exija el prestamista. Job de pg_cron que ejecuta la política de retención y deja
  registro.
- **LFPDPPP**: los datos financieros y patrimoniales requieren **consentimiento
  expreso** del titular (artículo 9). El consentimiento lo recaba el tenant en su flujo
  y el sistema guarda la evidencia (fecha, versión del aviso) junto a la solicitud.
  Se implementan derechos ARCO: endpoint de exportación y de borrado por proveedor, con
  propagación a trazas y cola. Aviso de privacidad del tenant referenciado en cada
  mensaje de WhatsApp o correo inicial.
- **Proveedor de LLM**: la API de Anthropic no entrena con datos de clientes bajo los
  términos comerciales; la retención estándar es limitada y existe retención cero por
  acuerdo. Algunos modelos recientes exigen retención de 30 días y quedan fuera de ZDR,
  así que la elección de modelo se documenta como decisión de privacidad y se deja
  configurable por tenant. `inference_geo` se fija para controlar dónde corre la
  inferencia cuando el tenant lo exija.
- **Logs sin PII**: pino con redacción de campos (`rfc`, `clabe`, `holder`, números de
  teléfono); los identificadores en logs son UUIDs de solicitud, no datos del proveedor.

## 4. Riesgos propios del LLM (OWASP LLM Top 10, 2025)

| Riesgo | Control |
|---|---|
| LLM01 Inyección de prompt | El contenido del PDF y los mensajes del proveedor son datos no confiables: van en el turno de usuario, nunca en el system prompt; el modelo solo devuelve objetos validados; el agente extractor **no tiene herramientas**; un Noul de Jev detecta texto dirigido a un sistema y marca el documento; eval de inyección en CI con PDFs que contienen instrucciones ocultas y deben producir exactamente la misma extracción. |
| LLM02 Fuga de información sensible | Minimización por llamada, trazas en modo metadatos, sin PII en logs, retención cero o acotada con el proveedor. |
| LLM03 Cadena de suministro | Modelos y versiones fijados (`claude-opus-5-5`, `jev-1.13.0`), SBOM de dependencias, sin forks de librerías. |
| LLM05 Manejo inseguro de salida | Toda salida pasa por Zod antes de usarse; el texto generado nunca se interpreta como HTML ni como comando; el filtro de cifras (doc 04) rechaza texto con números que no vienen del motor. |
| LLM06 Agencia excesiva | El único componente con efecto externo es el envío de aclaraciones, y solo puede escribir al número o correo registrado de ese proveedor (lista blanca por solicitud), con límite de mensajes por solicitud y por día. Ningún modelo decide si se envía: lo decide el motor. |
| LLM07 Fuga del system prompt | Sin secretos ni lógica de negocio sensible en prompts; las políticas de los tenants no se incluyen en prompts. |
| LLM09 Desinformación | Cubierto en `04-control-de-alucinaciones.md`. |
| LLM10 Consumo sin límite | Límites por documento (tamaño, páginas), presupuesto de tokens por job, cuota diaria por tenant, alerta de gasto por versión de prompt, circuit breaker ante 429. |

## 5. Archivos y canales de entrada

- **PDF**: se valida tipo por bytes mágicos, no por extensión; tamaño y número de
  páginas máximos; se rechaza PDF con JavaScript o adjuntos embebidos; el parseo local,
  si lo hay, corre en el worker sin acceso de red y con límite de memoria, nunca en la
  API. El sistema nunca descarga PDFs desde URLs que mande el usuario (SSRF): solo lee
  de su propio bucket.
- **Webhooks de Resend**: verificación de firma (Svix) y ventana de tiempo contra
  replay; idempotencia por `message_id`.
- **WhatsApp con Baileys**: número dedicado, nunca uno personal; el estado de sesión se
  guarda cifrado en Storage, no en disco; el proceso `apps/whatsapp` solo puede escribir
  a números registrados y encolar, no tiene acceso al resto de la base; se instala
  únicamente `@whiskeysockets/baileys` fijado por versión, porque existen forks
  maliciosos en npm que secuestran la sesión; se asume que la cuenta puede ser
  suspendida y el adaptador de Cloud API es el camino a producción.
- **Endpoints internos** (pg_cron → API): autenticación por token de servicio en Vault
  y, en Cloud Run, invocación restringida por IAM con tokens OIDC; nada interno queda
  público.

## 6. Secretos, cadena de suministro y CI/CD

- Secretos en Supabase Vault y en el gestor del cloud; nunca en el repositorio ni en
  variables `NEXT_PUBLIC_` o equivalentes. Rotación trimestral y al salir cualquier
  persona del equipo.
- `gitleaks` en pre-commit y en CI; falla el pipeline si detecta una llave.
- Dependencias con lockfile y `npm ci`; `osv-scanner` y `npm audit` con umbral; Dependabot
  con revisión; SBOM CycloneDX generado en cada build; acciones de GitHub fijadas por
  SHA, no por tag; permisos mínimos del `GITHUB_TOKEN`.
- Autenticación de CI hacia el cloud por OIDC (sin llaves de larga vida).
- Imágenes de contenedor escaneadas con Trivy; base mínima (distroless); usuario no root;
  solo lectura en el filesystem salvo `/tmp`.
- Ramas protegidas, revisión obligatoria, despliegue a producción solo desde tag firmado.

## 7. Infraestructura y operación

- Cloud Run con salida de red restringida a Supabase, Anthropic, TypeSafe y Resend;
  Supabase con restricciones de red por IP para la base.
- Rate limiting por tenant y por IP en la API; límites de tamaño de cuerpo.
- Respaldos con PITR y **prueba de restauración** programada; es un control que los
  auditores piden y pocos tienen.
- Registro de auditoría inmutable: quién vio qué solicitud, quién cambió qué política,
  quién activó qué versión. Append-only, con retención larga.
- Alertas: fallos de autenticación, uso de `service_role` fuera del worker, picos de
  gasto, tasa de corrección en revisión, cola creciendo.
- Runbook de incidente: contención (revocar llaves, pausar colas), evaluación de datos
  afectados, notificación al tenant y, si aplica, a los titulares y a la autoridad
  según la LFPDPPP.

## 8. Pruebas de seguridad en el pipeline

| Tipo | Herramienta | Cuándo |
|---|---|---|
| Secretos | gitleaks | pre-commit y CI |
| SAST | Semgrep con reglas OWASP y reglas propias (sin `service_role` fuera de `apps/worker`, Zod en cada handler) | CI |
| Dependencias | osv-scanner, npm audit, SBOM | CI |
| Contenedores | Trivy | CI |
| Aislamiento de tenants | tests de RLS tabla por tabla con dos tenants | CI |
| Inyección de prompt | eval con PDFs adversarios; la extracción no debe cambiar | CI (Evalite) |
| DAST | OWASP ZAP baseline contra staging | en cada despliegue a staging |
| Pentest externo | checklist ASVS 5.0 nivel 2 | antes de producción y anual |

## 9. Alcance para el worksample

Se implementa lo barato y de alto valor: RLS con sus tests, Zod en cada frontera,
secretos fuera del repo, URLs firmadas, verificación de firma de webhooks, dependencias
fijadas, gitleaks y osv-scanner en CI, logs sin PII, límites de tamaño y páginas, agente
extractor sin herramientas, y el eval de inyección. Lo demás (cifrado de columna, ARCO,
política de retención, DAST, pentest, runbook) queda en este documento como plan con
prioridad, para discutirlo en la llamada.

---

## Cambios durante la implementación

### Fase 2 (2026-11-04)

- **Excepción planeada al aislamiento por tenant** (`docs/09` §9.2): índice de plataforma
  de `HMAC(UUID del CFDI)` con llave de plataforma, fuera del RLS de los tenants, de solo
  escritura para ellos, cuya lectura devuelve únicamente "visto en otro prestamista hace N
  días". Detecta solicitudes simultáneas a varios prestamistas sin revelar RFC, montos ni
  quién. Línea de corte: **si alcanza**; se diseña en la fase 6.
- **Sellos del CFDI fuera del contrato** (ADR 0008): ni se piden al modelo ni se guardan.
- **Sin PII en logs**: el logger de Mastra se silencia porque imprime el error crudo con
  headers y partes del request; los errores salen saneados con código estable.

### Fase 6 (2026-11-05, ADR 0016 y 0017)

- **§2, RLS**: forzada en las 16 tablas de `app` con `tenant_id = app.current_tenant()`, que lee
  `app.tenant_id` de la transacción. No usa `auth.uid()` porque en local no hay Supabase Auth; en
  Supabase la API copia el claim del JWT. Hay siete roles; el de migraciones solo migra y da de
  alta tenants. Tres funciones `security definer` revisadas, que devuelven solo ids.
- **§2b**:
  - **Implementado**: el vínculo verificado, un número por tenant, la resolución de cada entrante,
    la respuesta fija a números sin vínculo y el buzón como única superficie del rol de WhatsApp.
  - **Pruebas**: un número ajeno citando un folio (escenario 15); WhatsApp no lee documentos; sin
    tenant, cero filas.
  - **Pendiente**: lista numerada para un número con varios proveedores, límites por número,
    columna cifrada y el segundo factor por correo.
- **§3**: cifrado de columna, ARCO y retención siguen como plan. Los logs del worker y de la API son
  una línea JSON con ids y códigos; nunca el error crudo.
- **§5**: PDF validado por bytes mágicos y tamaño, solo desde almacenamiento propio, con ruta bajo
  el tenant. Webhook de Resend con firma, ventana contra replay e idempotencia por id. Baileys
  fijado en 7.0.0-rc14 con sus scripts de instalación negados; su sesión vive en disco y no cifrada
  en Storage (pendiente).

### Fase 8 (2026-11-05): Google y TypeSafe como encargados (ADR 0011 y 0022)

- **Google es encargado de datos junto a Anthropic.** Con `GEMINI_API_KEY`, el PDF completo va a
  la Gemini API para extraer (ADR 0011). Anthropic sigue recibiendo el PDF en la doble lectura y
  en la emergencia, y en la extracción cuando no hay llave de Google. Con Haiku, recibe el texto
  de las primeras páginas y las descripciones de los movimientos. El README lo dice en
  "Privacidad del dataset", antes del primer comando.
- **Términos de la Gemini API de pago**, en
  [aistudio.google.com/docs/terms](https://aistudio.google.com/docs/terms) ("Effective March 23,
  2026"; consultados el 2026-11-05):
  - **Entrenamiento.** En servicios de pago, Google "doesn't use your prompts … or responses to
    improve our products". La redacción es más estrecha que la de los servicios gratuitos, que
    sí mencionan aprendizaje automático. Solo cuenta como pago la API usada desde un proyecto de
    Cloud con facturación activa: **la llave del despliegue tiene que ser de un proyecto con
    facturación**, nunca una del nivel gratuito.
  - **Registro.** Google registra prompts y respuestas "for a limited period of time, solely for
    detecting and preventing violations" de su política de uso prohibido, y también por
    seguridad del servicio y por obligaciones legales. Los datos "may be stored transiently or
    cached in any country": **no hay control de región** comparable a `inference_geo`.
  - **Plazo.** Según [aistudio.google.com/docs/usage-policies](https://aistudio.google.com/docs/usage-policies),
    prompts, contexto y respuestas se retienen **55 días** para detectar abusos. La página no
    distingue pago de gratuito ni ofrece retención cero.
  - **Contrato.** Prompts y respuestas se procesan conforme al Data Processing Addendum de Google
    (Google como encargado). Los datos de cuenta y facturación siguen los Controller-Controller
    Data Protection Terms.
  - **Edad.** Uso solo para mayores de 18 años, y la aplicación no puede dirigirse a menores. No
    aplica a este sistema: los usuarios son prestamistas y proveedores.
- **Consecuencias para el aviso de privacidad y el contrato con el tenant:**
  1. Los dos proveedores de modelos se nombran como encargados, cada uno con su plazo de
     retención: 55 días en Google; el de los términos comerciales en Anthropic.
  2. La transferencia internacional se declara sin región fija para Google.
  3. Un tenant que exija retención cero o región fija se configura sin `GEMINI_API_KEY`, con
     extracción en Claude, a unas 5 veces el costo (README, "Costo estimado").
- **TypeSafe AI (Jev)** recibe, con `TYPESAFE_API_KEY`, el texto de las primeras páginas y las
  descripciones de los movimientos (ADR 0022). Sus términos de uso de datos **no están
  verificados**. Hasta revisarlos, en producción Jev se habilita por tenant y no por defecto.

### Fase 8 (2026-11-06): vinculación de WhatsApp desde el backoffice (ADR 0033)

- **§2b, un número por tenant**:
  - El QR para vincular el número se muestra en Configuración, solo a usuarios del tenant, y
    caduca. Quien lo escanee vincula su cuenta al bot del tenant: verlo queda en la bitácora
    (huella del QR, nunca el valor) y nunca va a registros. Sin terminal interactiva, el
    proceso no lo dibuja en stdout.
  - El logger de Baileys se silencia porque imprime el número de la cuenta.
- **§2b, radio de daño**: `gow_whatsapp` ahora también escribe el estado de su propia sesión
  (`app.whatsapp_sessions`, RLS forzada). `gow_api` la lee y solo puede pedir desvincular. Las
  pruebas de RLS cubren ambos privilegios y el aislamiento entre tenants.
- **El proceso tiene que estar corriendo** para vincular: en Cloud Run, 1 instancia fija.

### Fase 8 (2026-11-06): login del backoffice con Supabase Auth (ADR 0035)

- **§2, `tenant_id` como claim firmado**: lo agrega un custom access token hook (migración 0008).
  La única función que salta RLS es `security definer` y devuelve solo el id del tenant. El hook
  descarta cualquier `tenant_id` que traigan los claims. Solo `supabase_auth_admin` puede
  ejecutarlas; `anon`, `authenticated`, `service_role` y los roles `gow_*`, no. La API sigue
  leyendo la pertenencia en cada petición.
- **Sin enumeración de cuentas**: pedir el enlace siempre responde 202 con el mismo cuerpo, y la
  llamada a GoTrue va fuera de la petición. Hay límite por IP (429) y por correo (en silencio).
  GoTrue no crea cuentas ahí (`create_user: false`) y el registro público está apagado: las
  cuentas solo las crea la API o el CLI con la llave service_role, que nunca llega al navegador.
- **Tokens fuera del navegador**: el access token llega en el fragmento de la URL, se quita de
  la barra y del historial al leerlo y se cambia por la cookie `HttpOnly`. El refresh token no se
  usa, y la API cierra su sesión de GoTrue al crear la cookie. Ni el correo ni los tokens van a
  los registros.

### Fase 8 (2026-11-06): sesión del backoffice que se renueva sola (ADR 0036)

- **Ajusta el punto anterior**: el refresh token ya se usa, pero nunca lo guarda JavaScript. La
  API lo recibe una vez de `/entrar` y lo guarda en una segunda cookie (`gow_refresh`, `HttpOnly;
  SameSite=Strict; Path=/bo`, `Secure` detrás de HTTPS), cifrado con AES-256-GCM. La llave se
  deriva con HKDF de `BACKOFFICE_JWT_SECRET` con una etiqueta fija; no es la llave que firma los
  JWT. Una cookie alterada o de otra llave se ignora.
- **Límites**: 12 h desde el login (`BACKOFFICE_SESSION_MAX_HOURS`) y 8 h sin renovar
  (`BACKOFFICE_SESSION_IDLE_HOURS`). Van dentro del texto cifrado, así que el navegador no los
  puede estirar.
- **Cada renovación vuelve a verificar**: firma, `tenant_id` del hook, mismo usuario y pertenencia
  vigente. Quitar a un usuario lo saca en la siguiente petición, renueve o no, y en esa petición
  se cierra su sesión de GoTrue. Salir también la cierra.
- **Peticiones en paralelo**: una renovación por refresh token y proceso, compartida 30 s; entre
  instancias, el intervalo de reúso de GoTrue (10 s). Un fallo al renovar no saca a quien todavía
  tiene un access token vigente; con GoTrue caído y el token vencido, 503 sin borrar cookies.
- Ni los tokens ni el correo van a los registros: la llave del mapa de renovaciones es el hash
  del refresh token, y un error de GoTrue registra solo el código.

### Fase 8 (2026-11-06): estados de cuenta por WhatsApp (ADR 0037)

§2b decía que el canal es de una sola dirección en cuanto a datos. Ahora acepta una cosa más: un
estado de cuenta en PDF desde un **vínculo verificado**, que abre una solicitud igual que la API.

- `gow_whatsapp` no gana acceso: descarga el documento e inserta el entrante con sus bytes, como
  ya insertaba el texto. Sigue sin ver documentos ni el almacenamiento.
- El worker valida (vínculo con un solo proveedor, firma PDF, 40 MB, hash no repetido), mueve los
  bytes al almacenamiento del tenant, vacía la columna y encola el procesamiento. `gow_worker`
  gana `INSERT` en `app.applications`.
- Un número sin vínculo, un vínculo con varios proveedores, un archivo que no es PDF o un
  duplicado reciben un texto fijo; nada se abre. Las respuestas nunca dicen el resultado.
- Riesgo aceptado: quien controle la cuenta de WhatsApp del proveedor puede mandar un PDF a su
  nombre. Lo acotan el cotejo de identidad del titular, el CFDI y la política. Pendiente: límite
  de documentos por número.

### Fase 8 (2026-11-06): registro de proveedores por WhatsApp en la demo (ADR 0038)

Con `WHATSAPP_SELF_REGISTRATION=true` (encendido por defecto desde la ADR 0062; `false` lo apaga), un número sin vínculo verificado no
recibe la respuesta fija: el bot le pide razón social y RFC y crea el proveedor con su contacto
verificado **por posesión del número** (`whatsapp_self_registration`), que no equivale a un KYC.
Solo es para demos: cualquiera puede registrar cualquier razón social y disparar extracciones.
El cotejo del RFC del titular del documento y la política siguen aplicando. `gow_worker` gana
`INSERT` en `suppliers` y `supplier_contacts`; la tabla `supplier_registrations` tiene RLS forzada.

### Fase 8 (2026-11-06): factura y veredicto por WhatsApp (ADR 0039)

- Opcional (`askInvoice`, apagado en la demo): antes de analizar un estado de cuenta recibido por
  WhatsApp, el bot pide monto, cadena compradora y vencimiento de la factura
  (`app.invoice_intakes`, RLS forzada). Apagado, el estado de cuenta se analiza al llegar.
- Al guardar un veredicto final se deja un aviso en el buzón de salida del WhatsApp verificado del
  proveedor. Es una plantilla fija: el resultado, la factura que él mismo dio y, si califica, el
  monto. **Nunca** saldos, RFC, CLABE ni los motivos del motor, que pueden citar cifras del
  documento. El destino sale del vínculo verificado, como el resto del buzón.

### Fase 8 (2026-11-06): intérprete con Haiku y nombres con typos (ADR 0040)

- Las respuestas por WhatsApp que las reglas no leen, y siempre la razón social y el comprador,
  pasan por Haiku, que clasifica el mensaje y propone el dato. El dato vuelve a pasar por el mismo
  lector determinista; Haiku no autoriza nada, no elige destinatarios y no contesta al proveedor.
  Una consulta recibe "solo puedo pedirte los datos de tu solicitud" (§2b, el bot no contesta
  preguntas). El texto del mensaje va a Anthropic; el error se registra sin el mensaje.
- El cotejo del nombre del titular tolera un typo por palabra (dos desde 10 letras). El RFC sigue
  siendo la prueba fuerte de identidad.

### Fase 8 (2026-11-06): fotos y notas de voz por WhatsApp (ADR 0051)

- Una foto, nota de voz, video o sticker se guarda en `inbound_messages.media_kind` solo con su tipo
  (`image`, `audio`, `video`, `sticker`, con CHECK en la base). El proceso de WhatsApp nunca descarga
  el medio ni guarda sus bytes; el worker contesta con texto fijo que solo lee el PDF. Grupos y
  estados se siguen ignorando. Sin grants nuevos: `gow_whatsapp` ya inserta entrantes y
  `app.pending_inbound` solo devuelve ids.
- El resumen para confirmar las respuestas de la aclaración repite las cifras de los hechos de cada
  pregunta (monto y fecha del abono), las mismas que ya llevaba la pregunta, al mismo número.
- Borrar un proveedor (ADR 0059) no le da a `gow_api` DELETE sobre las tablas: borra solo por
  `app.purge_supplier(uuid)`, una función `SECURITY DEFINER` revisada a mano, con RLS forzado, filtro
  por tenant en cada DELETE y otorgada solo a `gow_api`. El trabajo `supplier.purge` lleva ids y rutas,
  y el worker solo borra rutas bajo el tenant del trabajo.

### Fase 8 (2026-11-07): prompts y respuestas crudos para analizar un caso (ADR 0064)

- Cada llamada a un modelo queda en `app.llm_exchanges` con el prompt y la respuesta tal cual, que
  llevan datos del documento. No es un log ni la bitácora de movimientos, que siguen sin PII: es una
  tabla de negocio con los mismos controles que `extractions` (RLS forzada, el worker solo inserta,
  la API y `gow_readonly` leen, nadie actualiza ni borra) y se borra con el proveedor.
- Ver el detalle desde el backoffice queda en la bitácora (`llm_exchange.viewed`, sin contenido).
- El PDF no se copia (va su sha256). El mensaje de `LlmCallError` sigue sin contenido; la salida cruda
  viaja aparte, solo hacia esta tabla.
- Pendiente: retención. Hoy viven lo que vive el proveedor.
