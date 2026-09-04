/**
 * Post-run reflection — the "dreaming" mechanism.
 *
 * After the pipeline completes, spawns a reflection agent that reads the audit
 * trail, identifies patterns (retries, errors, timing), scores them, and updates
 * learned.md + learned-index.json. The next run's agents wake up smarter.
 *
 * Non-blocking: the pipeline result is already returned to the user. Reflection
 * runs in the background with a generous timeout. If it fails, no harm — the
 * pipeline result is unaffected.
 */

import { runAgentViaDelegation, type DelegationEventBus } from "../agents/delegation-backend.ts";
import {
	getAuditPath,
	getLearnedPath,
	getLearnedIndexPath,
	getLearnedArchivePath,
	getReflectionPath,
	getSuperDevDir,
	getConfig,
	auditAppend,
	auditPathFor,
	reflectionPathFor,
	languageDirective,
} from "./super-dev-dir.ts";
import { existsSync } from "node:fs";
import { cleanupOldRuns } from "./cleanup.ts";

/** v0.3.23: pure task builder so the language directive (and any future prompt
 *  policy) is unit-testable without touching audit files. Reflection calls
 *  runAgentViaSession DIRECTLY — it bypasses realAgent's prompt seam — so the
 *  output-language directive must ride here explicitly: learned.md /
 *  reflection.md are cross-run history and must honor config.language. */
export function buildReflectionTask(runDir?: string | null): string {
	return [
		"## Files",
		`- Audit trail: ${runDir ? auditPathFor(runDir) : getAuditPath()}`,
		`- Knowledge base: ${getLearnedPath()}`,
		`- Archive: ${getLearnedArchivePath()}`,
		`- Index: ${getLearnedIndexPath()}`,
		`- Reflection summary: ${runDir ? reflectionPathFor(runDir) : getReflectionPath()}`,
		"",
		"## Task",
		"Analyze the audit trail. Identify patterns (retries, errors, timing).",
		"Score each pattern. Update learned.md (append/update). Rebuild learned-index.json.",
		"Write reflection.md summary.",
	].join("\n") + "\n\n" + languageDirective();
}

/** Spawn the reflection agent asynchronously (fire-and-forget). Non-blocking.
 *  AC-29 (SCENARIO-060): the originating run's dir is threaded through — every
 *  path this module touches is resolved from it AT ENTRY, never re-read from
 *  the module global after an await (a run B starting mid-flight cannot
 *  redirect run A's reflection writes). */
export function runReflectionAsync(runDir: string | undefined, events?: DelegationEventBus): Promise<void> {
	const config = getConfig();
	if (!config.reflectionEnabled) return Promise.resolve();

	const auditPath = runDir ? auditPathFor(runDir) : getAuditPath();
	if (!auditPath || !existsSync(auditPath)) return Promise.resolve();

	// Fire-and-forget — never blocks the user's result. v0.3.60 R9: the promise
	// is now RETURNED so the caller (extension.ts) can track it and
	// session_shutdown can name it when a session teardown drops it (P10:
	// discards are named). Callers that ignore the return are unaffected.
	return runReflection(runDir, events).catch((err) => { auditAppend({ stage: "reflection", error: String(err instanceof Error ? err.message : err) }, runDir);
		// Silent failure — reflection is best-effort.
	});
}

/** Run the reflection agent synchronously (for testing). AC-29: `runDir` is
 *  the ORIGINATING run dir captured at run start (falls back to the module
 *  global for legacy callers). */
export async function runReflection(runDir?: string, events?: DelegationEventBus): Promise<void> {
	// Paths are captured at ENTRY — no getAuditPath()/getReflectionPath() read
	// after the agent await below can observe a newer run's dir.
	const superDevDir = getSuperDevDir();
	const auditPath = runDir ? auditPathFor(runDir) : getAuditPath();

	if (!existsSync(auditPath)) return;
	// v0.3.64: reflection runs through the pi-subagents delegation backend (the
	// sd-reflection registration carries agents/reflection.md as its system
	// prompt) so it rides the same machinery — and the same Fleet visibility —
	// as every specialist call. Without an event bus (bench/tests) there is no
	// delegation owner in-process: SKIP with a named audit row (P10 — the
	// discard is named, never silent) instead of hanging on an unanswered
	// request.
	if (!events) {
		auditAppend({ stage: "reflection", skipped: "no delegation event bus (extension mode required for reflection)" }, runDir);
		return;
	}
	const task = buildReflectionTask(runDir);

	const result = await runAgentViaDelegation({
		agent: "reflection",
		prompt: task,
		cwd: superDevDir,
		timeoutMs: 180_000,
		controlKeys: [],
		events,
		ownerRunId: `reflection${runDir ? "-" + runDir : ""}`.slice(0, 256).replace(/[\n\r]/g, ""),
		id: "pipeline.reflection",
	});
	if (result.error) {
		auditAppend({ stage: "reflection", error: result.error }, runDir);
		// Reflection is best-effort — the run result is already delivered.
	}

	// Phase 6: cleanup old runs/traces. Sweep-3 G10: updateStats is NO LONGER
	// called here — extension.ts's run-end block is the SINGLE stats owner
	// (pre-fix both fired per run, double-counting totalRuns; and this late call
	// re-read the module-global audit path AFTER awaits, misattributing runs).
	try { cleanupOldRuns(); } catch { /* best-effort */ }
}
