/* eslint-disable no-console -- CLI interactive prompting */
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { OwnerAnswer, type Question } from '@gow/contracts'

const USER_CWD = process.env.INIT_CWD ?? process.cwd()

async function askChoiceQuestion(rl: ReturnType<typeof createInterface>, q: Question): Promise<OwnerAnswer> {
  q.options.forEach((o, i) => { console.log(`   ${String(i + 1)}) ${o.label}`); })
  const pick = Number((await rl.question('   Opción (vacío = no sé): ')).trim())
  const value = q.options[pick - 1]?.value
  const parsed = value === undefined ? null : OwnerAnswer.safeParse(q.kind === 'account_use' ? { question_id: q.id, kind: q.kind, use: value } : { question_id: q.id, kind: q.kind, category: value, counterparty: null })
  return parsed?.success ? parsed.data : { question_id: q.id, kind: 'decline', note: null }
}

async function askQuestion(rl: ReturnType<typeof createInterface>, q: Question): Promise<OwnerAnswer> {
  console.log(`\n${q.id}. ${q.text}`)
  if (q.kind === 'deposit' || q.kind === 'charge' || q.kind === 'account_use') {
    return askChoiceQuestion(rl, q)
  }
  if (q.kind === 'buyer') {
    const name = (await rl.question('   Nombre del cliente principal (vacío = no sé): ')).replace(/\s+/g, ' ').trim()
    return name.length >= 3 ? { question_id: q.id, kind: 'buyer', name } : { question_id: q.id, kind: 'decline', note: null }
  }
  if (q.kind === 'identity') {
    const legal = (await rl.question('   Razón social o nombre del titular (vacío = no sé): ')).trim()
    const rfc = (await rl.question('   RFC (opcional): ')).trim()
    const clabe = (await rl.question('   CLABE (opcional): ')).trim()
    return legal ? { question_id: q.id, kind: 'identity', legal_name: legal, rfc: rfc || null, clabe: clabe || null } : { question_id: q.id, kind: 'decline', note: null }
  }
  const paths = (await rl.question('   Ruta de los PDF, separadas por coma (vacío = no los tengo): ')).split(',').map((p) => p.trim()).filter(Boolean)
  return paths.length ? { question_id: q.id, kind: 'documents', paths: paths.map((p) => resolve(USER_CWD, p)) } : { question_id: q.id, kind: 'decline', note: null }
}

export async function askInteractively(questions: readonly Question[]): Promise<OwnerAnswer[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answers: OwnerAnswer[] = []
  try {
    for (const q of questions) {
      answers.push(await askQuestion(rl, q))
    }
  } finally {
    rl.close()
  }
  return answers
}
