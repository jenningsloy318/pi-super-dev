/**
 * P3 / D4 — the flywheel (src/evolution/flywheel.ts): DEC-13① premise gate,
 * zero-LLM proposal drafting (DEC-11② propose/apply split), DEC-13③
 * saturation retirement, DEC-13② discrimination check, DEC-13④ evolution
 * refresh, §8.3 M1 noteProposalApplied — plus the workflow close-out wiring
 * source-contract pins (the eval-stage test owns the stage-side pins).
 *
 * Hermetic by construction: every directory is an injected tmp dir; no LLM
 * anywhere (the flywheel is deterministic by contract — a dispatch stub
 * would be a category error here).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	runFlywheel, STREAK_N, DISCRIM_MIN_CASES, PROPOSAL_MIN_RUNS, PROPOSAL_NEW_RUNS,
	readFlywheelState, writeFlywheelState, noteProposalApplied, readRefreshMarker,
	computeCaseStates, caseObservations, checkDiscrimination, draftClusters,
	type FlywheelInput, type FlywheelState,
} from "../src/evolution/flywheel.ts";
import { validateGoldenCase, makeCanary, loadGoldenCases } from "../src/evolution/eval-layer.ts";
import { MIN_PRIOR_RUNS } from "../src/evolution/sigma-bands.ts";
import { SUPER_DEV_EXTENSION_VERSION } from "../src/version.ts";
import type { EvalRow } from "../src/evolution/eval-stage.ts";

let tmpRoot: string;
let seq = 0;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "sd-flywheel-")); });
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

/** Fresh per-test layout: {root}/{cases,runs,rubrics,labels,proposals,state}. */
function layout(name = "l") {
	const root = join(tmpRoot, `${name}-${++seq}`);
	const dirs = {
		root,
		cases: join(root, "cases"),
		runs: join(root, "runs"),
		labels: join(root, "labels"),
		proposals: join(root, "proposals"),
		state: join(root, "state.json"),
		marker: join(root, "refresh-pending"),
		ledger: join(root, "contamination.jsonl"),
		learnedIndex: join(root, "learned-index.json"),
	};
	for (const d of [dirs.cases, dirs.runs, dirs.labels, dirs.proposals]) mkdirSync(d, { recursive: true });
	return dirs;
}

/** Write a wire-form golden case file (validator-passing; the canary is
 *  embedded via makeCanary). */
function writeCase(casesDir: string, id: string, over: Record<string, unknown> = {}) {
	const wire = {
		id,
		title: `case ${id}`,
		source: "docs/requirements/sdlc-tips-adoption.md",
		target: "judge",
		scenario: `TODO scenario for ${id}\n${makeCanary(id)}`,
		expected: { verdict: "accepted", mustHold: ["holds"], mustNot: [] },
		caseVersion: 1,
		...over,
	};
	writeFileSync(join(casesDir, `${id}.json`), JSON.stringify(wire, null, "\t"), "utf8");
	return wire;
}

/** Append EvalRows to <runs>/rows.jsonl. */
function appendRows(runsDir: string, rows: EvalRow[]) {
	writeFileSync(join(runsDir, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "a" });
}

/** A trajectory metric row (no caseRef) — the clustering feed. */
function metricRow(runId: string, target: string, bandPosition: EvalRow["bandPosition"], over: Partial<EvalRow> = {}): EvalRow {
	return { ts: 1, runId, target, metric: "judgeAccepted", bandPosition, verdict: "honest-absent", scorerKind: "trajectory", configStamp: "cfg-a", ...over };
}

/** A scored case row. */
function caseRow(runId: string, caseId: string, verdict: string, over: Partial<EvalRow> = {}): EvalRow {
	return { ts: 1, runId, caseRef: caseId, caseVersion: 1, caseSet: "judge", target: "judge", verdict, scorerKind: "trajectory", configStamp: "cfg-a", ...over };
}

const FLY_INPUT = (dirs: ReturnType<typeof layout>, over: Partial<FlywheelInput> = {}): FlywheelInput => ({
	runId: "run-1",
	datasetDir: dirs.runs,
	casesDirPath: dirs.cases,
	labelsDirPath: dirs.labels,
	statePath: dirs.state,
	proposalsDirPath: dirs.proposals,
	refreshMarkerPathStr: dirs.marker,
	learnedIndexPath: dirs.learnedIndex,
	contaminationLedgerPathStr: dirs.ledger,
	ts: 1_000,
	...over,
});

