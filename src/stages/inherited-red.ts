/**
 * v0.3.85 F2/F4 (C1/C4 fixes; §9 F2+F4, §10 decision 3, §13 mapping rows,
 * §14 ADR 8/9/10 of docs/requirements/run-2026-09-09-poisoned-baseline-
 * postmortem-v0.3.85.md): the inherited-red tier ladder's PURE predicates and
 * its append-only ledger.
 *
 * C1 — a phase that ends partial forwarded a poisoned baseline to every later
 * phase (the gate was red on out-of-scope subjects and the harness KNEW it,
 * but had no rule connecting that knowledge to phase-advance). F2 replaces the
 * blind forward-continue with an ATTRIBUTION-KEYED stop-the-line ladder.
 *
 * C4 — the GREEN test-edit ban deadlocked on work whose completion REQUIRES
 * editing a test file a prior phase's scope pins ("requires a spec change"
 * with no mechanism to perform it). F4 is the door: a deterministically
 * restored test file that belongs to a prior PARTIAL phase's declared scope
 * routes the declared handoff IMMEDIATELY (retry is provably futile — ADR 10).
 *
 * This module is deliberately dependency-light (build-runner/scope parsers +
 * plan-feasibility's phaseClauseFiles + node fs), synchronous, and
 * never-throwing — the same contract class as fault-classification.ts. The
 * stage (implementation.ts) owns the control flow; everything here is pure or
 * a ledger primitive, unit-testable with no LLM and no stage context.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BuildGateResult } from "../build-runner.ts";
import { isBaselineVerifySyntheticError } from "../fault-classification.ts";
import { parseFailingNpmTestFiles, parseFailingPythonTestFiles } from "../build-runner/scope.ts";
import { phaseClauseFiles } from "./plan-feasibility.ts";

/** §13: the declared-handoff row tag. Distinct from `classificationSource`
 *  (that is R2 routing provenance); never overloaded. */
export const INHERITED_RED_SOURCE = "inherited-red";

/** Backslash→slash + leading-"./" + trailing-slash + trim normalization for
 *  repo-relative compares (the leakNorm semantics, single-sourced here for the
 *  F2/F4 predicates). */
