/**
 * EVAL STAGE (P2 / D5+D3) — the in-pipeline fail-open eval surface
 * (docs/requirements/sdlc-tips-adoption.md DEC-2/9/10, §8.3 M1, §8.4 M3,
 * §8.6 L4, D7/DEC-13①).
 *
 * Hermetic by construction: every directory is an injected tmp dir, the
 * agent dispatch is a stub (NO real LLM), and no test touches
 * ~/.super-dev (the suite-wide SUPER_DEV_NO_GLOBAL_METRICS guard also keeps
 * the DEFAULT dataset append inert; tests that assert writes inject the dir).
 *
 * Contract under test:
 *  - Statistics core extraction (D3/L4): median/MAD/classifyBand exported
 *    from sigma-bands.ts; bandPositions classifies EVERY metric with the
 *    EXACT sigmaReport rules (parity pinned); zero behavior change to the
 *    existing sigmaReport face.
 *  - Trajectory scorer: deterministic rows from synthetic S3 counters + band
 *    positions; rubric bandMap mapping; the conservative DEFAULT rule
 *    (in-band → family positive if unambiguous, else honest-absent).
 *  - Final-response scorer: dispatch stub → per-assertion booleans → folded
 *    dimension rows; honest-absent option; M3 degradation floors (quota /
 *    spawn error / throw) and the cold-start discard (NOT degraded).
 *  - configStamp (M1): same config → same stamp; shaping-key change →
 *    different stamp.
 *  - D7 gate execution with synthetic labels; honest-absent rows are named
 *    discards, never disagreements.
 *  - Outputs pinned: `eval.*` events, eval-report.md, rows.jsonl — exact row
 *    key sets (no single score / no aggregate anywhere).
 *  - Observational tripwire (2026-09-11 裁定): eval-stage.ts imports nothing
 *    that mutates loop state; the workflow wiring sits BEFORE the
 *    run.completed bracket (INV-L5) and is hermeticity-gated.
 *  - eval-scorer agent registration consistency (mirrors register-agents
 *    tests): REGISTERED_AGENTS ∪ READ_ONLY_AGENTS ∪ agents/eval-scorer.md.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	EVAL_SCORER_AGENT, EVAL_SCORER_TIMEOUT_MS, HONEST_ABSENT, EVAL_REPORT_BASENAME, EVAL_DATASET_BASENAME,
	configStampOf, METRIC_TARGET, bandVerdictFor, scoreTrajectory,
	distillEvalScorerControl, foldFinalResponseRows, assertionId, buildEvalScorerPrompt,
	runGate, runEvalStage, evalStageEnabled, renderEvalReport, EVAL_MAX_ASSERTIONS,
	type EvalRow, type EvalAgentDispatch,
} from "../src/evolution/eval-stage.ts";
import {
	median, medianAbsoluteDeviation, classifyBand, bandPositions, sigmaReport, MIN_PRIOR_RUNS,
	type RunMetricsRow, type MetricBandPosition, type S3Counters,
} from "../src/evolution/sigma-bands.ts";
import {
	validateRubric, RUBRIC_SCALE, type Rubric, type GoldenCase, type GateLabels,
} from "../src/evolution/eval-layer.ts";
import { readRunEvents } from "../src/runlog.ts";
import { REGISTERED_AGENTS, READ_ONLY_AGENTS } from "../src/agents/register-agents.ts";
import { loadAgentBasePrompt } from "../src/agents.ts";
import { HARNESS_FILE_ROLES } from "../src/harness-paths.ts";
import { runWorkflow } from "../src/workflow.ts";
import { getSuperDevDir } from "../src/render/super-dev-dir.ts";
import { sequence, task } from "../src/nodes.ts";
import type { Stage, Workflow } from "../src/types.ts";

/** F-07 wiring-test hermeticity: getSuperDevDir is mocked to a tmp home (the
 *  run-metrics.test.ts pattern — the dir is created INSIDE the factory, so
 *  the hoisted vi.mock never references outer variables) so the ONE runtime
 *  runWorkflow test can enable the eval stage (delete
 *  SUPER_DEV_NO_EVAL_STAGE) without ever writing the real ~/.super-dev/evals/.
 *  Every other export stays real (the suite's SUPER_DEV_NO_CONFIG_ENV=1 keeps
 *  the real superDevEnv config-fallback-free). */
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "sd-eval-home-"));
	return { ...mod, getSuperDevDir: () => dir };
});

// ─── temp-dir plumbing (hermetic — never ~/.super-dev) ──────────────────────

let tmpRoot: string;
let dirSeq = 0;
beforeAll(() => { tmpRoot = mkdtempSync(join(tmpdir(), "sd-eval-stage-")); });
afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(getSuperDevDir(), { recursive: true, force: true });
});

/** Fresh UNIQUE directory per call (a reused name would leak events.jsonl
 *  rows across tests — cross-test contamination). */
