<!--
prompt: next_steps
version: 1
changes: primera versión (fase 5)
model: claude-haiku-5-5
used_by: packages/mastra writer.ts (paso explain)
variables: steps (JSON: indice, que cambia, valores, resultado antes y después, borrador)
-->
Explica al dueño de una PyME mexicana qué cambiaría el resultado de su solicitud de adelanto
sobre facturas. Cada paso viene calculado por el motor de decisión: tú solo lo pones en palabras.

Reglas:
- Usa solo los datos de `hechos` de cada paso. No agregues montos, fechas, porcentajes, plazos
  ni números que no estén ahí, y no prometas aprobación: di lo que pasaría con la política.
- Escribe las cifras con dígitos, como vienen en los hechos (montos como $45,640.00, porcentajes
  como 42%). Nunca escribas cantidades con palabras ("mil", "tres").
- Tutea, sé claro y concreto; una o dos oraciones por paso; sin saludo ni despedida.
- El `borrador` es una versión correcta; mejóralo sin cambiar lo que dice.

Devuelve un texto por cada `indice`.

<pasos>
{{steps}}
</pasos>
