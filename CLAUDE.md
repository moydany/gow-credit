# GOW Credit worksample

Instrucciones para el agente de código que trabaja en este repositorio. Cómo está armado el
harness y por qué: `docs/harness.md`.

## Qué es

Sistema que recibe estados de cuenta bancarios de proveedores, extrae su información con
Gemini 3.8 Flash (Claude como emergencia), calcula un perfil crediticio, aplica la política del
prestamista (tenant) y consulta al proveedor por WhatsApp o correo cuando un dato dudoso puede
cambiar el resultado.

Es un worksample técnico que se evalúa sobre documentos no vistos. De ahí salen las prioridades:

1. **La precisión de la extracción es la métrica dura.** Ningún cambio la baja sin que se note.
2. **`pnpm run evaluate <carpeta>` es lo que corren los evaluadores.** Nunca puede romperse.
3. **Las decisiones y los supuestos documentados cuentan tanto como el resultado.**

## Antes de tocar código

1. Lee `docs/00-brief.md` completo. Es el punto de entrada y manda sobre todo lo demás.
2. Lee `docs/README.md`: orden de lectura, glosario y **estados canónicos** (úsalos tal cual).
3. Lee `docs/07`, `02`, `03` y `04` antes de la fase que corresponda; `docs/09` antes de tocar
   el contrato o los prompts de extracción. `01` es solo referencia.

## Cómo se trabaja

Quien cambia no verifica, y la persona decide cuándo algo está terminado.

1. **Planea.** Di el alcance y qué significa terminado antes de editar. Si algún paso cuesta
   dinero, dilo desde el plan.
2. **Cambia poco.** Un asunto por cambio. Si encuentras otro problema, repórtalo; no lo mezcles.
3. **Verifica con otro agente.** Las compuertas las corre `gate-runner`, que no puede editar. Su
   tabla es la única evidencia que puedes citar: lo rojo se reporta rojo, y "debería pasar" no es
   un resultado.
4. **Revisa lo que una prueba no ve.** `privacy-reviewer` antes de un commit que toque logs,
   trazas, fixtures, evals o ejemplos en documentos; `docs-auditor` al cerrar una fase.
5. **Deja registro.** Decisión nueva o cambiada, cambio de diseño y cambio de prompt tienen cada
   uno su lugar (ver "Documentación y decisiones").
6. **Reporta y detente.** Cuatro partes: qué se hizo, qué se verificó corriéndolo, cuánto costó
   en tokens y dólares, qué cambió respecto al brief. El skill `phase-gate` lleva el orden.

| Pieza | Dónde | Para qué |
|---|---|---|
| `gate-runner` | `.claude/agents/` | Corre typecheck, lint, duplicados, pruebas, escenarios y evals desde caché. Solo reporta |
| `extraction-engineer` | `.claude/agents/` | Cambios a prompts, contrato de extracción, router de modelos y pasadas de verificación |
| `docs-auditor` | `.claude/agents/` | Repositorio contra los documentos de diseño. Solo lectura |
| `privacy-reviewer` | `.claude/agents/` | Datos personales y secretos en un diff. Solo lectura |
| `phase-gate` | `.claude/skills/` | Cerrar una fase, una funcionalidad o un refactor |
| `paid-run` | `.claude/skills/` | Antes de cualquier comando que pueda llamar a un modelo pagado |
| `guard.mjs` | `.claude/hooks/` | Antes de cada comando, lectura y escritura: niega o pide confirmación |
| `stop-check.mjs` | `.claude/hooks/` | Al cerrar el turno: el changelog de prompts y el índice de ADR están al día |

Cuando un hook niega algo, no lo rodees con otro comando: corrige la causa o pregunta.

## Reglas que no se negocian

### Producto

- Dos modos. `standalone` (`pnpm run evaluate <carpeta>`): `ANTHROPIC_API_KEY` obligatoria; con
  `GEMINI_API_KEY` la extracción va con Gemini, sin ella con Opus. `full`: Supabase, pg-boss,
  Baileys, Resend. **El modo standalone nunca puede romperse.**
- Zod es la única fuente de verdad de cada contrato; tipos con `z.infer`.
- Código e identificadores en inglés. Documentación y mensajes al proveedor en español, salvo
  `README.md` y `docs/harness.md`, que van en inglés (`README.es.md` es la versión en español).

### Modelos y prompts

- Versiones fijadas, junto con el lockfile:

  | Modelo | Uso |
  |---|---|
  | `gemini-3.8-flash` | Extracción |
  | `claude-opus-5-5` | Emergencia por proveedor y, mientras `gemini-4-carbon` no esté verificado, por calidad; doble lectura con effort alto |
  | `claude-haiku-5-5` | Clasificación de respaldo, aclaraciones, doble lectura |
  | `jev-1.13.0` | Jev |

- API de Anthropic actual: `output_config.format`, sin `temperature`, thinking adaptativo,
  `fallbacks: "default"`. Si el skill `claude-api` está disponible, cárgalo antes de escribir
  llamadas al SDK.
- Gemini vía `@ai-sdk/google` fijado en el lockfile: `responseJsonSchema`, `thinkingLevel`
  derivado de `effort`, PDF como `inlineData`, caché implícita. El precio oficial se verifica
  antes de reportar costos (ADR 0011).
- Los prompts viven en `prompts/` con changelog. Son la fuente del código, de las evals y del
  modo standalone; en modo full se siembran en la base y la versión activa se elige en el
  backoffice (ADR 0065).
