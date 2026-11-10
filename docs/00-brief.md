# Brief para quien implementa

Este brief es el punto de entrada para construir el sistema. Supone que no se tiene la
conversación de diseño: todo lo necesario está en esta carpeta. Léelo completo antes de
tocar código; después lee `07`, `02`, `03`, `04` y `README.md` (glosario y estados).
`05`, `06` y `08` se leen cuando toque su fase. `01` solo para entender por qué se
descartaron alternativas.

## 1. Contexto en diez líneas

- Es un **worksample técnico** de GOW Credit (infraestructura de diagnóstico crediticio
  para prestamistas PyME en México, multi-tenant). Plazo 72 horas desde la recepción; el
  tiempo efectivo sugerido es 6 a 8 horas pero se decidió invertir más.
- El enunciado habla de "facturas" de proveedores que quieren cobrar antes del
  vencimiento. El dataset real son **estados de cuenta bancarios** de 9 bancos mexicanos.
  Ellos correrán el sistema sobre 10 documentos que no vimos y **medirán la extracción**.
- Entregables: repo con README reproducible; spec (qué se entendió, supuestos, alcance);
  decisiones de diseño con razones; todos los prompts y artefactos; el harness de
  desarrollo con agentes; pipeline de CI/CD y plan de deploy. Luego una llamada de 60
  minutos para explicar diseño, implementación y problemas resueltos.
- Evalúan el criterio tanto como el resultado. Documentar supuestos vale puntos.
- Stack pedido por la vacante: TypeScript estricto, Node, Express, Zod en los límites,
  Supabase (RLS multi-tenant, pgvector, pg_cron, Vault, Edge Functions), pg-boss con
  idempotencia y dead letter, Claude con structured outputs y evals, integraciones
  (SAT, buró, WhatsApp, Resend), React en Vercel, logging estructurado y trazas.
- En entrevista preguntaron: reglas → sistema que aprende de outcomes; diagnóstico de un
  incidente de latencia, costo y 429; plan de evaluación lean; cómo aislar datos entre
  números de WhatsApp; cómo lidiar con alucinaciones. El diseño responde cada una y el
  código debe hacerlas visibles.

## 2. Decisiones finales (no reabrir sin registrar la decisión)

| Tema | Decisión | Detalle |
|---|---|---|
| Orquestación | **Mastra** (agentes, workflows con suspend/resume, scorers, tracing). Salida de emergencia: SDK de Anthropic directo dentro de un step | `02` |
| Extracción | **`gemini-3.8-flash`** como modelo de extracción; emergencia `gemini-4-carbon` ante fallas de calidad y `claude-opus-5-5` ante fallas del proveedor. PDF nativo (texto + imagen por página), structured output con esquema Zod, dos pasadas (resumen, luego movimientos por bloques) con caché implícita del proveedor; verificación por cuadre, saldo corrido, validadores y doble lectura adaptativa con un modelo de otra familia | `02` 2, `04` |
| Clasificación | **Jev** `jev-1.13.0` (TypeSafe AI) tras la interfaz `Classifier`, con fallback automático a `claude-haiku-5-5` si no hay llave | `02` 4c |
| Decisión | Perfil de features fijo + **política JSON por tenant** validada con Zod (DSL cerrado), motor puro y determinístico, salida con diagnóstico y contrafactuales | `03` |
| Aclaración | Interfaz `ClarificationChannel`: consola/archivo (`standalone`), **Baileys** para WhatsApp y **Resend** para correo (`full`); una sola ronda; el bot no contesta consultas | `02` 3, `05` 2b |
| API | Express 5 + Zod + `zod-to-openapi`; adaptador `MastraServer` | `02` |
| Datos | Supabase Postgres con **Drizzle**, RLS en todas las tablas de negocio con tests de aislamiento, Vault, pg_cron; Mastra en esquema aparte | `02`, `05` |
| Colas | **pg-boss 12** decide cuándo y cuántos; Mastra ejecuta. Idempotencia por hash + versión de prompt; dead letter; prioridades; Batches API para masivos | `02` 4, 4b |
| Evals | **Evalite** en CI con ground truth de los 9 documentos; invención y omisión por separado; eval de inyección | `04` 6 |
| Observabilidad | Mastra tracing → Langfuse (opcional por env) + storage exporter; pino sin PII | `02` 7 |
| Backoffice | React 19 + Vite en Vercel; **un rol, varios usuarios por tenant**; acceso solo por API | `08` |
| Deploy | API y worker en Cloud Run, Supabase gestionado, Vercel; GitHub Actions | `02` 8 |
| Escenarios | YAML de punta a punta con adaptadores simulados; runner `pnpm scenario` | `06` |
| Seguridad | ASVS 5.0 nivel 2 como meta; lo barato y de alto valor se implementa, el resto queda en plan | `05` 9 |
| Bloque fiscal | Ocho de nueve estados de cuenta traen un **CFDI** del banco: se extrae como `fiscal_documents[]` (UUID, certificados, fechas, RFC y régimen de emisor y receptor, subtotal, IVA, total). **Los sellos y la cadena original nunca se transcriben.** Cruces aritméticos y de formato. El bloque se usa como ancla: comisiones firmadas por el SAT contra las filas `fee`, huella del estado de cuenta por UUID, comprador por RFC de contraparte, listas públicas del SAT, régimen fiscal como filtro; verificación ante el SAT opcional y apagada en `standalone` | `09` |

