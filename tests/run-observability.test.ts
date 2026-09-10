/**
 * v0.3.85 S3 — run-health counter DERIVATION (evolution/run-observability.ts).
 *
 * The meters must be wired to the territory (constitution §8.3: every
 * cross-module contract has a health counter in run-metrics): judge outcomes
 * fold from the events.jsonl rows runJudge double-writes, phase truth from
 * state.implementation.phaseStatus, inherited-red from the spec-dir ledgers —
 * all windowed to THIS run pass. The C2 lesson drives the honest-zero
 * contract: absent data = 0 with the counter PRESENT, never a missing key.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunEvent } from "../src/runlog.ts";
import { deriveS3Counters, runPassStartedAt } from "../src/evolution/run-observability.ts";
import { REPLAN_REQUESTS_FILE } from "../src/replan/replan.ts";
import { appendInheritedRedEvent } from "../src/stages/inherited-red.ts";

const dirs: string[] = [];
function mkSpecDir(): string {
	const d = mkdtempSync(join(tmpdir(), "sd-s3-"));
	dirs.push(d);
	return d;
}

beforeEach(() => {
	for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } }
});

/** Real ledger writes — the same writers production uses. */
const judgeEvent = (specDir: string, runId: string, status: string) =>
	appendRunEvent(specDir, { runId, agent: "judge", type: "judge.called", data: { scope: "stage9.x", status } });

