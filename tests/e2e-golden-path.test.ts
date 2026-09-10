/**
 * v0.3.85 S2 — the E2E GOLDEN PATH (§9 S2 / §8 principle 6 of
 * docs/requirements/run-2026-09-09-poisoned-baseline-postmortem-v0.3.85.md):
 * "verify the system, not the fix."
 *
 * C2 died in production because the smoke exercised a classifier, never a
 * judge: the v0.3.70–v0.3.84 canonical-string evidence wiring rotted
 * silently. This test walks the seam that rotted through REAL machinery:
 *
 *   - REAL implementation stage (no build-runner mocks — the RED oracle and
 *     the build gate run REAL `node --test` / `node --check` processes);
 *   - REAL git temp repo (P9): HEAD reads, porcelain, the F5 ratchet's
 *     pre-edit surface compare, the scoped revert, and the phase commit are
 *     all real;
 *   - REAL runJudge path with the REAL verifyJudgeEvidence (no judge
 *     internals mocked) — only the LLM agent responses are scripted stubs
 *     (ctx.agent), per the S2 contract;
 *   - REAL ledgers under test: .judge.jsonl, events.jsonl (judge.called),
 *     and the S3 counters derived from them.
 *
 * The scripted scenario (3 phases, one stage pass, one runId):
 *   phase-01 "GoldenGreen"     — RED→GREEN through the real boundary with
 *                                F5's ratchet in the path: try 1 weakens the
 *                                pre-existing guard suite → REJECTED + hint +
 *                                scoped revert; try 2's legal new-file RED is
 *                                accepted and the implementer greens it.
 *   phase-02 "JudgeStall"      — the tdd-guide keeps authoring an
 *                                already-green test → RED no-progress → judge
 *                                consult #1 ACCEPTED via canonical STRING
 *                                evidence ("<path>: <quote>") quoting a real
 *                                line from a real temp file; the re-author
 *                                restart (a different test file → fresh
 *                                signature) stalls again → consult #2: the
 *                                J2 timeout-retry arm burns the second
 *                                per-signature slot, then the retry verdict's
 *                                fabricated quote fails verification with the
 *                                corrective budget exhausted → DISCARDED →
 *                                honest HITL → partial.
 *   phase-03 "CorrectiveFloor" — a confirmed RED + an implementer that keeps
 *                                failing identically → impl no-progress (the
 *                                signature-repeat valve, or F3's failure-
 *                                category recurrence at the 3rd attempt when
 *                                the real runner's per-run duration noise
 *                                keeps signatures fresh) → judge consult with
 *                                unverifiable evidence → the corrective
 *                                re-call ALSO unverifiable → escalate floor
 *                                (diagnosis preserved) → honest HITL →
 *                                partial.
 *
 * The run then terminates honestly and the S3 meters reflect the judge
 * outcomes: accepted ≥ 1, discarded ≥ 1 — the meters wired to the territory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCall, AgentResult, Budget, ControlObj, HelperResult, PipelineState, RunOptions, Stage, StageContext } from "../src/types.ts";

// The ONLY mock: the stage's render side effect (the summary write) — the
// stage9-smoke precedent. The build-runner barrel (RED oracle + gates) is
// deliberately NOT mocked: this is the golden path through real machinery.
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));

import { implementationStage } from "../src/stages/implementation.ts";
import { resetJudgeBudgets } from "../src/stages/judge.ts";
import { appendRunEvent, readRunEvents } from "../src/runlog.ts";
import { deriveS3Counters } from "../src/evolution/run-observability.ts";
import { buildRunMetricsRow } from "../src/evolution/sigma-bands.ts";

const RUN_ID = "e2e-golden-run-0001";

// ─── the repo (real git; P9) ────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", "stdio": ["ignore", "pipe", "pipe"] }).trim();
}

/** The frozen guard suite — behavior-INVARIANT assertions so it passes both
 *  before and after phase-01's fix (each guard line carries a `test(` + an
 *  `assert` marker; weakening = one guard line removed). */
