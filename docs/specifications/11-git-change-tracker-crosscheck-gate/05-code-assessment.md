# Code Assessment: Codebase Assessment — Git Change-Tracker & Cross-Check Gate (spec-11)

- **Date**: 2026-07-21
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a self-contained TypeScript pi-extension/CLI pipeline (ESM, "type":"module", node ≥22.19, zero runtime deps — only peerDeps pi-coding-agent/typebox/pi-tui). The change-tracker fits cleanly into a mature, heavily-patterned codebase: a control-flow node algebra (src/nodes.ts) drives an EventEmitter-powered engine (src/workflow.ts) that emits "stage"/"phase" events; a deterministic oracle layer (src/build-runner.ts) already does robust, never-throwing git/spawn work with discrete-argv spawnSync and the exact committed-diff UNION untracked-files pattern the tracker needs; phase-green is already an AND-chain `(gate.pass||gate.inScopePass) && deliverableCheck.pass` with retry-prompt injection; and there is a canonical module-level per-run singleton pattern (activeRun in src/extension.ts) set in execute() entry / cleared in finally — the exact mechanism to thread a per-run ChangeTracker. There is NO HTTP API server or UI dev server in this repo; local verification is `npm run typecheck` (tsc --noEmit) and `npm test` (vitest run). The implementer's output contract is a single line in prompts.ts that returns `filesModified (array)` — advisory only — so the structured-set + cross-check gate is a small, surgical addition, not a rewrite.

## Patterns

### Never-throw safe degradation on every git/spawn op

- **Example**: src/build-runner.ts:538-573 (touchedFilePaths: try { spawnSync git diff + ls-files } catch { return [] }) — returns [] on non-git dir, ENOENT, non-string stdout, or any throw
- **Consistency**: Universal in build-runner.ts (runBuildGate, runRedCheck, runDeliverableCheck all degrade to []/unknown/empty rather than throwing). The ChangeTracker MUST follow this: git unavailable → record {gitUnavailable:true} and continue, never block, never throw.
### Discrete-argv spawnSync + timeout envelope, no shell

- **Example**: src/build-runner.ts:538-545 (spawnSync("git", ["-C", cwd, "diff", ...], { encoding:"utf8" }) — never shell:true; timeouts via resolveTimeoutMs)
- **Consistency**: Every git subprocess in the module. The tracker's rev-parse / status --porcelain / diff --name-status <beginHead> spawns must use the identical discrete-argv form to keep path data out of any shell and to inherit the timeout discipline.
### Git delta = committed-diff UNION untracked, deduped first-seen

- **Example**: src/build-runner.ts:538-573 (git diff --merge-base <ref> --name-only UNION git ls-files --others --exclude-standard, then dedupePreservingOrder); dedupePreservingOrder defined at src/build-runner.ts:118
- **Consistency**: This is the exact union logic the tracker's gitActual classification needs — but keyed off a stored beginHead (git diff --name-status <beginHead>) rather than a base ref, plus git status --porcelain for uncommitted. Reuse dedupePreservingOrder verbatim.
### Phase-green AND-chain with retry-prompt injection (spec-10 pattern to mirror)

- **Example**: src/stages/implementation.ts:194 (if ((gate.pass||gate.inScopePass) && deliverableCheck.pass) {...GREEN...}); failures injected at src/stages/implementation.ts:146-148 via implParts.push(`## Previous attempt failed...`) / `## Deliverables still missing — create/wire these`
- **Consistency**: The changeGate MUST slot into this exact pattern: extend line 194 to `&& changeGate.pass`, and feed claimedNotChanged into implParts under a `## Claimed changes not present in git — actually create/wire these` block mirroring the deliverable-miss block at 148, bounded by MAX_ATTEMPTS (=3, src/stages/implementation.ts:16).
### Per-run module singleton, set in execute() entry / cleared in finally

- **Example**: src/extension.ts:68 (let activeRun) / :141 (setActiveRun on execute() entry) / :149 (getActiveRun) / :391 (null in finally) — the mid-run-input feature's threading model
- **Consistency**: The canonical mechanism for threading per-run state across stage boundaries without editing nodes.ts/workflow.ts/pipeline.ts internals. The ChangeTracker should mirror this exactly: module-level `let activeTracker`, setActiveTracker(specDir, worktreePath) in execute() entry, null in the same finally. state.setup.worktreePath + state.setup.specDirectory (src/types.ts:112-113, 292-293) supply both required paths.
### Event-bus stage/phase seam (minimal engine touch)

