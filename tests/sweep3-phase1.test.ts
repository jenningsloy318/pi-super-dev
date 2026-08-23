/**
 * Codebase sweep-3 remediation, Phase 1 — escalation safety & run-status honesty.
 * Fix groups (docs/requirements/sweep3-findings-dossier.md):
 *   G4  — applyRetryDecision must never roll back the MAIN CHECKOUT (skipWorktree).
 *   G3  — failedStages is LAST-status-per-stage (a converged-after-failure run can succeed).
 *   G9  — `success` requires an AFFIRMATIVE buildGate; absent buildGate is not a vacuous pass.
 *   G22 — a success run never carries the mid-loop __stagnated marker into the summary/HITL.
 *
 * RED-first: every FIX test below fails on pre-fix main (4c97dbe1); CONTROL tests
 * pass on both trees.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyRetryDecision } from "../src/escalation.ts";
import { deriveRunStatus } from "../src/workflow.ts";
import type { PipelineState } from "../src/types.ts";

function git(cwd: string, args: string[]): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** A real repo with one committed file + one dirty uncommitted edit. */
function dirtyRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "sweep3-p1-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "t@t"]);
	git(dir, ["config", "user.name", "t"]);
	writeFileSync(join(dir, "file.txt"), "committed\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-qm", "init"]);
	writeFileSync(join(dir, "file.txt"), "DIRTY UNCOMMITTED EDIT\n");
	return dir;
}

// ─── G4: retry-with-guidance never resets the main checkout ────────────────

describe("G4 — applyRetryDecision main-checkout guard", () => {
	it("CONTROL (passes both trees): worktree rollback still works for a REAL worktree-shaped run (skipWorktree unset)", () => {
		const dir = dirtyRepo();
		try {
			const state = { setup: { skipWorktree: false } } as unknown as PipelineState;
			applyRetryDecision(state, { choice: "retry-with-guidance", guidance: "again" }, { worktreePath: dir, specDirectory: undefined });
			expect(readFileSync(join(dir, "file.txt"), "utf8")).toBe("committed\n"); // dirty edit reset — intended in a worktree
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("FIX (RED pre-fix): skipWorktree run (worktreePath IS the main checkout) — rollback REFUSED, dirty work untouched", () => {
		const dir = dirtyRepo();
		try {
			const state = { setup: { skipWorktree: true } } as unknown as PipelineState;
			applyRetryDecision(state, { choice: "retry-with-guidance", guidance: "again" }, { worktreePath: dir, specDirectory: undefined });
			expect(readFileSync(join(dir, "file.txt"), "utf8")).toBe("DIRTY UNCOMMITTED EDIT\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("FIX (RED pre-fix): no setup at all (defensive) — rollback REFUSED", () => {
		const dir = dirtyRepo();
		try {
			const state = {} as PipelineState;
			applyRetryDecision(state, { choice: "retry-with-guidance", guidance: "again" }, { worktreePath: dir, specDirectory: undefined });
			expect(readFileSync(join(dir, "file.txt"), "utf8")).toBe("DIRTY UNCOMMITTED EDIT\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── G3/G9/G22: deriveRunStatus (extracted pure) ────────────────────────────

type Row = { id: string; label?: string; status: string; error?: string };

function derive(results: Row[], state: Partial<PipelineState>, aborted = false, abortError?: string) {
	return deriveRunStatus({
		results: results as never,
		state: state as PipelineState,
		aborted,
		abortError,
	});
}

const greenBase: Partial<PipelineState> = {
	implementation: { totalPhases: 2, allGreen: true } as never,
	review: { verdict: "Approved" } as never,
	buildGate: { pass: true } as never,
};

describe("G3 — failedStages is LAST-status-per-stage", () => {
	it("FIX (RED pre-fix): a stage whose round-1 task failed but later round converged does NOT block success", () => {
		const r = derive(
			[
				{ id: "bdd", label: "BDD", status: "failed", error: "round 1 validation" },
				{ id: "bdd", label: "BDD", status: "ok" },
			],
			greenBase,
		);
		expect(r.status).toBe("success");
		expect(r.failedStages).toEqual([]);
	});

	it("CONTROL: a stage that ENDS failed still blocks success", () => {
		const r = derive(
			[
				{ id: "bdd", status: "ok" },
				{ id: "bdd", status: "failed", error: "late failure" },
			],
			greenBase,
		);
		expect(r.status).not.toBe("success");
		expect(r.failedStages.map((f: { label: string }) => f.label)).toEqual(["bdd"]);
	});

	it("CONTROL: failed-then-failed keeps the LAST error text", () => {
		const r = derive(
			[
				{ id: "spec", status: "failed", error: "old" },
				{ id: "spec", status: "failed", error: "new" },
			],
			greenBase,
		);
		expect(r.failedStages[0]?.error).toBe("new");
	});
});

describe("G9 — absent buildGate is not a vacuous pass", () => {
	it("FIX (RED pre-fix): green impl + approved review but NO buildGate at all → partial, honest reason", () => {
		const s: Partial<PipelineState> = {
			implementation: { totalPhases: 2, allGreen: true } as never,
			review: { verdict: "Approved" } as never,
		};
		const r = derive([], s);
		expect(r.status).toBe("partial");
		expect(r.statusReasons.some((x: string) => /build gate/i.test(x))).toBe(true);
	});

	it("CONTROL: affirmative buildGate pass:true stays success", () => {
		expect(derive([], greenBase).status).toBe("success");
	});

	it("CONTROL: buildGate pass:false stays non-success", () => {
		const r = derive([], { ...greenBase, buildGate: { pass: false } as never });
		expect(r.status).not.toBe("success");
	});
});

describe("G22 — success runs never surface __stagnated", () => {
	it("FIX (RED pre-fix): derivation clears a stale __stagnated marker when the final status is success", () => {
		const s = { ...greenBase } as Record<string, unknown>;
		s.__stagnated = { kind: "stage10.stagnation", rounds: 2 };
		const r = derive([], s as Partial<PipelineState>);
		expect(r.status).toBe("success");
		expect((s as Record<string, unknown>).__stagnated).toBeUndefined();
	});

	it("CONTROL: a NON-success run keeps the marker (the human must still see it)", () => {
		const s = { ...greenBase, buildGate: { pass: false } } as Record<string, unknown>;
		s.__stagnated = { kind: "stage10.stagnation", rounds: 2 };
		const r = derive([], s as Partial<PipelineState>);
		expect(r.status).not.toBe("success");
		expect(s.__stagnated).toBeDefined();
	});
});

// v0.3.13: prototype must be labeled 6C (6B belongs to Design Review)
it("prototype stage label is Stage 6C (no 6B collision with Design Review)", async () => {
	const { prototypeStage } = await import("../src/stages/prototype.ts");
	const { designReviewWriter } = await import("../src/stages/writers.ts");
	expect(prototypeStage.label).toBe("Stage 6C — Prototype");
	expect(designReviewWriter.label).toBe("Stage 6B — Design Review");
});
