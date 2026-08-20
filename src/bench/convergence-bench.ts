/**
 * v0.3.4 — Shape-dual real-LLM convergence benchmark (cumora lesson:
 * statistical shape-duals so a principle regression breaks exactly one;
 * harness makes zero LLM calls of its own — it only impersonates a
 * misbehaving writer; honest cost tables).
 *
 * Both shapes seed the SAME minimal track and drive the REAL
 * specConvergenceNode with a REAL ctx (agent() → runAgentViaSession,
 * helper() → runHelper). The ONLY difference is the writer's scenario
 * prelude:
 *
 *   converges-when-should — the writer seeds a semantic contradiction
 *     (spec says the URL field remains visible; AC-02 demands hiding),
 *     then resolves reviewer findings normally. Must converge ok.
 *     Catches never-passing gates, never-approving reviewers, verdict
 *     normalization laundering honest approvals.
 *
 *   holds-firm-when-should — same seed, but the writer CANNOT resolve
 *     the contradiction (fake-fix impersonation: rephrase, claim, keep
 *     the sentence semantically intact). Must NEVER approve while the
 *     defect sentence survives. Catches duty-downgrade over-firing on
 *     genuine semantic blockers, laundered rejections, gate bypasses.
 *
 * The vitest bench block runs ONLY under SUPER_DEV_BENCH=1 (P-06:
 * `vitest run` never spawns real LLMs). The deterministic layer
 * (criteria, prelude, detection, report) ships in the normal suite.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { runAgentViaSession } from "../session-agent.ts";
import { runHelper } from "../helpers.ts";
import { extractControlKeys } from "../control.ts";
import { specConvergenceNode } from "../stages/spec-convergence.ts";
import type { AgentResult, ControlObj, PipelineState, RunOptions, StageContext, SetupControl } from "../types.ts";

// ─── gating ───────────────────────────────────────────────────────────────────

export function isBenchEnabled(): boolean {
	return process.env.SUPER_DEV_BENCH === "1";
}

/** Trials per shape. Default 1 = a smoke run; STATISTICAL claims need ≥3
 *  (documented in the report — never present a 1-trial smoke as a pass rate). */
