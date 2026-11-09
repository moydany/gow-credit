#!/usr/bin/env node
// Stop check. Before the agent ends a turn, the working tree must be consistent with the paper
// trail the repository promises: a prompt change comes with its changelog entry, and a new ADR is
// listed in the index. Cheap on purpose (one `git status`); the expensive gates live in the
// phase-gate skill and in CI. Blocks once and explains; never loops.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

function changedFiles() {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), file: line.slice(3).replace(/^.* -> /, '') }))
}

function findings(files) {
  const names = new Set(files.map((f) => f.file))
  const problems = []
  const prompts = files.filter((f) => /^prompts\/[\w-]+\.v\d+\.md$/.test(f.file))
  if (prompts.length > 0 && !names.has('prompts/CHANGELOG.md')) {
    problems.push(
      `Prompt files changed (${prompts.map((f) => f.file).join(', ')}) without an entry in prompts/CHANGELOG.md.`,
    )
  }
  const newAdrs = files.filter((f) => /^docs\/adr\/\d{4}-.+\.md$/.test(f.file) && /^(\?\?|A)/.test(f.status))
  if (newAdrs.length > 0 && !names.has('docs/adr/README.md')) {
    problems.push(`New ADR (${newAdrs.map((f) => f.file).join(', ')}) is not listed in docs/adr/README.md.`)
  }
  return problems
}

function main() {
  const payload = JSON.parse(readFileSync(0, 'utf8') || '{}')
  if (payload.stop_hook_active) return
  let problems
  try {
    problems = findings(changedFiles())
  } catch {
    return
  }
  if (problems.length === 0) return
  process.stdout.write(JSON.stringify({ decision: 'block', reason: problems.join(' ') }))
}

main()
