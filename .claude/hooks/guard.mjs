#!/usr/bin/env node
// PreToolUse guard. Turns the non-negotiable rules of CLAUDE.md into checks the agent cannot skip:
// statement data never reaches the transcript or the index, commits carry no agent attribution,
// published prompt versions are immutable, and anything that costs money or leaves the machine
// (model calls, push, deploy) waits for the person. Reads the hook payload on stdin and prints a
// permission decision; silence means "no opinion".
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

/** Paths whose contents are statements, ground truth or secrets. */
const PRIVATE_PATH = /(^|\/)(data\/(dev|ground-truth|storage-supabase|whatsapp|backups)(\/|$)|gow-data\.tar\.gz|\.env(\.(?!example$)[\w.-]+)?$)/

const PUBLISHED_PROMPT = /^prompts\/[\w-]+\.v\d+\.md$/

const BASH_RULES = [
  {
    decision: 'deny',
    test: (cmd) => /\bgit\s+commit\b/.test(cmd) && /co-authored-by|generated with claude/i.test(cmd),
    reason: 'Commits in this repository carry no agent attribution (CLAUDE.md). Remove the trailer.',
  },
  {
    decision: 'deny',
    test: (cmd) => /\bgit\s+add\b[^|;&]*(\s|\/)(data(\/|\s|$)|\.env(\s|$)|[^\s]*\.pdf\b|gow-data)/.test(cmd),
    reason: 'data/, PDFs, the data bundle and .env are never staged (CLAUDE.md).',
  },
  {
    decision: 'deny',
    test: (cmd) =>
      /\b(cat|head|tail|less|more|strings|xxd|pdftotext|open)\b[^|;&]*\bdata\/(dev|ground-truth)\b/.test(cmd),
    reason:
      'Statement and ground-truth contents are not printed. Use scripts/inspect-extractions.mjs or the eval reports, which mask them.',
  },
  {
    decision: 'ask',
    test: (cmd) =>
      /\bpnpm\s+(run\s+)?(evaluate|extract|eval)\b/.test(cmd) &&
      !/LLM_CACHE_MODE=read\b|--cache\s+read\b/.test(cmd),
    reason:
      'This run can call paid model APIs. State the estimated cost first, or rerun with LLM_CACHE_MODE=read / --cache read.',
  },
  {
    decision: 'ask',
    test: (cmd) => /\bgit\s+push\b|\brailway\s+(up|deploy|redeploy)\b|infra\/railway\/deploy\.sh|\bgh\s+pr\s+merge\b/.test(cmd),
    reason: 'Push, merge and deploy only happen when the person asks for them.',
  },
]

function relative(filePath) {
  return path.relative(ROOT, path.resolve(ROOT, filePath)).split(path.sep).join('/')
}

function checkBash(input) {
  const cmd = String(input.command ?? '')
  const hit = BASH_RULES.find((rule) => rule.test(cmd))
  return hit ? { decision: hit.decision, reason: hit.reason } : null
}

function checkRead(input) {
  const rel = relative(String(input.file_path ?? ''))
  if (!PRIVATE_PATH.test(rel)) return null
  return { decision: 'deny', reason: `${rel} holds statement data or secrets and stays out of the transcript.` }
}

function checkWrite(input) {
  const rel = relative(String(input.file_path ?? ''))
  if (PRIVATE_PATH.test(rel)) {
    return { decision: 'deny', reason: `${rel} is private data or a secret; the agent does not write it.` }
  }
  if (PUBLISHED_PROMPT.test(rel) && isTracked(rel)) {
    return {
      decision: 'ask',
      reason: `${rel} is a published prompt version. A change creates v<N+1> plus a prompts/CHANGELOG.md entry and an eval run.`,
    }
  }
  return null
}

function isTracked(rel) {
  try {
    const index = readFileSync(path.join(ROOT, '.git', 'index'))
    return index.includes(Buffer.from(rel))
  } catch {
    return false
  }
}

const CHECKS = { Bash: checkBash, Read: checkRead, Edit: checkWrite, Write: checkWrite }

function main() {
  const payload = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const check = CHECKS[payload.tool_name]
  const verdict = check ? check(payload.tool_input ?? {}) : null
  if (!verdict) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision,
        permissionDecisionReason: verdict.reason,
      },
    }),
  )
}

main()