const GUARD_PATH = "src/math.test.js";
const GUARD_LINES = [
	"test('guard: add returns a number', () => assert.equal(typeof add(1, 2), 'number'));",
	"test('guard: add handles zero', () => assert.equal(add(0, 0), 0));",
];
const GUARD_FULL = [
	"const test = require('node:test');",
	"const assert = require('node:assert/strict');",
	"const { add } = require('./math.js');",
	...GUARD_LINES,
	"",
].join("\n");
/** The weakened variant: the second guard is gutted (strict surface decrease). */
const GUARD_WEAKENED = GUARD_FULL.replace(`${GUARD_LINES[1]}\n`, "");

const P1_TEST = "src/add42.test.js";
const P1_TEST_CONTENT = [
	"const test = require('node:test');",
	"const assert = require('node:assert/strict');",
	"const { add } = require('./math.js');",
	"test('add sums numbers', () => assert.equal(add(2, 3), 5));",
	"",
].join("\n");

const P2_TEST = "src/phase2.test.js";
// The assert lives on its OWN line: the canonical-string quote must BYTE-OCCUR
// in the file, and the single-line arrow form `() => assert.equal(...));`
// puts an extra `)` before the `;` — the quote `assert.equal(...);` is NOT a
// substring of it (fix-round-1 root cause: verification failed honestly).
const P2_TEST_CONTENT = [
	"const test = require('node:test');",
	"const assert = require('node:assert/strict');",
	"const { add } = require('./math.js');",
	"test('phase2 tautology guard', () => {",
	"  assert.equal(typeof add, 'function');",
	"});",
	"",
].join("\n");
/** A REAL line from a REAL temp file — the canonical-string evidence quote. */
const P2_QUOTE = "assert.equal(typeof add, 'function');";
/** The post-restart re-authored stall file — a DIFFERENT name so the second
 *  consult runs on a fresh judge signature (deterministic budget arithmetic:
 *  the timeout-retry arm then exhausts the per-signature slots IN-consult). */
const P2B_TEST = "src/phase2b.test.js";
const P2B_TEST_CONTENT = [
	"const test = require('node:test');",
	"const assert = require('node:assert/strict');",
	"const { add } = require('./math.js');",
	"test('phase2b re-authored tautology guard', () => {",
	"  assert.equal(typeof add, 'function');",
	"});",
	"",
].join("\n");

const P3_TEST = "src/phase3.test.js";
const P3_TEST_CONTENT = [
	"const test = require('node:test');",
	"const assert = require('node:assert/strict');",
	"const { feature3 } = require('./phase3.js');",
	"test('feature3 returns 42', () => assert.equal(feature3(), 42));",
	"",
].join("\n");

function mkRepo(): string {
	const wt = mkdtempSync(join(tmpdir(), "sd-e2e-golden-"));
	git(wt, "init", "-q", "-b", "main");
	git(wt, "config", "user.email", "t@t");
	git(wt, "config", "user.name", "t");
	mkdirSync(join(wt, "src"), { recursive: true });
	writeFileSync(join(wt, "package.json"), JSON.stringify({
		name: "e2e-golden",
		private: true,
		scripts: {
			build: "node --check src/math.js",
			test: "node --test src/*.test.js",
		},
	}, null, 2));
	// The WRONG implementation (phase-01's implementer fixes it), the frozen
	// guard suite, and phase-03's stub — all committed at HEAD.
	writeFileSync(join(wt, "src", "math.js"), "function add(a, b) { return a - b; }\nmodule.exports = { add };\n");
	writeFileSync(join(wt, GUARD_PATH), GUARD_FULL);
	writeFileSync(join(wt, "src", "phase3.js"), "function feature3() { return 0; }\nmodule.exports = { feature3 };\n");
	git(wt, "add", "-A");
	git(wt, "commit", "-qm", "frozen guards + wrong impl");
	return wt;
}

// ─── the scripted agents (the ONLY stubs — LLM responses, nothing else) ─────

