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

import { runAgentViaSession } from "../session-agent.ts";
import { loadAgentPrompt } from "../agents.ts";
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
export function runReflectionAsync(runDir: string | undefined): void {
	const config = getConfig();
	if (!config.reflectionEnabled) return;

	const auditPath = runDir ? auditPathFor(runDir) : getAuditPath();
	if (!auditPath || !existsSync(auditPath)) return;

	// Fire-and-forget — never blocks the user's result.
	void runReflection(runDir).catch((err) => { auditAppend({ stage: "reflection", error: String(err instanceof Error ? err.message : err) }, runDir);
		// Silent failure — reflection is best-effort.
	});
}

/** Run the reflection agent synchronously (for testing). AC-29: `runDir` is
 *  the ORIGINATING run dir captured at run start (falls back to the module
 *  global for legacy callers). */
export async function runReflection(runDir?: string): Promise<void> {
	// Paths are captured at ENTRY — no getAuditPath()/getReflectionPath() read
	// after the agent await below can observe a newer run's dir.
	const superDevDir = getSuperDevDir();
	const auditPath = runDir ? auditPathFor(runDir) : getAuditPath();

	if (!existsSync(auditPath)) return;
	const systemPrompt = loadAgentPrompt("reflection");
	const task = buildReflectionTask(runDir);

	await runAgentViaSession({
		agent: "reflection",
		prompt: task,
		cwd: superDevDir,
		timeoutMs: 180_000,
		controlKeys: [],
		onProgress: {
			event: () => {},
			text: () => {},
		},
	});

	// Phase 6: cleanup old runs/traces. Sweep-3 G10: updateStats is NO LONGER
	// called here — extension.ts's run-end block is the SINGLE stats owner
	// (pre-fix both fired per run, double-counting totalRuns; and this late call
	// re-read the module-global audit path AFTER awaits, misattributing runs).
	try { cleanupOldRuns(); } catch { /* best-effort */ }
}
