# Technical Specification — HITL Escalation (pause-ask-continue)

- **Spec**: 18-hitl-escalation-pause-continue
- **Date**: 2026-07-28
- **Author**: super-dev:spec-writer
- **Task type**: bug (silent-failure remediation) / TypeScript frontend library
- **Status**: ready for implementation
- **Upstream**: 01-requirements.md (AC-01..AC-12), 02-bdd-scenarios.md (SCENARIO-001..025), 03-research-report.md, 05-code-assessment.md

---

## 1. Purpose & Problem

Today pi-super-dev **fails silently** on unrecoverable blockers. A fatal gate that exhausts its retry budget throws `FatalAbort` (src/nodes.ts:436); `execute()`'s catch (src/extension.ts) returns `isError` with **no prompt to the user**. Only verify-loop *stagnation* has an opt-in, post-run HITL hook (`handleStagnation`, src/extension.ts:249), and it fires *after* the loop has already broken — it cannot resume.

When a human is present, super-dev must **pause, ask, and continue**: surface the blocker inline (where the live failure context still exists), let the user choose a recovery action, and resume execution on that decision. This is the canonical pi pattern (`await ctx.ui.select` / `ctx.ui.input` block the running handler; the user decides; execution continues inline) and the pi-subagents `clarify` model.

This spec locks the design already produced in the requirements + research + code-assessment stages. It is **additive**: non-interactive runs behave byte-identically to today (report + fail); interactive runs gain a pause-ask-continue path.

---

## 2. Design Summary (single-paragraph architecture)

