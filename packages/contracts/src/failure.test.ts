import { describe, expect, it } from 'vitest'
import { DISCARDED_PREFIX } from './corrections.ts'
import { describeFailure, extractionFailedReason, extractionFailure, multipleStatementsFailure, multipleStatementsReason, notBankStatementReason, PDF_PASSWORD_FAILURE, PDF_UNREADABLE_PREFIX, scannedUnreadableReason } from './failure.ts'
import type { StatementExtraction } from './statement.ts'
import { sampleStatement } from './testing/fixtures.ts'

function statement(o: { textLayer?: StatementExtraction['document']['text_layer']; status?: StatementExtraction['extraction']['status']; reason?: string | null; empty?: boolean }): StatementExtraction {
  const s = sampleStatement()
  return {
    ...s,
    document: { ...s.document, text_layer: o.textLayer ?? 'ok', route: o.textLayer === 'absent' || o.textLayer === 'corrupt' ? 'vision_only' : 'text_and_vision' },
    accounts: o.empty ? s.accounts.map((a) => ({ ...a, periods: a.periods.map((p) => ({ ...p, transactions: [] })) })) : s.accounts,
    extraction: { ...s.extraction, status: o.status ?? 'complete', failure_reason: o.reason ?? null },
  }
}

describe('motivo de una solicitud fallida', () => {
  it('lo que arma el workflow se lee de vuelta con su tipo', () => {
    expect(describeFailure(notBankStatementReason('credit_card_statement'))).toEqual({ kind: 'not_bank_statement', documentType: 'credit_card_statement', label: 'El documento es un estado de cuenta de tarjeta de crédito, no de una cuenta bancaria.' })
    expect(describeFailure(notBankStatementReason('invoice')).documentType).toBe('invoice')
    expect(describeFailure(extractionFailedReason('page_render_error'))).toMatchObject({ kind: 'extraction_failed', label: 'No se pudo leer el documento (page_render_error).' })
    expect(describeFailure(extractionFailedReason(null)).kind).toBe('extraction_failed')
  })

  it('descartado por el analista, error interno y vacío', () => {
    expect(describeFailure(`${DISCARDED_PREFIX}illegible`).kind).toBe('discarded')
    expect(describeFailure('el workflow terminó sin veredicto')).toMatchObject({ kind: 'internal', label: 'El análisis no terminó: el workflow terminó sin veredicto.' })
    expect(describeFailure(null)).toMatchObject({ kind: 'internal', documentType: null })
  })
})

describe('PDF con contraseña y escaneado ilegible', () => {
  it('la contraseña tiene su motivo y su etiqueta', () => {
    const reason = extractionFailure(statement({ textLayer: 'absent', status: 'failed', reason: PDF_PASSWORD_FAILURE }))
    expect(reason).toBe(extractionFailedReason(PDF_PASSWORD_FAILURE))
    expect(describeFailure(reason)).toEqual({ kind: 'password_protected', documentType: null, label: 'El PDF tiene contraseña y no se pudo abrir. Pide uno sin contraseña.' })
  })

  it('sin capa de texto: si la extracción falla o no lee ningún movimiento, se dice que parece escaneado', () => {
    const failed = extractionFailure(statement({ textLayer: 'absent', status: 'failed', reason: 'no se obtuvo el resumen del documento (pasada 1)' }))
    expect(failed).toBe(scannedUnreadableReason('no se obtuvo el resumen del documento (pasada 1)'))
    expect(describeFailure(failed)).toMatchObject({ kind: 'scanned_unreadable', label: expect.stringMatching(/^El PDF no tiene texto \(parece escaneado o una foto\)/) as unknown })
    expect(describeFailure(extractionFailure(statement({ textLayer: 'absent', status: 'partial', empty: true }))).kind).toBe('scanned_unreadable')
  })

  it('un escaneado que sí se leyó por visión se analiza; con texto, un fallo sigue siendo de extracción', () => {
    expect(extractionFailure(statement({ textLayer: 'absent', status: 'partial' }))).toBeNull()
    expect(extractionFailure(statement({ textLayer: 'ok', status: 'complete', empty: true }))).toBeNull()
    expect(describeFailure(extractionFailure(statement({ textLayer: 'ok', status: 'failed', reason: 'x' }))).kind).toBe('extraction_failed')
    // The corrupt text layer (EBCDIC) is not a scan.
    expect(describeFailure(extractionFailure(statement({ textLayer: 'corrupt', status: 'failed', reason: 'x' }))).kind).toBe('extraction_failed')
    // A file that doesn't even open as a PDF isn't either.
    expect(describeFailure(extractionFailure(statement({ textLayer: 'absent', status: 'failed', reason: `${PDF_UNREADABLE_PREFIX}: Invalid PDF structure` }))).kind).toBe('extraction_failed')
  })
})

describe('varios estados de cuenta en un PDF (robustez documental, sección W)', () => {
  const issue = (details: Record<string, unknown>) =>
    ({ id: 'i1', code: 'multiple_statements', severity: 'error', message: 'El PDF trae más de un estado de cuenta', page: null, path: null, account_id: null, period_id: null, transaction_id: null, details }) as StatementExtraction['issues'][number]
  const flagged = (o: { issues?: StatementExtraction['issues']; flag?: boolean; textLayer?: StatementExtraction['document']['text_layer']; status?: StatementExtraction['extraction']['status']; reason?: string | null } = {}): StatementExtraction => {
    const s = statement({ textLayer: o.textLayer ?? 'ok', status: o.status ?? 'complete', reason: o.reason ?? null })
    return { ...s, flags: o.flag === false ? s.flags : [...s.flags, 'multiple_statements'], issues: [...s.issues, ...(o.issues ?? [])] }
  }

  it('el motivo se lee de vuelta con su tipo y su etiqueta para el analista', () => {
    expect(multipleStatementsReason(3)).toBe('el PDF trae 3 estados de cuenta')
    expect(describeFailure(multipleStatementsReason(2))).toEqual({ kind: 'multiple_statements', documentType: null, label: 'El PDF trae más de un estado de cuenta; se necesita cada uno en un archivo aparte.' })
    // Must not look like the other reasons or charge for something that isn't there.
    expect(describeFailure('el PDF trae un estado de cuenta').kind).toBe('internal')
  })

  it('la bandera falla la solicitud con el número de documentos del issue, o dos si no está', () => {
    expect(multipleStatementsFailure(flagged({ issues: [issue({ documents: 3, restarts_at: [4, 8] })] }))).toBe('el PDF trae 3 estados de cuenta')
    expect(multipleStatementsFailure(flagged())).toBe('el PDF trae 2 estados de cuenta')
    expect(multipleStatementsFailure(flagged({ issues: [issue({ documents: 'tres' })] }))).toBe('el PDF trae 2 estados de cuenta')
    expect(multipleStatementsFailure(flagged({ issues: [issue({ documents: 1 })] }))).toBe('el PDF trae 2 estados de cuenta')
    expect(multipleStatementsFailure(flagged({ flag: false, issues: [issue({ documents: 3 })] }))).toBeNull()
  })

  it('un corte de la extracción no se envuelve en "la extracción falló" ni en "escaneado", escaneado o no', () => {
    for (const textLayer of ['ok', 'absent'] as const) {
      const reason = extractionFailure(flagged({ textLayer, status: 'failed', reason: multipleStatementsReason(2) }))
      expect(reason).toBe(multipleStatementsReason(2))
      expect(describeFailure(reason).kind).toBe('multiple_statements')
    }
  })
})
