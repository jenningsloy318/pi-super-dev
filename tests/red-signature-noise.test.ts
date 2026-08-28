import { describe, expect, it } from "vitest";
import { redEvidenceSignature } from "../src/stages/implementation.ts";

/** Structural stand-in for the module-private RedEvidence interface — the
 * signature function only reads these fields. */
type RedEvidenceLike = Parameters<typeof redEvidenceSignature>[0];

// ─── v0.3.24 S4-2 ─────────────────────────────────────────────────────────────
// Run 12-51-40: redEvidenceSignature includes raw changedFiles from git status,
// and the harness's own implementation-evidence.jsonl (appended after every
// RED try inside the worktree's spec dir) drifts into changedFiles — so every
// try's signature is unique, the repeated-signature escape never fires, and
// the judge / allow-scaffold path is never consulted until the 6-try ceiling.
// These tests pin a noise-free signature: runtime-evidence and spec-dir paths
// must not participate.

function baseEvidence(overrides: Partial<RedEvidenceLike> = {}): RedEvidenceLike {
	return {
		phaseId: "phase-01",
		attempt: 1,
		status: "red-behavior-failure",
		oracleStatus: "red",
		testFiles: ["app/src/test/java/dev/FooTest.kt"],
		changedFiles: ["app/src/main/java/dev/Foo.kt"],
		forbiddenFiles: [],
		coveredScenarios: ["SCENARIO-001"],
		missingScenarios: [],
		redRetries: 0,
		reason: "14/14 failing",
		diagnostics: [],
		...overrides,
	};
}

describe("S4-2 redEvidenceSignature is noise-free for harness bookkeeping", () => {
	it("implementation-evidence.jsonl in changedFiles does not change the signature", () => {
		const clean = redEvidenceSignature(baseEvidence());
		const noisy = redEvidenceSignature(baseEvidence({
			changedFiles: ["app/src/main/java/dev/Foo.kt", "docs/specifications/17-x/implementation-evidence.jsonl"],
		}));
		expect(noisy).toBe(clean);
	});

	it(".judge.jsonl / .resume-cache.jsonl / change-tracker.jsonl are excluded too", () => {
		const clean = redEvidenceSignature(baseEvidence());
		const noisy = redEvidenceSignature(baseEvidence({
			changedFiles: [
				"app/src/main/java/dev/Foo.kt",
				"docs/specifications/17-x/.judge.jsonl",
				"docs/specifications/17-x/.resume-cache.jsonl",
				"docs/specifications/17-x/change-tracker.jsonl",
			],
		}));
		expect(noisy).toBe(clean);
	});

	it("REAL source changes still change the signature (no over-filtering)", () => {
		const a = redEvidenceSignature(baseEvidence());
		const b = redEvidenceSignature(baseEvidence({ changedFiles: ["app/src/main/java/dev/Foo.kt", "app/src/main/java/dev/Bar.kt"] }));
		expect(b).not.toBe(a);
	});

	it("status/oracle differences still change the signature", () => {
		const a = redEvidenceSignature(baseEvidence());
		const b = redEvidenceSignature(baseEvidence({ status: "polluted-red", forbiddenFiles: ["app/src/main/java/dev/Foo.kt"] }));
		expect(b).not.toBe(a);
	});
});