export function normalizeRepoPath(p: string): string {
	return String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

// ── F2 trigger: the boundary shape ──────────────────────────────────────────

export interface InheritedRedShapeInput {
	/** The attempt's (re-run-adjusted) build gate result. */
	gate: BuildGateResult;
	/** Own-scope evidence booleans — the Track-30 row-2 shape (all four must
	 *  be green: the phase's own work is NOT the blocker). */
	ownScope: { deliverablePass: boolean; changePass: boolean; symbolPass: boolean; tddClean: boolean };
	/** The phase's coverage gate blocked this attempt (below-threshold). */
	coverageBlocked: boolean;
	/** The phase's declared clause-target set (phaseClauseFiles, normalized). */
	declaredScope: ReadonlySet<string>;
}

export interface InheritedRedShapeResult {
	shape: boolean;
	/** P10: why the shape held or did not (surfaced in the boundary log). */
	why: string;
	/** Failing test file paths extracted from the gate's error blocks
	 *  (empty when no structured parser matched — the documented fallback then
	 *  trusts the gate's own out-of-scope classification). */
	failingFiles: string[];
}

/** Extract failing TEST FILE paths from gate error blocks via the structured
 *  test-runner record parsers (npm/vitest/jest + pytest). Documented
 *  limitation: go/rust stacks surface packages/crates rather than file paths
 *  there — the F4 Arm-B containment fallback covers those families. Pure. */
export function extractFailingTestFilePaths(blocks: readonly string[]): string[] {
	const out = new Set<string>();
	for (const p of parseFailingNpmTestFiles(blocks.join("\n"))) out.add(normalizeRepoPath(p));
	for (const block of blocks) {
		for (const p of parseFailingPythonTestFiles(block)) out.add(normalizeRepoPath(p));
	}
	return [...out].filter(Boolean).sort();
}

/**
 * The inherited-red boundary SHAPE (§9 F2): the gate is the blocker (red, not
 * lenient-green), every remaining failure is out-of-scope-or-synthetic, a
 * baseline verification ran (attribution needs evidence — absent baselineCheck
 * is the deliberate NOT-inherited-red exclusion), the phase's own-scope
 * evidence is green, coverage did not block, and the failing subjects sit
 * OUTSIDE the phase's declared targets. When failing file paths are
 * extractable they must not intersect `declaredScope`; when no path is
 * extractable the gate's own out-of-scope classification stands (documented
 * best-effort fallback). Pure; never throws.
 */
export function inheritedRedBoundaryShape(input: InheritedRedShapeInput): InheritedRedShapeResult {
	const { gate, ownScope, coverageBlocked, declaredScope } = input;
	// FIX ROUND 2 (1): P1 — never trust gate shapes. BuildGateResult declares
	// errors/outOfScopeErrors required, but real gates and fixtures have
	// passed them undefined (observed: TypeError at the spread below). Every
	// read goes through these local guards; an absent outOfScopeErrors degrades
	// to "empty classification" semantics (never grants the shape).
	const gateErrors = Array.isArray(gate.errors) ? gate.errors : [];
	const gateOutOfScope = Array.isArray(gate.outOfScopeErrors) ? gate.outOfScopeErrors : [];
	const failingFiles = extractFailingTestFilePaths([...gateOutOfScope, ...gateErrors]);
	const reasons: string[] = [];
	if (gate.pass) { reasons.push("gate passed"); return { shape: false, why: reasons.join("; "), failingFiles }; }
	if (gate.inScopePass) { reasons.push("gate lenient-green in scope"); return { shape: false, why: reasons.join("; "), failingFiles }; }
	if (gateOutOfScope.length === 0) { reasons.push("no out-of-scope failures classified"); return { shape: false, why: reasons.join("; "), failingFiles }; }
	if (gate.baselineCheck === undefined) {
		// Deliberate exclusion (§9 F2): a partial boundary with NO completed
		// baseline verification is NOT inherited-red — attribution needs
		// evidence; the poison is caught at the NEXT completed gate.
		reasons.push("baselineCheck absent (no attribution evidence)");
		return { shape: false, why: reasons.join("; "), failingFiles };
	}
	const outOfScope = new Set(gateOutOfScope);
	const nonOos = gateErrors.filter((e) => !outOfScope.has(e) && !isBaselineVerifySyntheticError(e));
	if (nonOos.length > 0) { reasons.push(`${nonOos.length} in-scope failure block(s) remain`); return { shape: false, why: reasons.join("; "), failingFiles }; }
	if (!ownScope.deliverablePass || !ownScope.changePass || !ownScope.symbolPass || !ownScope.tddClean) {
		reasons.push("own-scope evidence not green");
		return { shape: false, why: reasons.join("; "), failingFiles };
	}
	if (coverageBlocked) { reasons.push("coverage gate below threshold"); return { shape: false, why: reasons.join("; "), failingFiles }; }
	if (failingFiles.length > 0) {
		const inDeclared = failingFiles.filter((f) => declaredScope.has(f));
		if (inDeclared.length > 0) { reasons.push(`failing subject(s) inside the phase's declared targets: ${inDeclared.join(", ")}`); return { shape: false, why: reasons.join("; "), failingFiles }; }
	}
	return {
		shape: true,
		why: `gate red on ${gateOutOfScope.length} out-of-scope-only failure(s), baseline=${gate.baselineCheck.status}, own-scope green${failingFiles.length ? `, failing subject(s) outside declared targets (${failingFiles.slice(0, 4).join(", ")})` : " (no extractable failing path — gate out-of-scope classification stands)"}`,
		failingFiles,
	};
}

// ── F2 Tier 0: deterministic attribution ────────────────────────────────────

export type InheritedRedAttribution = "inherited" | "own-leak" | "not-evaluable";

export interface InheritedRedAttributionInput {
	/** `gate.baselineCheck?.status` — undefined when absent. */
	baselineStatus: "preexisting" | "regression" | "unknown" | undefined;
	/** Canonical-inventory dirt paths that were ALREADY dirty at the phase's
	 *  first-ever start (earlier phases' leftovers / prior-run state). */
	prePhaseDirt: readonly string[];
	/** Canonical-inventory dirt paths that appeared DURING this phase (the
	 *  phase's own undeclared out-of-scope edits — the revertable leak). */
	ownLeakPaths: readonly string[];
}

/**
 * The Tier-0 dirt-provenance truth table (fault-classification.ts G1
 * semantics, re-keyed to the PHASE-start boundary — the run-start partition
 * G1 uses would classify an earlier phase's mid-run poison as this phase's
 * own work, exactly the C1 disease F2 exists to stop):
 *
 *   baseline "preexisting"                    → inherited (merge-base repo red)
 *   baseline "regression" + pre-phase dirt    → inherited (not attributable to
 *                                               this phase's edits)
 *   baseline "regression" + clean at phase    → own-leak (an out-of-scope
 *                                             subject that passes at baseline
 *                                             cannot break on a clean-at-start
 *                                             tree any other way — G1's own
 *                                             row-2 derivation)
 *   baseline "unknown" / absent               → not-evaluable (attribution
 *                                             needs evidence; today's
 *                                             behavior)
 *
 * Pure; never throws.
 */
export function inheritedRedAttribution(input: InheritedRedAttributionInput): InheritedRedAttribution {
	if (input.baselineStatus === "preexisting") return "inherited";
	if (input.baselineStatus === "regression") return input.prePhaseDirt.length > 0 ? "inherited" : "own-leak";
	return "not-evaluable";
}

// ── F4: the door-in-the-fence scope predicate (Option C union) ──────────────

export interface F4ScopeMatch {
	/** Which arm matched: A = prior partial phase's declared clause files;
	 *  B = prior partial phase's recorded failing-test file paths. */
	arm: "arm-a" | "arm-b";
	/** The prior PARTIAL phase whose scope the path belongs to. */
	phaseId: string;
	/** The matched (restored) path, normalized repo-relative. */
	path: string;
}

/**
 * Option-C scope match over prior PARTIAL phases only (converged phases
 * committed green — nothing to inherit), exact normalized repo-relative paths:
 *
 *   Arm A — path ∈ that phase's declared clause/target files (the
 *           phaseClauseFiles canonical grammar; plan-declared coupling);
 *   Arm B — path ∈ failing-test file paths recorded in that phase's
 *           lastFailures (structured test-runner record preferred via the
 *           shared parsers; normalized-path containment as the documented
 *           best-effort fallback — the actual 09-09 killer class Arm A alone
 *           would have missed entirely).
 *
 * NO prior partial phase exists ⇒ null (F4 can never fire — the restore is
 * implementer error and today's behavior stands). Deterministic order: paths
 * in input order, phases in plan order, Arm A before Arm B per phase. Pure;
 * never throws.
 */
export function f4ScopeMatch(
	restoredPaths: readonly string[],
	phases: ReadonlyArray<Record<string, unknown>>,
	phaseStatus: ReadonlyArray<{ id: string; status: string }>,
	currentIndex: number,
	lastFailures: ReadonlyArray<{ phaseId: string; reasons: readonly string[] }>,
): F4ScopeMatch | null {
	if (restoredPaths.length === 0) return null;
	const partialIds = new Set(phaseStatus.filter((p) => p.status === "partial").map((p) => p.id));
	if (partialIds.size === 0) return null;
	const failuresById = new Map(lastFailures.map((f) => [f.phaseId, f.reasons ?? []]));
	for (const rawPath of restoredPaths) {
		const path = normalizeRepoPath(rawPath);
		if (!path) continue;
		for (let j = 0; j < currentIndex && j < phases.length; j++) {
			const priorId = `phase-${String(j + 1).padStart(2, "0")}`;
			if (!partialIds.has(priorId)) continue; // prior PARTIAL phases only
			// Arm A — declared clause/target files (canonical grammar).
			const clause = new Set(phaseClauseFiles(phases[j] as never).map(normalizeRepoPath));
			if (clause.has(path)) return { arm: "arm-a", phaseId: priorId, path };
			// Arm B — recorded failing-test file paths (structured parsers over
			// the phase's lastFailures reasons; containment fallback documented).
			const reasons = failuresById.get(priorId) ?? [];
			const recorded = extractFailingTestFilePaths(reasons);
			if (recorded.includes(path)) return { arm: "arm-b", phaseId: priorId, path };
			if (reasons.some((r) => typeof r === "string" && r.includes(path))) return { arm: "arm-b", phaseId: priorId, path };
		}
	}
	return null;
}

// ── the ledger (append-only; persists across resume) ────────────────────────

/** `<specDir>/.inherited-red.jsonl` — one JSON line per ladder event. The
 *  OCCURRENCE tally (rows with `event:"occurrence"` — boundary evaluations
 *  whose classification survived Tier 0 and Tier 1, i.e. reached the Tier-2
 *  decision) and the flake tally (`event:"flake-rerun"`) are derived from it;
 *  both persist across resume because the file does. Rows are NEVER rewritten
 *  (append-only). */
export function inheritedRedLedgerPath(specDir: string): string {
	return join(specDir, ".inherited-red.jsonl");
}

/** Append ONE ledger row. Never throws: a failure degrades to a warning
 *  through `log` (ledger bookkeeping never blocks the ladder — the
 *  replan-requests.json row written by the replan circuit is the durable
 *  handoff record; this ledger is the tally/audit channel). */
export function appendInheritedRedEvent(specDir: string | undefined, row: Record<string, unknown>, log?: (m: string) => void): void {
	if (!specDir) return;
	try {
		mkdirSync(isAbsolute(specDir) ? specDir : join(process.cwd(), specDir), { recursive: true });
		appendFileSync(inheritedRedLedgerPath(isAbsolute(specDir) ? specDir : join(process.cwd(), specDir)), JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		try { log?.(`inherited-red ledger append failed (continuing; never fatal): ${msg}`); } catch { /* never throw */ }
	}
}

/** All ledger rows (newest last). `[]` when absent/unreadable. Never throws. */
export function readInheritedRedEvents(specDir: string | undefined): Array<Record<string, unknown>> {
	if (!specDir) return [];
	try {
		const dir = isAbsolute(specDir) ? specDir : join(process.cwd(), specDir);
		return readFileSync(inheritedRedLedgerPath(dir), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

/** The OCCURRENCE tally: boundary evaluations whose inherited-red
 *  classification survived Tier 0 and Tier 1 (reached the Tier-2 decision).
 *  Ledger-backed; persists across resume. Occurrence 1 → Tier-2 handoff;
 *  occurrence ≥2 → Tier-3 FatalAbort. */
export function countInheritedRedOccurrences(specDir: string | undefined): number {
	return readInheritedRedEvents(specDir).filter((r) => r.event === "occurrence").length;
}

/** The per-run flake tally (Tier-1 re-runs performed). Counter only —
 *  surfaced in the close-out report, never a retry reason. */
export function inheritedRedFlakeTally(specDir: string | undefined): number {
	return readInheritedRedEvents(specDir).filter((r) => r.event === "flake-rerun").length;
}
