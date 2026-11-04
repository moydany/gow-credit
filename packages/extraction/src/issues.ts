import type { Issue, IssueCode } from '@gow/contracts'

type IssueInput = Omit<Issue, 'id' | 'page' | 'path' | 'account_id' | 'period_id' | 'transaction_id' | 'details'> &
  Partial<Pick<Issue, 'page' | 'path' | 'account_id' | 'period_id' | 'transaction_id' | 'details'>>

/** Acumula issues con ids estables (i0001, ...). Los mensajes no llevan PII: montos y páginas sí. */
export class IssueSink {
  readonly issues: Issue[] = []

  add(input: IssueInput): Issue {
    const issue: Issue = {
      id: `i${String(this.issues.length + 1).padStart(4, '0')}`,
      page: null,
      path: null,
      account_id: null,
      period_id: null,
      transaction_id: null,
      details: {},
      ...input,
    }
    this.issues.push(issue)
    return issue
  }

  count(code: IssueCode): number {
    return this.issues.filter((i) => i.code === code).length
  }
}
