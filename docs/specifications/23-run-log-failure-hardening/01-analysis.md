# Analysis: Run Log Failure Hardening

## Run reviewed

`/Users/I336589/.pi/agent/super-dev/runs/2026-08-01T05-46-39-633Z/run.log`

## Findings

1. **Late requirement propagation gap** — user added a multi-select filter requirement during execution. Runtime notes were injected into later specialists, but previously-green implementation phases could be skipped by phase carry, so backend/API phases did not necessarily rerun with the new requirement.
2. **Deliverable regex false negative** — phase 4 failed deliverables on patterns like `(?i)permission` and `(?i)empty|error|loading`. The checked files contained matching text, but JavaScript `RegExp` does not support `(?i)` inline case-insensitive prefix. The checker fell back to literal substring matching and missed the content.
3. **Pre-merge after cleanup** — the pipeline ran cleanup before pre-merge build. Cleanup can remove dependency installs; the final build then failed with missing `next`/`typescript` modules instead of a true application failure.

## Fix plan

- Invalidate Stage 9 phase carry when runtime instructions change so earlier backend phases rerun.
- Teach deliverable pattern matching to translate leading `(?i)` into JS regex `i` flag.
- Move pre-merge build gate before cleanup.
