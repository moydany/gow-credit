import type { Issue, IssueCode } from '@gow/contracts'

type IssueInput = Omit<Issue, 'id' | 'page' | 'path' | 'account_id' | 'period_id' | 'transaction_id' | 'details'> &
  Partial<Pick<Issue, 'page' | 'path' | 'account_id' | 'period_id' | 'transaction_id' | 'details'>>

/** Accumulates issues with stable ids (i0001, ...). Messages carry no PII (amounts and pages are fine). */
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
