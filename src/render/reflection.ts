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
} from "./super-dev-dir.ts";
import { existsSync } from "node:fs";
import { cleanupOldRuns, updateStats } from "./cleanup.ts";

/** Spawn the reflection agent asynchronously (fire-and-forget). Non-blocking. */
export function runReflectionAsync(): void {
	const config = getConfig();
	if (!config.reflectionEnabled) return;

	const auditPath = getAuditPath();
	if (!auditPath || !existsSync(auditPath)) return;

	// Fire-and-forget — never blocks the user's result.
	void runReflection().catch((err) => { auditAppend({ stage: "reflection", error: String(err instanceof Error ? err.message : err) });
		// Silent failure — reflection is best-effort.
	});
}

/** Run the reflection agent synchronously (for testing). */
export async function runReflection(): Promise<void> {
	const auditPath = getAuditPath();
	const learnedPath = getLearnedPath();
	const archivePath = getLearnedArchivePath();
	const indexPath = getLearnedIndexPath();
	const reflectionPath = getReflectionPath();

	if (!existsSync(auditPath)) return;

	const systemPrompt = loadAgentPrompt("reflection");
	const task = [
		"## Files",
		`- Audit trail: ${auditPath}`,
		`- Knowledge base: ${learnedPath}`,
		`- Archive: ${archivePath}`,
		`- Index: ${indexPath}`,
		`- Reflection summary: ${reflectionPath}`,
		"",
		"## Task",
		"Analyze the audit trail. Identify patterns (retries, errors, timing).",
		"Score each pattern. Update learned.md (append/update). Rebuild learned-index.json.",
		"Write reflection.md summary.",
	].join("\n");

	await runAgentViaSession({
		agent: "reflection",
		prompt: task,
		cwd: getSuperDevDir(),
		timeoutMs: 180_000,
		controlKeys: [],
		onProgress: {
			event: () => {},
			text: () => {},
		},
	});

	// Phase 6: cleanup old runs/traces + update aggregate stats
	try { updateStats(); } catch { /* best-effort */ }
	try { cleanupOldRuns(); } catch { /* best-effort */ }
}
