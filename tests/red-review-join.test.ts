/**
 * The parallel RED-review join — contract test for the v0.4.35 extraction
 * (increment 7 of the stage.ts split).
 *
 * The extraction is a control-flow conversion (the third, after red-judge.ts
 * and research-assist-dispatch.ts): the inline block's `continue` (reject →
 * re-author) became a returned `restart`, and its `break` (cap exhausted)
 * became a returned `terminal`. These tests pin the four verdict branches AND
 * the cross-iteration carry that a returned record must reproduce explicitly
 * (the v0.4.33 lesson — a `continue` preserved phase-scoped state implicitly):
 * the reject branch must not touch the terminal-* trio, and the proceed
 * branches must leave acceptedRed / redTestSnapshot untouched.
 *
 * discardGreenWork touches a real git worktree, so the reject tests build a
 * temp repo (the discard-staged.test.ts fixture pattern).
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { joinRedReview } from "../src/stages/implementation/red-review-join.ts";
import type { RedReviewJoinInput, RedReviewInFlight } from "../src/stages/implementation/red-review-join.ts";
import type { StageContext, PipelineState } from "../src/types.ts";

function git(cwd: string, ...args: string[]): string {
	return execSync(`git ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, { cwd, encoding: "utf8" });
}

/** Real temp repo with a committed baseline, plus one committed RED test file. */
function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "sd-redjoin-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src/a.test.ts"), "test\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	return root;
}

const ctx = () => ({ log: vi.fn(), budget: { check: () => true } } as unknown as StageContext);

const baseInput = (worktreePath: string, review: RedReviewInFlight, over: Partial<RedReviewJoinInput> = {}): RedReviewJoinInput => ({
	ctx: ctx(),
	state: {} as unknown as PipelineState,
	worktreePath,
	phaseId: "phase-02",
	review,
	implControl: null,
	testFiles: ["src/a.test.ts"],
	maxParallelReviewRejects: MAX_PARALLEL_REJECTS_FOR_INPUT_VALUE,
	attemptsRun: 3,
	parallelReviewRejects: 0,
	phaseReviewViolations: 0,
	terminalFailureKind: "implementation-gate",
	terminalRedTries: 0,
	terminalStopReason: "failed",
	acceptedRed: { status: "red", testFiles: ["src/a.test.ts"], changedFiles: [] },
	redTestSnapshot: new Map([["src/a.test.ts", "test\n"]]),
	redWeaknessAdvisory: "",
	reauthorEvidence: "",
	...over,
});

// the production bound is a phase-loop const at the caller; exercise the seam
// against the same value passed in as a param (P6: never re-declare the bound).
const MAX_PARALLEL_REJECTS_FOR_INPUT_VALUE = 3;

/** A resolved review carrying a control object (the promise shape is
 *  {control, error?} — the verdict is read off .control.verdict). */
const reviewWith = (control: unknown): RedReviewInFlight =>
	Promise.resolve({ control, error: undefined });

