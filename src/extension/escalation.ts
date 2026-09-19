import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSummary, Escalate, EscalationDecision, EscalationFailure } from "../types.ts";
import { writeEscalationReport } from "../render/escalation-report.ts";
import { getConfig } from "../render/super-dev-dir.ts";

/** Wave 3 increment 1: the escalation surface (the legacy stagnation flavor +
 *  the spec-18 inline `escalate` callback + the shared prompt/option/choice
 *  core), extracted from extension.ts verbatim. One reason to change: how
 *  blockers escalate to the human. */

interface StagnationRecord {
	/** F-C: WHY the loop broke. "stagnation" (default, legacy) = identical
	 *  findings recurred across consecutive rounds — the fixer tried and failed.
	 *  "blocked-on-decisions" = no actionable findings remain (all deferred:
	 *  advisory / needs-human / cross-stage) — nothing recurred; a human
	 *  decision or upstream revision is the only way forward. The report and
	 *  prompt must never tell the human to "fix the implementation" for this
	 *  kind — that is precisely the misdiagnosis run 2026-08-16T01-00-35
	 *  produced by reusing the stagnation template. */
	kind?: "stagnation" | "blocked-on-decisions";
	rounds?: number;
	verdict?: string;
	findings?: Array<{ file?: string | null; severity?: string | null; title?: string | null }>;
}
/** Gap 4.6′-lite — stagnation escalation (scheme C: informative by default, interactive opt-in).
 *  Always writes a stagnation-report.md to the spec dir (baseline, all modes);
 *  spec-18 / Phase 2 additionally delegates the canonical escalation-report.md
 *  to the shared `writeEscalationReport` writer. When the run is interactive
 *  (ctx.hasUI) AND config.escalation === "interactive", additionally prompts a
 *  3-option select. Returns the chosen option (or undefined if not interactive /
 *  dismissed). For Tier-2 all options just finish the run — "revise spec" only
 *  surfaces the recommendation; auto-replay is deferred (Tier-3). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleStagnation(summary: RunSummary, ctx: any, opts?: { escalation?: "informative" | "interactive" }): Promise<string | undefined> {
	const st = (summary.state as Record<string, unknown>).__stagnated as StagnationRecord | undefined;
	if (!st) return undefined;
	// If the inline escalation (verify.ts) already attempted (even if dismissed),
	// don't re-prompt here (prevents double-prompt on the same stagnation).
	if ((summary.state as Record<string, unknown>).__escalationAttempted) return undefined;

	// Baseline (all modes): write the report. The stagnation prose is shared
	// between the legacy human-facing `stagnation-report.md` (backward-compat —
	// the diagnostic referenced in the run summary) and the canonical
	// `escalation-report.md` produced by delegating to the shared
	// `writeEscalationReport` writer (spec-18 / Phase 2 generalization: one
	// structured report format across this legacy path and the new inline
	// `escalate` callback; uniformly never-throw). Additive + never-regressing.
	const findingsRaw = st.findings ?? [];
	const blocked = st.kind === "blocked-on-decisions";
	const message = blocked
		? [
			`The verify loop stopped after **${st.rounds}** round(s): the merged review verdict (**${st.verdict ?? "unknown"}**) is not approved, but every remaining finding is deferred — advisory, needs-human, or owned by an upstream stage.`,
			"",
			"Nothing recurred and no code fixer may act on these items. Awaiting a human decision: accept the deferred items as known limitations, resolve them manually, or revise the owning upstream artifact (spec/design) and rerun.",
		].join("\n")
		: [
		`The verify-loop broke early after **${st.rounds}** review round(s): the same findings recurred across two consecutive iterations.`,
		"",
		`Merged review verdict at stagnation: **${st.verdict ?? "unknown"}**.`,
		"",
		"This means the workflow reached review/verify but repeated the same unresolved findings. Treat it as a workflow/review convergence blocker: inspect the recurring findings, fix the implementation or orchestration issue they identify, or provide explicit retry guidance before rerunning.",
	].join("\n");
	// Legacy human-facing diagnostic (byte-identical to pre-spec-18 output for
	// the stagnation kind; honest kind-specific prose for the dead-state break).
	try {
		const findingLines = findingsRaw.map((f) => `- [${f.severity ?? "?"}] ${f.file ? "`" + f.file + "` " : ""}${f.title ?? ""}`);
		writeFileSync(
			join(summary.specDirectory, "stagnation-report.md"),
			[
				"# Stagnation report",
				"",
				message,
				"",
				blocked ? "## Blocked on decisions (deferred findings — no code fixer can act)" : "## Recurring findings",
				...(findingLines.length ? findingLines : ["_(no structured findings captured)_"]),
			].join("\n"),
		);
	} catch { /* best-effort */ }
	// Canonical escalation report via the shared writer (never-throw).
	writeEscalationReport(
		{
			kind: "stagnation",
			stage: "verify",
			severity: "soft",
			message,
			findings: findingsRaw.map((f) => ({
				file: f.file ?? null,
				severity: f.severity ?? null,
				title: f.title ?? null,
			})),
			specDirectory: summary.specDirectory,
		},
		undefined,
		summary.specDirectory,
	);

	// Opt-in interactive escalation (TUI/RPC only).
	const mode = opts?.escalation ?? getConfig().escalation;
	const interactive = ctx?.hasUI === true && mode === "interactive";
	if (!interactive) return undefined;
	try {
		const choice = await ctx.ui?.select?.(
			formatEscalationPrompt(
				{ kind: blocked ? "blocked-on-decisions" : "stagnation", stage: "verify", severity: "soft", message, findings: findingsRaw },
				blocked ? "Blocked on decisions — how to proceed?" : "Review loop stagnant — how to proceed?",
			),
			["Revise spec & re-run from design", "Accept findings as known limitations", "Abandon worktree"],
			{ timeout: 120_000 },
		);
		return choice ?? undefined;
	} catch {
		return undefined;
	}
}

