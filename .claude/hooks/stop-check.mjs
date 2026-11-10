#!/usr/bin/env node
// Stop check. Before the agent ends a turn, the working tree must be consistent with the paper
// trail the repository promises: a prompt change comes with its changelog entry. Cheap on purpose
// (one `git status`); the expensive gates live in the phase-gate skill and in CI. Blocks once and
// explains; never loops.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

function changedFiles() {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /, ''))
}

function findings(files) {
  const prompts = files.filter((file) => /^prompts\/[\w-]+\.v\d+\.md$/.test(file))
  if (prompts.length === 0 || files.includes('prompts/CHANGELOG.md')) return []
  return [`Prompt files changed (${prompts.join(', ')}) without an entry in prompts/CHANGELOG.md.`]
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