describe("red-review join (v0.4.35 increment-7 extraction)", () => {
	it("STRONG + no contradictions → proceed, touching NOTHING carried in", async () => {
		const root = makeRepo();
		try {
			const snapshot = new Map([["src/a.test.ts", "test\n"]]);
			const accepted = { status: "red" as const, testFiles: ["src/a.test.ts"], changedFiles: [] };
			const out = await joinRedReview(baseInput(root, reviewWith({ verdict: "STRONG" }), {
				acceptedRed: accepted,
				redTestSnapshot: snapshot,
			}));
			expect(out.kind).toBe("proceed");
			// v0.4.33 lesson: the proceed branch must echo carried-in state untouched.
			expect(out.routing.acceptedRed).toBe(accepted);
			expect(out.routing.redTestSnapshot).toBe(snapshot);
			expect(out.routing.terminalStopReason).toBe("failed");
			expect(out.routing.redWeaknessAdvisory).toBe("");
			expect(out.routing.attemptErrorsAppend).toBeNull();
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("WEAK + no contradictions → proceed with an advisory, still not touching the RED state", async () => {
		const root = makeRepo();
		try {
			const accepted = { status: "red" as const, testFiles: ["src/a.test.ts"], changedFiles: [] };
			const out = await joinRedReview(baseInput(root, reviewWith({ verdict: "weak", summary: "assertions unbound" }), {
				acceptedRed: accepted,
			}));
			expect(out.kind).toBe("proceed");
			expect(out.routing.redWeaknessAdvisory).toContain("NOT STRONG");
			expect(out.routing.redWeaknessAdvisory).toContain("assertions unbound");
			// weak is advisory — the accepted RED survives (the post-RED oracle guards)
			expect(out.routing.acceptedRed).toBe(accepted);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("a contradiction list with a STRONG verdict still REJECTS (the contradiction overrides the verdict)", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "src/impl.ts"), "agent work\n"); // GREEN work to discard
		try {
			const out = await joinRedReview(baseInput(root, reviewWith({
				verdict: "strong",
				contradictions: [{ tests: "a.test.ts", proof: "jointly unsatisfiable" }],
			})));
			expect(out.kind).toBe("restart");
			expect(out.routing.acceptedRed).toBeNull();
			expect(out.routing.redTestSnapshot.size).toBe(0);
			expect(out.routing.attemptErrorsAppend).toContain("jointly unsatisfiable");
			expect(out.routing.reauthorEvidence).toContain("RED REVIEW REJECTED THE SUITE");
			// the GREEN work was discarded
			expect(git(root, "status", "--porcelain")).not.toContain("src/impl.ts");
			// v0.4.33 lesson: the terminal trio is untouched on a plain reject
			expect(out.routing.terminalFailureKind).toBe("implementation-gate");
			expect(out.routing.terminalStopReason).toBe("failed");
			expect(out.routing.terminalRedTries).toBe(0);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("an off-enum verdict REJECTS (fail-open only applies when NO verdict text was parsed)", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "src/impl.ts"), "agent work\n");
		try {
			const out = await joinRedReview(baseInput(root, reviewWith({ verdict: "REJECTED" })));
			expect(out.kind).toBe("restart");
			expect(out.routing.acceptedRed).toBeNull();
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("a REVIEWER-side failure with no verdict → fail-OPEN: keep the work, count the violation, proceed", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "src/impl.ts"), "agent work\n"); // must SURVIVE
		try {
			const accepted = { status: "red" as const, testFiles: ["src/a.test.ts"], changedFiles: [] };
			const out = await joinRedReview(baseInput(root, Promise.resolve({ control: null, error: "source-read-only boundary" }), {
				acceptedRed: accepted,
				phaseReviewViolations: 1, // already at 1 → this is the 2nd, disabling parallel review
			}));
			expect(out.kind).toBe("proceed");
			expect(out.routing.phaseReviewViolations).toBe(2);
			// the GREEN work is KEPT (checker failure, not suite evidence)
			expect(git(root, "status", "--porcelain")).toContain("src/impl.ts");
			// the accepted RED survives too
			expect(out.routing.acceptedRed).toBe(accepted);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("a THROWING review is caught and adjudicated as a reviewer failure (never escapes)", async () => {
		const root = makeRepo();
		try {
			const throwing: RedReviewInFlight = Promise.reject(new Error("agent threw"));
			const out = await joinRedReview(baseInput(root, throwing));
			expect(out.kind).toBe("proceed"); // no verdict parsed → fail-open
			expect(out.routing.phaseReviewViolations).toBe(1);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("the cap: rejects below the bound restart; AT the bound the phase stops as no-progress", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "src/impl.ts"), "agent work\n");
		try {
			// one below the cap → restart
			const near = await joinRedReview(baseInput(root, reviewWith({ verdict: "REJECTED" }), {
				parallelReviewRejects: MAX_PARALLEL_REJECTS_FOR_INPUT_VALUE - 1,
			}));
			expect(near.kind).toBe("restart");
			expect(near.routing.terminalStopReason).toBe("failed"); // unchanged

			// AT the cap → terminal, and the terminal trio is SET
			const at = await joinRedReview(baseInput(root, reviewWith({ verdict: "REJECTED" }), {
				parallelReviewRejects: MAX_PARALLEL_REJECTS_FOR_INPUT_VALUE,
			}));
			expect(at.kind).toBe("terminal");
			expect(at.routing.terminalFailureKind).toBe("red-generation");
			expect(at.routing.terminalStopReason).toBe("no-progress");
			expect(at.routing.terminalRedTries).toBe(3); // attemptsRun
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});

describe("adversarial-gate F2 pins — the three seams the first 7 tests left open", () => {
	/** v0.3.55: the quarantine payload and the salvaged control ride the THROWN
	 *  error (parent-composed, unforgeable) — a resolved promise never carries
	 *  them. Build the production-shaped rejection here. */
	const boundaryThrow = (salvagedControl: Record<string, unknown>): RedReviewInFlight =>
		Promise.reject(Object.assign(new Error("boundary violation: reviewer wrote src/impl.ts"), {
			quarantine: { violations: ["src/impl.ts"], dir: "/tmp/q" },
			salvagedControl,
		}));

	it("(a) an off-enum verdict WITH an error stays FAIL-CLOSED — the error must not launder a rejection into a keep", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "src/impl.ts"), "agent work\n"); // GREEN work
		try {
			const out = await joinRedReview(baseInput(root, Promise.resolve({ control: { verdict: "REJECTED" }, error: "source-read-only boundary" })));
			expect(out.kind).toBe("restart"); // REJECT — NOT the fail-open keep
			expect(out.routing.attemptErrorsAppend).toContain("red-review-rejected");
			expect(out.routing.attemptErrorsAppend).toContain("RED review did not complete");
			// a verdict IS suite evidence: no reviewer-failure violation is counted
			expect(out.routing.phaseReviewViolations).toBe(0);
			// fail-closed: the GREEN work was DISCARDED
			expect(git(root, "status", "--porcelain")).not.toContain("src/impl.ts");
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("(c) a resolved null review → REJECT with the no-usable-verdict summary (the | null arm of RedReviewInFlight)", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "src/impl.ts"), "agent work\n");
		try {
			const out = await joinRedReview(baseInput(root, Promise.resolve(null)));
			expect(out.kind).toBe("restart");
			expect(out.routing.attemptErrorsAppend).toContain("no usable verdict");
			expect(out.routing.phaseReviewViolations).toBe(0); // not a reviewer failure
			expect(git(root, "status", "--porcelain")).not.toContain("src/impl.ts");
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("(b) the salvage gate: a boundary throw whose violations are FULLY implementer-claimed salvages the verdict and adjudicates normally", async () => {
		const root = makeRepo();
		try {
			const log = vi.fn();
			const out = await joinRedReview(baseInput(root, boundaryThrow({ verdict: "strong" }), {
				ctx: { log, budget: { check: () => true } } as unknown as StageContext,
				implControl: { filesModified: ["src/impl.ts"] }, // declared claim covers the violation
			}));
			expect(out.kind).toBe("proceed"); // the salvaged STRONG verdict adjudicated
			expect(log.mock.calls.some(([line]) => String(line).includes("verdict salvaged"))).toBe(true);
			expect(out.routing.phaseReviewViolations).toBe(0); // salvage, not a failure count
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("(b′) a SALVAGED off-enum verdict still REJECTS — the salvage gate must not launder a rejection either", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "src/impl.ts"), "agent work\n"); // GREEN work
		try {
			const out = await joinRedReview(baseInput(root, boundaryThrow({ verdict: "REJECTED" }), {
				implControl: { filesModified: ["src/impl.ts"] }, // attribution passes → salvage fires
			}));
			// the salvage fired (verdict !== undefined), but the salvaged verdict is
			// off-enum → suite evidence → fail-CLOSED, not fail-open
			expect(out.kind).toBe("restart");
			expect(out.routing.phaseReviewViolations).toBe(0);
			expect(git(root, "status", "--porcelain")).not.toContain("src/impl.ts");
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});
