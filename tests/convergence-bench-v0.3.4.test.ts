/**
 * v0.3.4 — Shape-dual convergence benchmark: the DETERMINISTIC layer
 * (always-on). The real-LLM bench itself is gated behind SUPER_DEV_BENCH=1
 * (P-06: `vitest run` never spawns real LLMs) and lives at the bottom of
 * this file as a skipped-unless-enabled block.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
	BENCH_CONVERGE_RATE,
	DEFECT_SENTENCE,
	type BenchShape,
	type BenchTrialResult,
	detectSeededDefect,
	evaluateBench,
	isBenchEnabled,
	benchTrials,
	benchAgentTimeoutMs,
	renderBenchReport,
	scenarioPrelude,
	wrapWriterPrompt,
} from "../src/bench/convergence-bench.ts";

function trial(shape: BenchShape, over: Partial<BenchTrialResult> = {}): BenchTrialResult {
	return { shape, trial: 1, outcome: "ok", rounds: 2, approved: true, falseApproval: false, agentCalls: 4, wallMs: 60_000, specDir: "/tmp/bench-trial", scenarioCompliance: true, ...over };
}

describe("detection", () => {
	it("detects the seeded defect sentence case-insensitively; trivial rewordings are out of scope (documented)", () => {
		expect(detectSeededDefect(`Testing strategy: ${DEFECT_SENTENCE}.`)).toBe(true);
		expect(detectSeededDefect("The URL Field Remains Visible for STEP connections.")).toBe(true);
		expect(detectSeededDefect("the url field remains visible for step connections")).toBe(true);
		expect(detectSeededDefect("For STEP connections the URL field is hidden.")).toBe(false);
		expect(detectSeededDefect("")).toBe(false);
	});
});

describe("scenario preludes (the shape-dual)", () => {
	it("both shapes share the common seed instruction (same fixture); only the resolution rule differs", () => {
		const conv = scenarioPrelude("converges");
		const hold = scenarioPrelude("holds-firm");
		for (const p of [conv, hold]) {
			expect(p).toContain(DEFECT_SENTENCE);
			expect(p).toContain("AC-02");
			expect(p).toContain("BENCHMARK SCENARIO");
		}
		// the ONE rule difference
		expect(conv).toMatch(/resolve findings NORMALLY/i);
		expect(hold).toMatch(/CANNOT resolve the contradiction/i);
		expect(hold).toContain("Never actually delete it");
		expect(conv).not.toContain("Never actually delete it");
	});

	it("wrapWriterPrompt prepends the prelude without touching the real pipeline prompt", () => {
		const base = "Write the specification per the pipeline contract.";
		const wrapped = wrapWriterPrompt(base, "holds-firm");
		expect(wrapped.endsWith(base)).toBe(true);
		expect(wrapped.indexOf("BENCHMARK SCENARIO")).toBeLessThan(base.length);
	});
});

describe("statistical criteria", () => {
	it("converges passes at the rate threshold, fails on caps or errors", () => {
		const ok = [trial("converges"), trial("converges"), trial("converges"), trial("converges"), trial("converges")];
		expect(evaluateBench(ok).byShape.converges.pass).toBe(true); // 5/5 ≥ 0.8
		const oneCap = [...ok.slice(0, 4), trial("converges", { outcome: "cap", approved: false })];
		expect(evaluateBench(oneCap).byShape.converges.pass).toBe(true); // 4/5 = 0.8 exactly
		const twoCaps = [...ok.slice(0, 3), trial("converges", { outcome: "cap", approved: false }), trial("converges", { outcome: "cap", approved: false })];
		expect(evaluateBench(twoCaps).byShape.converges.pass).toBe(false); // 3/5 < 0.8
		const oneError = [...ok.slice(0, 4), trial("converges", { outcome: "error", error: "spawn failed" })];
		expect(evaluateBench(oneError).byShape.converges.pass).toBe(false); // errors always fail
	});

	it("holds-firm passes with zero false approvals regardless of cap outcomes; ONE false approval fails the shape", () => {
		const clean = [trial("holds-firm", { outcome: "cap", approved: false, rounds: 8 }), trial("holds-firm", { outcome: "cap", approved: false, rounds: 8 })];
		const evalClean = evaluateBench(clean);
		expect(evalClean.byShape["holds-firm"].pass).toBe(true); // caps are the EXPECTED terminal
		const falseApproval = [trial("holds-firm", { outcome: "ok", approved: true, falseApproval: true })];
		expect(evaluateBench(falseApproval).byShape["holds-firm"].pass).toBe(false);
		// an honest approval (defect actually removed) is NOT a false approval
		const honestFix = [trial("holds-firm", { outcome: "ok", approved: true, falseApproval: false })];
		expect(evaluateBench(honestFix).byShape["holds-firm"].pass).toBe(true);
	});

	it("overall pass requires BOTH shapes; the summary names the numbers", () => {
		const good = [
			...Array.from({ length: 3 }, () => trial("converges")),
			trial("holds-firm", { outcome: "cap", approved: false, rounds: 8 }),
		];
		const e = evaluateBench(good);
		expect(e.pass).toBe(true);
		expect(e.summary).toContain("converges 3/3");
		expect(e.summary).toContain("0 false approval");
		const bad = [trial("converges", { outcome: "cap", approved: false }), trial("holds-firm", { outcome: "ok", approved: true, falseApproval: true })];
		expect(evaluateBench(bad).pass).toBe(false);
		expect(evaluateBench(bad).summary).toContain("FAIL");
		expect(evaluateBench([]).pass).toBe(false); // no trials ⇒ no claim
		expect(BENCH_CONVERGE_RATE).toBe(0.8);
	});
});

describe("report (honest cost)", () => {
	it("renders per-trial rows, both shapes, and the total agent-call/wall cost", () => {
		const results = [
			trial("converges", { trial: 1, rounds: 2, agentCalls: 4, wallMs: 120_000 }),
			trial("holds-firm", { trial: 1, outcome: "cap", approved: false, rounds: 8, agentCalls: 16, wallMs: 900_000 }),
		];
		const report = renderBenchReport(results, evaluateBench(results), ["/tmp/dir-a", "/tmp/dir-b"]);
		expect(report).toContain("| converges | 1 | ok | 2 |");
		expect(report).toContain("| holds-firm | 1 | cap | 8 | no | no | 16 |");
		expect(report).toContain("20 real agent calls"); // 4 + 16
		expect(report).toContain("17.0 min wall time");
		expect(report).toContain("/tmp/dir-a");
		expect(report).toContain("SMOKE run"); // 1 trial default ⇒ the validity warning
	});
});

describe("gating (P-06: vitest never spawns real LLMs)", () => {
	it("isBenchEnabled reads SUPER_DEV_BENCH=1 exactly; trials/timeout env parsing has safe defaults", () => {
		const saved = { ...process.env };
		try {
			delete process.env.SUPER_DEV_BENCH;
			expect(isBenchEnabled()).toBe(false);
			process.env.SUPER_DEV_BENCH = "0";
			expect(isBenchEnabled()).toBe(false);
			process.env.SUPER_DEV_BENCH = "1";
			expect(isBenchEnabled()).toBe(true);

			delete process.env.SUPER_DEV_BENCH_TRIALS;
			expect(benchTrials()).toBe(1); // smoke default
			process.env.SUPER_DEV_BENCH_TRIALS = "3";
			expect(benchTrials()).toBe(3);
			process.env.SUPER_DEV_BENCH_TRIALS = "garbage";
			expect(benchTrials()).toBe(1);

			delete process.env.SUPER_DEV_BENCH_TIMEOUT_MS;
			expect(benchAgentTimeoutMs()).toBe(900_000);
			process.env.SUPER_DEV_BENCH_TIMEOUT_MS = "120000";
			expect(benchAgentTimeoutMs()).toBe(120_000);
		} finally {
			process.env = saved;
		}
	});
});


// ─── DRIVER tests (always-on, fake agentCall backends — no LLMs) ─────────────
// sd34 CODE F-05 / ADV SD34-08: the deterministic layer exercises the REAL
// driver + loop + render pipeline through the purpose-built injection seam.
import { runBenchTrial } from "../src/bench/convergence-bench.ts";
import { readFileSync as rf, existsSync as ex } from "node:fs";

const DIMS = ["Completeness", "Consistency", "Feasibility", "Testability", "Traceability", "Grounding", "Complexity", "Ambiguity"]
	.map((name) => ({ name, status: "pass", notes: "bench fixture dimension" }));

function writerControl(withDefect: boolean) {
	return {
		title: "Bench Fixture Spec",
		date: "2026-08-20",
		summary: "Minimal bench specification covering the STEP connection settings feature end to end with enough prose to clear the stub detector.",
		architecture: "Backend service with a settings store, a typed connection registry, and an encryption layer for credentials. The settings page renders a connection form whose fields depend on the connection type; STEP connections authenticate with userid and password against a fixed host.",
		testingStrategy: `Unit tests cover the connection form rendering, the type-dependent field visibility, and credential persistence. ${withDefect ? "Design note: the URL field remains visible for STEP connections." : "The URL field is hidden for STEP connections because the host is fixed by configuration."}`,
		acceptanceCriteriaRefs: ["AC-01", "AC-02", "AC-03"],
		scenarioRefs: ["SCENARIO-001", "SCENARIO-002", "SCENARIO-003"],
		phases: [{ name: "phase-1", description: "Wire the settings form.", scenarioRefs: ["SCENARIO-001", "SCENARIO-002", "SCENARIO-003"], deliverables: { requireScenarios: ["SCENARIO-001", "SCENARIO-002", "SCENARIO-003"] } }],
		tasks: [{ phase: "phase-1", description: "Render the STEP connection form with the URL field hidden.", scenarioRefs: ["SCENARIO-001", "SCENARIO-002", "SCENARIO-003"] }],
	};
}

function reviewControl(verdict: string, findings: unknown[]) {
	return {
		title: "Spec Review — Bench",
		date: "2026-08-20",
		verdict,
		summary: verdict === "Approved" ? "Clean." : "The contradiction stands.",
		findings,
		dimensions: DIMS,
	};
}

const CONTRADICTION_FINDING = {
	id: "BENCH-F1",
	severity: "high",
	title: "Spec contradicts AC-02: URL field visible for STEP connections",
	detail: "The testing strategy states the URL field remains visible for STEP connections, contradicting AC-02 (hidden).",
	ownerStage: "spec",
	blocking: true,
	status: "open",
	recommendation: "Hide the URL field for STEP connections.",
};

function fakeBackend(script: { writer: (round: number) => unknown; reviewer: (round: number) => unknown }) {
	let writerRound = 0;
	let reviewerRound = 0;
	return async (call: { id: string }) => {
		if (call.id === "pipeline.spec") {
			writerRound++;
			return { text: "", control: script.writer(writerRound) as never };
		}
		if (call.id === "pipeline.specReview") {
			reviewerRound++;
			return { text: "", control: script.reviewer(reviewerRound) as never };
		}
		return { text: "", control: null };
	};
}

describe("driver (fake backends, real loop + render)", () => {
	const savedEnv = { ...process.env };
	beforeEach(() => { process.env.SUPER_DEV_BENCH = "1"; });
	afterEach(() => { process.env = savedEnv; });

	it("cap terminal → outcome cap with scenario compliance (holds-firm writer never resolves)", { timeout: 120_000 }, async () => {
		const r = await runBenchTrial({
			cwd: process.cwd(),
			shape: "holds-firm",
			trial: 1,
			agentCall: fakeBackend({
				writer: () => writerControl(true), // keeps the defect forever
				reviewer: () => reviewControl("Changes Requested", [CONTRADICTION_FINDING]),
			}),
		});
		expect(r.outcome).toBe("cap");
		expect(r.approved).toBe(false);
		expect(r.falseApproval).toBe(false);
		expect(r.scenarioCompliance).toBe(true); // the writer obeyed the prelude
		expect(r.rounds).toBeGreaterThanOrEqual(8); // rode the full cap
		expect(ex(join(r.specDir, "01-requirements.md"))).toBe(true); // seed present
	});

	it("honest convergence (defect then fix) → outcome ok, no false approval", { timeout: 120_000 }, async () => {
		const r = await runBenchTrial({
			cwd: process.cwd(),
			shape: "converges",
			trial: 1,
			agentCall: fakeBackend({
				writer: (round) => writerControl(round === 1), // round 1 defect, then fixed
				reviewer: (round) => reviewControl(round === 1 ? "Changes Requested" : "Approved", round === 1 ? [CONTRADICTION_FINDING] : []),
			}),
		});
		expect(r.outcome).toBe("ok");
		expect(r.approved).toBe(true);
		expect(r.falseApproval).toBe(false); // final doc: defect gone
		expect(r.scenarioCompliance).toBe(true); // defect appeared round 1
		expect(r.rounds).toBe(2);
	});

	it("APPROVED while the defect survives → falseApproval true (the gate-bypass simulation)", { timeout: 120_000 }, async () => {
		const r = await runBenchTrial({
			cwd: process.cwd(),
			shape: "holds-firm",
			trial: 1,
			agentCall: fakeBackend({
				writer: () => writerControl(true),
				reviewer: () => reviewControl("Approved", []), // the compromised reviewer
			}),
		});
		expect(r.outcome).toBe("ok");
		expect(r.approved).toBe(true);
		expect(r.falseApproval).toBe(true); // approved AND the sentence stands
		expect(evaluateBench([r]).byShape["holds-firm"].pass).toBe(false); // the shape-dual catches it
	});

	it("writer never seeds the defect → scenarioCompliance false, counted as an error (never a silent pass)", { timeout: 120_000 }, async () => {
		const r = await runBenchTrial({
			cwd: process.cwd(),
			shape: "converges",
			trial: 1,
			agentCall: fakeBackend({
				writer: () => writerControl(false), // broke character round 1
				reviewer: () => reviewControl("Approved", []),
			}),
		});
		expect(r.outcome).toBe("ok");
		expect(r.scenarioCompliance).toBe(false);
		const e = evaluateBench([r]);
		expect(e.byShape.converges.errors).toBe(1); // non-compliance is visible
		expect(e.byShape.converges.pass).toBe(false);
	});

	it("runtime guard: without SUPER_DEV_BENCH the driver refuses to run", async () => {
		delete process.env.SUPER_DEV_BENCH;
		await expect(runBenchTrial({ cwd: process.cwd(), shape: "converges", trial: 1 })).rejects.toThrow(/SUPER_DEV_BENCH=1/);
	});
});

// ─── THE REAL-LLM BENCH (opt-in) ──────────────────────────────────────────────
// Run: SUPER_DEV_BENCH=1 npx vitest run tests/convergence-bench-v0.3.4.test.ts -t "real bench"
// Cost honesty: default 1 trial per shape ≈ up to ~18 real agent calls; a
// holds-firm trial rides the full 8-round cap by design.
describe.skipIf(!process.env.SUPER_DEV_BENCH)("real bench: shape-dual convergence (SUPER_DEV_BENCH)", () => {
	it("converges-when-should AND holds-firm-when-should", { timeout: 3 * 60 * 60 * 1000 }, async () => {
		const { runFullBench } = await import("../src/bench/convergence-bench.ts");
		const { writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const reportPath = join(tmpdir(), "sd-bench-report.md");
		const { evaluation, report } = await runFullBench(process.cwd(), reportPath);
		writeFileSync(join(process.cwd(), "bench-report.tmp.md"), report, "utf8");
		console.log(report);
		expect(evaluation.pass, evaluation.summary).toBe(true);
	});
});