// ─── DEC-13① premise gate ────────────────────────────────────────────────────

describe("flywheel — DEC-13① premise gate (F-01a: no single-run deadlock)", () => {
	it("gate never passed (no labels, no live gate) → NO auto-drafts, honest note", () => {
		const dirs = layout();
		// a drafting-worthy cluster exists (2 runs at 3σ)…
		appendRows(dirs.runs, [metricRow("r1", "judge", "3σ", { ts: 1 }), metricRow("r2", "judge", "3σ", { ts: 2 })]);
		const out = runFlywheel(FLY_INPUT(dirs));
		expect(out.gatePassed).toBe(false);
		expect(out.proposalsDrafted).toEqual([]);
		expect(readdirSync(dirs.proposals)).toEqual([]); // nothing drafted, on disk
		expect(out.notes.join(" ")).toContain("NO auto-drafts");
		expect(out.notes.join(" ")).toContain("no maintainer labels");
	});

	it("live miscalibrated posture BLOCKS drafting (a genuine signal, no fallback)", () => {
		const dirs = layout();
		appendRows(dirs.runs, [metricRow("r1", "judge", "3σ"), metricRow("r2", "judge", "3σ")]);
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: false, posture: "miscalibrated" } }));
		expect(out.gatePassed).toBe(false);
		expect(out.proposalsDrafted).toEqual([]);
		expect(out.gateReason).toContain("miscalibrated");
	});

	it("live calibrated posture arms drafting (the injected live decision is honored)", () => {
		const dirs = layout();
		appendRows(dirs.runs, [metricRow("r1", "judge", "3σ"), metricRow("r2", "judge", "3σ")]);
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" } }));
		expect(out.gatePassed).toBe(true);
		expect(out.proposalsDrafted).toHaveLength(1);
	});

	it("F-01a gate deadlock: live directional-only (or null) is NO SIGNAL — the ledger recompute decides (a single-run n=1 gate cannot freeze drafting)", () => {
		const dirs = layout();
		// An accumulating LEDGER with enough calibrated evidence to pass: 8
		// DISTINCT (caseId, caseVersion) pairs, all agreeing with their labels.
		const rows: EvalRow[] = [];
		for (let i = 1; i <= 8; i++) {
			writeCase(dirs.cases, `gc-${i}`);
			rows.push(caseRow(`run-${i}`, `gc-${i}`, "accepted", { ts: i }));
		}
		appendRows(dirs.runs, [...rows, metricRow("r1", "judge", "2σ", { ts: 90 }), metricRow("r2", "judge", "2σ", { ts: 91 })]);
		writeFileSync(join(dirs.labels, "gate-1.json"), JSON.stringify({
			gateId: "gate-1", created: "2026-09-11T00:00:00Z",
			maintainerVerdicts: Array.from({ length: 8 }, (_, i) => ({ caseId: `gc-${i + 1}`, caseVersion: 1, expectedByHuman: "accepted" })),
		}), "utf8");
		// …while the LIVE gate this run is directional-only (n=1 this run — the deadlock shape)
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: false, posture: "directional-only" } }));
		expect(out.gatePassed).toBe(true); // the ledger recompute carried the decision
		expect(out.gateReason).toContain("ledger recompute");
		expect(out.proposalsDrafted).toHaveLength(1);
		// and a null live gate (stage produced no gate) falls back identically
		const dirs2 = layout();
		for (let i = 1; i <= 8; i++) writeCase(dirs2.cases, `gc-${i}`);
		writeFileSync(join(dirs2.runs, "rows.jsonl"), readFileSync(join(dirs.runs, "rows.jsonl"), "utf8"), "utf8");
		writeFileSync(join(dirs2.labels, "gate-1.json"), readFileSync(join(dirs.labels, "gate-1.json"), "utf8"), "utf8");
		const out2 = runFlywheel(FLY_INPUT(dirs2, { gateDecision: null }));
		expect(out2.gatePassed).toBe(true);
	});

	it("no calibration signal ANYWHERE (live directional-only + empty ledger) stays blocked with an honest reason", () => {
		const dirs = layout();
		appendRows(dirs.runs, [metricRow("r1", "judge", "3σ"), metricRow("r2", "judge", "3σ")]);
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: false, posture: "directional-only" } }));
		expect(out.gatePassed).toBe(false);
		expect(out.gateReason).toContain("no calibration signal");
		expect(out.proposalsDrafted).toEqual([]);
	});
});