## 3. Reglas de trabajo

1. **Dos modos desde el primer día**: `standalone` (libSQL, en proceso, consola) y
   `full` (Supabase, pg-boss, Baileys, Resend). El comando `pnpm run evaluate <carpeta>`
   es lo que los evaluadores ejecutan: necesita `ANTHROPIC_API_KEY`; con `GEMINI_API_KEY`
   extrae con Gemini y sin ella con Opus, y debe funcionar
   sobre documentos nunca vistos sin crashear (salida parcial con banderas antes que un
   error).
2. **Zod es la única fuente de verdad** de cada contrato: extracción, perfil, política,
   veredicto, API. Tipos con `z.infer`, nunca escritos a mano. Publicar el contrato de
   extracción como JSON Schema en `docs/schema/`.
3. **Estados y términos** exactamente como en `docs/README.md`.
4. **Nada de PII en logs ni en trazas** por defecto. `data/` y cualquier PDF o ground
   truth nunca se versionan en un repo público; el repo es privado.
5. **Versiones fijadas**: modelos (`gemini-3.8-flash`, `claude-opus-5-5`, `claude-haiku-5-5`,
   `jev-1.13.0`),
   prompts (`prompts/<nombre>.v<N>.md` con `prompts/CHANGELOG.md`), dependencias con
   lockfile. Cada extracción guarda modelo, versión de prompt, tokens, latencia y costo.
6. **API de Anthropic actual, no la recordada**: `output_config.format` (no `output_format`),
   sin `temperature`, thinking adaptativo, `fallbacks: "default"` para refusals, PDF como
   bloque `document`. Si existe el skill `claude-api` en el entorno, cargarlo antes de
   escribir cualquier llamada al SDK. A través de Mastra estas opciones viajan por
   `providerOptions.anthropic`; verificar en el spike 1 de `07` H que llegan. Para Gemini
   (`@ai-sdk/google`): `responseJsonSchema`, `thinkingLevel` derivado de
   `effort`, PDF como `inlineData`, caché implícita del proveedor; precio oficial verificado
   en ai.google.dev antes de reportar costos.
7. **Evals antes de cambiar prompts**: ningún cambio de prompt, modelo o `effort` se
   fusiona si baja las métricas de `04` 6 por debajo del umbral.
8. **Idioma**: código, identificadores y commits en inglés; documentación, README y
   mensajes al proveedor en español. README con resumen en inglés.
