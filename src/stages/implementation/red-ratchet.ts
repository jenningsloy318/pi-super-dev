/**
 * v0.3.85 F5 — RED-phase assertion ratchet (C3 fix; §9 F5, §14 ADR 10).
 *
 * Extracted from stage.ts at v0.4.30. This module owns the ACCEPTANCE-TIME half
 * of the ratchet only — the deterministic evaluation that decides whether a RED
 * sample weakened a pre-existing test file. The escalation half (declared
 * handoff / judge routing on RED-retry exhaustion) stays in stage.ts because it
 * mutates run-scope state (terminalStopReason, attemptErrors) and breaks the
 * RED loop; see the seam note in stage.ts.
 */

import { preexistingTestSurfaceRows, weakenedAssertionSurfaces, type RedEvidence } from "./red-evidence.ts";

/** A status already rejected by an earlier gate never reaches the ratchet. */
const ALREADY_REJECTED: ReadonlySet<RedEvidence["status"]> = new Set([
	"coverage-incomplete",
	"green-weak-test",
	"broken-test",
	"polluted-red",
]);

/**
 * The statuses that count as "already rejected" only when the phase is
 * fail-closed (it requires tests). An unknown that is NOT fail-closed still
 * falls through to the implementer per v0.3.30 F2's P3 contract, so the ratchet
 * must not reject it.
 */
const REJECT_ONLY_WHEN_FAIL_CLOSED: ReadonlySet<RedEvidence["status"]> = new Set([
	"unknown-no-runner",
	"unknown-unclassified",
]);

export interface F5RatchetInput {
	/** Absolute worktree root the surface rows are read from. */
	readonly worktreePath: string;
	/** Files the RED phase actually touched this try. */
	readonly redChangedFiles: string[];
	/** True when the phase requires tests (the fail-closed guard engaged). */
	readonly failClosedUnknown: boolean;
	/** Phase id, for the log line only. */
	readonly phaseId: string;
	/** The stage's log sink. */
	readonly log: (line: string) => void;
}

/**
 * Evaluate the F5 assertion ratchet against a RED sample heading to acceptance.
 *
 * During RED the boundary LEGALLY admits edits to pre-existing test files (the
 * GREEN-side test-edit ban is v0.3.43) — the 09-09 phase-1 tdd-guide answered an
 * "unsatisfiable RED" by gutting 3 pre-existing guard suites, making the oracle
 * green and misrouting the phase. The ratchet: a pre-existing test file's
 * assertion-surface count (F5 grammar) must NEVER decrease vs its pre-edit HEAD
 * state.
 *
 * Checked at ACCEPTANCE — only for tries heading to acceptance (classes already
 * rejected below revert everything anyway) — so a weakened oracle can NEVER
 * reach GREEN, not even via the already-satisfied route.
 *
 * Pure: returns the input evidence unchanged, or a copy flagged
 * `weakened-preexisting-test`. Mutates nothing on disk.
 */
export function evaluateF5Ratchet(redEvidence: RedEvidence, input: F5RatchetInput): RedEvidence {
	const alreadyRejected = ALREADY_REJECTED.has(redEvidence.status)
		|| (REJECT_ONLY_WHEN_FAIL_CLOSED.has(redEvidence.status) && input.failClosedUnknown);
	if (alreadyRejected) return redEvidence;

	const f5Rows = preexistingTestSurfaceRows(input.worktreePath, input.redChangedFiles);
	const f5Weakened = weakenedAssertionSurfaces(f5Rows);
	if (f5Weakened.length === 0) return redEvidence;

	input.log(`Implementation ${input.phaseId} RED assertion ratchet: REJECTED — weakened pre-existing test file(s) ${f5Weakened.map((w) => `${w.path} (${w.before}→${w.after} markers)`).join(", ")}; the pre-existing test edit(s) will be reverted, new independent test files survive`);
	return {
		...redEvidence,
		status: "weakened-preexisting-test",
		reason: `pre-existing test assertion surface decreased: ${f5Weakened.map((w) => `${w.path} ${w.before}→${w.after}`).join(", ")}`,
		weakenedFiles: f5Weakened,
		preexistingTestFiles: f5Rows.map((r) => r.path),
	};
}
