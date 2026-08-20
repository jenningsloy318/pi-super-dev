/**
 * v0.3.3 V2 — deterministic completion audit (Codex close-out lesson:
 * treat completion as a claim to verify). Written for EVERY outcome at the
 * moment the run summary is derived: status, phase progress, review/build/
 * integration/merge outcomes, deferred findings, accepted limitations, and
 * the convergence-ledger residue. When a run claims success while BLOCKING
 * findings remain unresolved, the audit records an AUDIT ANOMALY — a gate
 * hole made visible instead of silently shipped.
 *
 * Deterministic only: built from state, no LLM, never throws, never blocks
 * (the anomaly section records; the merge gates remain the enforcers).
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { localTimestamp } from "./render/time.ts";
import { getConvergenceLedger, unresolvedBlockingConvergenceFindings } from "./convergence-ledger.ts";
import type { PipelineState, RunStatus } from "./types.ts";

export const COMPLETION_AUDIT_FILE = "completion-audit.md";

function line(label: string, value: string): string {
	return `- **${label}**: ${value}`;
}

/** Write the audit into the spec dir. No-op (never throws) without a spec
 *  directory. Returns the path written, or null. */
export function writeCompletionAudit(state: PipelineState, status: RunStatus): string | null {
	try {
		const dir = state.setup?.specDirectory;
		if (!dir) return null;
		const base = dir.endsWith("/") ? dir : dir + "/";
		const impl = (state.implementation ?? {}) as {
			totalPhases?: number;
			phasesCompleted?: number;
			phaseStatus?: Array<{ id?: string; status?: string }>;
		};
		const review = (state.review ?? {}) as { verdict?: string; deferredFindings?: unknown[] };
		const build = (state.buildGate ?? {}) as { pass?: boolean };
		const integration = (state.integration ?? {}) as { pass?: boolean };
		// sd33 SD33-1/2 (both reviewers): the real merge control carries
		// `merged` + `verification` (writers.ts mergeVerifyTask) — never a
		// `verified` field. Read what exists.
		const merge = (state.merge ?? {}) as { merged?: boolean; verification?: string };
		const accepted = ((state as Record<string, unknown>).__acceptedLimitations ?? {}) as Record<string, unknown>;

		const findings = getConvergenceLedger(state).findings;
		const unresolved = findings.filter((f) => ["open", "addressed", "needs-human"].includes(f.status));
		const unresolvedBlocking = unresolvedBlockingConvergenceFindings(state);

		const parts: string[] = [
			`# Completion Audit`,
			"",
			line("Generated", localTimestamp()),
			line("Status", status),
			line("Phases", `${impl.phasesCompleted ?? 0}/${impl.totalPhases ?? 0} green`),
			...(impl.phaseStatus ?? []).some((p) => p.status === "partial") ? [line("Partial phases", (impl.phaseStatus ?? []).filter((p) => p.status === "partial").map((p) => p.id ?? "?").join(", ") || "none")] : [],
			line("Final review verdict", review.verdict ?? "not run"),
			line("Build gate", build.pass === undefined ? "not run" : build.pass ? "pass" : "fail"),
			line("Integration", integration.pass === undefined ? "not run" : integration.pass ? "pass" : "fail"),
			line("Merge", merge.merged === true ? `merged (${merge.verification ?? "self-reported only — ancestry not confirmed"})` : "not merged"),
			line("Deferred findings", String(Array.isArray(review.deferredFindings) ? review.deferredFindings.length : 0)),
			line("Accepted limitations", Object.keys(accepted).length > 0 ? Object.keys(accepted).join(", ") : "none"),
			line("Ledger findings", `${findings.length} recorded, ${unresolved.length} unresolved (${unresolvedBlocking.length} blocking)`),
		];

		if (status === "success" && unresolvedBlocking.length > 0) {
			parts.push(
				"",
				"## AUDIT ANOMALY",
				"",
				`The run claims success while ${unresolvedBlocking.length} BLOCKING finding(s) remain unresolved — a gate hole. Every finding must be verified, deferred with a reason, or duty-downgraded before success is honest:`,
				"",
				...unresolvedBlocking.slice(0, 8).map((f) => `- \`${f.id}\` [${f.status}] ${f.title} (owner: ${f.ownerStage})`),
				...(unresolvedBlocking.length > 8 ? [`- …(+${unresolvedBlocking.length - 8} more)`] : []),
			);
		} else if (unresolved.length > 0) {
			parts.push(
				"",
				"## Ledger residue (unresolved)",
				"",
				...unresolved.slice(0, 12).map((f) => `- \`${f.id}\` [${f.status}${f.blocking ? "·blocking" : ""}] ${f.title} (owner: ${f.ownerStage})`),
				...(unresolved.length > 12 ? [`- …(+${unresolved.length - 12} more)`] : []),
			);
		}

		mkdirSync(base.slice(0, -1), { recursive: true });
		const path = `${base}${COMPLETION_AUDIT_FILE}`;
		writeFileSync(path, parts.join("\n") + "\n", "utf8");
		return path;
	} catch {
		return null;
	}
}

/** Test seam: does an audit anomaly exist for this state+status? */
export function completionAuditAnomaly(state: PipelineState, status: RunStatus): boolean {
	return status === "success" && unresolvedBlockingConvergenceFindings(state).length > 0;
}

export function completionAuditExists(specDir: string | undefined): boolean {
	if (!specDir) return false;
	const base = specDir.endsWith("/") ? specDir : specDir + "/";
	return existsSync(`${base}${COMPLETION_AUDIT_FILE}`);
}