9. **Git desde el primer commit**, commits pequeños con mensajes que cuenten la historia.
   Cada decisión nueva o cambiada queda en el registro de decisiones (`docs/decisions.md`: qué se
   decidió, frente a qué y por qué). Las decisiones de la tabla de arriba se pasan al registro
   en la fase 8 a partir de los documentos.
10. **No tocar la historia de `docs/01` a `08`**: si algo cambia, se agrega una sección
    "Cambios durante la implementación" al final del documento afectado.

## 4. Orden de construcción y definición de terminado

**Fase 0: repo, herramientas y spikes.** pnpm workspaces, TypeScript estricto, ESLint,
Vitest, `.env.example`. Ya existen: `CLAUDE.md` de raíz, `.gitignore` con `data/`, los 9
PDFs en `data/dev/` y `scripts/download-dev-data.sh` con manifiesto de hashes. Los cuatro
spikes de `07` H, cada uno con una nota de resultado en `docs/spikes/`. Terminado:
`pnpm typecheck` y `pnpm test` pasan vacíos; cada spike tiene veredicto.

**Fase 1: contratos.** `packages/contracts`: esquema de extracción
(`document → accounts[] → periods[] → transactions[]`, montos positivos con `type`,
`null` permitido, `source_page` y `source_snippet` por valor, `verification` y
`confidence`), esquema de perfil (catálogo de `03` 3), esquema de política (`03` 4, DSL
cerrado validado contra el catálogo), veredicto (`03` 6). JSON Schema exportado. Tests
de validación. Terminado: una política inválida (operador incompatible con el tipo de
feature) falla al parsear con mensaje claro.

**Fase 2: extracción.** `packages/extraction`: clasificación (Jev o Haiku), decisión
texto o visión, pasada 1 y pasada 2 por bloques con caché, deduplicación en solapes,
verificación (cuadre global, totales, saldo corrido, CLABE, RFC, fechas, snippet),
reintento dirigido por página, doble lectura adaptativa, salida parcial con banderas.
Terminado: los 9 documentos producen extracción válida; HSBC pasa por visión; Santander
produce dos cuentas; Mercado Pago tres periodos; se imprime costo y tokens por documento.

**Fase 3: ground truth y evals.** Revisión manual de las 9 extracciones (encabezado,
totales, muestra de movimientos por página, todo lo que no cuadre) guardada en
`evals/ground-truth/`. Evalite con precisión y recall de movimientos, exactitud por
campo, cuadre a la primera, eval de inyección con un PDF adversario sintético. Caché de
respuestas por hash para que CI no llame al modelo. Terminado: `pnpm eval` corre en CI
con umbral y reporte por banco.

**Fase 4: perfil y motor de políticas.** `packages/decision`: cálculo de features desde
la extracción y los adaptadores externos (simulados), `evaluate(policy, profile)`,
política base de `03` 4 como plantilla, contrafactuales para `next_steps`, simulación
sobre un conjunto de perfiles. Tests unitarios y de propiedades (el motor es puro).
Terminado: los escenarios 3, 5, 6 y 11 de `06` pasan en modo unitario sin LLM.

**Fase 5: workflow y modo standalone.** `packages/mastra`: workflow `processApplication`
con suspend/resume, canal de consola y archivo de respuestas, redacción de preguntas y
`next_steps` con filtro de cifras (`04` 4), reporte Markdown por documento. Comando
`pnpm run evaluate <carpeta> [--request ...] [--answers ...]`. Terminado: el comando
corre sobre `data/dev/` y produce JSON y reporte por documento; una solicitud pausada se
reanuda con un archivo de respuestas.