// ─── DEC-11② proposal drafting ───────────────────────────────────────────────

describe("flywheel — zero-LLM proposal drafting", () => {
	it("drafts one deterministic, validator-passing LONG-FORM skeleton per qualifying trajectory cluster (canary + provenance + TODO)", () => {
		const dirs = layout();
		appendRows(dirs.runs, [metricRow("r1", "judge", "2σ", { ts: 1 }), metricRow("r2", "judge", "2σ", { ts: 2 })]);
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" } }));
		expect(out.proposalsDrafted).toHaveLength(1);
		const file = out.proposalsDrafted[0]!;
		const proposal = JSON.parse(readFileSync(file, "utf8")) as {
			proposalId: string; kind: string; form: string; case: Record<string, unknown>;
			provenance: { runIds: string[]; configStamps: string[]; bandPosition?: string; rowCount: number }; gate: string;
		};
		expect(proposal.kind).toBe("golden-case-candidate");
		expect(proposal.form).toBe("long-form");
		expect(proposal.case.title).toContain("TODO(maintainer)");
		expect(String(proposal.case.scenario)).toContain("TODO(maintainer)");
		expect(String(proposal.case.scenario)).toContain(makeCanary(String(proposal.case.id)));
		expect(String(proposal.case.scenario)).toContain("run(s) r1, r2"); // provenance facts, deterministic
		expect(proposal.provenance).toMatchObject({ runIds: ["r1", "r2"], bandPosition: "2σ", configStamps: ["cfg-a"], rowCount: 2 });
		expect(proposal.gate).toContain("human gate");
		// the embedded case passes the REAL validator (template/validator parity)
		expect(validateGoldenCase(proposal.case).ok).toBe(true);
		// a judge-target skeleton carries a judge-admitted verdict (F6)
		expect((proposal.case.expected as { verdict: string }).verdict).toBe("accepted");
	});

	it("F-09: final-response clusters draft SHORT-FORM — no invented target/expected, marked non-validating", () => {
		const dirs = layout();
		appendRows(dirs.runs, [
			{ ts: 1, runId: "r1", target: "run", metric: "honesty", rubricId: "rub-x", rubricVersion: "1", verdict: "fail", scorerKind: "final-response", configStamp: "cfg-a" },
			{ ts: 2, runId: "r2", target: "run", metric: "honesty", rubricId: "rub-x", rubricVersion: "1", verdict: "fail", scorerKind: "final-response", configStamp: "cfg-a" },
		]);
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" } }));
		expect(out.proposalsDrafted).toHaveLength(1);
		const proposal = JSON.parse(readFileSync(out.proposalsDrafted[0]!, "utf8")) as {
			form: string; case: Record<string, unknown>; gate: string; provenance: { configStamps: string[]; rubricId?: string; dimension?: string };
		};
		expect(proposal.form).toBe("short-form");
		expect(String(proposal.case.target)).toContain("TODO(maintainer)");
		expect(String((proposal.case.expected as { verdict: unknown }).verdict)).toContain("TODO(maintainer)");
		expect(proposal.gate).toContain("SHORT-FORM");
		expect(proposal.gate).toContain("will NOT validate");
		expect(proposal.provenance).toMatchObject({ configStamps: ["cfg-a"], rubricId: "rub-x", dimension: "honesty" });
		// the documented relaxation: a short-form skeleton deliberately does NOT validate
		expect(validateGoldenCase(proposal.case).ok).toBe(false);
	});

	it("final-response fail rows cluster by (rubricId, dimension); pass/honest-absent rows never do", () => {
		const rows: EvalRow[] = [
			{ ts: 1, runId: "r1", target: "run", metric: "honesty", rubricId: "rub-x", rubricVersion: "1", verdict: "fail", scorerKind: "final-response", configStamp: "cfg-a" },
			{ ts: 2, runId: "r2", target: "run", metric: "honesty", rubricId: "rub-x", rubricVersion: "1", verdict: "fail", scorerKind: "final-response", configStamp: "cfg-a" },
			{ ts: 3, runId: "r3", target: "run", metric: "fidelity", rubricId: "rub-x", rubricVersion: "1", verdict: "pass", scorerKind: "final-response", configStamp: "cfg-a" },
		];
		const clusters = draftClusters(rows, new Set());
		expect(clusters).toHaveLength(1);
		expect(clusters[0]).toMatchObject({ axis: "final-response-dimension", rubricId: "rub-x", dimension: "honesty", configStamp: "cfg-a" });
	});

	it("F-03: rows under DIFFERENT configStamps never bundle into one cluster (no cross-config proposals)", () => {
		const rows: EvalRow[] = [
			metricRow("r1", "judge", "2σ", { configStamp: "cfg-a" }),
			metricRow("r2", "judge", "2σ", { configStamp: "cfg-a" }),
			metricRow("r3", "judge", "2σ", { configStamp: "cfg-b" }),
			metricRow("r4", "judge", "2σ", { configStamp: "cfg-b" }),
		];
		const clusters = draftClusters(rows, new Set());
		expect(clusters).toHaveLength(2);
		expect(new Set(clusters.map((c) => c.configStamp))).toEqual(new Set(["cfg-a", "cfg-b"]));
	});

	it("in-band / no-band / single-run / degraded clusters never draft", () => {
		const rows: EvalRow[] = [
			metricRow("r1", "judge", "in-band"),
			metricRow("r1", "judge", "no-band"),
			metricRow("r1", "judge", "3σ"), // single run — below PROPOSAL_MIN_RUNS
			metricRow("r1", "judge", "3σ", { scorerDegraded: true }),
			metricRow("r2", "judge", "3σ", { scorerDegraded: true }),
		];
		expect(draftClusters(rows, new Set())).toHaveLength(0);
		expect(PROPOSAL_MIN_RUNS).toBe(2);
	});

	it("F-02 registry: a re-run with the SAME evidence does not re-draft (cluster registered — survives even a maintainer mv)", () => {
		const dirs = layout();
		appendRows(dirs.runs, [metricRow("r1", "judge", "2σ"), metricRow("r2", "judge", "2σ")]);
		const first = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" }, ts: 1 }));
		// maintainer edits the draft AND the registry is keyed by cluster — even
		// after mv-ing the file away, the registry still knows the cluster
		const file = first.proposalsDrafted[0]!;
		writeFileSync(file, readFileSync(file, "utf8").replace("TODO(maintainer): case title", "MAINTAINER TITLE"), "utf8");
		const second = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" }, ts: 2 }));
		expect(second.proposalsDrafted).toEqual([]);
		expect(second.proposalsSkippedRegistered).toHaveLength(1); // the registry (not file existence) gated it
		expect(readFileSync(file, "utf8")).toContain("MAINTAINER TITLE"); // untouched
		// state.json carries the registry entry
		const state = JSON.parse(readFileSync(dirs.state, "utf8")) as FlywheelState;
		expect(Object.values(state.proposalClusters)).toHaveLength(1);
		expect(Object.values(state.proposalClusters)[0]).toMatchObject({ runIds: ["r1", "r2"] });
	});

	it(`F-02 registry: ≥ PROPOSAL_NEW_RUNS=${PROPOSAL_NEW_RUNS} NEW runIds re-draft as a FRESH file (reject-then-reevidence); below the bar stays skipped`, () => {
		const dirs = layout();
		appendRows(dirs.runs, [metricRow("r1", "judge", "2σ"), metricRow("r2", "judge", "2σ")]);
		const first = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" }, ts: 1 }));
		expect(first.proposalsDrafted).toHaveLength(1);
		// the registry advances ONLY on drafts: adding r3+r4 (2 new < the bar) skips
		// and leaves the registered set at {r1, r2} — the delta is "since the LAST DRAFT".
		appendRows(dirs.runs, [metricRow("r3", "judge", "2σ"), metricRow("r4", "judge", "2σ")]);
		const second = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" }, ts: 2 }));
		expect(second.proposalsDrafted).toEqual([]); // 2 new < PROPOSAL_NEW_RUNS
		expect(second.proposalsSkippedRegistered).toHaveLength(1);
		// the third new run crosses the bar (3 new since the last draft) → a FRESH
		// draft (new id via runIds), old file untouched
		appendRows(dirs.runs, [metricRow("r5", "judge", "2σ")]);
		const third = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" }, ts: 3 }));
		expect(third.proposalsDrafted).toHaveLength(1);
		const state = JSON.parse(readFileSync(dirs.state, "utf8")) as FlywheelState;
		const record = Object.values(state.proposalClusters)[0]!;
		expect(record.runIds).toEqual(["r1", "r2", "r3", "r4", "r5"]); // the union — the next delta is measured against ALL evidence
		expect(existsSync(first.proposalsDrafted[0]!)).toBe(true); // old draft never clobbered
		expect(third.proposalsDrafted[0]!).not.toBe(first.proposalsDrafted[0]!);
	});
});

