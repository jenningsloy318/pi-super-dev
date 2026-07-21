/**
 * Phase 3 — Stage + phase bracketing wiring (RED phase).
 * spec-11 AC-04 → SCENARIO-008 / SCENARIO-009.
 *
 * Re-listed in Phase 5's deliverable set ("new tests from Phases 1-4 …
 * tracker-bracketing.test.ts"), this is the synthetic-pipeline assertion that
 * the per-run ChangeTracker brackets EVERY stage (start+end) AND every
 * implementation phase (start+end), persisting a correctly-nested append-only
 * `<specDir>/change-tracker.jsonl`:
 *
 *     stage-start → phase1-start → phase1-end → phase2-start → phase2-end → stage-end
 *
 * Two layers, mirroring the two Phase-3 sub-changes:
 *
 *  (1) Behavioural nesting via the REAL `ChangeTracker` against a temp worktree
 *      + temp specDir (Phase 1 module + Phase 3b implementation.ts phase
 *      bracketing — documents the SCENARIO-009 nesting contract; GREEN once
 *      Phase 1 ships because nesting depends only on jsonl event ordering,
 *      which is emitted whether or not git is available).
 *
 *  (2) Wiring contract for Phase 3a — the RED driver: the engine's workflow
 *      stage-event seam must call `getActiveTracker()?.begin("stage", id)` on
 *      status==="running" and `getActiveTracker()?.end("stage", id)` on a
 *      terminal status (ok/failed/skipped). This subscription is currently
 *      NOT present in `src/workflow.ts` / `src/nodes.ts` (only `progress.*`
 *      is wired), so these assertions FAIL until Phase 3a lands.
 *
 * Hermetic: a fresh temp directory per test (no shared state). The tracker
 * degrades gracefully to `gitUnavailable` when the worktree is not a git repo,
 * and STILL emits the start/end records — so the nesting assertions hold even
 * without a real git binary, but we spin a real throwaway repo so the
 * `gitActual` end-records are also exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
	ChangeTracker,
	setActiveTracker,
	getActiveTracker,
	type StructuredChanges,
} from "../src/tracking.ts";

/** Read a repo source file as a string for wiring-contract assertions. */
function readSrc(rel: string): string {
	return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Parse `<specDir>/change-tracker.jsonl` into an array of records. */
function readJsonl(specDir: string): Array<Record<string, unknown>> {
	const f = join(specDir, "change-tracker.jsonl");
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Create a throwaway git repo so the tracker's real spawnSync works end-to-end. */
function makeTempGitRepo(): { worktree: string } {
	const worktree = mkdtempSync(join(tmpdir(), "tracker-bracket-wt-"));
	execSync("git init -q", { cwd: worktree });
	execSync('git config user.email t@t.t', { cwd: worktree });
	execSync('git config user.name t', { cwd: worktree });
	execSync('git config commit.gpgsign false', { cwd: worktree });
	writeFileSync(join(worktree, "seed.txt"), "seed\n");
	execSync("git add -A && git commit -q -m seed", { cwd: worktree });
	return { worktree };
}

describe("Phase 3 — tracker bracketing (SCENARIO-008 / SCENARIO-009)", () => {
	let specDir: string;
	let worktree: string;

	beforeEach(() => {
		specDir = mkdtempSync(join(tmpdir(), "tracker-bracket-spec-"));
		const repo = makeTempGitRepo();
		worktree = repo.worktree;
		setActiveTracker(new ChangeTracker(specDir, worktree));
	});

	afterEach(() => {
		setActiveTracker(null);
		rmSync(specDir, { recursive: true, force: true });
		rmSync(worktree, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// Layer 1 — behavioural nesting via the real ChangeTracker
	// -------------------------------------------------------------------------

	it("emits stage-start / phase-start / phase-end / stage-end in correct nested order", () => {
		const t = getActiveTracker()!;
		expect(t).toBeInstanceOf(ChangeTracker);

		// Simulate one stage containing two implementation phases.
		t.begin("stage", "stage-research");
		t.begin("phase", "phase-impl-1");
		t.end("phase", "phase-impl-1");
		t.begin("phase", "phase-impl-2");
		t.end("phase", "phase-impl-2");
		t.end("stage", "stage-research");

		const records = readJsonl(specDir);
		// stage-start, phase1-start, phase1-end, phase2-start, phase2-end, stage-end
		expect(records).toHaveLength(6);

		const events = records.map((r) => `${r.unit}/${r.id}/${r.event}`).join(" → ");
		expect(events).toBe(
			[
				"stage/stage-research/start",
				"phase/phase-impl-1/start",
				"phase/phase-impl-1/end",
				"phase/phase-impl-2/start",
				"phase/phase-impl-2/end",
				"stage/stage-research/end",
			].join(" → "),
		);
	});

	it("emits BOTH a start AND an end jsonl line for every stage AND phase", () => {
		const t = getActiveTracker()!;
		t.begin("stage", "s-a");
		t.end("stage", "s-a");
		t.begin("stage", "s-b");
		t.end("stage", "s-b");
		t.begin("phase", "p-1");
		t.end("phase", "p-1");

		const records = readJsonl(specDir);
		const starts = records.filter((r) => r.event === "start");
		const ends = records.filter((r) => r.event === "end");
		expect(starts).toHaveLength(3);
		expect(ends).toHaveLength(3);
		// Every bracketed unit has exactly one start and one end.
		for (const key of ["stage:s-a", "stage:s-b", "phase:p-1"]) {
			const [unit, id] = key.split(":");
			expect(records.some((r) => r.unit === unit && r.id === id && r.event === "start")).toBe(true);
			expect(records.some((r) => r.unit === unit && r.id === id && r.event === "end")).toBe(true);
		}
	});

	it("phase end-record carries the claimed structured set + a crossCheck verdict (Phase 4 input)", () => {
		const t = getActiveTracker()!;
		t.begin("stage", "s");
		t.begin("phase", "p");
		// Claim a created file that does NOT exist in the worktree → claimed-miss.
		const claimed: StructuredChanges = {
			filesCreated: ["src/never-created.ts"],
			filesModified: [],
			filesDeleted: [],
		};
		const rec = t.end("phase", "p", claimed);
		t.end("stage", "s");

		expect(rec).not.toBeNull();
		expect(rec!.claimed).toEqual(claimed);
		// git IS available (real temp repo) so a claimed-but-absent file is a miss.
		expect(rec!.gitUnavailable).toBeFalsy();
		expect(rec!.crossCheck).not.toBeNull();
		expect(rec!.crossCheck!.claimedNotChanged).toContain("src/never-created.ts");
		// getRecord returns the LAST end-record for the phase (gate reads this).
		expect(t.getRecord("phase", "p")).toBe(rec);
	});

	it("is append-only: repeated brackets accumulate lines, nothing is overwritten", () => {
		const t = getActiveTracker()!;
		t.begin("stage", "s");
		t.end("stage", "s");
		t.begin("stage", "s"); // re-bracket same id
		t.end("stage", "s");

		const records = readJsonl(specDir);
		// Two full start/end pairs appended — never overwritten.
		expect(records.filter((r) => r.event === "start")).toHaveLength(2);
		expect(records.filter((r) => r.event === "end")).toHaveLength(2);
	});

	// -------------------------------------------------------------------------
	// Layer 2 — Phase 3a wiring contract (RED driver)
	// -------------------------------------------------------------------------

	it("engine stage-event seam brackets the active tracker (Phase 3a)", () => {
		// The workflow stage subscription must call getActiveTracker()?.begin/end
		// ("stage", id). Currently only progress.* is wired (workflow.ts ~163),
		// so getActiveTracker is NOT referenced anywhere in the stage path.
		// This assertion FAILS until Phase 3a adds the subscription seam.
		const sources = [readSrc("src/workflow.ts"), readSrc("src/nodes.ts")].join("\n\n---\n\n");
		expect(sources, "stage-event seam must reference getActiveTracker").toMatch(
			/getActiveTracker/,
		);
	});

	it("Phase 3a stage seam calls begin('stage', …) on stage start", () => {
		const sources = [readSrc("src/workflow.ts"), readSrc("src/nodes.ts")].join("\n\n---\n\n");
		expect(sources, "stage start must call tracker.begin('stage', id)").toMatch(
			/\.\s*begin\(\s*["']stage["']/,
		);
	});

	it("Phase 3a stage seam calls end('stage', …) on a terminal stage status", () => {
		const sources = [readSrc("src/workflow.ts"), readSrc("src/nodes.ts")].join("\n\n---\n\n");
		expect(sources, "stage end must call tracker.end('stage', id)").toMatch(
			/\.\s*end\(\s*["']stage["']/,
		);
	});
});
