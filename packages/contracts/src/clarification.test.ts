import { describe, expect, it } from 'vitest'
import { AnswersFile, OwnerAnswer } from './clarification.ts'

describe('respuestas del dueño', () => {
  it('lee un archivo con los cuatro tipos de respuesta', () => {
    const file = AnswersFile.parse({
      version: 1,
      applications: {
        EDC_demo: {
          answers: [
            { question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: 'Cadena Norte' },
            { question_id: 'q2', kind: 'identity', rfc: 'CNO850101AB1' },
            { question_id: 'q3', kind: 'documents', paths: ['nuevo.pdf'] },
            { question_id: 'q4', kind: 'decline' },
          ],
        },
      },
    })
    const answers = file.applications.EDC_demo?.answers ?? []
    expect(answers).toHaveLength(4)
    expect(answers[1]).toEqual({ question_id: 'q2', kind: 'identity', legal_name: null, rfc: 'CNO850101AB1', clabe: null })
    expect(answers[3]).toEqual({ question_id: 'q4', kind: 'decline', note: null })
  })

  it('un abono solo admite las categorías que el dueño puede saber', () => {
    expect(OwnerAnswer.safeParse({ question_id: 'q1', kind: 'deposit', category: 'payroll' }).success).toBe(false)
    expect(OwnerAnswer.safeParse({ question_id: 'q1', kind: 'deposit', category: null }).success).toBe(false)
  })

  it('rechaza campos de más y tipos desconocidos', () => {
    expect(OwnerAnswer.safeParse({ question_id: 'q1', kind: 'deposit', category: 'other', comentario: 'x' }).success).toBe(false)
    expect(OwnerAnswer.safeParse({ question_id: 'q1', kind: 'texto', text: 'hola' }).success).toBe(false)
    expect(AnswersFile.safeParse({ version: 2, applications: {} }).success).toBe(false)
  })
})
