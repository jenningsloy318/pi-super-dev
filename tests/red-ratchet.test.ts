/**
 * Direct unit tests for evaluateF5Ratchet (v0.4.30 fold — adversarial gate F1).
 *
 * The set-split predicate had no direct test: integration walkthroughs covered
 * the acceptance path, the already-satisfied interplay and both escalation
 * triggers, but never the SHORT-CIRCUIT itself. These pin each set-membership
 * class and assert the short-circuit genuinely skips the git work.
 *
 * v0.4.31 honesty fix: the first version monkeypatched `cp.spawnSync` after
 * module load, which is VACUOUS — red-evidence.ts binds spawnSync via a static
 * ESM named import, so the patch never intercepts it and the counter read 0
 * even when git ran. This version hoists the mock with vi.mock (the repo's
 * established pattern, e.g. build-runner-autoscope) so the count is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RedEvidence } from "../src/stages/implementation/red-evidence.ts";

// Hoisted before the module under test imports child_process.
const spawnCalls: string[] = [];
vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => {
		const cmd = String(args[0] ?? "");
		const argv = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
		spawnCalls.push(`${cmd} ${argv.join(" ")}`);
		// A real `git show HEAD:<path>` on an untracked path fails (status !== 0);
		// emulate that so preexistingTestSurfaceRows yields no rows by default.
		return { status: 128, stdout: "", error: undefined };
	},
	execFileSync: () => ({ status: 0, stdout: "" }),
}));

// Imported AFTER the mock is registered.
import { evaluateF5Ratchet } from "../src/stages/implementation/red-ratchet.ts";

/** A minimal evidence with only the fields the ratchet reads. */
function evidence(status: RedEvidence["status"]): RedEvidence {
	return { status } as RedEvidence;
}

const baseInput = {
	worktreePath: "/tmp/nonexistent-ratchet-worktree",
	redChangedFiles: ["tests/sample.test.ts"],
	failClosedUnknown: false,
	phaseId: "phase-1",
	log: () => {},
};

/** Every git invocation the ratchet's helpers performed during fn. */
function gitCallsDuring<T>(fn: () => T): string[] {
	spawnCalls.length = 0;
	fn();
	return [...spawnCalls];
}

describe("evaluateF5Ratchet — the set-split short-circuit (v0.4.30 fold, adv F1)", () => {
	beforeEach(() => { spawnCalls.length = 0; });

	it("ALREADY_REJECTED statuses return the evidence UNCHANGED and perform ZERO git work", () => {
		for (const status of ["coverage-incomplete", "green-weak-test", "broken-test", "polluted-red"] as const) {
			const ev = evidence(status);
			const calls = gitCallsDuring(() => {
				const out = evaluateF5Ratchet(ev, baseInput);
				expect(out, `${status} must be returned unchanged`).toBe(ev);
			});
			expect(calls, `${status} must short-circuit before any git call`).toHaveLength(0);
		}
	});

	it("REJECT_ONLY_WHEN_FAIL_CLOSED statuses short-circuit WHEN fail-closed", () => {
		for (const status of ["unknown-no-runner", "unknown-unclassified"] as const) {
			const ev = evidence(status);
			const calls = gitCallsDuring(() => {
				const out = evaluateF5Ratchet(ev, { ...baseInput, failClosedUnknown: true });
				expect(out, `${status} fail-closed must be returned unchanged`).toBe(ev);
			});
			expect(calls, `${status} fail-closed must short-circuit`).toHaveLength(0);
		}
	});

	it("REJECT_ONLY_WHEN_FAIL_CLOSED statuses still RUN the ratchet when NOT fail-closed", () => {
		for (const status of ["unknown-no-runner", "unknown-unclassified"] as const) {
			const calls = gitCallsDuring(() => {
				evaluateF5Ratchet(evidence(status), { ...baseInput, failClosedUnknown: false });
			});
			// v0.3.30 F2 P3 contract: unknown-not-fail-closed falls through to the
			// implementer, so the ACCEPTANCE-TIME guard must still inspect it — the
			// ratchet must not pre-reject it as already-rejected.
			expect(calls.some((c) => /git .+ show HEAD:/.test(c)), `${status} not fail-closed must be evaluated`).toBe(true);
		}
	});

	it("statuses in NEITHER set run the ratchet (the acceptance surface is inspected)", () => {
		for (const status of ["red-behavior-failure", "review-weak", "green-already-satisfied", "weakened-preexisting-test"] as const) {
			const calls = gitCallsDuring(() => {
				const out = evaluateF5Ratchet(evidence(status), baseInput);
				expect(out.status, `${status} must not be rejected by the short-circuit`).toBe(status);
			});
			expect(calls.some((c) => /git .+ show HEAD:/.test(c)), `${status} must be evaluated`).toBe(true);
		}
	});
});