describe("v0.3.85 S3 — deriveS3Counters", () => {
	it("judgeAccepted/judgeDiscarded fold judge.called rows for THIS runId only; escalate/degraded are neither", () => {
		const dir = mkSpecDir();
		appendRunEvent(dir, { runId: "run-1", type: "run.started", data: { task: "t", version: "v" } });
		judgeEvent(dir, "run-1", "routed");      // accepted
		judgeEvent(dir, "run-1", "routed");      // accepted (2)
		judgeEvent(dir, "run-1", "discarded");   // discarded
		judgeEvent(dir, "run-1", "escalate");    // diagnosis preserved — NOT a discard
		judgeEvent(dir, "run-1", "degraded");    // INV-6 infrastructure — neither class
		judgeEvent(dir, "run-0", "routed");      // a PRIOR pass — must not count
		judgeEvent(dir, "run-0", "discarded");
		const c = deriveS3Counters({ runId: "run-1", specDirectory: dir, implementation: undefined });
		expect(c.judgeAccepted).toBe(2);
		expect(c.judgeDiscarded).toBe(1);
	});

	it("partialPhases counts partial phaseStatus rows; maxPhaseAttempts is the PEAK attempts (missing → 0)", () => {
		const dir = mkSpecDir();
		const impl = { phaseStatus: [
			{ id: "phase-01", status: "green", attempts: 1 },
			{ id: "phase-02", status: "partial", attempts: 2 },
			{ id: "phase-03", status: "partial" },           // attempts absent → contributes 0
			{ id: "phase-04", status: "partial", attempts: 4 }, // the peak
		] };
		const c = deriveS3Counters({ runId: "r", specDirectory: dir, implementation: impl });
		expect(c.partialPhases).toBe(3);
		expect(c.maxPhaseAttempts).toBe(4);
	});

	it("inheritedRedHandoffs counts source:inherited-red rows created at/after THIS run's started event (prior passes excluded)", () => {
		const dir = mkSpecDir();
		mkdirSync(dir, { recursive: true });
		// Prior pass: handoff row from an earlier run + its run.started bracket.
		appendRunEvent(dir, { runId: "run-old", type: "run.started", data: { task: "t", version: "v" } });
		// This pass (its bracket timestamps NOW — the seeded rows use unambiguous
		// far-past / far-future createdAt so the window comparison is deterministic).
		appendRunEvent(dir, { runId: "run-new", type: "run.started", data: { task: "t", version: "v" } });
		writeFileSync(join(dir, REPLAN_REQUESTS_FILE), JSON.stringify({
			version: 1, rounds: 1,
			requests: [
				{ id: "old", source: "inherited-red", status: "addressed", createdAt: "2000-01-01T00:00:00.000Z", fingerprint: "f1" }, // prior pass — windowed out
				{ id: "other", source: "red-weakening", status: "pending", createdAt: "2999-01-01T00:00:00.000Z", fingerprint: "f2" }, // different source tag — never counted
				{ id: "new", source: "inherited-red", status: "pending", createdAt: "2999-01-01T00:00:00.000Z", fingerprint: "f3" }, // THIS pass
			],
		}));
		const c = deriveS3Counters({ runId: "run-new", specDirectory: dir, implementation: undefined });
		expect(c.inheritedRedHandoffs).toBe(1);
	});

	it("inheritedRedOccurrences windows the .inherited-red.jsonl occurrence tally to this pass (survived-Tier-0+1 semantics)", () => {
		const dir = mkSpecDir();
		appendRunEvent(dir, { runId: "run-1", type: "run.started", data: { task: "t", version: "v" } });
		// A prior-pass occurrence (explicit EARLIER ts — the writer always stamps
		// NOW, which is >= run start), then this pass's occurrence + a flake row
		// (flake-rerun is NOT an occurrence — it never reaches the Tier-2 decision).
		writeFileSync(join(dir, ".inherited-red.jsonl"), JSON.stringify({ ts: "2000-01-01T00:00:00.000Z", event: "occurrence", phaseId: "phase-01", outcome: "tier3-fatal" }) + "\n");
		appendInheritedRedEvent(dir, { event: "occurrence", phaseId: "phase-02", outcome: "tier2-handoff-routed" });
		appendInheritedRedEvent(dir, { event: "flake-rerun", phaseId: "phase-02", outcome: "still-red" });
		const c = deriveS3Counters({ runId: "run-1", specDirectory: dir, implementation: undefined });
		expect(c.inheritedRedOccurrences).toBe(1); // the this-pass occurrence; flake-rerun never counts
	});

	it("degraded fallback: no run.started bracket → the inherited-red counters report the LIFETIME tally (documented approximation)", () => {
		const dir = mkSpecDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, REPLAN_REQUESTS_FILE), JSON.stringify({
			version: 1, rounds: 0,
			requests: [{ id: "a", source: "inherited-red", status: "pending", createdAt: "2026-09-09T10:00:00.000Z", fingerprint: "f" }],
		}));
		writeFileSync(join(dir, ".inherited-red.jsonl"), JSON.stringify({ ts: "2000-01-01T00:00:00.000Z", event: "occurrence", phaseId: "phase-01", outcome: "tier2-handoff-routed" }) + "\n");
		const c = deriveS3Counters({ runId: "run-x", specDirectory: dir, implementation: undefined });
		expect(c.inheritedRedHandoffs).toBe(1);
		expect(c.inheritedRedOccurrences).toBe(1);
	});

	it("honest zero: absent spec dir / absent ledgers / absent state → every counter PRESENT as 0 (the C2 lesson)", () => {
		const c = deriveS3Counters({ runId: "r", specDirectory: undefined, implementation: undefined });
		expect(c).toEqual({ judgeAccepted: 0, judgeDiscarded: 0, partialPhases: 0, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0, maxPhaseAttempts: 0 });
		const empty = deriveS3Counters({ runId: "r", specDirectory: mkSpecDir(), implementation: undefined });
		expect(empty).toEqual({ judgeAccepted: 0, judgeDiscarded: 0, partialPhases: 0, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0, maxPhaseAttempts: 0 });
	});

	it("runPassStartedAt returns THIS runId's bracket ('' when absent)", () => {
		const dir = mkSpecDir();
		appendRunEvent(dir, { runId: "a", type: "run.started", data: { task: "t", version: "v" } });
		appendRunEvent(dir, { runId: "b", type: "run.started", data: { task: "t", version: "v" } });
		expect(runPassStartedAt(dir, "b")).not.toBe("");
		expect(runPassStartedAt(dir, "a")).not.toBe("");
		expect(runPassStartedAt(dir, "missing")).toBe("");
	});
});
