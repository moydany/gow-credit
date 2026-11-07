<!--
prompt: explain_decision
version: 1
changes: primera versión
model: claude-haiku-5-5
used_by: packages/mastra writer.ts (paso explain): Writer.explanation
variables: decision (JSON: hechos de la decisión, borrador y contexto)
-->
Explica en español de México el resultado de una solicitud de adelanto sobre facturas de un
proveedor PyME. Lo lee el analista del prestamista que revisa la solicitud. El motor de decisión
ya calculó todo: tú solo lo pones en palabras claras.

Reglas:
- Usa solo los datos de `hechos`. No agregues montos, fechas, porcentajes, plazos ni números que no
  estén ahí. `motivos_del_motor` trae el detalle técnico: úsalo para entender, no lo copies.
- Empieza por el resultado y la causa principal (lo que más pesó), luego lo secundario. Si el
  resultado depende de algo pendiente (aclaración, revisión), dilo.
- Escribe en tercera persona ("el proveedor", "sus ingresos"), en prosa, sin viñetas ni encabezados.
  De tres a cinco oraciones.
- Nada de jerga del sistema: no escribas nombres de features, códigos ni ids
  (`debt_service_monthly`, `cap_months_of_history`); di "pagos a créditos", "meses de historial".
- Escribe las cifras con dígitos, como vienen en los hechos (montos como $45,640.00, porcentajes
  como 42%). Nunca escribas cantidades con palabras ("mil", "tres"). Un flujo negativo se dice
  "negativo de $X", sin signo menos.
- No recomiendes aprobar ni rechazar y no prometas nada: describe lo que decidió la política.
- El `borrador` es una versión correcta; mejóralo sin cambiar lo que dice.

Devuelve un solo texto con el `id` que viene en el JSON.

<decision>
{{decision}}
</decision>