// ─── DEC-13③ saturation ──────────────────────────────────────────────────────

describe("flywheel — saturation retirement", () => {
	it(`STREAK_N=${STREAK_N} consecutive agreeing scored runs saturate; the case file is NEVER deleted`, () => {
		const dirs = layout();
		writeCase(dirs.cases, "gc-a");
		const rows = Array.from({ length: STREAK_N }, (_, i) => caseRow(`run-${i + 1}`, "gc-a", "accepted", { ts: i + 1 }));
		appendRows(dirs.runs, rows);
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" } }));
		expect(out.saturated).toEqual(["gc-a"]);
		expect(out.notes.join(" ")).toContain("SATURATED");
		expect(out.notes.join(" ")).toContain("never deleted");
		// STILL the regression baseline: the case file stays, and stays scoreable
		expect(existsSync(join(dirs.cases, "gc-a.json"))).toBe(true);
		const loaded = loadGoldenCases(dirs.cases);
		expect(loaded.cases.map((c) => c.id)).toEqual(["gc-a"]);
		// persisted state carries the lifecycle
		const state = JSON.parse(readFileSync(dirs.state, "utf8")) as FlywheelState;
		expect(state.cases["gc-a"]).toMatchObject({ streak: STREAK_N, saturated: true, observedRuns: STREAK_N });
	});

	it("first disagreement UN-SATURATES and resets the streak (honest-absent breaks it too)", () => {
		const dirs = layout();
		writeCase(dirs.cases, "gc-a");
		appendRows(dirs.runs, [
			...Array.from({ length: STREAK_N }, (_, i) => caseRow(`run-${i + 1}`, "gc-a", "accepted", { ts: i + 1 })),
			caseRow("run-late", "gc-a", "discarded", { ts: 999 }),
		]);
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" } }));
		expect(out.saturated).toEqual([]);
		expect(out.unsaturated).toEqual([]); // it never saturated in the same pass — computed atomically
		const state = JSON.parse(readFileSync(dirs.state, "utf8")) as FlywheelState;
		expect(state.cases["gc-a"]!.saturated).toBe(false);
		expect(state.cases["gc-a"]!.streak).toBe(0);
		// honest-absent is not green: it also resets
		const states = computeCaseStates([caseRow("r1", "gc-a", "accepted"), caseRow("r2", "gc-a", "honest-absent")], loadGoldenCases(dirs.cases).cases);
		expect(states["gc-a"]!.streak).toBe(0);
	});

	it("saturated cases are excluded from the drafting signal (but metric-row clusters still draft)", () => {
		const dirs = layout();
		writeCase(dirs.cases, "gc-a");
		const saturatedRows: EvalRow[] = [
			// the saturated case's rows sit at an anomaly position on 3 runs —
			// without the exclusion these would form a drafting cluster
			...Array.from({ length: STREAK_N }, (_, i) => caseRow(`run-${i + 1}`, "gc-a", "accepted", { ts: i + 1, bandPosition: "3σ", metric: "judgeAccepted" })),
			caseRow("run-x", "gc-a", "accepted", { ts: 100, bandPosition: "3σ", metric: "judgeAccepted", runId: "run-x" }),
		];
		const states = computeCaseStates(saturatedRows, loadGoldenCases(dirs.cases).cases);
		expect(states["gc-a"]!.saturated).toBe(true);
		expect(draftClusters(saturatedRows, new Set(["gc-a"]))).toHaveLength(0); // excluded
		expect(draftClusters(saturatedRows, new Set())).toHaveLength(1); // the counterfactual pin
	});

	it("caseObservations: last row per run wins; older-revision rows never mix (M2)", () => {
		const obs = caseObservations([
			caseRow("r1", "gc-a", "discarded", { ts: 1 }),
			caseRow("r1", "gc-a", "accepted", { ts: 5 }), // same run, later — wins
			caseRow("r2", "gc-a", "accepted", { ts: 6, caseVersion: 2 }), // revision 2 — not mixed below
		], "gc-a");
		expect(obs).toHaveLength(2);
		expect(obs[0]).toMatchObject({ runId: "r1", verdict: "accepted" });
	});

	it("F-08: scorerDegraded rows FREEZE the streak (neither agreement nor disagreement — the run contributes no observation)", () => {
		const dirs = layout();
		writeCase(dirs.cases, "gc-a");
		// 3 agreeing runs, then a DEGRADED run, then another agreeing run — the
		// degraded row must not reset the streak (frozen at 3, then +1 → 4, NOT reset).
		const states = computeCaseStates([
			caseRow("r1", "gc-a", "accepted", { ts: 1 }),
			caseRow("r2", "gc-a", "accepted", { ts: 2 }),
			caseRow("r3", "gc-a", "accepted", { ts: 3 }),
			caseRow("r-degraded", "gc-a", "honest-absent", { ts: 4, scorerDegraded: true }),
			caseRow("r5", "gc-a", "accepted", { ts: 5 }),
		], loadGoldenCases(dirs.cases).cases);
		expect(states["gc-a"]!.streak).toBe(4); // 3 + 1 (the degraded run is invisible), NOT reset
		expect(states["gc-a"]!.observedRuns).toBe(4); // the degraded run is not an observation
	});
});

