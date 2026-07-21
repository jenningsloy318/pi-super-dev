/**
 * Phase 1 — `src/tracking.ts` ChangeTracker core module (RED phase).
 *
 * These tests define the contract for the NEW self-contained `ChangeTracker`
 * class BEFORE any implementation exists. They map to Layer 1 of spec-11:
 * AC-01 (git primitives + classification), AC-02 (never-throw / git-unavailable
 * + conservative parse), AC-03 (begin/end bracketing + append-only jsonl).
 *
 * Coverage matrix:
 *   - SCENARIO-001/002/003/004 → classification (diff A/M/D + porcelain
 *     ?? / D / M codes, UNION via dedupePreservingOrder)        (AC-01)
 *   - SCENARIO-005 → git-unavailable: never throws, records
 *     {gitUnavailable:true}, verdict "git-unavailable", no block  (AC-02)
 *   - SCENARIO-006 → conservative parse: ambiguous/unavailable parse
 *     leaves claimedNotChanged empty (no false failure)           (AC-02)
 *   - SCENARIO-007 → begin/end bracketing emits BOTH start + end jsonl
 *     lines; append-only across multiple events                    (AC-03)
 *
 * CONTRACT (from the P1 specification):
 *   - `ChangeTracker` constructed with `(specDir, worktreePath)`; writes a
 *     single durable append-only file `<specDir>/change-tracker.jsonl`.
 *   - `begin(unit, id)` snapshots baseline = `git rev-parse HEAD` UNION
 *     `git status --porcelain`; emits ONE `{event:"start"}` jsonl line.
 *   - `end(unit, id, claimed?)` re-snapshots; delta =
 *     `git diff --name-status <beginHead>` UNION `git status --porcelain`;
 *     classifies diff letters (A→created, M→modified, D→deleted) and
 *     porcelain XY via `classifyPorcelain` (`??`→created, `D*`/`*D`→deleted,
 *     else modified); UNIONs with `dedupePreservingOrder` (first-seen order);
 *     computes `claimedNotChanged` and `changedNotClaimed`; emits ONE
 *     `{event:"end"}` jsonl line; returns the `ChangeRecord`.
 *   - `getRecord(unit, id)` returns the LAST end-record (gate reads crossCheck).
 *   - NEVER throws: any git failure (ENOENT, non-zero exit, non-string stdout,
 *     spawn error, non-git dir) → record carries `{gitUnavailable:true,
 *     gitActual:null, crossCheck:null, verdict:"git-unavailable"}`, method
 *     returns that record without throwing (no block).
 *   - Conservative parse: a claimed file is `claimedNotChanged` ONLY when
 *     gitActual was successfully computed AND the file is absent from
 *     gitActual.created∪modified — ambiguous/unavailable → stays empty.
 *
 * Hermetic: `node:child_process.spawnSync` is mocked so NO real `git` runs.
 * specDir points at a fresh temp directory per test (no shared state).
 *
 * `src/tracking.ts` does NOT exist yet — every import resolves to `undefined`,
 * so every test throws / fails on assertions (intentional RED state).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the ONLY side-effect the tracker performs: spawnSync. Real git must
// never run in CI. The router below feeds scripted rev-parse / status /
// diff stdouts based on argv, and lets us also read the exact spawn argv
// (discrete elements, never shell:true).
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	ChangeTracker,
	type ChangeRecord,
	type StructuredChanges,
	type TrackerUnit,
} from "../src/tracking.ts";
import { dedupePreservingOrder } from "../src/build-runner.ts";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

const WORKTREE = "/fake/worktree";

/** A fresh temp specDir per test so the append-only jsonl never leaks state. */
let specDir: string;
beforeEach(() => {
	spawn.mockReset();
	specDir = fs.mkdtempSync(path.join(os.tmpdir(), "change-tracker-"));
});
afterEach(() => {
	fs.rmSync(specDir, { recursive: true, force: true });
});

/**
 * Program the spawnSync mock to route by argv keyword.
 *   head     → stdout for `git rev-parse HEAD`
 *   diff     → stdout for `git diff --name-status <beginHead>`
 *   porcelain→ stdout for `git status --porcelain`
 */
function git(opts: { head?: string; diff?: string; porcelain?: string }): void {
	spawn.mockImplementation((_cmd: string, args: string[]) => {
		const argv = args as unknown as string[];
		if (argv.includes("rev-parse")) return { status: 0, stdout: opts.head ?? "" };
		if (argv.includes("diff")) return { status: 0, stdout: opts.diff ?? "" };
		if (argv.includes("status")) return { status: 0, stdout: opts.porcelain ?? "" };
		return { status: 0, stdout: "" };
	});
}

