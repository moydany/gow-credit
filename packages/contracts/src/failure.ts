/**
 * Motivo de una solicitud `failed` (ADR 0041). Se guarda como texto en
 * `applications.failure_reason` (y `ApplicationResult.failure_reason` en standalone); estas
 * funciones lo arman y lo leen en un solo lugar, para que el workflow, el worker, el aviso al
 * proveedor y el backoffice digan lo mismo. Nunca lleva datos del documento: solo el tipo y el
 * detalle técnico de la extracción.
 */
import { z } from 'zod'
import { DISCARDED_PREFIX } from './corrections.ts'
import { DocumentType } from './enums.ts'
import type { StatementExtraction } from './statement.ts'

const NOT_BANK_STATEMENT = /^el documento no es un estado de cuenta bancario \((\w+)\)$/
const EXTRACTION_FAILED = /^la extracción falló: ([\s\S]*)$/
const SCANNED_UNREADABLE = /^no se pudo leer el documento escaneado: ([\s\S]*)$/
const MULTIPLE_STATEMENTS = /^el PDF trae (\d+) estados de cuenta$/

/**
 * `extraction.failure_reason` de un PDF que pide contraseña para abrirse (ADR 0049). Lo escribe la
 * extracción y lo lee `describeFailure`.
 */
export const PDF_PASSWORD_FAILURE = 'el PDF tiene contraseña'
/** Prefijo de `extraction.failure_reason` cuando el archivo no se pudo abrir como PDF. */
export const PDF_UNREADABLE_PREFIX = 'no se pudo leer el PDF'

const NO_DETAIL = 'sin detalle'

export function notBankStatementReason(documentType: DocumentType): string {
  return `el documento no es un estado de cuenta bancario (${documentType})`
}

export function extractionFailedReason(detail: string | null): string {
  return `la extracción falló: ${detail ?? NO_DETAIL}`
}

/** PDF sin capa de texto (escaneado o foto) que la lectura por visión no pudo leer (ADR 0049). */
export function scannedUnreadableReason(detail: string | null): string {
  return `no se pudo leer el documento escaneado: ${detail ?? NO_DETAIL}`
}

/**
 * Un solo PDF con más de un estado de cuenta (robustez documental, sección W): se rechaza y se pide cada
 * uno en su archivo. Lo arma la extracción al cortar (modo full) y el workflow cuando la bandera
 * `multiple_statements` quedó en una extracción que sí se hizo (standalone).
 */
export function multipleStatementsReason(count: number): string {
  return `el PDF trae ${String(count)} estados de cuenta`
}

/**
 * Motivo de falla si la extracción trae la bandera `multiple_statements`, haya cortado o no; null si no.
 * El número de documentos sale del issue del mismo nombre (`details.documents`) y, si no está, son dos.
 */
export function multipleStatementsFailure(s: StatementExtraction): string | null {
  if (!s.flags.includes('multiple_statements')) return null
  const documents = s.issues.find((i) => i.code === 'multiple_statements')?.details['documents']
  return multipleStatementsReason(typeof documents === 'number' && Number.isInteger(documents) && documents >= 2 ? documents : 2)
}

/** Ningún periodo con movimientos: de un documento escaneado no se leyó nada que analizar. */
function nothingRead(s: StatementExtraction): boolean {
  return s.accounts.every((a) => a.periods.every((p) => p.transactions.length === 0))
}

/**
 * Motivo de falla de una extracción, o null si se puede analizar (ADR 0041 y 0049). Un PDF con
 * contraseña lo dice; uno sin capa de texto (escaneado o foto) que falló o del que no se leyó ningún
 * movimiento, también. Lo de no ser estado de cuenta lo decide quien llama.
 */
export function extractionFailure(s: StatementExtraction): string | null {
  const detail = s.extraction.failure_reason ?? null
  // El corte por varios estados de cuenta ya trae su motivo completo; no se envuelve en "la extracción falló".
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
  /** Solo en `not_bank_statement`: lo que el clasificador dijo que es. */
  documentType: DocumentType | null
  /** Para el analista, en español, sin jerga del pipeline. */
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
