---
name: paid-run
description: Protocol for any command that can call a paid model API (pnpm run evaluate, pnpm extract, pnpm eval without the read-only cache). Use before proposing or running one.
---

# Paid run

Model spend is approved by the person, per run, with a number in front of them.

1. **Try free first.** `LLM_CACHE_MODE=read` (or `--cache read` on `evaluate`) replays recorded
   responses. If the question can be answered from the cache, answer it from the cache.
2. **Smallest experiment.** If a model must be called, start with one or two documents, never the
   full set. A full run comes after the small one says it is worth it.
3. **Estimate.** Documents x calls per document x the per-document cost already measured in
   `docs/experiments/` for that model. Prices come from the provider's official page, checked the
   same day, never from memory (ADR 0011).
4. **Ask.** State the command, the model, the number of documents, the estimate and what decision
   the result will inform. Wait for a yes.
5. **Run and record.** Afterwards report the actual tokens and USD next to the estimate. A result
   that informs a decision becomes a dated note in `docs/experiments/`, negative results included.

The `guard` hook asks for confirmation on these commands anyway; this skill is what makes the
question worth answering.
