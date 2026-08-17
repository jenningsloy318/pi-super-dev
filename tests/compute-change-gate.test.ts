/**
 * Phase 4 — `computeChangeGate` pure unit tests (AC-07, AC-08 → SCENARIO-013,
 * SCENARIO-014, SCENARIO-016, SCENARIO-017).
 *
 * `computeChangeGate(rec)` is the never-throwing gate helper co-located with
 * the other deterministic gates in `src/build-runner.ts`. It collapses a
 * tracker `ChangeRecord` (the phase end-record carrying the git cross-check)
 * into a boolean gate verdict:
 *
 *   { pass: boolean; claimedNotChanged: string[] }
 *
 * Contract (the false-green killer, AC-08):
 *   - `pass === false` iff `rec != null && !rec.gitUnavailable &&
 *     (rec.crossCheck?.claimedNotChanged?.length ?? 0) > 0` — a created/
 *     modified claim git does NOT show.
 *   - `changedNotClaimed` is ADVISORY-only: it NEVER affects `pass`
 *     (SCENARIO-014 — under-reporting is not a false-green).
 *   - `gitUnavailable` (or no tracker → `rec === null`) → `pass = true`
 *     (don't block on infrastructure, SCENARIO-017).
 *   - No claimed changes → `claimedNotChanged` empty → `pass = true`
 *     (SCENARIO-016, trivial pass).
 *   - NEVER throws (defensive against a malformed record).
 *
 * Pure: no mocks, no git, no filesystem — only hand-built `ChangeRecord`
 * fixtures. Independent of the implementation.ts wiring (covered by
 * `tests/implementation-crosscheck-gate.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { computeChangeGate } from "../src/build-runner.ts";
import { ChangeTracker, type ChangeRecord } from "../src/tracking.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

/** Build a `ChangeRecord` with sensible defaults overridden by `over`. */
function rec(over: Partial<ChangeRecord>): ChangeRecord {
	return {
		unit: "phase",
		id: "phase-01",
		event: "end",
		ts: "2026-07-21T00:00:00.000Z",
		beginHead: "abc123",
		endHead: "def456",
		gitActual: { created: [], modified: [], deleted: [] },
		claimed: { filesCreated: [], filesModified: [], filesDeleted: [] },
		crossCheck: null,
		verdict: "ok",
		...over,
	};
}

describe("computeChangeGate — gate verdict from a tracker record (AC-07/AC-08)", () => {
	it("SCENARIO-016: null record (no tracker / never ended) → trivial pass", () => {
		const g = computeChangeGate(null);
		expect(g.pass).toBe(true);
		expect(g.claimedNotChanged).toEqual([]);
	});

	it("SCENARIO-017: gitUnavailable record → pass (infrastructure never blocks)", () => {
		const g = computeChangeGate(
			rec({ gitUnavailable: true, crossCheck: null, verdict: "git-unavailable" }),
		);
		expect(g.pass).toBe(true);
		expect(g.claimedNotChanged).toEqual([]);
	});

	it("SCENARIO-016b: record present but crossCheck null → pass", () => {
		const g = computeChangeGate(rec({ crossCheck: null }));
		expect(g.pass).toBe(true);
		expect(g.claimedNotChanged).toEqual([]);
	});

	it("SCENARIO-016c: crossCheck present but claimedNotChanged empty → pass", () => {
		const g = computeChangeGate(
			rec({
				crossCheck: { claimedNotChanged: [], changedNotClaimed: ["src/orphan.ts"] },
			}),
		);
		expect(g.pass).toBe(true);
		expect(g.claimedNotChanged).toEqual([]);
	});

	it("SCENARIO-013: claimedNotChanged non-empty + git available → FAIL (the false-green killer)", () => {
		const g = computeChangeGate(
			rec({
				crossCheck: { claimedNotChanged: ["src/x.ts"], changedNotClaimed: [] },
			}),
		);
		expect(g.pass).toBe(false);
		expect(g.claimedNotChanged).toEqual(["src/x.ts"]);
	});

	it("SCENARIO-013b: claimedNotChanged non-empty BUT gitUnavailable → still pass (infra trumps miss)", () => {
		// Git could not be queried, so the cross-check is unreliable → never block.
		const g = computeChangeGate(
			rec({
				gitUnavailable: true,
				verdict: "git-unavailable",
				crossCheck: { claimedNotChanged: ["src/x.ts"], changedNotClaimed: [] },
			}),
		);
		expect(g.pass).toBe(true);
	});

	it("SCENARIO-014: changedNotClaimed present but claimedNotChanged empty → pass (advisory-only)", () => {
		const g = computeChangeGate(
			rec({
				crossCheck: { claimedNotChanged: [], changedNotClaimed: ["src/unreported.ts"] },
			}),
		);
		// Under-reporting is advisory-only and must NOT fail the gate.
		expect(g.pass).toBe(true);
		expect(g.claimedNotChanged).toEqual([]);
	});

	it("never throws on a malformed record (defensive — untrusted agent output)", () => {
		// crossCheck is a non-null object missing claimedNotChanged entirely.
		const g = computeChangeGate(rec({ crossCheck: {} as never }));
		expect(() => computeChangeGate(rec({ crossCheck: {} as never }))).not.toThrow();
		expect(g.pass).toBe(true);
		expect(g.claimedNotChanged).toEqual([]);
	});

	it("returns claimedNotChanged verbatim from a populated cross-check", () => {
		const claimed = ["src/a.ts", "src/b.ts", "src/c.ts"];
		const g = computeChangeGate(
			rec({ crossCheck: { claimedNotChanged: claimed, changedNotClaimed: [] } }),
		);
		expect(g.pass).toBe(false);
		expect(g.claimedNotChanged).toEqual(claimed);
	});
});

