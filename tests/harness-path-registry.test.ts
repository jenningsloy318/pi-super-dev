/**
 * v0.3.74 P1-a — single canonical harness-file registry (M6 class).
 *
 * Run 2026-09-05T23-09-55-596Z root: the harness's own bookkeeping basenames
 * were declared in FOUR parallel Set literals across TWO files (tracking.ts ×2,
 * test-artifacts.ts ×2). `events.jsonl` sat in one list and not another — the
 * drift fired twice as red-polluted retries. This suite pins the consolidated
 * `HARNESS_FILE_ROLES` registry as the single source of truth:
 *
 *   1. Golden-set equality — every basename of every pre-refactor list must be
 *      present in the registry under the right role flags, and the derived
 *      membership must reproduce the consumers' classification behavior.
 *   2. No-drift source contract — the consumers declare NO basename Set
 *      literals of their own anymore; a new bookkeeping file that misses the
 *      registry cannot silently regress into the four-list world.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_FILE_ROLES } from "../src/harness-paths.ts";
import { isRuntimeEvidencePath, isSpecScopedRuntimeEvidencePath } from "../src/test-artifacts.ts";
import { isHarnessBookkeepingPath, isInternalRuntimeClaim } from "../src/tracking.ts";

// ── Golden sets — captured verbatim from the four pre-refactor literals ──────

const GOLDEN_RED_BOUNDARY_ANYWHERE = [
	"implementation-evidence.jsonl",
	"change-tracker.jsonl",
	".resume-cache.jsonl",
	".user-notes.json",
	".judge.jsonl",
	"test-runner.json",
	"stagnation-report.md",
	"escalation-report.md",
	"escalation-report-stagnation.md",
	"api-test-report.md",
	"ui-test-report.md",
] as const;

const GOLDEN_RED_BOUNDARY_SPEC_SCOPED = [
	"events.jsonl",
	"run-metrics.jsonl",
	"audit.jsonl",
	"routing-journal.jsonl",
	"routing-epoch.json",
	"replan-requests.json",
	"artifact-revisions.json",
	"completion-audit.md",
] as const;

const GOLDEN_TRACKER_ADVISORY_NOISE = [
	".knowledge.json",
	".user-notes.json",
	".judge.jsonl",
	"events.jsonl",
	"change-tracker.jsonl",
	"implementation-evidence.jsonl",
	"escalation-report.md",
] as const;

const GOLDEN_INTERNAL_RUNTIME_CLAIM = [".resume-cache.jsonl", ".run-lock"] as const;

const GOLDEN_SPEC_DIR_BOOKKEEPING = [
	"events.jsonl",
	"change-tracker.jsonl",
	"implementation-evidence.jsonl",
	".resume-cache.jsonl",
	".judge.jsonl",
	".knowledge.json",
	".run-lock",
	".convergence-ledger.json",
	"completion-audit.md",
	"test-runner.json",
] as const;

const GOLDEN_PHASE_COMMIT_EXCLUDED = [".judge.jsonl", "test-runner.json"] as const;

const roleNames = (flag: keyof (typeof HARNESS_FILE_ROLES)[string]): string[] =>
	Object.entries(HARNESS_FILE_ROLES)
		.filter(([, roles]) => roles[flag])
		.map(([name]) => name)
		.sort();

describe("v0.3.74 P1-a — harness-file registry is the single source of truth", () => {
	it("registry flags reproduce the pre-refactor any-path RED-boundary list (golden)", () => {
		expect(roleNames("redBoundaryAnywhere")).toEqual([...GOLDEN_RED_BOUNDARY_ANYWHERE].sort());
	});

	it("registry flags reproduce the pre-refactor spec-scoped RED-boundary list (golden)", () => {
		expect(roleNames("redBoundarySpecScoped")).toEqual([...GOLDEN_RED_BOUNDARY_SPEC_SCOPED].sort());
	});

	it("registry flags reproduce the pre-refactor tracker advisory-noise list (golden)", () => {
		expect(roleNames("trackerAdvisoryNoise")).toEqual([...GOLDEN_TRACKER_ADVISORY_NOISE].sort());
	});

	it("registry flags reproduce the pre-refactor internal-runtime-claim list (golden)", () => {
		expect(roleNames("internalRuntimeClaim")).toEqual([...GOLDEN_INTERNAL_RUNTIME_CLAIM].sort());
	});

	it("registry flags reproduce helpers.ts's spec-dir bookkeeping list (golden — dual review F3)", () => {
		expect(roleNames("specDirBookkeeping")).toEqual([...GOLDEN_SPEC_DIR_BOOKKEEPING].sort());
	});

	it("registry flags reproduce the phase-commit exclusion list (golden — dual review F3)", () => {
		expect(roleNames("phaseCommitExcluded")).toEqual([...GOLDEN_PHASE_COMMIT_EXCLUDED].sort());
	});

	it("consumers classify every golden basename per its registry role (behavior)", () => {
		for (const name of GOLDEN_RED_BOUNDARY_ANYWHERE) {
			expect(isRuntimeEvidencePath(`pkg/deep/${name}`), name).toBe(true);
		}
		for (const name of GOLDEN_RED_BOUNDARY_SPEC_SCOPED) {
			expect(isSpecScopedRuntimeEvidencePath(`docs/specifications/spec-x/${name}`), name).toBe(true);
			// Position-aware: the same basename OUTSIDE the spec tree stays production.
			expect(isSpecScopedRuntimeEvidencePath(`src/${name}`), name).toBe(false);
		}
		for (const name of GOLDEN_TRACKER_ADVISORY_NOISE) {
			expect(isHarnessBookkeepingPath(`docs/specifications/spec-x/${name}`), name).toBe(true);
		}
		for (const name of GOLDEN_INTERNAL_RUNTIME_CLAIM) {
			expect(isInternalRuntimeClaim(name), name).toBe(true);
		}
	});

	it("a name absent from the registry is NOT exempted anywhere (fail-closed default)", () => {
		expect(isRuntimeEvidencePath("src/production-data.jsonl")).toBe(false);
		expect(isSpecScopedRuntimeEvidencePath("docs/specifications/x/production-data.jsonl")).toBe(false);
		// (isHarnessBookkeepingPath exempts the WHOLE docs/specifications/ tree by
		// prefix — registry-independent by design — so probe it OUTSIDE the tree.)
		expect(isHarnessBookkeepingPath("pkg/production-data.jsonl")).toBe(false);
		expect(isInternalRuntimeClaim("production-data.jsonl")).toBe(false);
	});

	it("no-drift source contract: consumers declare no basename Set literals of their own", () => {
		// v0.3.74 dual review F3: the scan covers ALL FOUR consumer files —
		// helpers.ts (fifth literal) and implementation.ts (sixth) had survived
		// the two-file scan while claiming the class was dead.
		for (const rel of ["../src/test-artifacts.ts", "../src/tracking.ts", "../src/helpers.ts", "../src/stages/implementation.ts"]) {
			const src = readFileSync(join(import.meta.dirname, rel), "utf8");
			expect(src.includes("BASENAMES = new Set("), `${rel} must derive its basename sets from harness-paths.ts`).toBe(false);
			expect(src.includes("HARNESS_BOOKKEEPING_FILES = new Set(["), `${rel} must derive its basename sets from harness-paths.ts`).toBe(false);
		}
	});
});
