---
name: phase-gate
description: Close a unit of work (a phase, a feature, a refactor) the way this repository closes them - independent verification, documentation audit, and the four-part report the person decides on. Use when asked to close, wrap up, or report on a phase or change.
---

# Phase gate

A unit of work is closed by evidence, not by the author's opinion of it. Run the steps in order.

1. **Freeze the scope.** `git status` and `git diff --stat` against the base. Name what changed in
   one paragraph. If something unrelated is in the tree, say so instead of folding it in.
2. **Verify independently.** Delegate to the `gate-runner` agent. Do not run the gates yourself and
   do not paraphrase its result: red stays red.
3. **Fix and repeat.** For each red gate, fix the cause (never the threshold, the lint budget or
   the test) and send it back to `gate-runner`. Stop after three rounds on the same failure and
   report it as open.
4. **Review what a gate cannot see.** In parallel: `privacy-reviewer` on the diff, and
   `docs-auditor` on the documents that govern the area.
5. **Leave the paper trail.** A new or changed decision gets an ADR in `docs/adr/` and a row in its
   README. A design that changed gets a "Cambios durante la implementación" section in the affected
   document. A prompt change gets its changelog entry.
6. **Report, then stop.** Four sections, in this order:
   - **What was done**: the change, by package.
   - **What was verified by running it**: the gate table from `gate-runner`, verbatim.
   - **What it cost**: tokens and USD of paid model calls in this unit, zero if cache-only.
   - **What changed against the brief**: each divergence with its ADR, and every open item.

The person reads the report and decides whether to continue. Do not commit, push or start the next
unit on your own.