// ---------------------------------------------------------------------------
// AC-32 / SCENARIO-065/066 (spec-28) — a gitignored-but-PRESENT claimed file
// downgrades from `claimedNotChanged` (gate-fatal) to an ADVISORY
// `ignoredVerified` list on the cross-check record. Existence is verified on
// disk (`git check-ignore` exit 0 alone is NOT enough — an absent file proves
// nothing). A TRACKED, non-ignored unchanged claim remains a claimed-miss
// (no false-green). REAL git fixtures: the observable is git's own
// check-ignore/status/diff behavior.
// ---------------------------------------------------------------------------

const sh = (cwd: string, cmd: string): string => {
	try { return execSync(cmd, { cwd, encoding: "utf8" }); } catch { return ""; }
};

/** A real repo with `.gitignore`d `public/schema.json`, a tracked base file,
 *  and one base commit. */
function gitignoredRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "sd-ignored-claim-"));
	sh(root, "git init -b main");
	sh(root, "git config user.email t@t && git config user.name t");
	writeFileSync(join(root, ".gitignore"), "public/schema.json\n");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "existing.ts"), "export const x = 1;\n");
	writeFileSync(join(root, "base.txt"), "base\n");
	sh(root, "git add .gitignore src/existing.ts base.txt && git commit -m base");
	return root;
}

function endClaim(root: string, claimed: { filesCreated: string[]; filesModified: string[]; filesDeleted: string[] }): ChangeRecord | null {
	const tracker = new ChangeTracker(join(root, "tmp-spec"), root);
	tracker.begin("phase", "phase-01");
	return tracker.end("phase", "phase-01", claimed);
}

describe("computeCrossCheck ignoredVerified advisory (AC-32, SCENARIO-065/066)", () => {
	it("SCENARIO-065: a gitignored-but-present claimed file lands in ignoredVerified, never claimedNotChanged — verdict ok", () => {
		const root = gitignoredRepo();
		try {
			// premise: the path is genuinely ignored by this repo's rules
			expect(sh(root, "git check-ignore -- public/schema.json; echo $?" ).trim().endsWith("0")).toBe(true);
			mkdirSync(join(root, "public"), { recursive: true });
			writeFileSync(join(root, "public", "schema.json"), "{}\n");
			const rec = endClaim(root, { filesCreated: ["public/schema.json"], filesModified: [], filesDeleted: [] });
			expect(rec!.crossCheck).not.toBeNull();
			expect(rec!.crossCheck!.claimedNotChanged).toEqual([]);
			expect(rec!.crossCheck!.ignoredVerified).toEqual(["public/schema.json"]);
			expect(rec!.verdict).toBe("ok");
			// the gate no longer fails on the ignored claim's account
			expect(computeChangeGate(rec).pass).toBe(true);
			expect(computeChangeGate(rec).claimedNotChanged).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("SCENARIO-066: a tracked, non-ignored, unchanged claim remains claimed-miss (no false-green)", () => {
		const root = gitignoredRepo();
		try {
			// src/existing.ts exists on disk, is tracked, and was NOT changed.
			const rec = endClaim(root, { filesCreated: ["src/existing.ts"], filesModified: [], filesDeleted: [] });
			expect(rec!.crossCheck!.claimedNotChanged).toEqual(["src/existing.ts"]);
			expect(rec!.crossCheck!.ignoredVerified ?? []).toEqual([]);
			expect(rec!.verdict).toBe("claimed-miss");
			expect(computeChangeGate(rec).pass).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("existence-guard: a gitignored claim whose file is ABSENT stays claimed-miss (check-ignore alone proves nothing)", () => {
		const root = gitignoredRepo();
		try {
			// public/schema.json matches the ignore rule but was never written.
			const rec = endClaim(root, { filesCreated: ["public/schema.json"], filesModified: [], filesDeleted: [] });
			expect(rec!.crossCheck!.claimedNotChanged).toEqual(["public/schema.json"]);
			expect(rec!.crossCheck!.ignoredVerified ?? []).toEqual([]);
			expect(rec!.verdict).toBe("claimed-miss");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a REAL git change is never demoted: an ignored file the agent ALSO tracked via a committed diff stays a normal match", () => {
		const root = gitignoredRepo();
		try {
			mkdirSync(join(root, "public"), { recursive: true });
			writeFileSync(join(root, "public", "schema.json"), "{}\n");
			// Open the bracket BEFORE the force-add commit so the committed diff
			// inside the bracket shows the path: git's diff DOES report it changed,
			// so the claim matches through the normal path — the advisory never
			// overrides real git evidence.
			const tracker = new ChangeTracker(join(root, "tmp-spec"), root);
			tracker.begin("phase", "phase-01");
			sh(root, "git add -f public/schema.json && git commit -m force");
			const rec = tracker.end("phase", "phase-01", { filesCreated: ["public/schema.json"], filesModified: [], filesDeleted: [] });
			expect(rec!.crossCheck!.claimedNotChanged).toEqual([]);
			expect(rec!.crossCheck!.ignoredVerified ?? []).toEqual([]);
			expect(rec!.verdict).toBe("ok");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