- **Example**: src/nodes.ts:126-127 (ctx.events.emit("phase", stage.label) + emit("stage", {id,label,status:"running"})) and :98 (emit "stage" with status after run); subscribed at src/workflow.ts:163-164 (ctx.events.on("stage"/"phase"))
- **Consistency**: PREFERRED over editing nodes.ts internals: subscribe the tracker to ctx.events for stage enter/exit boundaries, OR add a thin tracker.begin/end wrapper around stage.run at nodes.ts:127-129. Phases still bracket inside implementation.ts since phase events are coarse (only the stage label, per-node), not per-phase-id.
### Output contract is a single templated prompt line (easy to upgrade)

- **Example**: src/prompts.ts:120 (buildImplementPrompt ends: "Output <control> JSON with: filesModified (array), testsPassCount (number), summary.") and :140 (fix prompt: "...with: filesModified (array), fixesApplied (number), summary.")
- **Consistency**: The structured-set change is a one-line edit in two prompt builders (buildImplementPrompt + the review/fix prompt), changing filesModified (array) → filesCreated (array), filesModified (array), filesDeleted (array). No other contract plumbing.
### Hermetic vitest tests, one file per concern, fully mocked git/agent

- **Example**: tests/implementation-deliverable-wiring.test.ts:24-40 (vi.mock("../src/build-runner.ts"), stub runRedCheck to "unknown", mock renderAndWrite — disk-free); naming: build-runner-<feature>.test.ts / implementation-<feature>-wiring.test.ts
- **Consistency**: 1120 existing tests all follow this. New tracker tests must vi.mock spawnSync (or the tracker's git helper), assert change-tracker.jsonl content + append-only behavior, and follow build-runner-tracker.test.ts / implementation-crosscheck-gate.test.ts naming. .ts extensions in all imports; ESM import paths.

## Files Assessed

- package.json
- README.md
- src/build-runner.ts
- src/stages/implementation.ts
- src/workflow.ts
- src/nodes.ts
- src/pipeline.ts
- src/extension.ts
- src/types.ts
- src/prompts.ts
- tests/implementation-deliverable-wiring.test.ts

## Recommendations

- Mirror the activeRun singleton (src/extension.ts:68/141/149/391) for the ChangeTracker: a module-level `let activeTracker` in a new src/tracking.ts, set setActiveTracker(specDir, worktreePath) on execute() entry right after setActiveRun, nulled in the SAME finally. This threads both required paths (from state.setup, src/types.ts:112-113) with zero edits to nodes.ts/workflow.ts/pipeline.ts internals.
- Reuse build-runner.ts's git primitives, do not re-implement: import dedupePreservingOrder and copy the two-spawn discrete-argv union shape (src/build-runner.ts:538-573). For the tracker's delta use `git diff --name-status <beginHead>` (status letters A/M/D map directly to created/modified/deleted) UNION `git status --porcelain`, wrapped in one try/catch that records {gitUnavailable:true} on any failure and continues (never throws, never blocks — the established never-throw contract).
- Slot the changeGate into the existing phase-green AND at src/stages/implementation.ts:194 — extend to `(gate.pass||gate.inScopePass) && deliverableCheck.pass && changeGate.pass`. Feed claimedNotChanged into the next implementer retry under a `## Claimed changes not present in git — actually create/wire these` block, mirroring the missingDeliverables block at line 148, bounded by MAX_ATTEMPTS. changedNotClaimed stays advisory-only (ctx.log), and git-unavailable → changeGate.pass = true (don't block on infra).
- Bracket phases inside implementation.ts around the `for (const [idx, phase] of phases.entries())` loop (src/stages/implementation.ts ~93): tracker.begin("phase", phaseId) before the attempt loop, tracker.end("phase", phaseId, claimedFromImplementer) after. Bracket ALL stages via a ctx.events subscription in src/workflow.ts:163-164 (stage enter/exit) — the minimal-touch seam — rather than editing nodes.ts stage.run internals. Emit begin events as {event:"start"} and end as {event:"end"} into <specDir>/change-tracker.jsonl so the bracket trace is complete.
- Bridge to spec-10 by unioning claimed.filesCreated into the deliverable requireFiles before calling runDeliverableCheck (src/build-runner.ts:1830, DeliverableContract.requireFiles at :1588) — a claimed-created file must exist, so tracking and deliverable-assertions reinforce. Update the prompt contract line at src/prompts.ts:120 and :140 from `filesModified (array)` to the structured `filesCreated/filesModified/filesDeleted` set, with a one-line 'these are git-cross-checked; claiming a file you didn't change fails the phase' nudge. Accept legacy flat filesModified arrays defensively (tolerate both control shapes) — same defensive cast already used at src/stages/implementation.ts:159.
