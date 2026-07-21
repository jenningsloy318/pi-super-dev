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
import type { ChangeRecord } from "../src/tracking.ts";

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