// ─── DEC-13② discrimination ──────────────────────────────────────────────────

describe("flywheel — discrimination check (paired across configStamps)", () => {
	it(`indistinguishable distributions on ≥ DISCRIM_MIN_CASES shared cases fire the advisory`, () => {
		expect(DISCRIM_MIN_CASES).toBe(MIN_PRIOR_RUNS);
		const rows: EvalRow[] = [];
		for (let i = 0; i < DISCRIM_MIN_CASES; i++) {
			rows.push(caseRow("ra1", `gc-${i}`, "accepted", { configStamp: "cfg-a", ts: i }));
			rows.push(caseRow("ra2", `gc-${i}`, "accepted", { configStamp: "cfg-a", ts: i }));
			rows.push(caseRow("rb1", `gc-${i}`, "accepted", { configStamp: "cfg-b", ts: i }));
			rows.push(caseRow("rb2", `gc-${i}`, "accepted", { configStamp: "cfg-b", ts: i }));
		}
		const out = checkDiscrimination(rows);
		expect(out.advisories).toHaveLength(1);
		expect(out.advisories[0]).toContain("lacks discrimination");
		expect(out.advisories[0]).toContain("do NOT artificially harden");
		expect(out.advisories[0]).toContain("cfg-a vs cfg-b");
	});

	it("separable distributions stay silent; below the case floor stays silent", () => {
		const separable: EvalRow[] = [];
		for (let i = 0; i < DISCRIM_MIN_CASES; i++) {
			separable.push(caseRow("ra1", `gc-${i}`, "accepted", { configStamp: "cfg-a" }));
			separable.push(caseRow("rb1", `gc-${i}`, i % 2 === 0 ? "accepted" : "discarded", { configStamp: "cfg-b" }));
		}
		expect(checkDiscrimination(separable).advisories).toEqual([]);
		const few: EvalRow[] = [];
		for (let i = 0; i < DISCRIM_MIN_CASES - 1; i++) {
			few.push(caseRow("ra1", `gc-${i}`, "accepted", { configStamp: "cfg-a" }));
			few.push(caseRow("rb1", `gc-${i}`, "accepted", { configStamp: "cfg-b" }));
		}
		expect(checkDiscrimination(few).advisories).toEqual([]);
	});

	it("runFlywheel surfaces discrimination advisories in its notes (report line only)", () => {
		const dirs = layout();
		const rows: EvalRow[] = [];
		for (let i = 0; i < DISCRIM_MIN_CASES; i++) {
			rows.push(caseRow("ra1", `gc-${i}`, "accepted", { configStamp: "cfg-a", ts: i }));
			rows.push(caseRow("rb1", `gc-${i}`, "accepted", { configStamp: "cfg-b", ts: i }));
		}
		appendRows(dirs.runs, rows);
		const out = runFlywheel(FLY_INPUT(dirs));
		expect(out.discriminationAdvisories).toHaveLength(1);
		expect(out.notes.join(" ")).toContain("lacks discrimination");
	});
});