/** Human-readable choices offered via ctx.ui.select, in stable order. */
const ESCALATE_OPTIONS_SOFT = [
	"Retry with guidance",
	"Revise manually",
	"Accept limitation",
	"Abandon",
];
const ESCALATE_OPTIONS_HARD = [
	"Retry with guidance",
	"Revise manually",
	"Abandon",
];

/** M4 routing (G6): the full offered list for a failure — when it carries a
 *  routeBackOwner (exactly one upstream routable owner), "Route back to
 *  ⟨owner⟩ (recommended)" leads BOTH severity lists. */
export function escalateOptionsFor(failure: { severity?: string; routeBackOwner?: string }): string[] {
	const base = failure.severity === "hard" ? ESCALATE_OPTIONS_HARD : ESCALATE_OPTIONS_SOFT;
	if (!failure.routeBackOwner) return base;
	return [`Route back to ${failure.routeBackOwner} (recommended)`, ...base];
}

/** Map a ctx.ui.select result to an EscalationDecision (undefined = dismissed).
 *  The route-back marker is matched FIRST — "Revise manually" never contains
 *  "route", but keep the order explicit anyway. */
export function mapEscalateChoice(choice: unknown): EscalationDecision | undefined {
	if (typeof choice !== "string") return undefined;
	const lower = choice.toLowerCase();
	if (lower.startsWith("route back")) return { choice: "route-back" };
	if (lower.includes("retry")) return { choice: "retry-with-guidance" };
	if (lower.includes("revise")) return { choice: "revise-manually" };
	if (lower.includes("accept")) return { choice: "accept-limitation" };
	if (lower.includes("abandon")) return { choice: "abandon" };
	return undefined;
}

/** Format the FULL blocker (message + structured findings) into the interactive
 *  escalation prompt, so the user sees WHAT blocked the run — not merely that a
 *  blocker exists — before choosing how to proceed. The finding layout mirrors
 *  escalation-report.md (one source of truth for the blocker text). */
function formatEscalationPrompt(
	failure: { kind?: string; stage?: string; severity?: string; message: string; findings?: readonly { file?: string | null; severity?: string | null; title?: string | null }[] },
	headline: string,
): string {
	const meta = [
		failure.stage && `Stage: ${failure.stage}`,
		failure.kind && `Kind: ${failure.kind}`,
		failure.severity && `Severity: ${failure.severity}`,
	].filter(Boolean).join("   ");
	const findings = (failure.findings ?? []).filter((f) => (f.title ?? "").trim() || (f.file ?? "").trim());
	const findingLines = findings.length
		? ["", "Findings:", ...findings.map((f) => `- [${f.severity ?? "?"}] ${f.file ? "`" + f.file + "` " : ""}${f.title ?? ""}`)]
		: [];
	return [headline, ...(meta ? ["", meta] : []), "", failure.message, ...findingLines].join("\n");
}

/**
 * Build the inline `escalate` callback for a run (spec-18 / AC-01). ALWAYS
 * writes `escalation-report.md` via {@link writeEscalationReport}; then — ONLY
 * when `ctx.hasUI === true` — prompts `ctx.ui.select` (300s timeout) and, for a
 * retry-with-guidance choice, `ctx.ui.input` to capture free-text guidance.
 * Wrapped in try/catch so dismissal / timeout / error all collapse to
 * `undefined` (the pre-existing fail-with-report path). `accept-limitation` is
 * omitted from the offered choices when the failure is `severity: "hard"`.
 * NEVER throws.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeEscalate(ctx: any): Escalate {
	const escalate: Escalate = async (failure: EscalationFailure) => {
		let decision: EscalationDecision | undefined;
		// Interactive pause-ask-continue — TUI/RPC only.
		if (ctx?.hasUI === true) {
			try {
				const options = escalateOptionsFor(failure);
				failure.offeredChoices = options; // MP5: persisted with the report
				const choice = await ctx.ui?.select?.(
					formatEscalationPrompt(failure, "Super-dev hit a blocker — how to proceed?"),
					options,
					{ timeout: 300_000 },
				);
				decision = mapEscalateChoice(choice);
				if (decision?.choice === "retry-with-guidance") {
					const guidance = await ctx.ui?.input?.(
						"Guidance for the retry (appended to the next specialist attempt):",
						{ timeout: 300_000 },
					);
					if (typeof guidance === "string" && guidance.trim()) {
						decision.guidance = guidance;
					}
				}
			} catch {
				decision = undefined;
			}
		}
		// ALWAYS write the report (baseline, all modes). Never throws.
		writeEscalationReport(failure, decision, failure.specDirectory);
		return decision;
	};
	return escalate;
}