**Fase 6: modo full.** `packages/db` con Drizzle, migraciones, RLS y tests de
aislamiento con dos tenants; `apps/worker` con pg-boss (idempotencia, dead letter,
prioridades, semáforo hacia Anthropic); `apps/api` Express con subida por URL firmada,
solicitudes, aclaraciones, políticas con simulate/shadow/activate, outcomes; canales
Resend y Baileys con vínculo verificado y rol de base acotado (`05` 2b); runner de
escenarios con al menos los casos 1, 5, 6, 12, 15, 16, 19. Terminado: `docker compose
up` levanta Postgres local y los escenarios pasan; el test de RLS falla si una tabla
nueva no tiene política.

**Fase 7: backoffice.** `apps/web` con Solicitudes, Detalle (PDF, extracción con salto a
página, decisión) y Aclaraciones con respuesta manual. Luego Revisión humana, Políticas
con JSON y Simular, Outcomes, si hay tiempo. Terminado: el detalle de una solicitud real
se ve con los valores no verificados resaltados.

**Fase 8: entregables de proceso.** README (cómo correr ambos modos, costo estimado, qué
reproducibilidad se promete, privacidad del dataset), `docs/00-spec.md` (una página),
`docs/decisions.md` (el registro de decisiones, con cada fila de la tabla), `docs/harness.md`
(herramientas, configuración, cómo se trabajó, esta carpeta como artefacto),
`prompts/` con changelog, GitHub Actions (typecheck, lint, test, eval con umbral,
gitleaks, osv-scanner, build de imágenes) y `docs/deploy.md` con el plan de Cloud Run,
Supabase y Vercel. Terminado: una persona ajena sigue el README y obtiene resultados
sobre `data/dev/`.

**Líneas de corte** si el tiempo aprieta: `07` G. Nunca se corta la fase 2, 3, 5 ni 8.

## 5. Asuntos abiertos

- Respuesta de GOW a la pregunta sobre facturas vs estados de cuenta: pendiente. Los
  estados de cuenta traen su propio CFDI (`09`), lo que explica el término; se asume
  estados de cuenta y el bloque fiscal se extrae siempre.
- ~~Acceso a Jev~~ **Resuelto**: Jev `jev-1.13.0` responde con `TYPESAFE_API_KEY` (32 de 33
  en la eval del clasificador). Sin llave, clasifica Haiku y el reporte lo indica.
- Falta el décimo documento de desarrollo en el Drive.
- `gemini-4-carbon`: precio y límites por verificar en ai.google.dev y fijar en
  `models.ts`; una corrida de prueba sobre Nu antes de dejarlo como emergencia. **Sigue
  abierto por decisión del dueño**: mientras tanto, la emergencia por calidad es Opus.
- ~~Los documentos salen a Google y a Anthropic~~ **Resuelto**: el README lo dice antes del
  primer comando, y `05` ("Cambios", fase 8) lista a Google, a Anthropic y a TypeSafe como
  encargados, con los términos de la Gemini API de pago citados.
- Datos de la solicitud (monto, vencimiento, comprador) no vienen con los PDFs: sin ellos
  la salida es línea máxima y perfil, no veredicto completo. **Resuelto así**:
  `--request` da los datos cuando existen, y sin ellos la salida trae la línea máxima.

## 6. Qué mostrar en la llamada

`pnpm run evaluate data/dev` con un documento pausado por aclaración y reanudado; el
detalle de una solicitud en el backoffice con un valor no verificado resaltado y su
página; una política borrador simulada contra las solicitudes existentes; las métricas
de evals por banco con invención y omisión separadas. Y las frases de `04` 7 y `05` 2b.

---

## Cambios durante la implementación

- **Fase 2, Mercado Pago.** El documento de desarrollo imprime un solo periodo
  (13 de junio a 11 de septiembre) con un solo saldo inicial y final, sin cortes por mes. La
  definición de terminado pasa de "tres periodos" a "un periodo con los movimientos de los
  tres meses, cuadrado contra los saldos impresos"; los meses los cuenta el perfil (fase 4).