// ─── DEC-13④ evolution refresh ───────────────────────────────────────────────

describe("flywheel — evolution refresh", () => {
	it("version wave flags ALL cases (conservative default) and writes refresh-pending", () => {
		const dirs = layout();
		writeCase(dirs.cases, "gc-a");
		writeCase(dirs.cases, "gc-b");
		// state last saw an older version
		writeFlywheelState(dirs.state, { schema: 1, lastSeenExtensionVersion: "0.3.89", cases: {}, proposalApplied: [], proposalClusters: {} });
		const out = runFlywheel(FLY_INPUT(dirs, { extensionVersion: "0.3.90" }));
		expect(out.refreshFlagged).toEqual(["gc-a", "gc-b"]);
		const marker = readRefreshMarker(dirs.marker);
		expect(marker).toMatchObject({ previousVersion: "0.3.89", currentVersion: "0.3.90", changedModules: null, flaggedCases: ["gc-a", "gc-b"] });
		// the marker persists across runs until the maintainer clears it
		const again = runFlywheel(FLY_INPUT(dirs, { extensionVersion: "0.3.90" }));
		expect(again.refreshFlagged).toBeNull(); // no NEW wave
		expect(again.refreshPendingSince).toBe(1_000);
		expect(again.notes.join(" ")).toContain("PENDING");
	});

	it("a changed-modules list narrows the flag by target heuristic", () => {
		const dirs = layout();
		writeCase(dirs.cases, "gc-judge"); // target judge
		writeCase(dirs.cases, "gc-impl", { target: "implementation" });
		writeFlywheelState(dirs.state, { schema: 1, lastSeenExtensionVersion: "0.3.89", cases: {}, proposalApplied: [], proposalClusters: {} });
		const out = runFlywheel(FLY_INPUT(dirs, { extensionVersion: "0.3.90", changedModules: ["src/stages/implementation.ts"] }));
		expect(out.refreshFlagged).toEqual(["gc-impl"]);
	});

	it("F-10: an EMPTY changed-modules list flags NO cases; null/absent flags ALL (the ternary no longer conflates them)", () => {
		const dirs = layout();
		writeCase(dirs.cases, "gc-a");
		writeCase(dirs.cases, "gc-b");
		writeFlywheelState(dirs.state, { schema: 1, lastSeenExtensionVersion: "0.3.89", cases: {}, proposalApplied: [], proposalClusters: {} });
		const out = runFlywheel(FLY_INPUT(dirs, { extensionVersion: "0.3.90", changedModules: [] }));
		expect(out.refreshFlagged).toEqual([]); // the caller KNEW nothing relevant changed
		const marker = readRefreshMarker(dirs.marker);
		expect(marker).toMatchObject({ changedModules: [], flaggedCases: [] }); // distinguishable from null
	});

	it("no version change → no wave, no marker", () => {
		const dirs = layout();
		writeCase(dirs.cases, "gc-a");
		const out = runFlywheel(FLY_INPUT(dirs, { extensionVersion: "0.3.90" }));
		expect(out.refreshFlagged).toBeNull();
		expect(existsSync(dirs.marker)).toBe(false);
	});
});