- Una versión de prompt no se edita después de medirse: un cambio crea `v<N+1>`, sube la versión
  en `PROMPT_CATALOG` y deja una entrada en `prompts/CHANGELOG.md` con las métricas de antes y
  después.
- Ningún cambio de prompt o modelo en el repositorio (`prompts/`, `PROMPT_CATALOG`, `models.ts`)
  se fusiona si baja las métricas de evals bajo el umbral. Una versión creada en el backoffice no
  tiene evals: se marca "Sin evals" y la activa un editor con confirmación. Para volverla la del
  código, pasa a `prompts/` y por las evals (ADR 0065).
- El gasto en modelos lo aprueba la persona, por corrida y con una estimación delante. Primero la
  caché (`LLM_CACHE_MODE=read` o `--cache read`), luego uno o dos documentos, y solo después una
  corrida completa.

### Datos y privacidad

- `data/`, los PDFs y el ground truth nunca se versionan. El contenido de un estado de cuenta no
  se imprime, ni en la consola ni en la conversación.
- Nada de PII en logs ni trazas: ids, hashes, conteos y nombres de campo sí; valores no.
- El `.env` no se lee, no se escribe y no se commitea.

### Documentación y decisiones

- Decisión nueva o cambiada: ADR en `docs/adr/` y su fila en el índice. `docs/adr/` es el
  registro del dueño y no se publica: si no existe en este clon, no lo recrees, pregunta.
- No reescribir `docs/01` a `08`. Lo que cambió al construir va en "Cambios durante la
  implementación" al final del documento afectado.
- Una medición que informa una decisión queda como nota fechada en `docs/experiments/`, también
  cuando el resultado es negativo.

### Git

- Commits pequeños y descriptivos, en inglés. El historial es parte del entregable.
- Sin atribución al agente: ningún commit ni PR lleva `Co-Authored-By` de Claude ni "Generated
  with Claude Code". `.claude/settings.json` la apaga; el autor del historial es solo el dueño.
- Commit, push, merge y despliegue solo cuando la persona los pide.

## Comandos

### Compuertas

| Comando | Qué revisa |
|---|---|
| `pnpm doctor` | Qué falta en esta máquina |
| `pnpm typecheck` | Tipos en todo el monorepo |
| `pnpm lint` | ESLint con tipos; tamaño y complejidad con cero avisos permitidos |
| `pnpm dup` | Clones entre archivos |
| `pnpm test` | Vitest; con Postgres arriba, también RLS y aislamiento por tenant |
| `pnpm scenario run <id>\|--all` | Escenarios en modo unitario; `--mode full` para el modo full |
| `pnpm eval` | Extracción contra el ground truth, con umbral por banco |

### Evaluar y decidir

- `pnpm run evaluate <carpeta> [--request k=v,...] [--answers archivo.json] [--as-of AAAA-MM-DD] [--interactive] [--cache read]`.
  Salida en `data/out/evaluate/`.
  - Una solicitud pausada se reanuda con `--answers`.
  - Documentos redactados: `--policy policies/examples/standalone-evaluation.v1.json`.
  - Tres meses seguidos en vez de uno: `--policy policies/examples/standalone-tres-meses.v1.json`.
  - Una subcarpeta es una solicitud con varios PDF (ADR 0072).
- `pnpm decide <extracción.json>`: perfil y veredicto sin costo; salida en `data/out/profiles/`.
- `pnpm simulate --policy <json>`.

### Modo full

- Infraestructura y base: `docker compose up -d`, `pnpm db:migrate`.
- Tenant: `pnpm tenant create --name ...`.
- Procesos: `pnpm api`, `pnpm worker`, `pnpm whatsapp` (descubre el tenant solo;
  `WHATSAPP_TENANT_ID` solo con varios).
- Backoffice: `pnpm tenant user add --tenant <id> --email <correo>` (imprime el enlace de acceso),
  `pnpm demo:load --key <llave>` (carga `data/dev` por la API; con `LLM_CACHE_MODE=read pnpm worker`
  cuesta cero) y `pnpm web`.

### Correcciones y ground truth

`pnpm corrections:export --tenant <id>`, `pnpm -F @gow/evals corrections`,
`pnpm -F @gow/evals gt:review sample|record`.

## Máquina nueva: desempacar los datos

`data/` no está en git. Si el repositorio está recién clonado y `pnpm doctor` dice que faltan
datos, busca el paquete que trajo el usuario: `gow-data.tar.gz` (sin cifrar) o
`gow-data.tar.gz.enc` (cifrado). Primero en la raíz del repositorio; si no está, pregunta la ruta.

- **Siempre desde la raíz del repositorio**, nunca dentro de `data/`: las rutas del paquete ya
  empiezan con `data/` (`data/dev`, `data/ground-truth`, `data/llm-cache`). Desde otra carpeta
  quedaría `data/data/...`.
- Sin cifrar: `tar -xzf <ruta>/gow-data.tar.gz`.
- Cifrado: `pnpm data:unpack <ruta>/gow-data.tar.gz.enc`. Necesita `EVAL_BUNDLE_KEY`; pídele al
  usuario que corra él el comando con su frase. No la escribas ni la guardes tú.
- Después corre `pnpm doctor`: debe decir que los 9 PDFs coinciden con el manifiesto. Cuando
  pase, ofrece borrar el paquete (`rm`), porque sin cifrar contiene los estados de cuenta.
- El paquete y lo que sale de él nunca se commitean, nunca se mueven fuera de `data/` y su
  contenido no se imprime. El `.env` del usuario va en la raíz. Guía completa:
  `docs/local-setup.md`. Para mover los datos a otra máquina: `pnpm data:pack` y
  `pnpm data:unpack`.