- **Fase 2, esquema del modelo.** El esquema que ve el modelo no es el contrato:
  la API limita las uniones (16) y el tamaño de la gramática. Montos como texto impreso,
  valores citados en listas `{field, value, page, snippet}`; el código traduce al contrato.
- **Fase 2, caché.** Todas las llamadas de extracción sobre un documento usan el
  mismo esquema de salida, porque el esquema forma parte del prefijo cacheado.
- **Fase 3, ground truth y evals.** El ground truth no vive en
  `evals/ground-truth/` sino en `data/ground-truth/` (no se versiona: son movimientos reales);
  en `evals/ground-truth/` quedan el manifiesto sin datos personales y el README de
  convenciones. No se revisó "una muestra por página" de la extracción: un parser por banco
  sobre la capa de texto arma el libro completo (1,513 movimientos) y la aritmética del banco
  lo valida, sin pasar por el modelo. La caché de los 9 documentos tampoco se
  versiona; CI la restaura desde almacenamiento privado (fase 8). La de los PDFs adversarios
  sintéticos sí se versiona y la eval de inyección corre en CI sin llaves.
- **Fase 4, perfil y motor.** `packages/decision` y `scenarios/`:
  - **Clasificación.** Ninguna extracción trae movimientos clasificados, porque el paso Jev es
    del workflow de la fase 5. El perfil usa un clasificador por reglas (`rules-v1`) como
    respaldo gratuito, y Jev entra encima cuando exista.
  - **Contratos.** La clasificación canónica gana `loan_payment`, sin el cual no se podía
    calcular `debt_service_monthly`; el contrato de extracción sube a 1.2.0 y lee 1.1.0. El
    catálogo pasa a 1.1.0.
  - **Escenarios.** Corren en modo unitario con estados de cuenta **sintéticos**, porque sin
    LLM no hay PDFs que extraer y los datos reales no se versionan. Además de 3, 5, 6 y 11
    pasan 4, 7, 10, 17 y los fiscales 21 a 25. Comando `pnpm scenario run <id>|--all`.
  - **Comandos nuevos.** `pnpm decide`: perfil y veredicto sobre extracciones ya hechas, sin
    costo. `pnpm simulate`: política borrador contra la vigente.
- **Fase 5, workflow y modo standalone.** `packages/mastra` y `pnpm run evaluate`:
  - **Una solicitud por PDF.** El comando escribe `<id>.extraction.json`, `<id>.result.json`
    (`ApplicationResult`, publicado en `docs/schema/`) y `<id>.md`. Una solicitud pausada se
    reanuda en otra invocación con `--answers`; también se puede contestar en la terminal con
    `--interactive`.
  - **Movimientos.** Las reglas de la fase 4 van primero. Jev, o Haiku sin llave de Jev, solo ve
    lo que ellas no resuelven: 1,020 de 1,513 movimientos en el dataset.
  - **Datos reales.** Con la política base, los 9 documentos se pausan y, respondidas las
    preguntas, quedan en revisión humana. El dataset redacta la identidad y el RFC receptor del
    CFDI es el genérico, así que ninguno pasa la compuerta de identidad. El camino hasta
    `qualified_with_limit` está probado con datos sintéticos.
  - **Costo de la corrida completa de los 9**: USD 0.0159 (Jev y Haiku). La extracción sale de
    caché.
- **Fase 6, modo full.** `packages/db`, `packages/channels`,
  `packages/platform`, `apps/api`, `apps/worker`, `apps/whatsapp` y el runner full de `scenarios/`:
  - **Terminado como se pidió.** `docker compose up -d` levanta Postgres 17 con los roles.
    `pnpm scenario run --all --mode full` pasa 7 de 7 (casos 1, 5, 6, 12, 15, 16 y 19). La prueba
    de RLS falla si una tabla nueva no tiene política.
  - **Simulado en los escenarios**: las fuentes externas, el teléfono del proveedor y los modelos
    (caché fija). Nunca hay llamadas pagadas.
  - **Distinto al plan**:
    - El webhook de correo vive en la API, no en una Edge Function.
    - La sesión de Baileys queda en un directorio local y no se probó contra WhatsApp real.
    - El almacenamiento es local, detrás de la interfaz; el de Supabase es de la fase 8.
    - Por WhatsApp o correo solo se preguntan abonos; identidad y documentos van por la API.