// ─── §8.3 M1 baseline re-key stamp ───────────────────────────────────────────

describe("flywheel — noteProposalApplied (M1 stamp)", () => {
	it("stamps state.json so P4-era banding consumers know baselines must re-key", () => {
		const dirs = layout();
		runFlywheel(FLY_INPUT(dirs)); // creates the state file
		const stamp = noteProposalApplied("judge", { statePath: dirs.state, ts: 4_242 });
		expect(stamp).toEqual({ caseSet: "judge", appliedAt: 4_242 });
		const state = readFlywheelState(dirs.state);
		expect(state.proposalApplied).toEqual([{ caseSet: "judge", appliedAt: 4_242 }]);
	});
});

// ─── fail-open + determinism ─────────────────────────────────────────────────

describe("flywheel — fail-open (P4/P5)", () => {
	it("corrupt rows.jsonl lines are named discards; corrupt state rebuilds; never throws", () => {
		const dirs = layout();
		writeFileSync(join(dirs.runs, "rows.jsonl"), "{ not json\n" + JSON.stringify(metricRow("r1", "judge", "3σ")) + "\n", "utf8");
		writeFileSync(dirs.state, "{ corrupt", "utf8");
		const out = runFlywheel(FLY_INPUT(dirs, { gateDecision: { passed: true, posture: "calibrated" } }));
		expect(out.proposalsDrafted).toEqual([]); // single valid row < PROPOSAL_MIN_RUNS
		const state = readFlywheelState(dirs.state);
		expect(state.lastSeenExtensionVersion).toBe(SUPER_DEV_EXTENSION_VERSION); // rebuilt default
	});

	it("deterministic: identical inputs → identical outcome notes (no LLM, no drift)", () => {
		const a = layout("det-a");
		const b = layout("det-b");
		for (const dirs of [a, b]) {
			writeCase(dirs.cases, "gc-a");
			appendRows(dirs.runs, Array.from({ length: STREAK_N }, (_, i) => caseRow(`run-${i + 1}`, "gc-a", "accepted", { ts: i + 1 })));
		}
		const outA = runFlywheel(FLY_INPUT(a, { gateDecision: { passed: true, posture: "calibrated" }, ts: 5 }));
		const outB = runFlywheel(FLY_INPUT(b, { gateDecision: { passed: true, posture: "calibrated" }, ts: 5 }));
		expect(outA.notes).toEqual(outB.notes);
		expect(readFileSync(a.state, "utf8")).toBe(readFileSync(b.state, "utf8"));
	});
});

