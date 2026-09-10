/**
 * v0.3.85 F2/F4 — pure predicates + ledger + sub-cap accounting for the
 * inherited-red tier ladder (tests/inherited-red.test.ts).
 *
 * Covers (per §9 F2+F4, §10 decision 3, §13, §14 ADR 8/9):
 *   - the Tier-0 attribution truth table (preexisting → inherited;
 *     regression + pre-phase dirt → inherited; regression + clean-at-start →
 *     own-leak; unknown/absent → not-evaluable);
 *   - the boundary SHAPE truth table (gate-blocking, out-of-scope-only,
 *     baselineCheck present, own-scope green, coverage not blocking, failing
 *     subjects outside the declared targets; the documented no-extractable-
 *     path fallback);
 *   - the F4 Option-C scope predicate (arm A clause files, arm B structured
 *     failing-test record, arm B containment fallback, no-prior-partial,
 *     converged-phase exclusion, current-phase exclusion);
 *   - the append-only ledger (occurrence tally, flake tally);
 *   - the replan-requests sub-cap counting (ANY status; pending-only probe)
 *     and the optional source/sourcePhase/handoffArm row fields riding the
 *     existing triggerReplanForFindings circuit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildGateResult } from "../src/build-runner.ts";
import { BASELINE_VERIFY_ERROR_PREFIX } from "../src/build-runner/gates.ts";
import {
	INHERITED_RED_SOURCE,
	appendInheritedRedEvent,
	countInheritedRedOccurrences,
	extractFailingTestFilePaths,
	f4ScopeMatch,
	inheritedRedAttribution,
	inheritedRedBoundaryShape,
	inheritedRedFlakeTally,
	normalizeRepoPath,
	readInheritedRedEvents,
} from "../src/stages/inherited-red.ts";
import { countInheritedRedRows, pendingInheritedRedRows, REPLAN_REQUESTS_FILE, triggerReplanForFindings } from "../src/replan/replan.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

const OWN_SCOPE_GREEN = { deliverablePass: true, changePass: true, symbolPass: true, tddClean: true };

const CENSUS_BLOCK = "FAIL tests/census-mirror.test.ts\nError: census lockstep violated — mirrors must amend atomically";
const SYNTHETIC = `${BASELINE_VERIFY_ERROR_PREFIX} npm run test (whole suite) PASSES at baseline abc123 — the failure is new on this branch`;

function mkGate(overrides: Partial<BuildGateResult> = {}): BuildGateResult {
	return {
		pass: false,
		buildSuccess: false,
		allTestsPass: false,
		typecheckSuccess: false,
		inScopePass: false,
		ran: ["mock"],
		errors: [CENSUS_BLOCK, SYNTHETIC],
		outOfScopeErrors: [CENSUS_BLOCK],
		baselineCheck: { status: "regression", evidence: "whole suite PASSES at baseline abc123" },
		...overrides,
	};
}

const scope = (paths: string[]) => new Set(paths.map(normalizeRepoPath));

// ─── Tier-0 attribution truth table ────────────────────────────────────────

describe("F2 inheritedRedAttribution — the Tier-0 dirt-provenance truth table", () => {
	it("preexisting → inherited even with zero dirt (a merge-base repo red still propagates — grill pass 2)", () => {
		expect(inheritedRedAttribution({ baselineStatus: "preexisting", prePhaseDirt: [], ownLeakPaths: [] })).toBe("inherited");
		expect(inheritedRedAttribution({ baselineStatus: "preexisting", prePhaseDirt: ["tests/census-mirror.test.ts"], ownLeakPaths: [] })).toBe("inherited");
	});

	it("regression + pre-phase dirt → inherited (the failure is not attributable to this phase's edits)", () => {
		expect(inheritedRedAttribution({ baselineStatus: "regression", prePhaseDirt: ["tests/census-mirror.test.ts"], ownLeakPaths: ["src/leak.ts"] })).toBe("inherited");
	});

	it("regression + clean at phase start → own-leak (G1 row-2: an out-of-scope subject that passes at baseline cannot break on a clean-at-start tree any other way)", () => {
		expect(inheritedRedAttribution({ baselineStatus: "regression", prePhaseDirt: [], ownLeakPaths: ["src/leak.ts"] })).toBe("own-leak");
		expect(inheritedRedAttribution({ baselineStatus: "regression", prePhaseDirt: [], ownLeakPaths: [] })).toBe("own-leak");
	});

	it("unknown / absent baseline → not-evaluable (attribution needs evidence — the deliberate exclusion)", () => {
		expect(inheritedRedAttribution({ baselineStatus: "unknown", prePhaseDirt: ["x"], ownLeakPaths: [] })).toBe("not-evaluable");
		expect(inheritedRedAttribution({ baselineStatus: undefined, prePhaseDirt: [], ownLeakPaths: [] })).toBe("not-evaluable");
	});
});

// ─── boundary shape truth table ─────────────────────────────────────────────

describe("F2 inheritedRedBoundaryShape — the trigger shape", () => {
	it("holds for the C1 shape: gate red, out-of-scope-only + synthetic, baseline present, own-scope green, subjects outside declared targets", () => {
		const r = inheritedRedBoundaryShape({ gate: mkGate(), ownScope: OWN_SCOPE_GREEN, coverageBlocked: false, declaredScope: scope(["src/prod.ts"]) });
		expect(r.shape).toBe(true);
		expect(r.why).toContain("baseline=regression");
		expect(r.failingFiles).toContain("tests/census-mirror.test.ts");
	});

	it("absent baselineCheck → NOT the shape (the deliberate not-inherited-red exclusion)", () => {
		const gate = mkGate();
		delete gate.baselineCheck;
		const r = inheritedRedBoundaryShape({ gate, ownScope: OWN_SCOPE_GREEN, coverageBlocked: false, declaredScope: scope(["src/prod.ts"]) });
		expect(r.shape).toBe(false);
		expect(r.why).toContain("baselineCheck absent");
	});

	it("gate passed / lenient-green → NOT the shape (the gate is not the blocker)", () => {
		expect(inheritedRedBoundaryShape({ gate: mkGate({ pass: true, errors: [], outOfScopeErrors: [] }), ownScope: OWN_SCOPE_GREEN, coverageBlocked: false, declaredScope: new Set() }).shape).toBe(false);
		expect(inheritedRedBoundaryShape({ gate: mkGate({ inScopePass: true }), ownScope: OWN_SCOPE_GREEN, coverageBlocked: false, declaredScope: new Set() }).shape).toBe(false);
	});

	it("an in-scope (non-out-of-scope, non-synthetic) error block remains → NOT the shape (mixed failures never escape)", () => {
		const inScope = "FAIL src/prod.test.ts\nTypeError: boom";
		const r = inheritedRedBoundaryShape({ gate: mkGate({ errors: [CENSUS_BLOCK, SYNTHETIC, inScope] }), ownScope: OWN_SCOPE_GREEN, coverageBlocked: false, declaredScope: scope(["src/prod.ts"]) });
		expect(r.shape).toBe(false);
		expect(r.why).toContain("in-scope failure block(s) remain");
	});

	it("own-scope evidence not green / coverage blocked → NOT the shape (the phase has its own work)", () => {
		expect(inheritedRedBoundaryShape({ gate: mkGate(), ownScope: { ...OWN_SCOPE_GREEN, deliverablePass: false }, coverageBlocked: false, declaredScope: new Set() }).shape).toBe(false);
		expect(inheritedRedBoundaryShape({ gate: mkGate(), ownScope: OWN_SCOPE_GREEN, coverageBlocked: true, declaredScope: new Set() }).shape).toBe(false);
	});

	it("failing subject INSIDE the phase's declared targets → NOT the shape (that is the phase's own declared work, F4's class)", () => {
		const r = inheritedRedBoundaryShape({ gate: mkGate(), ownScope: OWN_SCOPE_GREEN, coverageBlocked: false, declaredScope: scope(["tests/census-mirror.test.ts"]) });
		expect(r.shape).toBe(false);
		expect(r.why).toContain("inside the phase's declared targets");
	});

	it("no extractable failing path → the gate's out-of-scope classification stands (documented fallback)", () => {
		// FIX ROUND 2 (1/5): go/rust compiler blocks carry NO `^FAIL <path>` jest
		// line, NO vitest ❯ pointer, and NO pytest FAILED node id — the documented
		// unparseable family. (A cargo `FAIL\t<crate>\t<time>` summary line DOES
		// hit the jest regex and extracts the crate token as a pseudo-path — that
		// is pre-existing parseFailingNpmTestFiles behavior, out of scope here.)
		const rustcBlock = "error[E0432]: unresolved import `crate::snow::mirror`\n --> src/snow/mod.rs:3:5\n  |\n 3 | use crate::snow::mirror;\n  |     ^^^^^^^^^^^^ no `mirror` in `snow`\n\nfailures:\n    SnowMirrorTest::lockstep";
		const r = inheritedRedBoundaryShape({ gate: mkGate({ errors: [rustcBlock, SYNTHETIC], outOfScopeErrors: [rustcBlock] }), ownScope: OWN_SCOPE_GREEN, coverageBlocked: false, declaredScope: scope(["src/prod.ts"]) });
		expect(r.shape).toBe(true);
		expect(r.failingFiles).toEqual([]);
		expect(r.why).toContain("no extractable failing path");
	});

	it("extractFailingTestFilePaths: jest FAIL lines + vitest ❯ pointers + pytest FAILED node ids, normalized + deduped", () => {
		const paths = extractFailingTestFilePaths([
			"FAIL tests/a.test.ts",
			"❯ ./tests/a.test.ts:12:3",
			"FAILED tests/sub/b_test.py::TestC::test_m",
			"unrelated prose",
		]);
		expect(paths).toEqual(["tests/a.test.ts", "tests/sub/b_test.py"]);
	});
});

// ─── F4 Option-C scope predicate ────────────────────────────────────────────

describe("F4 f4ScopeMatch — the door-in-the-fence scope predicate (Option C union over prior PARTIAL phases)", () => {
	const phases = [
		{ name: "P1", deliverables: { requireFiles: ["tests/census-mirror.test.ts"] } },
		{ name: "P2", deliverables: {} },
		{ name: "P3", deliverables: {} },
	] as Array<Record<string, unknown>>;

	it("NO prior partial phase exists → null (F4 can never fire — today's behavior)", () => {
		expect(f4ScopeMatch(["tests/census-mirror.test.ts"], phases, [], 1, [])).toBeNull();
		expect(f4ScopeMatch(["tests/census-mirror.test.ts"], phases, [{ id: "phase-01", status: "green" }], 1, [])).toBeNull();
	});

	it("converged (green) prior phases are excluded — only PARTIAL phases can be inherited from", () => {
		expect(f4ScopeMatch(["tests/census-mirror.test.ts"], phases, [{ id: "phase-01", status: "green" }], 1, [])).toBeNull();
	});

	it("the CURRENT phase is never its own scope owner (index < currentIndex only)", () => {
		// phase-01 partial AND current index 0 — no earlier phase exists.
		expect(f4ScopeMatch(["tests/census-mirror.test.ts"], phases, [{ id: "phase-01", status: "partial" }], 0, [])).toBeNull();
	});

	it("ARM A: restored path ∈ a prior partial phase's declared clause files (phaseClauseFiles canonical grammar)", () => {
		const r = f4ScopeMatch(["tests/census-mirror.test.ts"], phases, [{ id: "phase-01", status: "partial" }], 1, []);
		expect(r).toEqual({ arm: "arm-a", phaseId: "phase-01", path: "tests/census-mirror.test.ts" });
	});

	it("ARM B (structured): restored path ∈ a prior partial phase's recorded failing-test file paths (test-runner record parser)", () => {
		const phasesNoClause = [{ name: "P1", deliverables: { requireFiles: ["src/other.ts"] } }, { name: "P2" }] as Array<Record<string, unknown>>;
		const r = f4ScopeMatch(
			["tests/census-mirror.test.ts"],
			phasesNoClause,
			[{ id: "phase-01", status: "partial" }],
			1,
			[{ phaseId: "phase-01", reasons: ["FAIL tests/census-mirror.test.ts\nError: lockstep", "unrelated"] }],
		);
		expect(r).toEqual({ arm: "arm-b", phaseId: "phase-01", path: "tests/census-mirror.test.ts" });
	});

	it("ARM B (containment fallback): a recorded reason merely CONTAINS the normalized path (documented best-effort)", () => {
		const phasesNoClause = [{ name: "P1", deliverables: {} }, { name: "P2" }] as Array<Record<string, unknown>>;
		const r = f4ScopeMatch(
			["tests/census-mirror.test.ts"],
			phasesNoClause,
			[{ id: "phase-01", status: "partial" }],
			1,
			[{ phaseId: "phase-01", reasons: ["tdd-targets-still-red: tests/census-mirror.test.ts"] }],
		);
		expect(r).toEqual({ arm: "arm-b", phaseId: "phase-01", path: "tests/census-mirror.test.ts" });
	});

	it("path normalization: backslash / leading ./ / trailing slash all match exactly-normalized clause files", () => {
		const phasesWin = [{ name: "P1", deliverables: { requireFiles: ["./src\\deep\\x.test.ts"] } }, { name: "P2" }] as Array<Record<string, unknown>>;
		const r = f4ScopeMatch(["src/deep/x.test.ts"], phasesWin, [{ id: "phase-01", status: "partial" }], 1, []);
		expect(r).toEqual({ arm: "arm-a", phaseId: "phase-01", path: "src/deep/x.test.ts" });
	});

	it("a non-matching prior partial phase → null (today's behavior for implementer-error restores)", () => {
		const phasesNoMatch = [{ name: "P1", deliverables: { requireFiles: ["src/other.ts"] } }, { name: "P2" }] as Array<Record<string, unknown>>;
		expect(f4ScopeMatch(["tests/own.test.ts"], phasesNoMatch, [{ id: "phase-01", status: "partial" }], 1, [{ phaseId: "phase-01", reasons: ["FAIL tests/different.test.ts"] }])).toBeNull();
	});
});

// ─── the ledger (append-only; occurrence + flake tallies) ───────────────────

describe("F2/F4 ledger — append-only tallies", () => {
	const dirs: string[] = [];
	const dir = () => {
		const d = mkdtempSync(join(tmpdir(), "sd-ir-ledger-"));
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("occurrence tally counts only event:\"occurrence\" rows; rows are append-only", () => {
		const d = dir();
		expect(countInheritedRedOccurrences(d)).toBe(0);
		appendInheritedRedEvent(d, { event: "tier0-own-leak", phaseId: "phase-01", outcome: "reverted" });
		appendInheritedRedEvent(d, { event: "flake-rerun", phaseId: "phase-02", outcome: "flake-cleared" });
		expect(countInheritedRedOccurrences(d)).toBe(0); // metrics-only rows never consume the tally
		appendInheritedRedEvent(d, { event: "occurrence", phaseId: "phase-02", outcome: "tier2-handoff-routed" });
		expect(countInheritedRedOccurrences(d)).toBe(1);
		appendInheritedRedEvent(d, { event: "occurrence", phaseId: "phase-03", outcome: "tier3-fatal" });
		expect(countInheritedRedOccurrences(d)).toBe(2);
		expect(readInheritedRedEvents(d)).toHaveLength(4);
		expect(readInheritedRedEvents(d)[0]).toMatchObject({ event: "tier0-own-leak", phaseId: "phase-01" });
	});

	it("flake tally counts Tier-1 re-runs regardless of outcome", () => {
		const d = dir();
		expect(inheritedRedFlakeTally(d)).toBe(0);
		appendInheritedRedEvent(d, { event: "flake-rerun", phaseId: "phase-01", outcome: "still-red" });
		appendInheritedRedEvent(d, { event: "flake-rerun", phaseId: "phase-03", outcome: "flake-cleared" });
		expect(inheritedRedFlakeTally(d)).toBe(2);
	});

	it("unreadable/absent ledger → 0 (never throws); undefined specDir is a no-op", () => {
		expect(countInheritedRedOccurrences(join(tmpdir(), "sd-ir-absent-xyz"))).toBe(0);
		expect(inheritedRedFlakeTally(undefined)).toBe(0);
		expect(() => appendInheritedRedEvent(undefined, { event: "occurrence", phaseId: "p" })).not.toThrow();
	});
});

// ─── the replan sub-cap + the optional handoff row fields ───────────────────

describe("declared handoff row shape — sub-cap counting + source/sourcePhase/handoffArm riding triggerReplanForFindings", () => {
	const dirs: string[] = [];
	const dir = () => {
		const d = mkdtempSync(join(tmpdir(), "sd-ir-replan-"));
		dirs.push(d);
		return d;
	};
	beforeEach(() => { delete process.env.SUPER_DEV_MAX_REPLAN_ROUNDS; });
	afterEach(() => {
		delete process.env.SUPER_DEV_MAX_REPLAN_ROUNDS;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const mkStateCtx = (d: string) => {
		const logs: string[] = [];
		const state = {
			task: "t",
			options: {},
			setup: { worktreePath: d, specDirectory: d, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "ir-test", worktreeCreated: false, initializedRepo: false },
		} as unknown as PipelineState;
		const ctx = {
			task: "t", options: {}, state: {} as PipelineState,
			budget: { check: () => true, spent: () => true, count: 0 },
			log: (m: string) => logs.push(m),
			phase: () => {},
			events: { on: () => () => {}, emit: () => {} },
			results: [],
			agent: vi.fn(async () => ({ text: "", control: { owner: "human", confidence: 0.9, reason: "fallback", evidence: [] } })),
			async helper() { return { value: {}, digest: "" }; },
			async parallel() { return []; },
		} as unknown as StageContext;
		return { state, ctx, logs };
	};

	it("routes the handoff row with ownerStage spec + source/sourcePhase/handoffArm; counts as 1 inherited-red row (any status)", async () => {
		const d = dir();
		const { state, ctx } = mkStateCtx(d);
		const finding = {
			id: "inherited-red-phase-02",
			file: null,
			severity: "high",
			title: "inherited-red partial boundary at phase-02",
			detail: "gate red on out-of-scope failures by attribution",
			ownerStage: "spec",
			source: INHERITED_RED_SOURCE,
			sourcePhase: "phase-02",
			handoffArm: "arm-b",
			recommendation: "declare the coupling",
		};
		const routed = await triggerReplanForFindings(state, ctx, [finding], "implementation", "ir-test");
		expect(routed).toBe(true);
		expect((state as Record<string, unknown>).__replan).toBeDefined();

		const file = JSON.parse(readFileSync(join(d, REPLAN_REQUESTS_FILE), "utf8")) as { rounds: number; requests: Array<Record<string, unknown>> };
		expect(file.rounds).toBe(1); // consumes ONE round of the shared pool
		expect(file.requests).toHaveLength(1);
		const row = file.requests[0]!;
		expect(row.ownerStage).toBe("spec");
		expect(row.source).toBe("inherited-red"); // NEVER classificationSource (that stays R2 provenance)
		expect(row.classificationSource).toBe("reviewer-ownerStage");
		expect(row.sourcePhase).toBe("phase-02");
		expect(row.handoffArm).toBe("arm-b");
		expect(row.status).toBe("pending");

		// Sub-cap: ANY status counts (non-resetting across resume).
		expect(countInheritedRedRows(d)).toBe(1);
		row.status = "addressed";
		writeFileSync(join(d, REPLAN_REQUESTS_FILE), JSON.stringify(file));
		expect(countInheritedRedRows(d)).toBe(1); // addressed still spends the cap
		expect(pendingInheritedRedRows(d)).toHaveLength(0); // the pending-only probe (validator override signal)
	});

	it("rows WITHOUT the source tag never count against the sub-cap; absent file → 0", () => {
		const d = dir();
		expect(countInheritedRedRows(d)).toBe(0);
		expect(pendingInheritedRedRows(d)).toHaveLength(0);
		writeFileSync(join(d, REPLAN_REQUESTS_FILE), JSON.stringify({ version: 1, rounds: 0, requests: [
			{ id: "x", title: "t", detail: "d", severity: "high", ownerStage: "spec", classificationSource: "keyword", classificationReason: "r", requestedRevision: "rr", fingerprint: "f1", status: "pending", createdAt: "now" },
		] }));
		expect(countInheritedRedRows(d)).toBe(0);
	});
});