interface JudgeScript {
	/** A verdict control to return. */
	verdict?: Record<string, unknown>;
	/** Simulate a backend TIMEOUT (the engine's error shape, no control) —
	 *  exercises the judge's J2 timeout-retry arm deterministically (a real
	 *  1ms SUPER_DEV_JUDGE_TIMEOUT_MS fixture would depend on wall-clock
	 *  scheduling; the stubbed error rides the SAME code path). */
	timeoutError?: string;
}

function mkCtx(wt: string, judgeScripts: JudgeScript[]) {
	const logs: string[] = [];
	const escalations: Array<{ kind?: string; message: string; stage?: string | null }> = [];
	const tddCalls: AgentCall[] = [];
	const implCalls: AgentCall[] = [];
	const judgeCalls: AgentCall[] = [];
	/** Per-phase tdd-guide try counters (the prompt names the phase — the dispatch key). */
	const phaseTries: Record<string, number> = {};
	/** Once the phase-02 judge consult routed re-author-tests, every later
	 *  tdd try authors the RE-START file (the judge-diagnosis hint rides only
	 *  the first restart prompt; later normal-retry prompts lose the marker —
	 *  the flag keeps the second stall on the fresh signature). */
	let phase2Restarted = false;
	const judgeQ = [...judgeScripts];
	const writeRepo = (rel: string, content: string) => {
		writeFileSync(join(wt, rel), content);
	};
	const escalate: RunOptions["escalate"] = async (failure) => {
		escalations.push({ kind: (failure as { kind?: string }).kind, message: String((failure as { message?: string }).message ?? ""), stage: (failure as { stage?: string | null }).stage ?? null });
		return undefined; // dismissed — the honest terminal path
	};
	const budget: Budget = { count: 0, check: () => true, spent() { this.count++; return true; } };
	const ctx: StageContext = {
		task: "e2e golden path",
		options: { escalate } as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				tddCalls.push(call);
				if (call.prompt.includes("- Phase: GoldenGreen")) {
					const n = (phaseTries["golden"] ?? 0) + 1;
					phaseTries["golden"] = n;
					if (n === 1) {
						// The F5 bait: weaken the frozen guard AND author the independent
						// RED (the salvage case — the scoped revert must keep the new file).
						writeRepo(GUARD_PATH, GUARD_WEAKENED);
						writeRepo(P1_TEST, P1_TEST_CONTENT);
						return { text: "", control: { testFiles: [GUARD_PATH, P1_TEST] } };
					}
					// The legal route alone (guard rewritten byte-identical to HEAD — no diff).
					writeRepo(GUARD_PATH, GUARD_FULL);
					writeRepo(P1_TEST, P1_TEST_CONTENT);
					return { text: "", control: { testFiles: [P1_TEST] } };
				}
				if (call.prompt.includes("- Phase: JudgeStall")) {
					if (call.prompt.includes("Judge diagnosis")) phase2Restarted = true;
					if (phase2Restarted) {
						// The post-consult re-author restart: a DIFFERENT file (the judge's
						// route) — the second stall runs on a fresh signature by construction.
						writeRepo(P2B_TEST, P2B_TEST_CONTENT);
						return { text: "", control: { testFiles: [P2B_TEST] } };
					}
					// The already-green test, authored identically every try — the
					// deterministic RED no-progress stall the judge owns.
					writeRepo(P2_TEST, P2_TEST_CONTENT);
					return { text: "", control: { testFiles: [P2_TEST] } };
				}
				// CorrectiveFloor: a confirmed RED against the stub.
				writeRepo(P3_TEST, P3_TEST_CONTENT);
				return { text: "", control: { testFiles: [P3_TEST] } };
			}
			if (call.agent === "implementer") {
				implCalls.push(call);
				if (call.prompt.includes("- Phase: GoldenGreen")) {
					writeRepo("src/math.js", "function add(a, b) { return a + b; }\nmodule.exports = { add };\n");
					return { text: "fixed add to sum", control: { filesCreated: [], filesModified: ["src/math.js"], filesDeleted: [] } };
				}
				if (call.prompt.includes("- Phase: CorrectiveFloor")) {
					// Persistently wrong (41 ≠ 42): identical gate failures across
					// attempts → the impl no-progress boundary.
					writeRepo("src/phase3.js", "function feature3() { return 41; }\nmodule.exports = { feature3 };\n");
					return { text: "still wrong", control: { filesCreated: [], filesModified: ["src/phase3.js"], filesDeleted: [] } };
				}
				return { text: "", control: { filesCreated: [], filesModified: [], filesDeleted: [] } };
			}
			if (call.agent === "judge") {
				judgeCalls.push(call);
				const scripted = judgeQ.shift();
				if (!scripted) return { text: "", control: null };
				if (scripted.timeoutError) return { text: "", control: null, error: scripted.timeoutError };
				return { text: "", control: scripted.verdict as ControlObj };
			}
			if (call.agent === "code-reviewer") {
				return { text: "", control: { verdict: "strong", summary: "ok", contradictions: [] } };
			}
			if (call.agent === "tdd-coverage-classifier") {
				return { text: "", control: { allCovered: true, coveredScenarios: [], missingScenarios: [], summary: "covered" } };
			}
			return { text: "", control: {} };
		},
		async parallel(cbs) { return Promise.all(cbs.map((cb) => cb())); },
		budget,
		log(message: string) { logs.push(message); },
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, logs, escalations, tddCalls, implCalls, judgeCalls };
}

