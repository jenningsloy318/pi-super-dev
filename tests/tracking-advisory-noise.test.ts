/**
 * changed-not-claimed advisory noise (run 2026-08-27T12-33-43-088Z).
 *
 * The advisory fired 3x/run listing ~23 files that are almost entirely
 * super-dev's OWN bookkeeping (.knowledge.json, events.jsonl, .judge.jsonl,
 * escalation reports, spec-dir artifacts) — alert fatigue that buried the one
 * signal that mattered (gate-baseline.json). Harness-owned paths are excluded
 * from the ADVISORY only; claimedNotChanged (the false-green killer) stays
 * strict.
 */
import { describe, it, expect } from "vitest";
import { isHarnessBookkeepingPath, filterChangedNotClaimedNoise } from "../src/tracking.ts";

describe("isHarnessBookkeepingPath", () => {
	it("recognizes super-dev's own run/spec artifacts wherever they live", () => {
		for (const p of [
			".knowledge.json",
			"docs/specifications/02-x/.knowledge.json",
			".user-notes.json",
			".judge.jsonl",
			"events.jsonl",
			"docs/specifications/02-x/events.jsonl",
			"change-tracker.jsonl",
			"implementation-evidence.jsonl",
			".resume-cache.jsonl",
			".run-lock",
			"escalation-report.md",
			"docs/specifications/02-x/escalation-report-31701-1.md",
		]) expect(isHarnessBookkeepingPath(p), p).toBe(true);
	});
	it("does NOT swallow REAL project files (the signal that matters)", () => {
		for (const p of ["index.html", "src/main.js", "gate-baseline.json", "docs/README.md"]) expect(isHarnessBookkeepingPath(p), p).toBe(false);
	});
});

describe("filterChangedNotClaimedNoise", () => {
	it("drops bookkeeping, keeps real deliverables, order preserved", () => {
		const out = filterChangedNotClaimedNoise([".knowledge.json", "index.html", "events.jsonl", "src/main.js"]);
		expect(out).toEqual(["index.html", "src/main.js"]);
	});
});
