# JSON Schema publicado

Generado desde los esquemas Zod de `packages/contracts` con `pnpm schema:export`; nunca se
edita a mano. Un test (`packages/contracts/src/json-schema.test.ts`) falla si estos archivos
no coinciden con Zod.

| Archivo | Contrato |
|---|---|
| `statement-extraction.schema.json` | Extracción de un estado de cuenta: documento → cuentas → periodos → movimientos, con fuente, verificación y confianza por valor (`docs/07` B) |
| `profile.schema.json` | Perfil crediticio: una entrada por feature del catálogo (`docs/03` §3) |
| `policy.schema.json` | Política del tenant (`docs/03` §4) |
| `decision.schema.json` | Veredicto con diagnóstico y contrafactuales (`docs/03` §6) |
| `application-request.schema.json` | Datos de la solicitud que no vienen en el PDF |
| `external-snapshot.schema.json` | Lo que responden las fuentes externas del perfil: créditos vigentes, buró, SAT, programa, historial (fase 4, ADR 0013) |
| `simulation-report.schema.json` | Resultado de simular una política sobre perfiles guardados (`docs/03` §5) |
| `scenario.schema.json` | Escenario YAML de `docs/06`, con estados de cuenta sintéticos para el modo `unit` |

JSON Schema describe la forma. Las reglas que no puede expresar viven solo en Zod y se
aplican al parsear: operador compatible con el tipo de feature, gramática de
`limitFormula`, pesos que suman 100, orden de bandas, ids únicos y fuente obligatoria para
todo valor extraído. Para validar una política con mensajes legibles se usa
`parsePolicy()` de `@gow/contracts`.

Convenciones: fechas ISO 8601 (`YYYY-MM-DD`), montos como número con a lo más dos
decimales, moneda ISO 4217 explícita por cuenta, montos de movimiento siempre positivos con
el sentido en `type: credit | debit`, y `null` cuando un dato no está en el documento.