Thread an `escalate(failure)` callback on `RunOptions` beside the existing `userSteerProvider`, so every node/stage/gate reaches it via the already-threaded `StageContext.options: RunOptions` (no new plumbing in `makeContext` — `ctx.options.escalate` is reachable as-is). The callback is **supplied by `extension.ts`** (the only module with `ctx.ui` access) and **fired INLINE at each unrecoverable point, BEFORE the throw/break** — because the failure context (`specDirectory`, `worktreePath`, in-progress `state.__feedback`) is live inside the pipeline but is lost by the time `execute()`'s catch runs. There are two firing points: (1) `gate({fatal:true})` exhaustion in src/nodes.ts (immediately before `throw new FatalAbort`), and (2) verify-loop stagnation in src/stages/verify.ts (where `state.__stagnated` / `state.__testStagnated` are stamped). At each point the firing point consults a **bounded per-blocker retry budget**, calls `await ctx.options.escalate?.(failure)`, and branches on `EscalationDecision.choice`: `retry-with-guidance` → `rollbackWorktreeTo` (never-throw, worktree-scoped `git reset --hard HEAD` + `git clean -fd`) + `appendUserNotes([guidance])` + re-run the failed unit inline; `revise-manually` → clean abort (partial run) with the report naming what to change; `accept-limitation` → stamp `state.__acceptedLimitations` and continue/skip (offered for soft blocks only); `abandon` → `throw new FatalAbort`. The extension's escalate impl is **always-best-effort / never-throw**: it ALWAYS writes an `escalation-report.md` to the spec dir (generalizing `handleStagnation`'s report body), prompts via `ctx.ui.select`/`ctx.ui.input` (300 000 ms timeout, wrapped in try/catch so dismissal/timeout → `undefined`) **only when `ctx.hasUI === true`**, and returns `undefined` otherwise so print/json/rpc-headless/headless proceed to fail-with-report exactly as today. Interactive escalation is **default-on** in TUI/RPC (`ctx.hasUI === true`); no new prompt can fire in automation/test/headless modes.

---

## 3. Types & Contracts (AC-01, AC-02)

### 3.1 New types — `src/types.ts`

Add to `src/types.ts` immediately above the `RunOptions` interface (currently at line 276):

```ts
/** The kind of unrecoverable blocker the pipeline hit. */
export type EscalationKind = "stagnation" | "gate-exhaustion" | "design-conflict";

/**
 * Whether the user may "accept" the finding and continue. Hard blockers
 * (e.g. a failed build gate) are terminal — `accept-limitation` is never
 * offered for them. Soft blockers (review/test findings, stagnation) may be
 * accepted. Defaults to "soft"; firing points set "hard" for build failures.
 */
export type EscalationSeverity = "soft" | "hard";

/** A single finding surfaced for stagnation/review escalation (advisory). */
export interface EscalationFinding {
	file?: string | null;
	severity?: string | null;
	title?: string | null;
}

/** The failure payload passed to {@link Escalate}. */
export interface EscalationFailure {
	kind: EscalationKind;
	stage?: string;
	message: string;
	specDirectory?: string;
	worktreePath?: string;
	findings?: EscalationFinding[];
	severity?: EscalationSeverity;
}

/** The user's chosen recovery action. */
export type EscalationChoice =
	| "retry-with-guidance"
	| "revise-manually"
	| "accept-limitation"
	| "abandon";

/** A decision returned by {@link Escalate}. `undefined` = no decision (treat as fail-with-report). */
export interface EscalationDecision {
	choice: EscalationChoice;
	/** Free-text guidance injected into the next specialist attempt (retry-with-guidance only). */
	guidance?: string;
}

/**
 * Inline pause-ask-continue hook fired BEFORE an unrecoverable throw/break.
 * Returns `undefined` on dismissal, timeout, non-interactive mode, or any error
 * (the impl NEVER throws). A firing point that receives `undefined` proceeds to
 * the pre-existing fail/abort path.
 */
export type Escalate = (failure: EscalationFailure) => Promise<EscalationDecision | undefined>;
```

### 3.2 `RunOptions.escalate` — `src/types.ts` (AC-01)

Add `escalate?: Escalate;` to the `RunOptions` interface **beside `userSteerProvider?: () => string[]`** (src/types.ts:318), so the two cross-cutting callbacks share the canonical seam:

```ts
export interface RunOptions {
	// ...existing fields...
	userSteerProvider?: () => string[];
	/** Inline HITL escalation hook (AC-01). Supplied by extension.ts; reachable as ctx.options.escalate. */
	escalate?: Escalate;
	// ...existing fields...
}
```

**Threading note (no `makeContext` change required):** `StageContext.options: RunOptions` (src/types.ts:196) and `makeContext(state, task, options, log)` already assigns `options` onto the context (src/workflow.ts:108 → ctx built at :239). Therefore adding the field to `RunOptions` makes `ctx.options.escalate` reachable inside every node/stage/gate with **zero edits to src/workflow.ts**. This mirrors exactly how `userSteerProvider` is consumed (`realAgent` reads `options.userSteerProvider` at src/workflow.ts:148).

---

## 4. The `escalate` Callback Implementation (AC-02, AC-07, AC-08, AC-10)

The extension owns the impl because only it has `ctx.ui`. It is registered alongside the existing `userSteerProvider` in the `runPipelineTask(task, {...})` call (src/extension.ts:509).

### 4.1 Behavior contract

| Condition | Action | Return |
|---|---|---|
| `ctx.hasUI === false` (print/json/headless) | Write `escalation-report.md`; do NOT prompt | `undefined` |
| `ctx.hasUI === true` AND `getConfig().escalation === "informative"` | Write report; do NOT prompt | `undefined` |
| `ctx.hasUI === true` AND mode is `interactive` (default-on) | Write report; `await ctx.ui.select(...)`; if `retry-with-guidance`, `await ctx.ui.input(...)` for guidance | `EscalationDecision` (or `undefined` on dismissal/timeout/error) |
| Any thrown error inside `ctx.ui.*` | Caught; report already written | `undefined` |

### 4.2 Reference implementation — `src/extension.ts`

```ts
function makeEscalate(ctx: ExtensionCtx): Escalate {
	return async (failure) => {
		// AC-07: ALWAYS write the report (best-effort, never throws).
		writeEscalationReport(failure.specDirectory, failure, undefined).catch(() => {});
		try {
			// AC-08 / AC-10: default-on guard. Non-interactive → report-only, no prompt.
			const interactive = ctx?.hasUI === true && getConfig().escalation !== "informative";
			if (!interactive) return undefined;
			// AC-06: accept-limitation offered ONLY for soft blocks.
			const choices: Array<{ value: EscalationChoice; label: string }> = [
				{ value: "retry-with-guidance", label: "Retry with my guidance (rolls back + re-runs)" },
				{ value: "revise-manually",     label: "Stop — I'll revise the spec / code myself" },
			];
			if (failure.severity !== "hard") {
				choices.push({ value: "accept-limitation", label: "Accept this limitation and continue" });
			}
			choices.push({ value: "abandon", label: "Abandon the run" });
			const select = await ctx.ui.select(
				`super-dev hit a blocker — ${failure.message}`,
				choices,
				{ timeout: 300_000 },
			);
			if (!select) return undefined; // dismissal / timeout
			if (select.value === "retry-with-guidance") {
				const guidance = await ctx.ui.input(
					"What guidance should the next attempt follow?",
					{ timeout: 300_000 },
				);
				return { choice: "retry-with-guidance", guidance: guidance || undefined };
			}
			return { choice: select.value };
		} catch {
			// AC-10: NEVER throw — degrade to no-decision (fail-with-report).
			return undefined;
		}
	};
}
```

Wired into the run call (src/extension.ts:509):

```ts
const summary = await runPipelineTask(task, {
	// ...existing opts...
	userSteerProvider: () => getActiveRun()?.drain() ?? [],
	escalate: makeEscalate(ctx),
});
```

> **Primitive choice (research SRC-01/SRC-04):** use `ctx.ui.select` + `ctx.ui.input`, NOT `ctx.ui.custom`. `select`/`input` are guarded by `ctx.hasUI` (true in TUI **and** RPC), support `{timeout}` with benign returns on dismissal (`select`→`undefined`, `input`→`undefined`), and work in RPC. `ctx.ui.custom` is TUI-only and has a documented footgun (pi-subagents #385) where a mid-flight overlay returns falsy and silently degrades to "cancelled" — exactly the silent failure this spec eliminates.

### 4.3 `handleStagnation` generalization (AC-07)

`handleStagnation` (src/extension.ts:249) is **generalized, not deleted**: its report-writing body (`stagnation-report.md`, ~:258–269) becomes the shared headless/informative path. Concretely:

- Extract its report-body builder into `writeEscalationReport(specDir, failure, decision?)` (new module `src/render/escalation-report.ts`, see §8.2). `handleStagnation`'s post-run call (src/extension.ts:536) continues to invoke it so the **post-run** report is still emitted for backward compatibility.
- The inline stagnation firing point (§6) now calls `ctx.options.escalate` *instead of* relying solely on the post-run hook, enabling pause-and-continue. The post-run hook remains as a safety net / summary for informative mode.

---

## 5. Firing Point A — Fatal-Gate Exhaustion (AC-03, AC-05, AC-06, AC-09)

### 5.1 Current code — `src/nodes.ts:435–436`

```ts
ctx.log(`gate: EXHAUSTED${opts.fatal ? " (FATAL — aborting run)" : " (non-fatal)"} — ${opts.fatal ? "aborting" : "proceeding with best-available artifact"}`);
if (opts.fatal) throw new FatalAbort(msg);
return { status: "failed", error: msg, attempts: max };
```

A `gate({fatal:true})` loses all live context once `FatalAbort` propagates past tolerant sequences (src/nodes.ts:172/202 re-throw `FatalAbort`). Therefore escalate MUST fire at the throw site, not at `execute()`'s catch.

### 5.2 New control flow

Wrap the gate's existing attempt loop in an **outer escalation loop** bounded by `ESCALATION_RETRY_CAP = 2` (AC-09). On exhaustion (the current throw/return point), when `ctx.options.escalate` is present AND the per-gate budget remains:

1. Build the failure payload:
   ```ts
   const failure: EscalationFailure = {
     kind: "gate-exhaustion",
     stage: opts.feedbackKey,
     message: msg,
     specDirectory: state.setup?.specDirectory,
     worktreePath: state.setup?.worktreePath,
     severity: "hard", // build/spec gates are terminal — no accept-limitation
   };
   ```
2. Call `const decision = await runEscalation(state, ctx, opts.feedbackKey ?? "gate", failure, ESCALATION_RETRY_CAP)`.
3. Branch on `decision?.choice`:
   - `retry-with-guidance` → `await applyRetryDecision(state, decision)` (rollback + notes, never-throw) → `continue` the outer escalation loop (re-runs the gate's attempt loop with `decision.guidance` now in `.user-notes.json` → drained into the next specialist prompt via `realAgent`; a re-run is uncached because `createMemoizingAgent` only caches completed calls — src/workflow.ts:213).
   - `accept-limitation` → impossible here (`severity:"hard"` hides the option); if ever returned, treat as `abandon`.
   - `revise-manually` → `return { status: "failed", error: msg + " (user chose revise-manually)", attempts: max }` (clean partial stop; the report tells the user what to change).
   - `abandon` OR `decision === undefined` → fall through to the original `if (opts.fatal) throw new FatalAbort(msg)`.

The outer loop guard ensures: after `ESCALATION_RETRY_CAP` retries without convergence, `runEscalation` returns `undefined` and the original abort/return executes. **The gate can never loop infinitely or spend unbounded agent budget** (AC-09, SCENARIO-020/021).

### 5.3 Non-fatal gates

Non-fatal gates (`opts.fatal` falsy) currently `return { status: "failed", ... }`. For consistency, the same escalation wrapper is applied: on exhaustion, escalate; on retry, re-run; otherwise return the failed result unchanged. This gives soft gates (e.g. review gates) the accept-limitation path. Severity for non-fatal gates defaults to `"soft"`.

---

## 6. Firing Point B — Verify-Loop Stagnation (AC-04, AC-05, AC-06)

### 6.1 Two stagnation sites — `src/stages/verify.ts`

- **Review loop:** `reviewLoopUntil` (src/stages/verify.ts:157, already `async`) stamps `state.__stagnated = {...}` at :167 and returns `true` (break).
- **Integration loop:** `recordTestStagnation()` stamps `state.__testStagnated` at :329 and the loop breaks at :346/:364.

### 6.2 New inline behavior

At each stagnation stamp site, **before** returning `true`/breaking, fire escalate INLINE so a `retry-with-guidance` decision lets the loop **continue** (re-run the body) instead of breaking:

```ts
// Inside reviewLoopUntil, replacing the bare stamp + return true:
if (escalationBudgetRemaining(s, "verify-review", ESCALATION_RETRY_CAP) > 0) {
	const failure: EscalationFailure = {
		kind: "stagnation",
		stage: "verify-review",
		message: `Verify review loop stagnant after ${rounds} round(s); identical findings.`,
		specDirectory: s.setup?.specDirectory,
		worktreePath: s.setup?.worktreePath,
		findings: currentFindings,
		severity: "soft",
	};
	const decision = await runEscalation(s, ctx, "verify-review", failure, ESCALATION_RETRY_CAP);
	if (decision?.choice === "retry-with-guidance") {
		await applyRetryDecision(s, decision);
		// clear the stagnation marker so the loop does not immediately re-trip
		delete (s as Record<string, unknown>).__stagnated;
		return false; // CONTINUE the loop (re-run body) — AC-04
	}
	if (decision?.choice === "accept-limitation") {
		(s as Record<string, unknown>).__acceptedLimitations = [
			...((s as Record<string, unknown>).__acceptedLimitations as string[] ?? []),
			"verify-review-stagnation",
		];
		return true; // break, accept, continue pipeline
	}
	// revise-manually / abandon / undefined → fall through to the original break
}
(s as Record<string, unknown>).__stagnated = { rounds, ts: new Date().toISOString(), findings: currentFindings };
return true; // break (original behavior)
```

The integration-loop site (`__testStagnated`) mirrors this with key `"verify-integration"`, `stage: "verify-integration"`, and on `accept-limitation` stamps `"verify-integration-stagnation"`.

This **generalizes** the post-run `handleStagnation` path into an inline pause-and-continue: stagnation no longer terminates the loop when a human intervenes with guidance.

---

## 7. Recovery Primitives (AC-05, AC-10)

### 7.1 `rollbackWorktreeTo` — `src/tracking.ts` (AUTHOR — does NOT exist; AC-05)

The code-assessment confirms `rollbackWorktreeTo` is **not present** in src/tracking.ts and must be authored. It reuses the discrete-argv `spawnSync("git", ["-C", wt, ...])` shape from `ChangeTracker.gitSpawn` (src/tracking.ts `gitSpawn`) — **never `shell:true`** — because `git reset --hard` and `git clean -fd` are on the `src/safety.ts` DENYLIST (:35, :39), but that guard only matches shell command strings.

```ts
/**
 * Worktree-scoped rollback to a known-good ref. Runs `git reset --hard <commit>`
 * then `git clean -fd` inside `worktreePath` ONLY — never touches the user's
 * main checkout (AC-05 / SCENARIO-010). NEVER throws: any failure (non-git dir,
 * missing worktree, git error) returns `{ ok:false, error }` and the caller
 * proceeds (the run degrades to fail-with-report — AC-10 / SCENARIO-012).
 *
 * @param worktreePath absolute path to the super-dev worktree
 * @param commit ref to reset to; defaults to `HEAD` (the pre-stage baseline)
 */
export function rollbackWorktreeTo(
	worktreePath: string | undefined,
	commit: string = "HEAD",
): { ok: boolean; error?: string } {
	if (!worktreePath) return { ok: false, error: "no worktreePath" };
	try {
		const reset = spawnSync("git", ["-C", worktreePath, "reset", "--hard", commit], {
			encoding: "utf8",
			timeout: resolveTimeoutMs(),
		});
		if (reset.error || reset.status !== 0) {
			return { ok: false, error: `git reset failed: ${String(reset.error ?? reset.stderr)}` };
		}
		const clean = spawnSync("git", ["-C", worktreePath, "clean", "-fd"], {
			encoding: "utf8",
			timeout: resolveTimeoutMs(),
		});
		if (clean.error || clean.status !== 0) {
			return { ok: false, error: `git clean failed: ${String(clean.error ?? clean.stderr)}` };
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}
```

**Scope guarantee (research SRC-07/SRC-08/SRC-10/SRC-11/SRC-12):** both `git reset --hard` and `git clean -fd` operate on `worktreePath`'s own working tree and HEAD only; linked worktrees have independent HEADs and never reach the main checkout. The whole body is wrapped in one try/catch (template: src/tracking.ts:13–17 never-throw discipline).

### 7.2 `appendUserNotes` — REUSE (AC-05)

`appendUserNotes(specDir, [guidance])` (src/render/user-notes.ts) already exists, is never-throw, and persists guidance to `.user-notes.json`. `realAgent` drains accumulated notes into the next specialist prompt (src/workflow.ts:148–153). Therefore a `retry-with-guidance` decision's guidance is automatically injected into the re-run — **no new plumbing**.

### 7.3 `applyRetryDecision` — `src/escalation.ts` (new helper)

```ts
/** AC-05: rollback + guidance-append. Best-effort / never-throws. */
export async function applyRetryDecision(state: PipelineState, decision: EscalationDecision): Promise<void> {
	try {
		rollbackWorktreeTo(state.setup?.worktreePath);
		appendUserNotes(state.setup?.specDirectory, [decision.guidance ?? ""]);
	} catch { /* never throws — degrade to fail-with-report (AC-10) */ }
}
```

---

## 8. Escalation Helpers — `src/escalation.ts` + `src/render/escalation-report.ts` (AC-07, AC-09, AC-10)

### 8.1 Bounded retry budget — `src/escalation.ts`

Each firing point tracks its OWN retry count so the run cannot loop infinitely (AC-09). State is keyed by blocker id under `state.__escalationRetries`:

```ts
export const ESCALATION_RETRY_CAP = 2;

/** Remaining escalation retries for `key`. Never throws. */
export function escalationBudgetRemaining(state: PipelineState, key: string, cap = ESCALATION_RETRY_CAP): number {
	try {
		const all = (state as Record<string, unknown>).__escalationRetries as Record<string, number> | undefined;
		const used = all?.[key] ?? 0;
		return Math.max(0, cap - used);
	} catch { return 0; }
}

/**
 * Fire escalation for `failure` if a callback is present AND budget remains.
 * Decrements the per-`key` budget. Returns the decision, or `undefined` when:
 * no callback, no budget, or the callback returned undefined (AC-09/AC-10).
 * Never throws.
 */
export async function runEscalation(
	state: PipelineState,
	ctx: StageContext,
	key: string,
	failure: EscalationFailure,
	cap = ESCALATION_RETRY_CAP,
): Promise<EscalationDecision | undefined> {
	try {
		const escalate = ctx.options?.escalate;
		if (!escalate) return undefined; // non-interactive / not wired → degrade
		if (escalationBudgetRemaining(state, key, cap) <= 0) return undefined; // bounded (AC-09)
		const all = ((state as Record<string, unknown>).__escalationRetries as Record<string, number> | undefined) ?? {};
		all[key] = (all[key] ?? 0) + 1;
		(state as Record<string, unknown>).__escalationRetries = all;
		return await escalate(failure); // callback is never-throw, but guard anyway
	} catch {
		return undefined;
	}
}
```

### 8.2 `writeEscalationReport` — `src/render/escalation-report.ts`

Generalizes `handleStagnation`'s report body (src/extension.ts:258–269) into a single always-written report. It is fire-and-forget from the extension impl (§4.2) and never throws:

```ts
/** AC-07: ALWAYS write escalation-report.md (best-effort, never throws). */
export async function writeEscalationReport(
	specDirectory: string | undefined,
	failure: EscalationFailure,
	decision: EscalationDecision | undefined,
): Promise<void> {
	if (!specDirectory) return;
	try {
		mkdirSync(specDirectory, { recursive: true });
		const body = renderEscalationReportBody(failure, decision); // markdown; includes findings + decision + next steps
		writeFileSync(join(specDirectory, "escalation-report.md"), body);
	} catch { /* best-effort */ }
}
```

The report body includes: the failure `kind`/`stage`/`message`, the `findings` (for stagnation), the `decision` (if any), and explicit "what to change" guidance for `revise-manually`. `handleStagnation`'s `stagnation-report.md` content is subsumed (the stagnation report is the escalation report when `kind === "stagnation"`).

---

## 9. Acceptance-Criteria → Spec Section Map

| AC | Spec § | Scenario(s) |
|---|---|---|
| AC-01 types + `RunOptions.escalate` reachable as `ctx.options.escalate` | §3 | SCENARIO-001, SCENARIO-002 |
| AC-02 extension supplies impl; `ctx.ui.select`/`input`; `ctx.hasUI` guard; try/catch; never throws | §4 | SCENARIO-003 |
| AC-03 fatal-gate exhaustion fires escalate before `throw new FatalAbort` | §5 | SCENARIO-004, SCENARIO-005, SCENARIO-006 |
| AC-04 stagnation fires escalate INLINE; retry continues the loop | §6 | SCENARIO-007, SCENARIO-008, SCENARIO-009 |
| AC-05 retry-with-guidance: rollback + notes + uncached re-run | §5.2, §7 | SCENARIO-010, SCENARIO-011, SCENARIO-012 |
| AC-06 other choices: revise-manually / accept-limitation (soft only) / abandon | §4.2, §5.2, §6.2 | SCENARIO-013, SCENARIO-014, SCENARIO-015 |
| AC-07 escalation-report.md always written (every mode) | §4.2, §8.2 | SCENARIO-016, SCENARIO-017 |
| AC-08 default-on (TUI/RPC); headless never prompts | §4.1, §4.2 | SCENARIO-018, SCENARIO-019 |
| AC-09 bounded retry cap before fallback | §5.2, §8.1 | SCENARIO-020, SCENARIO-021 |
| AC-10 no-throw / best-effort everywhere | §4.2, §7, §8 | SCENARIO-022, SCENARIO-023 |
| AC-11 focused tests | §11 | SCENARIO-024 |
| AC-12 typecheck strict + full test green + CHANGELOG | §12 | SCENARIO-025 |

---

## 10. Constraints & Non-Functional Requirements

- **C1 — No-throw / best-effort everywhere.** The escalate callback, `rollbackWorktreeTo`, `applyRetryDecision`, `runEscalation`, and `writeEscalationReport` each individually degrade to fail-with-report on ANY failure. A misbehaving `ctx.ui`, a non-git/missing worktree, or a write failure cannot abort the run (AC-10).
- **C2 — Headless safety.** print/json/rpc-headless/headless NEVER block on a prompt. The `ctx.hasUI === true` guard short-circuits to report + fail. No new prompt can fire in automation/test/headless modes (AC-08).
- **C3 — Bounded spend.** `ESCALATION_RETRY_CAP = 2` per blocker id; the firing point's own counter guarantees termination (AC-09).
- **C4 — Worktree scope.** `rollbackWorktreeTo` is confined to the super-dev worktree; the user's main checkout is never touched (AC-05).
- **C5 — Strictly additive.** When `ctx.options.escalate` is absent or returns `undefined`, behavior is byte-identical to today (the original throw/return/break executes).
- **C6 — ESM + `.ts` import specifiers + strict TS.** All new intra-project imports use the `.ts` extension; `npm run typecheck` (tsc --noEmit) must be strict-clean.

---

## 11. Testing Strategy (AC-11)

All tests are **LLM-free vitest unit tests over pure functions with injected fakes** (the established pattern — README.md:288, src/render/*.test.ts). No real agent spawns.

1. **`src/tracking.test.ts` (extend)** — `rollbackWorktreeTo`: resets a temp git repo's dirty tree to HEAD, removes untracked files, returns `{ok:true}`; on a non-git dir returns `{ok:false}` and never throws; argv form is used (assert no `shell:true`).
2. **`src/escalation.test.ts` (new)** — `escalationBudgetRemaining` / `runEscalation`: budget decrements per key; returns `undefined` when no `escalate` on options; returns `undefined` after cap; never throws when the fake escalate throws; `applyRetryDecision` calls rollback + appendUserNotes.
3. **`src/render/escalation-report.test.ts` (new)** — `writeEscalationReport`: writes `escalation-report.md` to a tmp spec dir; includes failure fields + decision; never throws on a read-only/unwritable dir.
4. **`src/nodes.escalation.test.ts` (new)** — gate firing: a fake `escalate` returning `retry-with-guidance` → gate re-runs the attempt loop and the guidance lands in `.user-notes.json`; `abandon` → throws `FatalAbort`; `accept-limitation` not offered when `severity:"hard"`; cap exhausted → original throw/return (bounded).
5. **`src/stages/verify.escalation.test.ts` (new)** — stagnation firing: `reviewLoopUntil` with a fake `escalate` returning `retry-with-guidance` → returns `false` (loop continues) and clears `__stagnated`; `accept-limitation` stamps `__acceptedLimitations`; `undefined` → original break.
6. **`src/extension.escalation.test.ts` (new)** — escalate impl contract: interactive (`hasUI:true`) returns an `EscalationDecision`; headless (`hasUI:false`) returns `undefined` AND writes `escalation-report.md`; `ctx.ui.select` throwing → `undefined`; default-on guard (no prompt when `hasUI:false`); `retry-with-guidance` additionally calls `ctx.ui.input`.

### 11.1 No-throw coverage (AC-10 / SCENARIO-022, SCENARIO-023)

Every helper test includes a variant where the dependency throws and asserts the helper returns a safe default (`undefined` / `{ok:false}`) rather than propagating.

---

## 12. Acceptance Gates (AC-12)

- `npm run typecheck` strict-clean (tsc --noEmit).
- Full `npm test` suite green (vitest, LLM-free).
- A concise `[Unreleased]` entry under `### Added` in CHANGELOG.md (Keep-a-Changelog; mirror the existing spec-NN anchor style).

---

## 13. File Inventory

### 13.1 CREATE
- `src/escalation.ts` — `escalationBudgetRemaining`, `runEscalation`, `applyRetryDecision`, `ESCALATION_RETRY_CAP`.
- `src/render/escalation-report.ts` — `writeEscalationReport`, `renderEscalationReportBody`.
- `src/escalation.test.ts`, `src/render/escalation-report.test.ts`, `src/nodes.escalation.test.ts`, `src/stages/verify.escalation.test.ts`, `src/extension.escalation.test.ts` (extend `src/tracking.test.ts`).

### 13.2 MODIFY
- `src/types.ts` — add `EscalationKind`/`EscalationSeverity`/`EscalationFinding`/`EscalationFailure`/`EscalationChoice`/`EscalationDecision`/`Escalate`; add `escalate?: Escalate` to `RunOptions` (:318).
- `src/tracking.ts` — add `rollbackWorktreeTo` (reuse `resolveTimeoutMs`, `spawnSync`).
- `src/nodes.ts` — wrap gate exhaustion in the escalation loop (gate() ~:395–436).
- `src/stages/verify.ts` — inline stagnation firing at `reviewLoopUntil` (:167) and the integration-loop site (:329).
- `src/extension.ts` — `makeEscalate(ctx)` impl; wire into `runPipelineTask` (:509); generalize `handleStagnation` (:249) to call `writeEscalationReport`.
- `CHANGELOG.md` — `[Unreleased]` `### Added` entry.

### 13.3 DELETE
- None. (`stagnation-report.md` writing is subsumed by `escalation-report.md`, but the post-run `handleStagnation` call is retained for backward compatibility.)

---

## 14. Open Questions (resolved)

- **OQ-1 (RPC interactivity, research ISS-01):** `ctx.hasUI` is true in TUI and RPC, but whether `ctx.ui.select` in RPC actually awaits a real client answer is unverified. **Resolution:** the impl guards on `ctx.hasUI === true` (matches existing `handleStagnation` at src/extension.ts:273) and wraps in try/catch returning `undefined`. If RPC no-ops, the benign return degrades to informative — strictly additive and safe. No extra config needed.
- **OQ-2 (rollbackWorktreeTo existence):** **Resolved** by code-assessment — it does NOT exist; this spec authors it (§7.1).