/** .judge.jsonl rows for one scope, in write order. */
function judgeAuditRows(specDir: string, scope: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(join(specDir, ".judge.jsonl"), "utf8")
			.split("\n").filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((r) => r.scope === scope);
	} catch {
		return [];
	}
}

const repos: string[] = [];
const dirs: string[] = [];

beforeEach(() => {
	resetJudgeBudgets();
	delete process.env.SUPER_DEV_DISABLE_JUDGE;
});
afterEach(() => {
	for (const r of repos.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* tmp */ } }
	for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } }
});

describe("v0.3.85 S2 — E2E golden path (scripted agents, REAL judge/verifier/oracle/git)", () => {
	it("walks RED→GREEN with the F5 ratchet, a judge ACCEPT (canonical string evidence), a judge DISCARD, the corrective floor, and honest S3 meters", async () => {
		const wt = mkRepo(); repos.push(wt);
		const specDir = mkdtempSync(join(tmpdir(), "sd-e2e-spec-")); dirs.push(specDir);
		// The run bracket — the S3 window keys off it (runWorkflow writes this
		// first; the stage-composed harness mirrors it).
		appendRunEvent(specDir, { runId: RUN_ID, type: "run.started", data: { task: "e2e golden path", version: "test" } });

		const { ctx, logs, escalations, tddCalls, implCalls, judgeCalls } = mkCtx(wt, [
			// JudgeStall consult #1: ACCEPTED via the canonical STRING arm —
			// "<path>: <quote>" quoting a real line from the real temp file.
			{ verdict: { diagnosis: "the phase-2 test asserts current behavior — it can never fail; re-author a test of the MISSING behavior", route: "re-author-tests", confidence: 0.92, evidence: [`${P2_TEST}: ${P2_QUOTE}`] } },
			// JudgeStall consult #2 (the re-authored stall — fresh signature): the
		// first attempt DIES AT THE TIMEOUT (J2 retry consumes the second
		// per-signature slot), then the retry verdict carries a FABRICATED
		// quote → verification fails with the budget exhausted → DISCARDED.
			{ timeoutError: "super-dev [pipeline.judge.stage9.red-no-progress.phase-02]: agent timed out after 1s. stderr: (empty)" },
			{ verdict: { diagnosis: "same stall after re-author", route: "re-author-tests", confidence: 0.9, evidence: [{ file: P2B_TEST, quote: "THIS FABRICATED QUOTE APPEARS IN NO FILE OF THIS WORKTREE" }] } },
			// CorrectiveFloor consult #1: fabricated quote → verification fails →
			// the corrective re-call (next script) also fails → escalate floor.
			{ verdict: { diagnosis: "phase-03 needs the spec amended", route: "challenge-test", confidence: 0.9, evidence: [{ file: P3_TEST, quote: "ANOTHER FABRICATED QUOTE THAT VERIFIES AGAINST NOTHING" }] } },
			{ verdict: { diagnosis: "phase-03 still needs the spec amended", route: "challenge-test", confidence: 0.88, evidence: [{ file: P3_TEST, quote: "YET ANOTHER UNVERIFIABLE FABRICATED QUOTE FOR THE CORRECTIVE" }] } },
		]);

		const state = {
			task: "e2e golden path",
			options: {},
			setup: { worktreePath: wt, specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "e2e-golden", worktreeCreated: false, initializedRepo: false },
			classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
			spec: { phases: [
				{ name: "GoldenGreen", description: "Fix add to sum, without weakening the frozen guards" },
				{ name: "JudgeStall", description: "A RED that never goes red" },
				{ name: "CorrectiveFloor", description: "An implementer that cannot converge" },
			] },
		} as unknown as PipelineState;
		(state as Record<string, unknown>).__runId = RUN_ID;
		ctx.state = state;

		const out = (await (implementationStage as Stage).run(state, ctx)) as unknown as {
			allGreen: boolean;
			phasesCompleted: number;
			totalPhases: number;
			phaseStatus: Array<{ id: string; status: string; attempts?: number }>;
		};

		const hasLog = (needle: string) => logs.some((l) => l.includes(needle));

		// ── 1. phase-01: RED→GREEN through the real boundary, F5 ratchet in path ──
		// The weakened try was rejected with the class named and the hint taught.
		expect(hasLog("RED assertion ratchet: REJECTED — weakened pre-existing test file(s) src/math.test.js")).toBe(true);
		const phase1Tdd = tddCalls.filter((c) => c.prompt.includes("- Phase: GoldenGreen"));
		expect(phase1Tdd.length).toBe(2);
		expect(phase1Tdd[1]!.prompt).toContain("RED assertion ratchet rejected the previous test set");
		expect(phase1Tdd[1]!.prompt).toContain("independent NEW test file");
		// The scoped revert restored the guard byte-identically; the new RED survived.
		expect(readFileSync(join(wt, GUARD_PATH), "utf8")).toBe(GUARD_FULL);
		// The legal RED was accepted (real oracle red) and the implementer greened it.
		expect(hasLog("phase-01 red-oracle: red")).toBe(true);
		expect(hasLog("Implementation phase-01 GREEN on attempt 1")).toBe(true);
		expect(out.phaseStatus[0]).toMatchObject({ id: "phase-01", status: "green" });

		// ── 2. phase-02: judge ACCEPT via canonical string evidence (the C2 seam) ──
		const stallAudit = judgeAuditRows(specDir, "stage9.red-no-progress.phase-02");
		expect(stallAudit.length).toBeGreaterThanOrEqual(1);
		const routedRow = stallAudit.find((r) => r.routed === true);
		expect(routedRow).toBeDefined();
		// F1: the STRING arm was normalized to {file, quote} records by the REAL
		// verifyJudgeEvidence at entry — the audit row carries the post-verification shape.
		const routedEvidence = (routedRow?.verdict as { evidence?: Array<{ file?: string; quote?: string }> }).evidence ?? [];
		expect(routedEvidence[0]).toEqual({ file: P2_TEST, quote: P2_QUOTE });
		// The routed diagnosis restarted the RED loop (the re-author round-trip).
		expect(hasLog("judge route=re-author-tests: restarting RED with the diagnosis")).toBe(true);

		// ── 3. phase-02: judge DISCARD — timeout retry burned the budget, then a
		// fabricated quote fails verification with the corrective budget exhausted ──
		expect(stallAudit.some((r) => r.retried === true && typeof r.error === "string" && /timed out after/i.test(String(r.error)))).toBe(true); // the J2 timeout row
		const discardedRow = stallAudit.find((r) => r.discarded === true);
		expect(discardedRow).toBeDefined();
		expect(String(discardedRow?.reason ?? "")).toContain("corrective budget exhausted");
		expect((discardedRow?.evidenceFailures as string[]).join(" ")).toContain("quote not found");
		expect(hasLog("verdict DISCARDED — evidence verification failed and the corrective budget is exhausted")).toBe(true);
		// The honest HITL surface carried the stall (dismissed → partial).
		expect(escalations.some((e) => e.message.includes("RED test generation"))).toBe(true);
		expect(out.phaseStatus[1]).toMatchObject({ id: "phase-02", status: "partial" });

		// ── 4. phase-03: the corrective-retry machinery + its audit rows ──
		// 5 judge agent calls total: 1 stall consult (#1) + 2 for the discard
		// consult (timeout attempt + its J2 retry) + 1 floor consult + its 1
		// corrective re-call — the timeout-retry AND corrective round-trips both
		// happened through the real budget machinery.
		expect(judgeCalls).toHaveLength(5);
		const floorAudit = judgeAuditRows(specDir, "stage9.impl-no-progress.phase-03");
		const correctiveRow = floorAudit.find((r) => r.correctiveRetry === true);
		expect(correctiveRow).toBeDefined();
		expect((correctiveRow?.evidenceFailures as string[]).join(" ")).toContain("quote not found");
		const floorRow = floorAudit.find((r) => r.correctiveFailed === true && r.escalated === true);
		expect(floorRow).toBeDefined();
		expect(String(floorRow?.reason ?? "")).toContain("escalate-after-corrective-retry");
		// The corrective re-call happened (2 judge agent calls for this consult).
		expect(hasLog("verdict failed evidence verification — one corrective re-call")).toBe(true);
		expect(hasLog("corrective verdict STILL fails evidence verification — escalating with the diagnosis preserved")).toBe(true);
		// Identical failures stop within the anti-windup bound — attempt 2 via
		// signature repeat OR attempt 3 via failure-category recurrence (F3: the
		// real node:test tail carries per-run `duration_ms` noise, so either valve
		// can fire first; both precede the attempt cap) — and the phase is partial.
		const floorImplCalls = implCalls.filter((c) => c.prompt.includes("- Phase: CorrectiveFloor"));
		expect(floorImplCalls.length).toBeGreaterThanOrEqual(2);
		expect(floorImplCalls.length).toBeLessThanOrEqual(3);
		expect(out.phaseStatus[2]).toMatchObject({ id: "phase-03", status: "partial" });
		expect([2, 3]).toContain(out.phaseStatus[2]!.attempts);

		// ── 5. the run terminates honestly ──
		expect(out.allGreen).toBe(false);
		expect(out.phasesCompleted).toBe(1);
		expect(out.totalPhases).toBe(3);
		expect(escalations.length).toBeGreaterThanOrEqual(2); // both stalls surfaced, both dismissed

		// ── 6. the S3 meters reflect the judge outcomes (meters wired to territory) ──
		const judgeEvents = readRunEvents(specDir).filter((e) => e.type === "judge.called");
		expect(judgeEvents.every((e) => e.runId === RUN_ID)).toBe(true);
		expect(judgeEvents.map((e) => String((e.data as Record<string, unknown>).status))).toEqual(["routed", "discarded", "escalate"]);

		const s3 = deriveS3Counters({ runId: RUN_ID, specDirectory: specDir, implementation: { phaseStatus: out.phaseStatus } });
		expect(s3.judgeAccepted).toBe(1);
		expect(s3.judgeDiscarded).toBe(1);
		expect(s3.partialPhases).toBe(2);
		expect(s3.maxPhaseAttempts).toBeGreaterThanOrEqual(2);
		// Honest zeros — the counters are PRESENT, never omitted (P10/C2).
		expect(s3.inheritedRedHandoffs).toBe(0);
		expect(s3.inheritedRedOccurrences).toBe(0);

		// And the row carries them (the close-out's write shape).
		const row = buildRunMetricsRow({ runId: RUN_ID, status: "partial", agentsSpawned: 1, wallMs: 1, results: [], usage: undefined, s3, ts: 1 });
		expect(row).toMatchObject({ judgeAccepted: 1, judgeDiscarded: 1, partialPhases: 2, inheritedRedHandoffs: 0, inheritedRedOccurrences: 0 });
		expect(row.maxPhaseAttempts).toBe(s3.maxPhaseAttempts);
	}, 60_000);
});