- **Fase 7, backoffice.** `apps/web` (React 19 + Vite) y la API `/bo/v1`:
  - **Terminado como se pidió.** El detalle de una solicitud real (PDF, extracción, decisión) se ve
    con los valores no verificados resaltados y el salto a la página citada; las aclaraciones se
    responden a mano, sin WhatsApp, y reanudan el workflow real.
  - **Además.** Revisión humana (cola), Políticas con JSON y Simular, Outcomes y Bitácora.
  - **Para verlo.** `docker compose up -d`, `pnpm db:migrate`, `pnpm tenant create ...`, `pnpm api`,
    `LLM_CACHE_MODE=read pnpm worker`, `pnpm demo:load --key ...`, `pnpm tenant user add ...` y
    `pnpm web`. Con la caché de respuestas, costo cero.
  - **Pendiente.** Proveedores y Configuración.
  - **Corrección en revisión humana.** Hecha: pares leído/correcto guardados, `analyst_answer`,
    reevaluación sin modelos. Falta descartar un documento y exportar los pares a las evals.
- **Fase 8, entregables de proceso.**
  - **README**: corrida standalone en 5 minutos, costo estimado, privacidad del dataset,
    reproducibilidad y los dos modos.
  - **Documentos nuevos**: `docs/00-spec.md`, `docs/harness.md` y `docs/deploy.md`.
  - **Registro de decisiones** (`docs/decisions.md`): cada fila de la tabla de decisiones, con lo
    que se descartó y por qué.
  - **CI en `.github/workflows/`**, con acciones fijadas por SHA:
    - typecheck, lint y test con Postgres;
    - escenarios unitarios y full;
    - evals de inyección y del clasificador, sin llaves;
    - build del backoffice y de las imágenes;
    - gitleaks y osv-scanner.

    La eval de extracción restaura `data/` de un paquete cifrado (`scripts/eval-bundle.sh`) y,
    sin los secretos, avisa y no corre.
  - **Distinto al plan**:
    - `evaluate` usa por defecto la política de evaluación standalone, para que los documentos
      redactados no se detengan todos en identidad.
    - `evaluate` ganó `--help`.
    - El despliegue queda como plan: no se crean cuentas.
  - **Menores del punto 6, también hechos:**
    - descartar un documento en revisión humana;
    - exportar las correcciones del analista y medirlas contra el modelo actual;
    - pantallas Proveedores y Configuración;
    - herramienta para revisar a mano una muestra del ground truth, con 72 filas.

    La revisión de esa muestra la tiene que hacer una persona y sigue pendiente.

- **Prompts en la base.** Las reglas 5 y 7 se mantienen para el repositorio:
  - `prompts/` con su changelog es la fuente del código, de las evals y del modo standalone.
  - En modo full, cada `pnpm db:migrate` siembra los archivos en la base.
  - El backoffice permite crear versiones nuevas (inmutables) y elegir la activa de cada prompt.
    Quién puede hacerlo lo define `BACKOFFICE_PROMPT_EDITORS`; sin esa variable, solo en una
    instalación con una sola institución crediticia.
  - Esas versiones no tienen evals y se marcan "Sin evals". Para volverse la versión del código pasan a
    `prompts/` y por las evals.
  - Los prompts son globales, no por tenant: de ellos depende la precisión que se mide.
- **Entrega: el repositorio es público.** La regla 4 decía "el repo es privado". El repositorio en
  GitHub es público; lo que protege la regla no cambia: `data/`, los PDFs y el
  ground truth siguen sin versionarse, y CI restaura lo que necesita desde almacenamiento privado.