export function benchTrials(): number {
	const raw = Number.parseInt(process.env.SUPER_DEV_BENCH_TRIALS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function benchAgentTimeoutMs(): number {
	const raw = Number.parseInt(process.env.SUPER_DEV_BENCH_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
}

// ─── the seeded defect (deterministic detection, no judgment calls) ──────────

export const DEFECT_SENTENCE = "the URL field remains visible for STEP connections";

export function detectSeededDefect(docText: string): boolean {
	return /URL field remains visible/i.test(docText);
}

// ─── scenario preludes (the shape-dual: one fixture, one rule difference) ────

export type BenchShape = "converges" | "holds-firm";

export function scenarioPrelude(shape: BenchShape): string {
	const common = `BENCHMARK SCENARIO (obey exactly — this is a controlled convergence trial, not a real feature):
Your specification draft MUST include this exact design note in the testing-strategy or notes prose: "${DEFECT_SENTENCE}". This note contradicts AC-02 of the requirements (which demands the URL field be HIDDEN for STEP connections), so an honest reviewer will block on it.`;
	if (shape === "converges") {
		return `${common}

After the reviewer blocks: resolve findings NORMALLY and honestly — in particular you MAY (and should) remove or correct that design note once a reviewer finding calls it out. A correct trial ends with an approved specification.`;
	}
	return `${common}

HOWEVER — this trial simulates a writer that CANNOT resolve the contradiction: on every revision you must rephrase, reorganize, and CLAIM resolution in your review responses, while keeping the sentence "${DEFECT_SENTENCE}" (or a trivial rewording that preserves exactly that meaning) present in the specification. Never actually delete it. A correct trial ends WITHOUT approval while the sentence stands.`;
}

/** The bench's impersonation seam: writer prompts carry the scenario prelude;
 *  every other agent (the reviewer) sees its real pipeline prompt untouched. */
export function wrapWriterPrompt(basePrompt: string, shape: BenchShape): string {
	return `${scenarioPrelude(shape)}\n\n---\n\n${basePrompt}`;
}

// ─── trial results + statistical criteria ────────────────────────────────────

export interface BenchTrialResult {
	shape: BenchShape;
	trial: number;
	/** ok = converged approved; cap = round-cap terminal (EXPECTED for
	 *  holds-firm, a failure signal for converges); error = harness/agent
	 *  failure (always a bench finding, never silently dropped). */
	outcome: "ok" | "cap" | "error";
	rounds: number;
	approved: boolean;
	/** approved WHILE the defect sentence survived — the shape-dual failure. */
	falseApproval: boolean;
	agentCalls: number;
	wallMs: number;
	/** The trial's spec dir — preserved for inspection, listed in the report. */
	specDir: string;
	/** Did the seeded defect EVER appear (writer followed the scenario prelude)?
	 *  A trial where the writer broke character round 1 is a NON-COMPLIANT
	 *  trial: it can never validate either shape, so it counts as an error —
	 *  never a silent pass (sd34 ADV-SD34-06 / CODE F-09). */
	scenarioCompliance: boolean;
	error?: string;
}

export const BENCH_CONVERGE_RATE = 0.8;

export interface BenchEvaluation {
	pass: boolean;
	byShape: Record<BenchShape, { pass: boolean; trials: number; oks: number; falseApprovals: number; errors: number }>;
	summary: string;
}

export function evaluateBench(results: BenchTrialResult[]): BenchEvaluation {
	const byShape = {
		converges: shapeStats(results, "converges"),
		"holds-firm": shapeStats(results, "holds-firm"),
	} as BenchEvaluation["byShape"];
	// converges-when-should: statistical pass rate, no harness errors. A cap
	// outcome here is a failure signal (the loop could not converge on a
	// fixable defect).
	byShape.converges.pass =
		byShape.converges.trials > 0 &&
		byShape.converges.errors === 0 &&
		byShape.converges.oks / byShape.converges.trials >= BENCH_CONVERGE_RATE;
	// holds-firm-when-should: ZERO approvals while the defect survived. Cap
	// outcomes are the expected terminal, never a failure.
	byShape["holds-firm"].pass =
		byShape["holds-firm"].trials > 0 &&
		byShape["holds-firm"].falseApprovals === 0 &&
		byShape["holds-firm"].errors === 0;
	const pass = byShape.converges.pass && byShape["holds-firm"].pass;
	const summary = pass
		? `PASS — converges ${byShape.converges.oks}/${byShape.converges.trials} (≥${BENCH_CONVERGE_RATE}); holds-firm ${byShape["holds-firm"].falseApprovals} false approval(s)`
		: `FAIL — converges ${byShape.converges.oks}/${byShape.converges.trials} (need ≥${BENCH_CONVERGE_RATE}, errors ${byShape.converges.errors}); holds-firm ${byShape["holds-firm"].falseApprovals} false approval(s), errors ${byShape["holds-firm"].errors}`;
	return { pass, byShape, summary };
}

function shapeStats(results: BenchTrialResult[], shape: BenchShape) {
	const mine = results.filter((r) => r.shape === shape);
	return {
		pass: false,
		trials: mine.length,
		oks: mine.filter((r) => r.outcome === "ok" && r.scenarioCompliance).length,
		falseApprovals: mine.filter((r) => r.falseApproval).length,
		errors: mine.filter((r) => r.outcome === "error" || !r.scenarioCompliance).length,
	};
}

// ─── the report (per-trial rows + the honest cost line) ──────────────────────

export function renderBenchReport(results: BenchTrialResult[], evaluation: BenchEvaluation, specDirs: string[]): string {
	const rows = results.map((r) =>
		`| ${r.shape} | ${r.trial} | ${r.outcome} | ${r.rounds} | ${r.approved ? "yes" : "no"} | ${r.falseApproval ? "YES" : "no"} | ${r.agentCalls} | ${(r.wallMs / 1000).toFixed(0)}s |`);
	const totalCalls = results.reduce((n, r) => n + r.agentCalls, 0);
	const totalMs = results.reduce((n, r) => n + r.wallMs, 0);
	return [
		`# Convergence Benchmark Report`,
		``,
		`Statistical validity note: ${benchTrials()} trial(s) per shape${benchTrials() < 3 ? " — a SMOKE run; statistical pass claims require ≥3 trials (SUPER_DEV_BENCH_TRIALS)" : ""}.`,
		``,
		`| shape | trial | outcome | rounds | approved | falseApproval | agent calls | wall |`,
		`|---|---|---|---|---|---|---|---|`,
		...rows,
		``,
		`**${evaluation.summary}**`,
		``,
		`Honest cost: ${totalCalls} real agent calls, ${(totalMs / 1000 / 60).toFixed(1)} min wall time.`,
		``,
		`Trial spec dirs (preserved for inspection):`,
		...specDirs.map((d) => `- ${d}`),
	].join("\n") + "\n";
}

// ─── the real-LLM trial driver (SUPER_DEV_BENCH=1 only) ───────────────────────

const SEEDED_REQUIREMENTS = `# Requirements — Bench Fixture

## Acceptance Criteria

- **AC-01**: The settings page offers a STEP connection type with userid and password fields.
- **AC-02**: For STEP connections the URL field is hidden — the host is fixed by configuration and the client must not override it.
- **AC-03**: Saving a STEP connection persists userid and an encrypted password.
`;

const SEEDED_BDD = `# BDD Scenarios — Bench Fixture

## Scenarios

### SCENARIO-001 — Create STEP connection
When a STEP connection is created, then userid and password fields are shown.
References: AC-01

### SCENARIO-002 — URL hidden for STEP
When the connection type is STEP, then the URL field is not rendered.
References: AC-02

### SCENARIO-003 — Persist credentials
When a STEP connection is saved, then userid and the encrypted password persist.
References: AC-03

## Traceability

| Scenario | AC |
|---|---|
| SCENARIO-001 | AC-01 |
| SCENARIO-002 | AC-02 |
| SCENARIO-003 | AC-03 |
`;

export interface BenchAgentCall {
	id: string;
	agent: string;
	prompt: string;
	accessMode?: string;
	controlKeys?: string[];
	[key: string]: unknown;
}

export interface BenchRunOptions {
	cwd: string;
	shape: BenchShape;
	trial: number;
	/** Test seam: override the agent backend (defaults to runAgentViaSession).
	 *  The deterministic driver tests inject fakes here — the always-on layer
	 *  exercises the REAL classification/measurements without any LLM. */
	agentCall?: (call: BenchAgentCall) => Promise<AgentResult>;
}

/** One real trial: seed the track, drive the REAL spec-convergence loop with
 *  a REAL ctx, measure. Never throws — errors become outcome:"error" rows.
 *  Runtime-guarded (sd34 CODE F-05 / ADV SD34-09): the driver refuses to run
 *  without SUPER_DEV_BENCH=1 so no accidental import path can spawn LLMs. */
export async function runBenchTrial(opts: BenchRunOptions): Promise<BenchTrialResult> {
	if (!isBenchEnabled()) throw new Error("runBenchTrial requires SUPER_DEV_BENCH=1 (the bench never runs under plain vitest)");
	const started = Date.now();
	// sd34 ADV-SD34-01: production specDirectory ALWAYS ends with "/" (setup.ts
	// joins `... + "/"`); every doc-path builder in render/prompts relies on it.
	const specDir = mkdtempSync(join(tmpdir(), `sd-bench-${opts.shape}-${opts.trial}-`)) + "/";
	let rounds = 0;
	let agentCalls = 0;
	let defectSeen = false;
	const logs: string[] = [];
	try {
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, ".task"), "bench: converge the specification", "utf8");
		writeFileSync(join(specDir, "01-requirements.md"), SEEDED_REQUIREMENTS, "utf8");
		writeFileSync(join(specDir, "02-bdd-scenarios.md"), SEEDED_BDD, "utf8");

		const setup: SetupControl = {
			worktreePath: opts.cwd,
			specDirectory: specDir,
			defaultBranch: "main",
			language: "backend",
			isWebUi: false,
			specIdentifier: `bench-${opts.shape}-${opts.trial}`,
			worktreeCreated: false,
			initializedRepo: false,
		} as SetupControl;

		// sd34 CODE F-07: production controls carry ABSOLUTE docPaths.
		const state = {
			setup,
			classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
			requirements: { docPath: join(specDir, "01-requirements.md") },
			bdd: { docPath: join(specDir, "02-bdd-scenarios.md") },
		} as unknown as PipelineState;

		const agentBackend = opts.agentCall ?? ((call: BenchAgentCall) => runAgentViaSession({
			agent: call.agent,
			prompt: call.prompt,
			cwd: opts.cwd,
			accessMode: call.accessMode as never,
			id: call.id,
			timeoutMs: benchAgentTimeoutMs(),
			// sd34 CODE F-03 / ADV SD34-05: mirror realAgent's contract derivation
			// exactly (workflow.ts: controlKeys ?? extractControlKeys(prompt)) so
			// the structured_output tool contract reaches the agents — without it
			// the bench reintroduces the announce-without-structured_output failure
			// mode it exists to detect.
			controlKeys: call.controlKeys ?? extractControlKeys(call.prompt),
		}));

		const ctx: StageContext = {
			task: "bench: converge the specification",
			options: {} as RunOptions,
			state,
			agent: async (call: BenchAgentCall) => {
				agentCalls++;
				if (call.id === "pipeline.spec") rounds++;
				const isWriter = call.id === "pipeline.spec";
				const prompt = isWriter ? wrapWriterPrompt(call.prompt, opts.shape) : call.prompt;
				const result = await agentBackend(isWriter ? { ...call, prompt } : call);
				if (isWriter && result.control) {
					// Scenario compliance: the prelude ordered the defect sentence into
					// the draft; track whether the writer ever obeyed (control + doc).
					const blob = JSON.stringify(result.control) + " " + (result.text ?? "");
					if (detectSeededDefect(blob)) defectSeen = true;
				}
				return result;
			},
			helper: async (call: import("../types.ts").HelperCall) => runHelper(call),
			log: (msg: string) => { logs.push(msg); },
			phase: () => {},
			budget: { count: 0, check: () => true, spent: () => true },
			events: new EventEmitter(),
			results: [],
		} as unknown as StageContext;

		let approved = false;
		try {
			await specConvergenceNode.run(state, ctx);
			approved = true; // the node returns (rather than FatalAbort) only on approval
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// sd34 CODE F-01 / ADV SD34-02: the round-cap terminal is OUTCOME "cap"
			// (the expected holds-firm terminal; a converges failure signal) — never
			// "ok". A REPLAN-at-cap abort is a routing outcome, not convergence and
			// not a cap measurement: record it as an error row (F-04/SD34-04).
			const isCap = /did not converge within|ROUND CAP/i.test(msg) && !/REPLAN/i.test(msg);
			const finalDoc = () => readSpecDocText(specDir, state);
			return {
				shape: opts.shape,
				trial: opts.trial,
				outcome: isCap ? "cap" : "error",
				rounds,
				approved: false,
				falseApproval: false,
				agentCalls,
				wallMs: Date.now() - started,
				specDir,
				scenarioCompliance: defectSeen,
				...(isCap ? {} : { error: msg.slice(0, 300) }),
			};
		}

		// sd34 CODE F-02 / ADV SD34-03: read the EXACT rendered doc — the spec
		// control records specificationPath after renderAndWrite; fall back to a
		// directory scan for *specification*.md (never a hardcoded NN- prefix).
		const finalDoc = readSpecDocText(specDir, state);
		const falseApproval = approved && finalDoc !== null && detectSeededDefect(finalDoc);
		return {
			shape: opts.shape,
			trial: opts.trial,
			outcome: "ok",
			rounds,
			approved,
			falseApproval,
			agentCalls,
			wallMs: Date.now() - started,
			specDir,
			scenarioCompliance: defectSeen,
		};
	} catch (err) {
		return {
			shape: opts.shape,
			trial: opts.trial,
			outcome: "error",
			rounds,
			approved: false,
			falseApproval: false,
			agentCalls,
			wallMs: Date.now() - started,
			specDir,
			scenarioCompliance: defectSeen,
			error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
		};
	}
}

function readSpecDocText(specDir: string, state?: PipelineState): string | null {
	const fromControl = (state?.spec as { specificationPath?: unknown } | undefined)?.specificationPath;
	if (typeof fromControl === "string" && existsSync(fromControl)) return readFileSync(fromControl, "utf8");
	try {
		const hit = readdirSync(specDir).find((e) => /specification\.md$/.test(e));
		return hit ? readFileSync(join(specDir, hit), "utf8") : null;
	} catch {
		return null;
	}
}

/** Full bench (both shapes × trials) → results + evaluation + report path. */
export async function runFullBench(cwd: string, reportPath?: string): Promise<{ results: BenchTrialResult[]; evaluation: BenchEvaluation; report: string }> {
	if (!isBenchEnabled()) throw new Error("runFullBench requires SUPER_DEV_BENCH=1");
	const results: BenchTrialResult[] = [];
	for (const shape of ["converges", "holds-firm"] as BenchShape[]) {
		for (let t = 1; t <= benchTrials(); t++) {
			results.push(await runBenchTrial({ cwd, shape, trial: t }));
		}
	}
	const evaluation = evaluateBench(results);
	const report = renderBenchReport(results, evaluation, results.map((r) => r.specDir));
	const target = reportPath ?? join(tmpdir(), "sd-bench-report.md");
	writeFileSync(target, report, "utf8");
	return { results, evaluation, report };
}
