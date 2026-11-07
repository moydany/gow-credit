/**
 * Reason for a `failed` request. Stored as text in `applications.failure_reason` (and
 * `ApplicationResult.failure_reason` in standalone); these functions build and read it in one
 * place so the workflow, worker, supplier notice and backoffice say the same thing. Never
 * carries document data: only the type and the technical extraction detail.
 */
import { z } from 'zod'
import { DISCARDED_PREFIX } from './corrections.ts'
import { DocumentType } from './enums.ts'
import type { StatementExtraction } from './statement.ts'

const NOT_BANK_STATEMENT = /^el documento no es un estado de cuenta bancario \((\w+)\)$/
const EXTRACTION_FAILED = /^la extracción falló: ([\s\S]*)$/
const SCANNED_UNREADABLE = /^no se pudo leer el documento escaneado: ([\s\S]*)$/
const MULTIPLE_STATEMENTS = /^el PDF trae (\d+) estados de cuenta$/

/** `extraction.failure_reason` of a PDF that needs a password to open. Written by extraction, read by `describeFailure`. */
export const PDF_PASSWORD_FAILURE = 'el PDF tiene contraseña'
/** Prefix of `extraction.failure_reason` when the file could not be opened as a PDF. */
export const PDF_UNREADABLE_PREFIX = 'no se pudo leer el PDF'

const NO_DETAIL = 'sin detalle'

export function notBankStatementReason(documentType: DocumentType): string {
  return `el documento no es un estado de cuenta bancario (${documentType})`
}

export function extractionFailedReason(detail: string | null): string {
  return `la extracción falló: ${detail ?? NO_DETAIL}`
}

/** PDF with no text layer (scan or photo) that vision reading could not read. */
export function scannedUnreadableReason(detail: string | null): string {
  return `no se pudo leer el documento escaneado: ${detail ?? NO_DETAIL}`
}

/**
 * One PDF holding several statements: rejected, each is requested in its own file. Built by
 * extraction when it splits (full mode) and by the workflow when the `multiple_statements` flag
 * stayed on an extraction that did run (standalone).
 */
export function multipleStatementsReason(count: number): string {
  return `el PDF trae ${String(count)} estados de cuenta`
}

/**
 * Failure reason if the extraction carries the `multiple_statements` flag, split or not; null
 * otherwise. The document count comes from the issue of the same name (`details.documents`), else two.
 */
export function multipleStatementsFailure(s: StatementExtraction): string | null {
  if (!s.flags.includes('multiple_statements')) return null
  const documents = s.issues.find((i) => i.code === 'multiple_statements')?.details['documents']
  return multipleStatementsReason(typeof documents === 'number' && Number.isInteger(documents) && documents >= 2 ? documents : 2)
}

/** No period has transactions: nothing to analyze was read from a scanned document. */
function nothingRead(s: StatementExtraction): boolean {
  return s.accounts.every((a) => a.periods.every((p) => p.transactions.length === 0))
}

/**
 * Failure reason for an extraction, or null if it can be analyzed. A password-protected PDF says
 * so; so does one with no text layer (scan or photo) that failed or yielded no transactions.
 * Whether it is a bank statement at all is the caller's call.
 */
export function extractionFailure(s: StatementExtraction): string | null {
  const detail = s.extraction.failure_reason ?? null
  // A multi-statement split already carries its full reason; don't wrap it in "extraction failed".
  if (s.extraction.status === 'failed' && MULTIPLE_STATEMENTS.test(detail ?? '')) return detail
  const scanned = s.document.text_layer === 'absent' && !(detail ?? '').startsWith(PDF_UNREADABLE_PREFIX) && detail !== PDF_PASSWORD_FAILURE
  if (s.extraction.status === 'failed') return scanned ? scannedUnreadableReason(detail) : extractionFailedReason(detail)
  if (scanned && nothingRead(s)) return scannedUnreadableReason('no se leyó ningún movimiento')
  return null
}

export const FailureKind = z.enum(['not_bank_statement', 'password_protected', 'scanned_unreadable', 'multiple_statements', 'extraction_failed', 'discarded', 'internal'])
export type FailureKind = z.infer<typeof FailureKind>

export interface FailureInfo {
  kind: FailureKind
  /** Only for `not_bank_statement`: what the classifier said it is. */
  documentType: DocumentType | null
  /** For the analyst, in Spanish, without pipeline jargon. */
  label: string
}

const DOCUMENT_LABEL: Record<DocumentType, string> = {
  bank_statement: 'El documento se marcó como no apto aunque parece un estado de cuenta bancario; revísalo.',
  credit_card_statement: 'El documento es un estado de cuenta de tarjeta de crédito, no de una cuenta bancaria.',
  invoice: 'El documento es una factura, no un estado de cuenta bancario.',
  other: 'El documento no parece un estado de cuenta bancario.',
}

export function describeFailure(reason: string | null): FailureInfo {
  const text = (reason ?? '').trim()
  const notBank = NOT_BANK_STATEMENT.exec(text)
  if (notBank) {
    const type = DocumentType.safeParse(notBank[1])
    const documentType = type.success ? type.data : 'other'
    return { kind: 'not_bank_statement', documentType, label: DOCUMENT_LABEL[documentType] }
  }
  if (MULTIPLE_STATEMENTS.test(text)) return { kind: 'multiple_statements', documentType: null, label: 'El PDF trae más de un estado de cuenta; se necesita cada uno en un archivo aparte.' }
  const scanned = SCANNED_UNREADABLE.exec(text)
  if (scanned) return { kind: 'scanned_unreadable', documentType: null, label: `El PDF no tiene texto (parece escaneado o una foto) y no se pudo leer (${scanned[1] ?? NO_DETAIL}). Pide el PDF descargado del portal o la app del banco.` }
  const extraction = EXTRACTION_FAILED.exec(text)
  if (extraction?.[1] === PDF_PASSWORD_FAILURE) return { kind: 'password_protected', documentType: null, label: 'El PDF tiene contraseña y no se pudo abrir. Pide uno sin contraseña.' }
  if (extraction) return { kind: 'extraction_failed', documentType: null, label: `No se pudo leer el documento (${extraction[1] ?? NO_DETAIL}).` }
  if (text.startsWith(DISCARDED_PREFIX)) return { kind: 'discarded', documentType: null, label: 'Documento descartado por el analista.' }
  return { kind: 'internal', documentType: null, label: text ? `El análisis no terminó: ${text}.` : 'El análisis no terminó por un error interno.' }
}