// ─── workflow close-out wiring (source contract) ─────────────────────────────

describe("workflow wiring — the flywheel + reread check at close-out", () => {
	const workflowSrc = readFileSync(fileURLToPath(new URL("../src/workflow.ts", import.meta.url)), "utf8");

	it("runFlywheel runs AFTER the eval stage, inside the evalStageEnabled() guard (same kill-switch class)", () => {
		const evalIdx = workflowSrc.indexOf("await runEvalStage(");
		const flywheelIdx = workflowSrc.indexOf("runFlywheel({");
		const completedIdx = workflowSrc.indexOf('type: "run.completed"');
		expect(evalIdx).toBeGreaterThan(-1);
		expect(flywheelIdx).toBeGreaterThan(evalIdx); // after the stage
		expect(completedIdx).toBeGreaterThan(flywheelIdx); // still inside the run bracket (INV-L5)
		const guard = workflowSrc.indexOf("runFlywheel({");
		const preceding = workflowSrc.lastIndexOf("if (evalStageEnabled())", guard);
		expect(preceding).toBeGreaterThan(-1);
	});

	it("the live gate decision rides into the flywheel as {passed, posture} (F-01a seam)", () => {
		expect(workflowSrc).toContain("evalGateDecision = evalOutcome.gate !== null");
		expect(workflowSrc).toContain("passed: evalOutcome.gate.decision.passes, posture: evalOutcome.gate.decision.posture");
		expect(workflowSrc).toContain("gateDecision: evalGateDecision,");
	});

	it("the reread check is wired with the VERIFIED upstream-artifact doc paths (F-04) and only emits the event on findings", () => {
		expect(workflowSrc).toContain("runRereadCheck({ specDir: state.setup?.specDirectory, injectedPaths })");
		expect(workflowSrc).toContain("const injectedPaths = upstreamArtifactDocPaths({");
		expect(workflowSrc).not.toContain("phaseClauseFiles"); // F-04: deliverables are WRITTEN, not injected
		expect(workflowSrc).toContain('type: "eval.reread"');
		const emitIdx = workflowSrc.indexOf('type: "eval.reread"');
		expect(workflowSrc.lastIndexOf("reread.findings.length > 0", emitIdx)).toBeGreaterThan(-1);
	});
});