/** Make spawn fail for a given argv keyword (non-zero exit / error). */
function gitFails(where: "rev-parse" | "diff" | "status", mode: "nonzero" | "error" | "nonstring" = "nonzero"): void {
	spawn.mockImplementation((_cmd: string, args: string[]) => {
		const argv = args as unknown as string[];
		const hit = argv.includes(where);
		if (hit && mode === "nonzero") return { status: 128, stdout: "", stderr: "fatal" };
		if (hit && mode === "error") return { status: null, stdout: "", error: new Error("ENOENT git") };
		if (hit && mode === "nonstring") return { status: 0, stdout: Buffer.from("not-a-string") };
		// Default success routing for the other keywords.
		if (argv.includes("rev-parse")) return { status: 0, stdout: "abc1234" };
		if (argv.includes("diff")) return { status: 0, stdout: "" };
		if (argv.includes("status")) return { status: 0, stdout: "" };
		return { status: 0, stdout: "" };
	});
}

const TRACKER_JSONL = "change-tracker.jsonl";

/** Read & JSON-parse every non-blank line of the append-only jsonl file. */
function readRecords(): any[] {
	const p = path.join(specDir, TRACKER_JSONL);
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// SCENARIO-004 — git primitives: begin captures the committed ref baseline.
// ---------------------------------------------------------------------------

describe("ChangeTracker — begin captures the git baseline (SCENARIO-004 / AC-01)", () => {
	it("records the beginHead from `git rev-parse HEAD` on the start line", () => {
		git({ head: "deadbeef" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "stage-1");

		const recs = readRecords();
		expect(recs).toHaveLength(1);
		expect(recs[0].event).toBe("start");
		expect(recs[0].unit).toBe("stage");
		expect(recs[0].id).toBe("stage-1");
		expect(recs[0].beginHead).toBe("deadbeef");
	});

	it("supports both `stage` and `phase` TrackerUnit kinds", () => {
		git({ head: "h1" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("phase", "phase-1");
		const recs = readRecords();
		expect(recs[0].unit).toBe("phase");
		expect(recs[0].id).toBe("phase-1");
	});
});

// ---------------------------------------------------------------------------
// SCENARIO-001/002/003 — classification of created/modified/deleted.
// ---------------------------------------------------------------------------

describe("ChangeTracker — classification from `diff --name-status` (SCENARIO-001..003 / AC-01)", () => {
	it("maps diff A→created, M→modified, D→deleted", () => {
		git({
			head: "base",
			diff: "A\tsrc/new.ts\nM\tsrc/mod.ts\nD\tsrc/gone.ts",
		});
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1");
		expect(rec).not.toBeNull();
		expect(rec!.gitActual).not.toBeNull();
		expect(rec!.gitActual!.created).toEqual(["src/new.ts"]);
		expect(rec!.gitActual!.modified).toEqual(["src/mod.ts"]);
		expect(rec!.gitActual!.deleted).toEqual(["src/gone.ts"]);
	});

	it("classifies porcelain XY codes: ?? → created, `D`/` D` → deleted, M/MM → modified", () => {
		git({
			head: "base",
			diff: "",
			porcelain: "?? src/untracked.ts\n D src/wt-deleted.ts\nD  src/ix-deleted.ts\nM  src/ix-mod.ts\n MM src/wt-mod.ts",
		});
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1");
		expect(rec!.gitActual!.created).toEqual(["src/untracked.ts"]);
		expect(rec!.gitActual!.deleted).toEqual(["src/wt-deleted.ts", "src/ix-deleted.ts"]);
		expect(rec!.gitActual!.modified).toEqual(["src/ix-mod.ts", "src/wt-mod.ts"]);
	});

	it("UNIONs committed diff with porcelain via dedupePreservingOrder (first-seen order)", () => {
		// `shared.ts` appears in BOTH committed diff (M) and porcelain (??);
		// it must collapse to ONE entry classified by its first source (diff).
		git({
			head: "base",
			diff: "M\tsrc/shared.ts\nM\tsrc/committed.ts",
			porcelain: "?? src/shared.ts\n?? src/fresh.ts",
		});
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1");
		const all = [...rec!.gitActual!.created, ...rec!.gitActual!.modified, ...rec!.gitActual!.deleted];
		// shared.ts present exactly once across all buckets (deduped), first-seen
		// from the committed diff → classified modified, NOT created.
		expect(all.filter((p) => p === "src/shared.ts")).toHaveLength(1);
		expect(rec!.gitActual!.modified).toContain("src/shared.ts");
		expect(rec!.gitActual!.created).not.toContain("src/shared.ts");
		expect(rec!.gitActual!.created).toEqual(["src/fresh.ts"]);
		expect(rec!.gitActual!.modified).toEqual(["src/shared.ts", "src/committed.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Cross-check split (claimedNotChanged vs changedNotClaimed).
// ---------------------------------------------------------------------------

describe("ChangeTracker — one-directional cross-check (AC-01 / AC-08 precursor)", () => {
	it("puts a claimed-created file git does NOT show into claimedNotChanged", () => {
		// git only created a.ts; agent claims a.ts (real) AND x.ts (a lie).
		git({ head: "base", diff: "A\tsrc/a.ts" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const claimed: StructuredChanges = {
			filesCreated: ["src/a.ts", "src/x.ts"],
			filesModified: [],
			filesDeleted: [],
		};
		const rec = t.end("stage", "s1", claimed);
		expect(rec!.crossCheck).not.toBeNull();
		expect(rec!.crossCheck!.claimedNotChanged).toEqual(["src/x.ts"]);
	});

	it("puts a git-changed file the agent did NOT report into changedNotClaimed (advisory)", () => {
		// git modified b.ts silently; agent reported nothing relevant.
		git({ head: "base", diff: "M\tsrc/b.ts" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1", { filesCreated: [], filesModified: [], filesDeleted: [] });
		expect(rec!.crossCheck!.changedNotClaimed).toEqual(["src/b.ts"]);
		expect(rec!.crossCheck!.claimedNotChanged).toEqual([]);
	});

	it("splits both directions in the same record", () => {
		// git: created a, modified b, deleted c.
		// claim: created a (real), modified x (a lie), deleted c (real).
		//   claimedNotChanged = {a, x} \ {a, b}            = {x}
		//   changedNotClaimed = {a, b, c} \ {a, x, c}       = {b}
		git({ head: "base", diff: "A\tsrc/a.ts\nM\tsrc/b.ts\nD\tsrc/c.ts" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1", {
			filesCreated: ["src/a.ts"],
			filesModified: ["src/x.ts"],
			filesDeleted: ["src/c.ts"],
		});
		expect(rec!.crossCheck!.claimedNotChanged).toEqual(["src/x.ts"]);
		expect(rec!.crossCheck!.changedNotClaimed).toEqual(["src/b.ts"]);
	});

	it("returns empty cross-check buckets when the claim matches git exactly", () => {
		git({ head: "base", diff: "A\tsrc/a.ts\nM\tsrc/b.ts" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1", {
			filesCreated: ["src/a.ts"],
			filesModified: ["src/b.ts"],
			filesDeleted: [],
		});
		expect(rec!.crossCheck!.claimedNotChanged).toEqual([]);
		expect(rec!.crossCheck!.changedNotClaimed).toEqual([]);
		expect(rec!.verdict).toBe("ok");
	});
});

// ---------------------------------------------------------------------------
// SCENARIO-005 — git unavailable: never throws, records gitUnavailable, no block.
// ---------------------------------------------------------------------------

describe("ChangeTracker — git-unavailable never throws (SCENARIO-005 / AC-02)", () => {
	it("records {gitUnavailable:true} + verdict 'git-unavailable' when rev-parse fails (ENOENT)", () => {
		gitFails("rev-parse", "error");
		const t = new ChangeTracker(specDir, WORKTREE);
		expect(() => {
			t.begin("stage", "s1");
		}).not.toThrow();
		const rec = t.end("stage", "s1", { filesCreated: ["src/a.ts"], filesModified: [], filesDeleted: [] });
		expect(rec).not.toBeNull();
		expect(rec!.gitUnavailable).toBe(true);
		expect(rec!.verdict).toBe("git-unavailable");
		expect(rec!.gitActual).toBeNull();
		expect(() => rec).not.toThrow();
	});

	it("records gitUnavailable when diff --name-status exits non-zero", () => {
		gitFails("diff", "nonzero");
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1");
		expect(rec!.gitUnavailable).toBe(true);
		expect(rec!.gitActual).toBeNull();
	});

	it("records gitUnavailable when stdout is not a string", () => {
		gitFails("status", "nonstring");
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1");
		expect(rec!.gitUnavailable).toBe(true);
	});

	it("begin never throws on git failure either", () => {
		gitFails("rev-parse", "error");
		const t = new ChangeTracker(specDir, WORKTREE);
		expect(() => t.begin("stage", "s1")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// SCENARIO-006 — conservative parse: no false claimedNotChanged on ambiguity.
// ---------------------------------------------------------------------------

describe("ChangeTracker — conservative parse avoids false failures (SCENARIO-006 / AC-02)", () => {
	it("leaves crossCheck null when git was unavailable, even with a claim (no false miss)", () => {
		// rev-parse fails → gitUnavailable. Agent claims filesCreated:[src/x.ts].
		// claimedNotChanged must NOT be populated (no false gate block).
		gitFails("rev-parse", "error");
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1", { filesCreated: ["src/x.ts"], filesModified: [], filesDeleted: [] });
		expect(rec!.gitUnavailable).toBe(true);
		expect(rec!.crossCheck).toBeNull();
		// Equivalently: there is no claimedNotChanged array that could block.
		expect(rec!.crossCheck?.claimedNotChanged ?? []).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// SCENARIO-007 — bracketing emits start + end lines; append-only.
// ---------------------------------------------------------------------------

describe("ChangeTracker — bracketing + append-only jsonl (SCENARIO-007 / AC-03)", () => {
	it("emits BOTH a `start` and an `end` jsonl line for one begin/end pair", () => {
		git({ head: "base", diff: "A\tsrc/a.ts" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		t.end("stage", "s1");
		const recs = readRecords();
		expect(recs).toHaveLength(2);
		expect(recs[0].event).toBe("start");
		expect(recs[1].event).toBe("end");
		expect(recs[0].id).toBe("s1");
		expect(recs[1].id).toBe("s1");
	});

	it("appends multiple events without overwriting earlier ones", () => {
		git({ head: "base", diff: "A\tsrc/a.ts" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		t.end("stage", "s1");
		t.begin("phase", "phase-1");
		t.end("phase", "phase-1");
		const recs = readRecords();
		// 4 lines total, in order: start s1, end s1, start phase-1, end phase-1.
		expect(recs).toHaveLength(4);
		expect(recs.map((r) => `${r.unit}:${r.id}:${r.event}`).join("|")).toBe(
			"stage:s1:start|stage:s1:end|phase:phase-1:start|phase:phase-1:end",
		);
	});

	it("writes to <specDir>/change-tracker.jsonl (exact path contract)", () => {
		git({ head: "base" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		expect(fs.existsSync(path.join(specDir, TRACKER_JSONL))).toBe(true);
	});

	it("every record carries an ISO-ish `ts` timestamp string", () => {
		git({ head: "base" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		const rec = t.end("stage", "s1");
		expect(typeof rec!.ts).toBe("string");
		expect(rec!.ts.length).toBeGreaterThan(0);
		expect(Number.isNaN(Date.parse(rec!.ts))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getRecord(unit, id) — last end-record lookup (gate reads crossCheck).
// ---------------------------------------------------------------------------

describe("ChangeTracker — getRecord returns the last end-record", () => {
	it("returns the end record (with crossCheck) for a completed unit", () => {
		git({ head: "base", diff: "A\tsrc/a.ts" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		t.end("stage", "s1", { filesCreated: ["src/a.ts"], filesModified: [], filesDeleted: [] });
		const rec = t.getRecord("stage", "s1");
		expect(rec).not.toBeNull();
		expect(rec!.event).toBe("end");
		expect(rec!.crossCheck).not.toBeNull();
	});

	it("returns null for a unit that was never ended", () => {
		git({ head: "base" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("stage", "s1");
		expect(t.getRecord("stage", "s1")).toBeNull();
		expect(t.getRecord("stage", "never")).toBeNull();
	});

	it("returns the LATEST end record when a unit was ended multiple times", () => {
		git({ head: "base", diff: "A\tsrc/a.ts" });
		const t = new ChangeTracker(specDir, WORKTREE);
		t.begin("phase", "p1");
		t.end("phase", "p1", { filesCreated: ["src/a.ts"], filesModified: [], filesDeleted: [] });
		// Second pass changes git output.
		git({ head: "base", diff: "A\tsrc/a.ts\nM\tsrc/b.ts" });
		t.begin("phase", "p1");
		t.end("phase", "p1", {
			filesCreated: ["src/a.ts"],
			filesModified: ["src/b.ts"],
			filesDeleted: [],
		});
		const rec = t.getRecord("phase", "p1");
		expect(rec!.gitActual!.modified).toContain("src/b.ts");
	});
});

// ---------------------------------------------------------------------------
// dedupePreservingOrder export contract (Phase 1 reuse deliverable).
// ---------------------------------------------------------------------------

describe("dedupePreservingOrder is exported from build-runner.ts (Phase 1 reuse)", () => {
	it("is an exported function preserving first-seen order", () => {
		expect(typeof dedupePreservingOrder).toBe("function");
		expect(dedupePreservingOrder(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
	});
});