function newDir(name: string): string {
	const dir = join(tmpRoot, `${name}-${++dirSeq}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ─── fixtures ───────────────────────────────────────────────────────────────

const S3_ZERO: S3Counters = { judgeAccepted: 0, judgeDiscarded: 0, partialPhases: 0, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0, maxPhaseAttempts: 0 };

const row = (over: Partial<RunMetricsRow> = {}): RunMetricsRow => ({
	runId: "r", status: "ok", agentsSpawned: 4, wallMs: 1000,
	stages: {}, agentErrorRounds: 0, fatalAborts: 0,
	judgeAccepted: 0, judgeDiscarded: 0, partialPhases: 0, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0, maxPhaseAttempts: 0,
	usage: { calls: 3, input: 100, output: 50, cost: 0.001 },
	ts: Date.now(),
	...over,
});

/** A parsed-form golden case (scoreTrajectory takes parsed cases). */
function gc(over: Partial<GoldenCase> = {}): GoldenCase {
	return {
		id: "gc-judge",
		title: "t",
		source: "docs/requirements/sdlc-tips-adoption.md",
		target: { raw: "judge", arm: "agent", agent: "judge" },
		scenario: "s",
		expected: { verdict: "accepted" },
		caseVersion: 1,
		...over,
	};
}

/** A wire-form rubric known valid, with an optional bandMap on dimension 0. */
function rubricWire(bandMap?: Record<string, unknown>): Record<string, unknown> {
	return {
		rubricId: "rubric-honesty",
		version: "1.0.0",
		dimensions: [{
			name: "traceability",
			guidance: "claims must be traceable to executed evidence; length is never evidence",
			mustHold: ["summary claims cite executed evidence", "residual risks are listed"],
			mustNot: ["coverage claims not backed by the ledger"],
			...(bandMap ? { bandMap } : {}),
		}],
		scale: RUBRIC_SCALE,
	};
}

function parsedRubric(bandMap?: Record<string, string>): Rubric {
	const v = validateRubric(rubricWire(bandMap), { expectedRubricId: "rubric-honesty" });
	if (!v.ok) throw new Error(`fixture rubric failed its own validation: ${v.reasons.join("; ")}`);
	return v.value;
}

/** Synthetic band position (the bandPositions() output shape). */
function pos(metric: MetricBandPosition["metric"], position: MetricBandPosition["position"]): MetricBandPosition {
	return { metric, position, sigma: position === "no-band" ? null : 1, median: 0, mad: 0, n: 8 };
}

const STAMP = "cfg-test00000";

function readDatasetRows(dir: string): EvalRow[] {
	const text = readFileSync(join(dir, EVAL_DATASET_BASENAME), "utf8");
	return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as EvalRow);
}

// ─── statistics core extraction (D3 / §8.6 L4) ──────────────────────────────

describe("σ-band statistics core extraction (D3/L4 — sigma-bands.ts)", () => {
	it("median handles odd and even lengths; MAD is the median absolute deviation about the median", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 2, 3])).toBe(2.5);
		expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1); // deviations [2,1,0,1,2] → 1
		expect(medianAbsoluteDeviation([8, 9, 9, 10, 10, 11, 11, 12])).toBe(1);
	});

	it("classifyBand: the exact sigmaReport rules — floors, MAD=0 cap, and every position", () => {
		// Spread baseline: median 10, MAD 1 (scale 1.4826 → 1σ ≈ 1.4826 away).
		const base = [8, 9, 9, 10, 10, 11, 11, 12];
		expect(classifyBand(10, base).position).toBe("in-band"); // 0σ
		expect(classifyBand(9.6, base).position).toBe("in-band"); // ≈0.27σ
		expect(classifyBand(11.5, base).position).toBe("1σ"); // ≈1.01σ
		expect(classifyBand(13.0, base).position).toBe("2σ"); // ≈2.02σ
		expect(classifyBand(15.0, base).position).toBe("3σ"); // ≈3.37σ
		// <8 finite baseline values → no-band (the MIN_PRIOR_RUNS honesty floor).
		const short = classifyBand(10, [10, 10, 10]);
		expect(short.position).toBe("no-band");
		expect(short.sigma).toBeNull();
		expect(short.n).toBe(3);
		// Non-finite current value → no-band, never a fabricated tier.
		expect(classifyBand(Number.NaN, base).position).toBe("no-band");
		// MAD=0: equal is exactly 0σ; ANY deviation is maximally surprising (capped 3σ).
		const flat = [10, 10, 10, 10, 10, 10, 10, 10];
		const same = classifyBand(10, flat);
		expect(same.position).toBe("in-band");
		expect(same.sigma).toBe(0);
		const drifted = classifyBand(11, flat);
		expect(drifted.position).toBe("3σ");
		expect(drifted.sigma).toBe(3);
		// MIN_PRIOR_RUNS stays the one shared floor (P6 — imported, not re-typed here).
		expect(MIN_PRIOR_RUNS).toBe(8);
	});

	it("bandPositions classifies EVERY metric (the eval report face) and agrees with sigmaReport (the drift face)", () => {
		// 9 flat priors + a current row whose judgeDiscarded is a 3σ outlier.
		const priors = Array.from({ length: 9 }, () => row());
		const current = row({ judgeDiscarded: 100 });
		const positions = bandPositions(priors, current);
		expect(positions.map((p) => p.metric)).toHaveLength(12);
		const byMetric = new Map(positions.map((p) => [p.metric, p] as const));
		expect(byMetric.get("judgeDiscarded")!.position).toBe("3σ");
		expect(byMetric.get("judgeAccepted")!.position).toBe("in-band");
		expect(byMetric.get("wallMs")!.position).toBe("in-band");
		// Parity: the same ledger through sigmaReport surfaces the same metric at
		// the same tier (zero behavior change to the existing face).
		const report = sigmaReport([...priors, current]);
		expect(report.insufficientHistory).toBe(false);
		expect(report.bands.map((b) => b.metric)).toContain("judgeDiscarded");
		expect(report.bands.find((b) => b.metric === "judgeDiscarded")!.tier).toBe("3σ");
	});

	it("bandPositions with no history: every metric honestly no-band", () => {
		const positions = bandPositions([], row());
		expect(positions).toHaveLength(12);
		expect(positions.every((p) => p.position === "no-band" && p.sigma === null)).toBe(true);
	});

	it("METRIC_TARGET covers every SigmaMetricName (compile-time by type; pinned at runtime)", () => {
		expect(Object.keys(METRIC_TARGET)).toHaveLength(12);
		expect(METRIC_TARGET.judgeAccepted).toBe("judge");
		expect(METRIC_TARGET.maxPhaseAttempts).toBe("implementation");
		expect(METRIC_TARGET.wallMs).toBe("run");
	});
});

// ─── trajectory scorer (D3 — deterministic) ─────────────────────────────────

describe("trajectory scorer (D3 — deterministic, strictly observational)", () => {
	it("per-metric rows: judge in-band maps to the family's positive verdict; implementation/run faces default to honest-absent (conservative DEFAULT rule)", () => {
		const positions = [
			pos("judgeAccepted", "in-band"),
			pos("judgeDiscarded", "in-band"),
			pos("partialPhases", "1σ"),
			pos("wallMs", "in-band"),
		];
		const rows = scoreTrajectory({ runId: "r1", ts: 1, configStamp: STAMP, positions, cases: [], rubrics: [] });
		expect(rows).toHaveLength(4);
		const byMetric = new Map(rows.map((r) => [r.metric!, r] as const));
		// judge → single judge family → canonical positive "accepted".
		expect(byMetric.get("judgeAccepted")!.verdict).toBe("accepted");
		expect(byMetric.get("judgeAccepted")!.target).toBe("judge");
		expect(byMetric.get("judgeAccepted")!.bandPosition).toBe("in-band");
		// implementation is UNMAPPED in the F6 table → full-closure admission →
		// ambiguous → honest-absent; drift is named by the band, not fabricated.
		expect(byMetric.get("partialPhases")!.verdict).toBe(HONEST_ABSENT);
		expect(byMetric.get("partialPhases")!.bandPosition).toBe("1σ");
		// "run" is an observation-only face (no arms) → ambiguous → honest-absent.
		expect(byMetric.get("wallMs")!.verdict).toBe(HONEST_ABSENT);
		// no-band is never a score.
		expect(bandVerdictFor({ agent: "judge" }, "no-band", [])).toBe(HONEST_ABSENT);
	});

	it("rubric bandMap overrides the default — first ADMITTED entry wins; non-admitted values are skipped loudly", () => {
		const rubrics = [parsedRubric({ "2σ": "Blocked", "3σ": "Changes Requested" })];
		// The implementation stage face is unmapped → full closure → both review
		// verdicts admitted; the 2σ position maps through the bandMap.
		expect(bandVerdictFor({ stage: "implementation" }, "2σ", rubrics)).toBe("Blocked");
		expect(bandVerdictFor({ stage: "implementation" }, "3σ", rubrics)).toBe("Changes Requested");
		// The judge face admits ONLY accepted/discarded — a review verdict in a
		// bandMap is skipped (loud note) and the default applies.
		const notes: string[] = [];
		expect(bandVerdictFor({ agent: "judge" }, "2σ", rubrics, (m) => notes.push(m))).toBe(HONEST_ABSENT);
		expect(notes.join("\n")).toContain("not admitted");
		// An in-band judge position keeps its positive default (bandMap has no in-band entry here).
		expect(bandVerdictFor({ agent: "judge" }, "in-band", rubrics)).toBe("accepted");
	});

	it("per-target case rows: the WORST owned band position drives the verdict; metric-less faces get an honest-absent row", () => {
		const positions = [
			pos("judgeAccepted", "in-band"),
			pos("judgeDiscarded", "3σ"),
			pos("partialPhases", "1σ"),
		];
		const rubrics = [parsedRubric({ "3σ": "discarded" })];
		const rows = scoreTrajectory({
			runId: "r1", ts: 1, configStamp: STAMP, positions, rubrics,
			cases: [
				gc(), // target judge — owns judgeAccepted/judgeDiscarded
				gc({ id: "gc-proto", target: { raw: "prototype|prototype-runner", arm: "compound", stage: "prototype", agent: "prototype-runner" }, expected: { verdict: "pass" } }), // owns no metric
				gc({ id: "gc-impl", target: { raw: "implementation", arm: "stage", stage: "implementation" }, expected: { verdict: "Changes Requested" } }),
			],
		});
		const caseRows = rows.filter((r) => r.caseRef !== undefined);
		expect(caseRows).toHaveLength(3);
		const judge = caseRows.find((r) => r.caseRef === "gc-judge")!;
		// Worst of {in-band, 3σ} = 3σ; the bandMap's admitted "discarded" applies.
		expect(judge.bandPosition).toBe("3σ");
		expect(judge.metric).toBe("judgeDiscarded");
		expect(judge.verdict).toBe("discarded");
		expect(judge.target).toBe("judge");
		// F-03 provenance: case stamps always; rubric stamps only when a bandMap
		// actually fired (it did here).
		expect(judge.caseVersion).toBe(1);
		expect(judge.caseSet).toBe("judge"); // caseSetOf: agent arm when no explicit caseSet
		expect(judge.rubricId).toBe("rubric-honesty");
		expect(judge.rubricVersion).toBe("1.0.0");
		const proto = caseRows.find((r) => r.caseRef === "gc-proto")!;
		expect(proto.verdict).toBe(HONEST_ABSENT);
		expect(proto.metric).toBeUndefined();
		expect(proto.bandPosition).toBeUndefined();
		// the metric-less face still carries its case stamps.
		expect(proto.caseVersion).toBe(1);
		expect(proto.caseSet).toBe("prototype"); // stage arm first
		// implementation owns partialPhases (1σ) — worst position 1σ, no default
		// for drift, no admitted bandMap entry for 1σ → honest-absent; no rubric
		// fired → no rubric stamps (never false provenance).
		const impl = caseRows.find((r) => r.caseRef === "gc-impl")!;
		expect(impl.bandPosition).toBe("1σ");
		expect(impl.verdict).toBe(HONEST_ABSENT);
		expect(impl.rubricId).toBeUndefined();
		expect(impl.rubricVersion).toBeUndefined();
	});
});

// ─── rubric bandMap validation (eval-layer additive extension) ──────────────

describe("RubricDimension.bandMap validation (additive — P1 tests untouched)", () => {
	it("accepts a well-formed bandMap and carries it into the parsed rubric", () => {
		const v = validateRubric(rubricWire({ "in-band": "Approved", "1σ": "Approved with Comments" }), { expectedRubricId: "rubric-honesty" });
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.value.dimensions[0]!.bandMap).toEqual({ "in-band": "Approved", "1σ": "Approved with Comments" });
	});

	it("rejects the never-mappable key, empty mappings, and non-string values — loudly per field", () => {
		const bad1 = validateRubric(rubricWire({ "no-band": "Approved" }), { expectedRubricId: "rubric-honesty" });
		expect(bad1.ok).toBe(false);
		if (!bad1.ok) expect(bad1.reasons.join("\n")).toContain("no-band");
		const bad2 = validateRubric(rubricWire({}), { expectedRubricId: "rubric-honesty" });
		expect(bad2.ok).toBe(false);
		if (!bad2.ok) expect(bad2.reasons.join("\n")).toContain("at least one entry");
		const bad3 = validateRubric(rubricWire({ "1σ": 42 }), { expectedRubricId: "rubric-honesty" });
		expect(bad3.ok).toBe(false);
		if (!bad3.ok) expect(bad3.reasons.join("\n")).toContain("non-empty verdict string");
	});

	it("bandMap-less rubrics parse exactly as before (absent field, not {})", () => {
		const v = validateRubric(rubricWire(), { expectedRubricId: "rubric-honesty" });
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.value.dimensions[0]!.bandMap).toBeUndefined();
	});
});

// ─── final-response scorer (D5②) ────────────────────────────────────────────

describe("final-response scorer (D5② — stubbed dispatch, no real LLM)", () => {
	const rubric = parsedRubric();
	const ids = [
		assertionId("rubric-honesty", "traceability", "mustHold", 0),
		assertionId("rubric-honesty", "traceability", "mustHold", 1),
		assertionId("rubric-honesty", "traceability", "mustNot", 0),
	];

	it("distillEvalScorerControl validates engine-side: happy path, malformed drops, the 32 cap", () => {
		const good = distillEvalScorerControl({
			assertions: ids.map((id) => ({ id, assertion: "a", pass: true, confidence: 0.9 })),
			summaryNote: " all checkable ",
		});
		expect(good).not.toBeNull();
		expect(good!.assertions).toHaveLength(3);
		expect(good!.summaryNote).toBe("all checkable");
		// Malformed entries drop, named.
		const mixed = distillEvalScorerControl({
			assertions: [
				{ id: "x", assertion: "a", pass: true, confidence: 0.5 },
				{ id: "", assertion: "a", pass: true, confidence: 0.5 },
				{ id: "y", assertion: "a", pass: "yes", confidence: 0.5 },
				{ id: "z", assertion: "a", pass: true, confidence: 1.5 },
			],
			summaryNote: "s",
		}, { log: () => {} });
		expect(mixed!.assertions.map((a) => a.id)).toEqual(["x"]);
		expect(mixed!.dropped).toBe(3);
		// Cap.
		const flood = distillEvalScorerControl({
			assertions: Array.from({ length: EVAL_MAX_ASSERTIONS + 5 }, (_, i) => ({ id: `a${i}`, assertion: "a", pass: true, confidence: 0.5 })),
			summaryNote: "s",
		});
		expect(flood!.assertions).toHaveLength(EVAL_MAX_ASSERTIONS);
		expect(flood!.dropped).toBe(5);
		// Unusable shapes → null (the orchestrator degrades, never burns).
		expect(distillEvalScorerControl(null)).toBeNull();
		expect(distillEvalScorerControl({ assertions: "no" })).toBeNull();
	});

	it("fold: any fail ⇒ fail; else any absent/missing ⇒ honest-absent; else pass — a decision rule, never a number", () => {
		const mk = (over: Record<string, Partial<{ pass: boolean; absent: boolean }>>) =>
			foldFinalResponseRows({
				runId: "r1", ts: 1, configStamp: STAMP, rubrics: [rubric],
				distilled: { assertions: ids.map((id) => ({ id, assertion: "a", confidence: 0.9, pass: over[id]?.pass ?? true, absent: over[id]?.absent ?? false })) },
			});
		expect(mk({})[0]!.verdict).toBe("pass");
		expect(mk({ [ids[2]!]: { pass: false } })[0]!.verdict).toBe("fail");
		expect(mk({ [ids[0]!]: { absent: true } })[0]!.verdict).toBe(HONEST_ABSENT);
		// A fail still dominates an absent (conservative order).
		expect(mk({ [ids[0]!]: { absent: true }, [ids[1]!]: { pass: false } })[0]!.verdict).toBe("fail");
		// Row shape: target run, metric = dimension name, NO confidence (a folded
		// confidence would be an aggregate).
		const r = mk({})[0]!;
		expect(r.target).toBe("run");
		expect(r.metric).toBe("traceability");
		expect(r.scorerKind).toBe("final-response");
		expect(r).not.toHaveProperty("confidence");
	});

	it("the prompt names ONLY verified-existing evidence paths (F-02), inlines the frozen snapshot, and disambiguates pass semantics per mustNot line (F-04)", () => {
		const specDir = newDir("prompt-spec");
		writeFileSync(join(specDir, "events.jsonl"), "{\"seq\":1}\n"); // ONLY the event ledger exists
		const prompt = buildEvalScorerPrompt({
			runId: "r1", status: "success", specDirectory: specDir, rubrics: [rubric],
			snapshot: { wallMs: 1234, agentsSpawned: 2, s3: S3_ZERO },
		});
		for (const id of ids) expect(prompt).toContain(`[${id}]`);
		// F-02: existing file named; non-existent candidates NOT named.
		expect(prompt).toContain("events.jsonl");
		expect(prompt).not.toContain("usage-calls.jsonl");
		// Phantom-path fixes: the per-spec run-metrics row is written AFTER the
		// eval stage (the frozen snapshot replaces it), and audit.jsonl lives in
		// the RUN dir — never <specDir>/audit.jsonl.
		expect(prompt).not.toContain("run-metrics.jsonl");
		expect(prompt).not.toContain("audit.jsonl");
		// The frozen snapshot is inlined instead.
		expect(prompt).toContain("Frozen run snapshot");
		expect(prompt).toContain("judgeAccepted 0");
		expect(prompt).toContain("1234ms");
		expect(prompt).toContain("final deliverables");
		// F-04: uniform pass semantics — stated in the rules AND on every mustNot line.
		expect(prompt).toContain("(pass=true means this violation did NOT occur)");
		expect(prompt).toContain("UNIFORM \"criterion satisfied\"");
		expect(prompt).toContain("absent:true");
	});

	it("F-11: a missing/non-string summaryNote degrades to \"\" — the assertions are the payload, the response is not dropped", () => {
		const noNote = distillEvalScorerControl({ assertions: ids.map((id) => ({ id, assertion: "a", pass: true, confidence: 0.9 })) });
		expect(noNote).not.toBeNull();
		expect(noNote!.assertions).toHaveLength(3);
		expect(noNote!.summaryNote).toBe("");
		const badNote = distillEvalScorerControl({ assertions: ids.map((id) => ({ id, assertion: "a", pass: true, confidence: 0.9 })), summaryNote: 42 });
		expect(badNote!.summaryNote).toBe("");
		// A present note still trims/slices as before.
		const note = distillEvalScorerControl({ assertions: [], summaryNote: "  ok  " });
		expect(note!.summaryNote).toBe("ok");
	});
});

// ─── the orchestrator (fail-open; all three outputs pinned) ─────────────────

describe("runEvalStage (fail-open orchestrator)", () => {
	const dispatch: EvalAgentDispatch = async () => ({
		text: "",
		control: {
			assertions: [
				{ id: assertionId("rubric-honesty", "traceability", "mustHold", 0), assertion: "a", pass: true, confidence: 0.9 },
				{ id: assertionId("rubric-honesty", "traceability", "mustHold", 1), assertion: "a", pass: true, confidence: 0.8 },
				{ id: assertionId("rubric-honesty", "traceability", "mustNot", 0), assertion: "a", pass: true, confidence: 0.7 },
			],
			summaryNote: "everything was checkable",
		},
	});

	function stageInput(over: Partial<Parameters<typeof runEvalStage>[0]> = {}): Parameters<typeof runEvalStage>[0] {
		return {
			runId: "run-1",
			status: "success",
			specDirectory: newDir("spec"),
			s3: S3_ZERO,
			metrics: { agentsSpawned: 3, wallMs: 1000, results: [], usage: { totals: { calls: 3 } } },
			sigmaRows: Array.from({ length: 9 }, () => row()),
			cases: { cases: [gc()], skipped: [] },
			rubrics: { rubrics: [parsedRubric()], skipped: [] },
			labels: [],
			config: {},
			datasetDir: newDir("dataset"),
			budgetOk: true,
			agentCall: dispatch,
			ts: 1_700_000_000_000,
			...over,
		};
	}

	it("happy path: all three outputs land, with the pinned row shapes (no aggregate anywhere)", async () => {
		const input = stageInput();
		const outcome = await runEvalStage(input);
		// 12 metric rows + 1 case row (judge in-band → default "accepted") + 1
		// final-response dimension row (all assertions pass).
		expect(outcome.trajectoryRows).toHaveLength(13);
		expect(outcome.finalResponseRows).toHaveLength(1);
		expect(outcome.finalResponseRows[0]!.verdict).toBe("pass");
		expect(outcome.degraded).toBe(false);
		// Dataset rows: exact key sets per shape.
		const rows = readDatasetRows(input.datasetDir!);
		expect(rows).toHaveLength(14);
		const metricRowKeys = Object.keys(rows[0]!).sort();
		expect(metricRowKeys).toEqual(["bandPosition", "configStamp", "metric", "runId", "scorerKind", "target", "ts", "verdict"]);
		const caseRow = rows.find((r) => r.caseRef === "gc-judge")!;
		// F-03: case stamps present; rubric stamps ABSENT (the DEFAULT rule fired —
		// no bandMap entry — and false provenance is never stamped).
		expect(Object.keys(caseRow).sort()).toEqual(["bandPosition", "caseRef", "caseSet", "caseVersion", "configStamp", "metric", "runId", "scorerKind", "target", "ts", "verdict"]);
		expect(caseRow.verdict).toBe("accepted");
		expect(caseRow.bandPosition).toBe("in-band");
		expect(caseRow.caseVersion).toBe(1);
		expect(caseRow.caseSet).toBe("judge");
		const frRow = rows.find((r) => r.scorerKind === "final-response")!;
		// F-03: rubric-shaped rows stamp their rubric (DEC-7 provenance).
		expect(Object.keys(frRow).sort()).toEqual(["configStamp", "metric", "rubricId", "rubricVersion", "runId", "scorerKind", "target", "ts", "verdict"]);
		expect(frRow.rubricId).toBe("rubric-honesty");
		expect(frRow.rubricVersion).toBe("1.0.0");
		// Every row carries the config stamp (M1).
		expect(rows.every((r) => r.configStamp === outcome.configStamp && r.configStamp.startsWith("cfg-"))).toBe(true);
		// Events: two eval.scored (trajectory, final-response) inside the spec dir.
		const events = readRunEvents(input.specDirectory!).filter((e) => e.type.startsWith("eval."));
		expect(events.filter((e) => e.type === "eval.scored")).toHaveLength(2);
		expect(events.some((e) => e.type === "eval.gate")).toBe(false); // no labels → no gate
		const frEvent = events.find((e) => e.type === "eval.scored" && (e.data as { scorerKind?: string }).scorerKind === "final-response")!;
		expect((frEvent.data as { assertions?: unknown[] }).assertions).toHaveLength(3);
		// Report artifact in the spec dir (the run report surface).
		const reportPath = join(input.specDirectory!, EVAL_REPORT_BASENAME);
		expect(existsSync(reportPath)).toBe(true);
		const report = readFileSync(reportPath, "utf8");
		expect(report).toContain("# Eval report");
		expect(report).toContain("gc-judge");
		expect(report).toContain("per-metric band rows");
		expect(report).toContain("per-assertion booleans");
		// eval-report.md is registered in the harness file registry (M6 class).
		expect(HARNESS_FILE_ROLES[EVAL_REPORT_BASENAME]).toBeDefined();
	});

	it("honest-absent option: an absent assertion folds the dimension to honest-absent (event keeps the per-assertion boolean)", async () => {
		const input = stageInput({
			agentCall: async () => ({
				text: "",
				control: {
					assertions: [
						{ id: assertionId("rubric-honesty", "traceability", "mustHold", 0), assertion: "a", pass: true, confidence: 0.9, absent: true },
						{ id: assertionId("rubric-honesty", "traceability", "mustHold", 1), assertion: "a", pass: true, confidence: 0.8 },
						{ id: assertionId("rubric-honesty", "traceability", "mustNot", 0), assertion: "a", pass: true, confidence: 0.7 },
					],
					summaryNote: "one assertion was not judgeable",
				},
			}),
		});
		const outcome = await runEvalStage(input);
		expect(outcome.finalResponseRows[0]!.verdict).toBe(HONEST_ABSENT);
		expect(outcome.finalResponseRows[0]!.scorerDegraded).toBeUndefined();
		expect(outcome.assertions[0]!.absent).toBe(true);
		expect(outcome.degraded).toBe(false);
	});

	it("M3 quota failure (budgetOk=false): ONE scorerDegraded floor row, dispatch NEVER launched, no fallback model", async () => {
		let called = false;
		const input = stageInput({
			budgetOk: false,
			agentCall: async () => { called = true; return { text: "", control: null }; },
		});
		const outcome = await runEvalStage(input);
		expect(called).toBe(false);
		expect(outcome.degraded).toBe(true);
		expect(outcome.finalResponseRows).toHaveLength(1);
		const floor = outcome.finalResponseRows[0]!;
		expect(floor.verdict).toBe(HONEST_ABSENT);
		expect(floor.scorerDegraded).toBe(true);
		// The degraded stamp rides the dataset row too (the baseline-exclusion marker).
		const rows = readDatasetRows(input.datasetDir!);
		const degraded = rows.filter((r) => r.scorerDegraded === true);
		expect(degraded).toHaveLength(1);
		expect(Object.keys(degraded[0]!).sort()).toEqual(["configStamp", "runId", "scorerDegraded", "scorerKind", "target", "ts", "verdict"]);
	});

	it("spawn error and spawn-throw both degrade fail-open — runEvalStage always resolves", async () => {
		const errored = await runEvalStage(stageInput({ agentCall: async () => ({ text: "", control: null, error: "timeout after 240000ms" }) }));
		expect(errored.degraded).toBe(true);
		expect(errored.finalResponseRows[0]!.scorerDegraded).toBe(true);
		const threw = await runEvalStage(stageInput({ agentCall: async () => { throw new Error("boom"); } }));
		expect(threw.degraded).toBe(true);
		expect(threw.finalResponseRows[0]!.scorerDegraded).toBe(true);
		// Trajectory rows still landed (deterministic layer unaffected).
		expect(threw.trajectoryRows).toHaveLength(13);
	});

	it("an unusable structured result degrades (defensive validation; no corrective round)", async () => {
		const outcome = await runEvalStage(stageInput({ agentCall: async () => ({ text: "", control: { nonsense: true } }) }));
		expect(outcome.degraded).toBe(true);
		expect(outcome.finalResponseRows[0]!.scorerDegraded).toBe(true);
	});

	it("cold start (no rubrics): the scorer is skipped — an honest-absent discard row that is NOT degraded", async () => {
		const logs: string[] = [];
		let called = false;
		const input = stageInput({
			rubrics: { rubrics: [], skipped: [] },
			agentCall: async () => { called = true; return { text: "", control: null }; },
			log: (m) => logs.push(m),
		});
		const outcome = await runEvalStage(input);
		expect(called).toBe(false);
		expect(outcome.degraded).toBe(false);
		expect(outcome.finalResponseRows).toHaveLength(1);
		expect(outcome.finalResponseRows[0]!.verdict).toBe(HONEST_ABSENT);
		expect(outcome.finalResponseRows[0]!.scorerDegraded).toBeUndefined();
		expect(logs.join("\n")).toContain("cold start");
	});

	it("F-06 run-aborted: trajectory still scores; the frontier dispatch is NEVER launched; the floor is an honest-absent SKIP (no scorerDegraded), named in the report", async () => {
		let called = false;
		const logs: string[] = [];
		const input = stageInput({
			runAborted: true,
			agentCall: async () => { called = true; return { text: "", control: null }; },
			log: (m) => logs.push(m),
		});
		const outcome = await runEvalStage(input);
		expect(called).toBe(false); // no LLM spend on a cancelled/fatal run
		expect(outcome.degraded).toBe(false); // a skip is not a degradation
		expect(outcome.finalResponseRows).toHaveLength(1);
		const floor = outcome.finalResponseRows[0]!;
		expect(floor.verdict).toBe(HONEST_ABSENT);
		expect(floor.scorerDegraded).toBeUndefined();
		expect(outcome.trajectoryRows).toHaveLength(13); // deterministic layer unaffected
		expect(outcome.report).toContain("run-aborted skip");
		expect(outcome.report).toContain("SKIPPED");
		expect(logs.join("\n")).toContain("run-aborted skip");
	});

	it("F-04 end-to-end: mustNot pass=true (violation did NOT occur) folds to pass; mustNot pass=false (violation occurred) folds to fail — uniform semantics", async () => {
		const mkDispatch = (mustNotPass: boolean, mustHoldPass = true): EvalAgentDispatch => async () => ({
			text: "",
			control: {
				assertions: [
					{ id: assertionId("rubric-honesty", "traceability", "mustHold", 0), assertion: "a", pass: mustHoldPass, confidence: 0.9 },
					{ id: assertionId("rubric-honesty", "traceability", "mustHold", 1), assertion: "a", pass: mustHoldPass, confidence: 0.8 },
					{ id: assertionId("rubric-honesty", "traceability", "mustNot", 0), assertion: "a", pass: mustNotPass, confidence: 0.7 },
				],
				summaryNote: "s",
			},
		});
		// A satisfied mustNot (pass=true → the violation did NOT occur) with all
		// mustHold satisfied → the dimension passes.
		const ok = await runEvalStage(stageInput({ agentCall: mkDispatch(true) }));
		expect(ok.finalResponseRows[0]!.verdict).toBe("pass");
		// An UNSATISFIED mustNot (pass=false → the violation DID occur) fails the
		// dimension exactly like an unsatisfied mustHold.
		const violated = await runEvalStage(stageInput({ agentCall: mkDispatch(false) }));
		expect(violated.finalResponseRows[0]!.verdict).toBe("fail");
		const holdViolated = await runEvalStage(stageInput({ agentCall: mkDispatch(true, false) }));
		expect(holdViolated.finalResponseRows[0]!.verdict).toBe("fail");
	});

	it("evalStageEnabled: true unless the SUPER_DEV_NO_EVAL_STAGE kill switch is set (F-07)", () => {
		// The vitest suite sets the switch globally (config-env-hermeticity) —
		// the default inside tests is DISABLED (that is what keeps the workflow
		// wiring inert suite-wide); production never sets it (stage ON by default).
		expect(evalStageEnabled()).toBe(false);
		delete process.env.SUPER_DEV_NO_EVAL_STAGE;
		try {
			expect(evalStageEnabled()).toBe(true);
		} finally {
			process.env.SUPER_DEV_NO_EVAL_STAGE = "1";
		}
	});
});

// ─── config stamp (M1) ──────────────────────────────────────────────────────

describe("configStamp (§8.3 M1 — the run-shaping config hash)", () => {
	it("same config → same stamp (key-order independent); a shaping-key change → a different stamp", () => {
		const a = { agentModels: { "code-reviewer": "zai/glm-4.6", implementer: "zai/glm-5.3" }, agentThinking: { implementer: "high" }, commonToolBudget: { soft: 40, hard: 60 }, agentToolBudget: { "eval-scorer": { soft: 10, hard: 20 } } };
		expect(configStampOf(a)).toBe(configStampOf({ ...a }));
		// Key ORDER inside the config maps must not matter (stable serialization).
		expect(configStampOf(a)).toBe(configStampOf({
			agentToolBudget: a.agentToolBudget,
			commonToolBudget: a.commonToolBudget,
			agentThinking: { implementer: "high" },
			agentModels: { implementer: "zai/glm-5.3", "code-reviewer": "zai/glm-4.6" }, // insertion order flipped
		}));
		const changedModel = { ...a, agentModels: { "code-reviewer": "zai/glm-4.7" } };
		expect(configStampOf(changedModel)).not.toBe(configStampOf(a));
		const changedBudget = { ...a, agentToolBudget: { "eval-scorer": { soft: 12, hard: 20 } } };
		expect(configStampOf(changedBudget)).not.toBe(configStampOf(a));
		// The empty config is a stable stamp of its own (cold start).
		expect(configStampOf({})).toBe(configStampOf({}));
		expect(configStampOf({})).toMatch(/^cfg-[0-9a-f]{10}$/);
		// A tool-budget change alone re-keys (P3 baseline re-key premise).
		expect(configStampOf({ commonToolBudget: { soft: 1, hard: 2 } })).not.toBe(configStampOf({}));
	});
});

// ─── D7 gate execution ──────────────────────────────────────────────────────

describe("gate execution (D7 / DEC-13① — arming the P3 flywheel premise)", () => {
	it("runs computeGateAgreement + gatePasses when labels cover scored cases; honest-absent rows are named discards, not disagreements", () => {
		const rows: EvalRow[] = [
			{ ts: 1, runId: "r", target: "judge", caseRef: "gc-judge", metric: "judgeAccepted", bandPosition: "in-band", verdict: "accepted", scorerKind: "trajectory", configStamp: STAMP },
			{ ts: 1, runId: "r", target: "prototype|prototype-runner", caseRef: "gc-proto", verdict: HONEST_ABSENT, scorerKind: "trajectory", configStamp: STAMP },
			{ ts: 1, runId: "r", target: "judge", metric: "judgeAccepted", bandPosition: "in-band", verdict: "accepted", scorerKind: "trajectory", configStamp: STAMP }, // metric row — not a case score
		];
		const labels: GateLabels[] = [{
			gateId: "g1", created: "2026-09-11T00:00:00.000Z",
			maintainerVerdicts: [
				{ caseId: "gc-judge", caseVersion: 1, expectedByHuman: "accepted" },
				{ caseId: "gc-other", caseVersion: 1, expectedByHuman: "accepted" }, // unmatched label (scored row absent)
			],
		}];
		const gate = runGate(rows, [gc()], labels);
		expect(gate).not.toBeNull();
		expect(gate!.agreement.matchedPairs).toBe(1);
		expect(gate!.agreement.agreed).toBe(1);
		expect(gate!.agreement.unmatchedLabels).toBe(1);
		expect(gate!.excludedRows).toBe(1); // the honest-absent case row — named discard
		expect(gate!.decision.passes).toBe(false); // n=1 < GATE_MIN_MATCHED_PAIRS — directional-only
		expect(gate!.decision.posture).toBe("directional-only");
	});

	it("F-03: the gate prefers the row's OWN caseVersion stamp; the loaded-case map is only a fallback", () => {
		// Row stamped v2 (the version the scorer saw); the loaded case file has
		// since moved to v1 — the row's stamp wins, so only a v2 label matches.
		const rows: EvalRow[] = [
			{ ts: 1, runId: "r", target: "judge", caseRef: "gc-judge", caseVersion: 2, verdict: "accepted", scorerKind: "trajectory", configStamp: STAMP },
		];
		const caseAtV1 = gc(); // caseVersion 1
		const labelAtV2: GateLabels[] = [{ gateId: "g", created: "t", maintainerVerdicts: [{ caseId: "gc-judge", caseVersion: 2, expectedByHuman: "accepted" }] }];
		const gate = runGate(rows, [caseAtV1], labelAtV2)!;
		expect(gate.agreement.matchedPairs).toBe(1); // row.caseVersion=2 joined the v2 label
		expect(gate.agreement.unmatchedLabels).toBe(0);
		// A row WITHOUT its own stamp falls back to the loaded case's version.
		const unstamped: EvalRow[] = [
			{ ts: 1, runId: "r", target: "judge", caseRef: "gc-judge", verdict: "accepted", scorerKind: "trajectory", configStamp: STAMP },
		];
		const gateFallback = runGate(unstamped, [caseAtV1], labelAtV2)!;
		expect(gateFallback.agreement.matchedPairs).toBe(0); // v1 row vs v2 label — version mismatch is an honest unmatch
		expect(gateFallback.agreement.unmatchedLabels).toBe(1);
	});

	it("no labels → no gate (null — nothing to judge)", () => {
		const rows: EvalRow[] = [{ ts: 1, runId: "r", target: "judge", caseRef: "gc-judge", verdict: "accepted", scorerKind: "trajectory", configStamp: STAMP }];
		expect(runGate(rows, [gc()], [])).toBeNull();
		expect(runGate(rows, [gc()], [{ gateId: "g", created: "t", maintainerVerdicts: [] }])).toBeNull();
	});

	it("the gate decision lands in the report rows and the eval.gate event (full close-out)", async () => {
		const specDir = newDir("gate-spec");
		const datasetDir = newDir("gate-dataset");
		const outcome = await runEvalStage({
			runId: "run-gate", status: "success", specDirectory: specDir, s3: S3_ZERO,
			metrics: { agentsSpawned: 1, wallMs: 10, results: [] },
			sigmaRows: Array.from({ length: 9 }, () => row()),
			cases: { cases: [gc()], skipped: [] },
			rubrics: { rubrics: [parsedRubric()], skipped: [] },
			labels: [{ gateId: "g1", created: "2026-09-11T00:00:00.000Z", maintainerVerdicts: [{ caseId: "gc-judge", caseVersion: 1, expectedByHuman: "accepted" }] }],
			config: {}, datasetDir, budgetOk: true,
			agentCall: async () => ({ text: "", control: { assertions: [{ id: assertionId("rubric-honesty", "traceability", "mustHold", 0), assertion: "a", pass: true, confidence: 0.9 }], summaryNote: "s" } }),
			ts: 1,
		});
		expect(outcome.gate).not.toBeNull();
		expect(outcome.gate!.agreement.matchedPairs).toBe(1);
		expect(outcome.report).toContain("Validation gate");
		expect(outcome.report).toContain("directional-only");
		const gateEvents = readRunEvents(specDir).filter((e) => e.type === "eval.gate");
		expect(gateEvents).toHaveLength(1);
		expect((gateEvents[0]!.data as { posture?: string }).posture).toBe("directional-only");
		// gatePasses=false suppresses NOTHING in P2 — the run summary is unaffected.
	});

	it("a well-sampled below-floor agreement is miscalibrated (the D7 posture vocabulary)", () => {
		// Reuse the pure P1 gate policy through the P2 seam: 8 matched pairs, 4
		// agreed → miscalibrated (fix the rubric/mapping, not the data).
		const cases = Array.from({ length: 8 }, (_, i) => gc({ id: `gc-${i}`, caseVersion: 1 }));
		const rows: EvalRow[] = cases.map((c, i) => ({
			ts: 1, runId: "r", target: "judge", caseRef: c.id, verdict: i < 4 ? "accepted" : "discarded", scorerKind: "trajectory", configStamp: STAMP,
		}));
		const labels: GateLabels[] = [{ gateId: "g", created: "t", maintainerVerdicts: cases.map((c) => ({ caseId: c.id, caseVersion: 1, expectedByHuman: "accepted" })) }];
		const gate = runGate(rows, cases, labels)!;
		expect(gate.agreement.matchedPairs).toBe(8);
		expect(gate.agreement.agreementRate).toBe(0.5);
		expect(gate.decision.posture).toBe("miscalibrated");
		expect(gate.decision.passes).toBe(false);
	});
	it("F-08/F-09/F-10 report wording: anomaly-position framing, v1 face-coverage note, and unmatched labels surfaced", () => {
		const rows: EvalRow[] = [
			{ ts: 1, runId: "r", target: "judge", caseRef: "gc-judge", caseVersion: 1, caseSet: "judge", verdict: "accepted", scorerKind: "trajectory", configStamp: STAMP },
		];
		const labels: GateLabels[] = [{
			gateId: "g", created: "t",
			maintainerVerdicts: [
				{ caseId: "gc-judge", caseVersion: 1, expectedByHuman: "accepted" },
				{ caseId: "gc-uncovered", caseVersion: 1, expectedByHuman: "accepted" }, // no scored row covers it
			],
		}];
		const gate = runGate(rows, [gc()], labels)!;
		expect(gate.agreement.unmatchedLabels).toBe(1);
		const report = renderEvalReport({ runId: "r", status: "success", configStamp: STAMP, s3: S3_ZERO, trajectoryRows: rows, finalResponseRows: [], assertions: [], degraded: false, summaryNote: "", gate });
		// F-08: bands read as anomaly positions, meaning owned by the bandMap.
		expect(report).toContain("ANOMALY positions");
		expect(report).toContain("bandMap");
		expect(report).toContain("band (anomaly position)");
		// F-09: the v1 face-coverage limitation is stated, not hidden.
		expect(report).toContain("judge + implementation targets only");
		// F-10: unmatched labels surfaced whenever > 0.
		expect(report).toContain("1 maintainer label(s) unmatched");
	});
});

describe("tripwires (P4/P6/§7 部分 5 — deterministic source contracts)", () => {
	const evalStageSrc = readFileSync(join(import.meta.dirname, "../src/evolution/eval-stage.ts"), "utf8");
	const workflowSrc = readFileSync(join(import.meta.dirname, "../src/workflow.ts"), "utf8");

	it("no-aggregate: the report renderer contains no single-score / weighted-aggregate machinery", () => {
		// Extract the renderEvalReport body (from its declaration to the next top-level section).
		const start = evalStageSrc.indexOf("export function renderEvalReport");
		const end = evalStageSrc.indexOf("// ── the orchestrator");
		const renderer = evalStageSrc.slice(start, end);
		expect(renderer.length).toBeGreaterThan(0);
		for (const banned of [/average/i, /weighted/i, /aggregate/i, /overall\s+score/i, /total\s+score/i, /\.reduce\(/, /mean\s*\(/]) {
			expect(renderer.match(banned), `renderer must not match ${banned}`).toBeNull();
		}
	});

	it("observational tripwire: eval-stage.ts imports ONLY read-only/ledger modules — nothing that mutates loop state", () => {
		const specifiers = [...evalStageSrc.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
		expect(specifiers.length).toBeGreaterThan(0);
		const allowed = new Set([
			"node:crypto", "node:fs", "node:path", "typebox",
			"./sigma-bands.ts", "./eval-layer.ts", "./eval-shared.ts", "../runlog.ts", "../render/super-dev-dir.ts", "../agents/agent-runtime.ts",
		]);
		for (const s of specifiers) expect(allowed.has(s), `unexpected import ${s} in eval-stage.ts (observational allowlist)`).toBe(true);
		// Belt and braces: the mutation-suspect modules are named and banned.
		for (const banned of ["implementation", "fault-classification", "stagnation", "replan", "./judge", "convergence", "inherited-red", "test-artifacts", "tracking"]) {
			expect(specifiers.some((s) => s.includes(banned)), `eval-stage.ts must not import ${banned}`).toBe(false);
		}
	});

	it("workflow wiring: the eval stage runs BEFORE the run.completed bracket (INV-L5) and is hermeticity-gated", () => {
		const evalIdx = workflowSrc.indexOf("await runEvalStage(");
		const completedIdx = workflowSrc.indexOf('type: "run.completed"');
		expect(evalIdx).toBeGreaterThan(-1);
		expect(completedIdx).toBeGreaterThan(-1);
		expect(evalIdx).toBeLessThan(completedIdx);
		expect(workflowSrc).toContain("if (evalStageEnabled())");
		// The metrics row keeps its single deriveS3Counters call site (shared const).
		expect(workflowSrc.match(/deriveS3Counters\(/g)).toHaveLength(1);
	});
});

// ─── eval-scorer agent registration consistency (mirrors register-agents tests) ──

describe("eval-scorer agent registration (REGISTERED_AGENTS ∪ file exists)", () => {
	it("is registered, read-only, and backed by a trim-clean prompt file (pi-subagents' validator)", () => {
		expect(REGISTERED_AGENTS).toContain(EVAL_SCORER_AGENT);
		expect(READ_ONLY_AGENTS.has(EVAL_SCORER_AGENT)).toBe(true);
		const promptPath = join(import.meta.dirname, "../agents/eval-scorer.md");
		expect(existsSync(promptPath)).toBe(true);
		const body = loadAgentBasePrompt(EVAL_SCORER_AGENT);
		expect(body.length).toBeGreaterThan(0);
		expect(body).toBe(body.trim()); // pi-subagents validateString: no leading/trailing whitespace
		expect(body).toContain("assertions");
		expect(body).toContain("absent");
		expect(body).toContain("READ-ONLY");
	});

	it("is NOT a mechanical classifier (capability agent: budgets and frontier-tier dispatch apply)", () => {
		// Structural pin: the role key the tool-budget chain resolves under.
		expect(EVAL_SCORER_AGENT).toBe("eval-scorer");
		expect(EVAL_SCORER_TIMEOUT_MS).toBe(240_000); // the research-assist per-call tier
	});
});

// ─── F-07: ONE runtime wiring test (real runWorkflow close-out) ────────────

describe("workflow wiring (F-07 — runtime execution with the stage enabled)", () => {
	/** Dispatch-stubbing note (F-07, documented per the ruling): a STUBBED
	 *  agent dispatch is infeasible at THIS seam — the wiring closes over
	 *  ctx.agent (run state: knowledge injection, user notes, budget, usage
	 *  accounting), and RunOptions deliberately has no injection point (the
	 *  eval scorer must ride the same delegation machinery as every
	 *  specialist, P4). Without the in-process event bus, ctx.agent fails
	 *  HONESTLY with the named infra error — this test uses that as the
	 *  deterministic degraded-dispatch outcome; the stubbed-dispatch contract
	 *  itself (happy path, throws, unusable control) is pinned by the
	 *  runEvalStage tests above. */
	function fakeSetupStage(specDir: string): Stage {
		return {
			id: "setup",
			label: "Setup",
			async run() {
				return { worktreePath: specDir, specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "01-t", worktreeCreated: false, initializedRepo: false } as never;
			},
		};
	}

	it("close-out runs the eval stage when enabled: eval.* events INSIDE the bracket, report + dataset rows land under the mocked home, and the frozen snapshot excludes the instrument (F-01)", async () => {
		const specDir = newDir("wiring-spec");
		const home = getSuperDevDir(); // the mocked tmp home — hermetic
		// Seed ONE rubric so the dispatch branch is reached (cold start would
		// skip it); the loaders read the mocked home.
		const rubricDir = join(home, "evals", "rubrics");
		mkdirSync(rubricDir, { recursive: true });
		writeFileSync(join(rubricDir, "rubric-w.json"), JSON.stringify({ ...rubricWire(), rubricId: "rubric-w" }), "utf8");
		delete process.env.SUPER_DEV_NO_EVAL_STAGE; // enable the stage for THIS test
		try {
			const wf: Workflow = {
				id: "w",
				root: sequence([
					task(fakeSetupStage(specDir)),
					task({ id: "classify", label: "Classify", run: async () => ({}) as never }),
				]),
			} as unknown as Workflow;
			const summary = await runWorkflow(wf, "t", {});
			// (a) eval.* events landed INSIDE the block — run.completed stays LAST (INV-L5).
			const events = readRunEvents(specDir);
			expect(events.some((e) => e.type === "eval.scored")).toBe(true);
			expect(events[events.length - 1]!.type).toBe("run.completed");
			// (b) the run report surface landed in the spec dir.
			expect(existsSync(join(specDir, EVAL_REPORT_BASENAME))).toBe(true);
			// (c) dataset rows landed under the MOCKED home (12 metric rows — no
			// cases seeded — plus the degraded final-response floor; the dispatch
			// failed honestly on the missing in-process event bus).
			const rows = readDatasetRows(join(home, "evals", "runs"));
			expect(rows.filter((r) => r.scorerKind === "trajectory")).toHaveLength(12);
			const degraded = rows.find((r) => r.scorerKind === "final-response" && r.scorerDegraded === true);
			expect(degraded).toBeDefined();
			expect(degraded!.verdict).toBe(HONEST_ABSENT);
			// (d) F-01 end-to-end: the run-metrics row carries the FROZEN pre-eval
			// snapshot (agentsSpawned 0) even though the scorer's own dispatch spent
			// a budget slot — the live summary count includes the instrument, the
			// measured row never does.
			const metricsRows = readFileSync(join(specDir, "run-metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { agentsSpawned: number });
			expect(metricsRows[metricsRows.length - 1]!.agentsSpawned).toBe(0);
			expect(summary.agentsSpawned).toBe(1);
		} finally {
			process.env.SUPER_DEV_NO_EVAL_STAGE = "1";
		}
	});
});
