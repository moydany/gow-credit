/**
 * PDF con contraseña (ADR 0049): se detecta sin abrir el documento cuando no está cifrado, se
 * distingue la contraseña de apertura de las restricciones de permisos, y la extracción falla con su
 * motivo propio sin llamar a ningún modelo.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeFailure, extractionFailedReason, PDF_PASSWORD_FAILURE } from '@gow/contracts'
import { createLimiter, type Classifier, type StructuredLlm } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, extractStatement } from './extract.ts'
import { hasEncryptDictionary, loadPdf, pdfProtection } from './pdf.ts'
import { encryptedStatementPdf, SYNTHETIC_STATEMENT_LINES, syntheticStatementPdf } from './testing-synthetic-pdf.ts'

const plain = syntheticStatementPdf(SYNTHETIC_STATEMENT_LINES)
const restricted = encryptedStatementPdf(SYNTHETIC_STATEMENT_LINES, { userPassword: '' })
const locked = encryptedStatementPdf(SYNTHETIC_STATEMENT_LINES, { userPassword: 'secreto' })

const dir = mkdtempSync(join(tmpdir(), 'gow-pdf-protection-'))
const write = (name: string, bytes: Buffer) => {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

describe('PDF con contraseña (ADR 0049)', () => {
  it('la llave /Encrypt del trailer delata el cifrado; /EncryptMetadata sola no', () => {
    expect(hasEncryptDictionary(plain)).toBe(false)
    expect(hasEncryptDictionary(restricted)).toBe(true)
    expect(hasEncryptDictionary(locked)).toBe(true)
    expect(hasEncryptDictionary(Buffer.from('%PDF-1.7\n<< /EncryptMetadata false >>', 'latin1'))).toBe(false)
    expect(hasEncryptDictionary(Buffer.from('%PDF-1.7\ntrailer<</Encrypt 9 0 R>>', 'latin1'))).toBe(true)
  })

  it('distingue la contraseña de apertura de las restricciones de permisos', async () => {
    expect(await pdfProtection(plain)).toBe('none')
    expect(await pdfProtection(restricted)).toBe('permissions_only')
    expect(await pdfProtection(locked)).toBe('password')
  })

  it('un PDF que solo restringe permisos se lee normal', async () => {
    const pdf = await loadPdf(write('restringido.pdf', restricted))
    expect(pdf.textLayer).toBe('ok')
    expect(pdf.pageTexts[0]).toContain('BANCO FICTICIO S.A.')
  })

  it('con contraseña, la extracción falla con su motivo y sin llamar a los modelos', async () => {
    const calls: string[] = []
    const llm: StructuredLlm = {
      call: (req) => {
        calls.push(req.purpose)
        return Promise.reject(new Error('no debió llamarse'))
      },
    }
    const classifier: Classifier = {
      classify: () => {
        calls.push('classify')
        return Promise.reject(new Error('no debió llamarse'))
      },
    }
    const doc = await extractStatement(write('con-contrasena.pdf', locked), { llm, classifier }, { ...DEFAULT_OPTIONS, limit: createLimiter(1), googleAvailable: true })
    expect(doc.extraction.status).toBe('failed')
    expect(doc.extraction.failure_reason).toBe(PDF_PASSWORD_FAILURE)
    expect(calls).toEqual([])
    expect(describeFailure(extractionFailedReason(doc.extraction.failure_reason)).kind).toBe('password_protected')
  })
})
