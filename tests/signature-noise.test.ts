/**
 * Phase 2 (Track 30) — PRB wiring: normalized signatures in the attempt loop
 * (tests/signature-noise.test.ts — RED-first per SCENARIO-031/AC-14).
 *
 * T2.1 (SCENARIO-014/015 · AC-06): `normalizeSignatureText` must delegate to
 *   `stripVolatileNoise` BEFORE the existing whitespace-collapse/trim/800-cap
 *   (strip → collapse → trim → cap), so >800 chars of leading volatile noise
 *   (ISO-8601 timestamps, UUIDs, durations, `(cached)`/`[cached]` markers)
 *   never displace the discriminating tail past the cap. Pinned BEHAVIORALLY
 *   through the real Stage 9 attempt loop (D-4: the normalizer stays
 *   module-local): two attempts whose seeded `gate.errors` differ ONLY in
 *   >800 chars of leading noise must trip the EXISTING `repeatedNoProgress`
 *   detector at attempt 2 — impossible pre-fix, because the whitespace-only
 *   normalizer's 800-char window sat entirely inside the differing noise.
 *   `repeatedNoProgress` itself is NOT modified (T2.1 contract).
 *
 * T2.2 (SCENARIO-016/017 · AC-07): the 11 identical snow failures from run
 *   2026-08-18T01-02-50-093Z replay through the harness as in-repo fixture
 *   replicas (`SNOW_REPLICA_FAILURES`, provenance below) and must collapse to
 *   ONE `ProgressSignature` — both components: `failure` (the trip at the
 *   second occurrence) AND `footprint` (constant claimed change set) — so the
 *   existing anti-windup engages: stop at attempt 2, implementer dispatched
 *   EXACTLY twice, judge consulted at scope `stage9.impl-no-progress.<phaseId>`
 *   (resetJudgeBudgets in beforeEach), HITL surfaced. Pre-fix: 11 distinct
 *   signatures → no trip → 12 budgeted attempts, 12 implementer dispatches.
 *
 * Controls (must hold on BOTH the pre-fix and post-fix tree — they guard
 *   against a trivial always-trip and an over-normalizing implementation):
 *   - same noise prefix on both attempts trips identically (pure `repeatedNoProgress`
 *     semantics, no stripper involvement);
 *   - an attempt-2 failing-package swap (`internal/services/snow` →
 *     `internal/services/auth`) does NOT trip (AC-08's no-over-normalization
 *     direction, through the real pipeline path).
 *
 * Harness (tests/implementation-rc8-rc12.test.ts + implementation-red-loop
 * .test.ts pattern): mocked `runBuildGate` with per-call sequenced results,
 * `mkState`/`mkCtx`, agent-dispatch call counting, and a `budget.check` that
 * fails once 12 implementer dispatches have happened ("budget failing after
 * 12 attempts"). Hermetic: no network, no LLM, no real toolchain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentCall,
	AgentResult,
	Budget,
	ControlObj,
	HelperResult,
	PipelineState,
	RunOptions,
	Stage,
	StageContext,
} from "../src/types.ts";

// ─── Mocks (red-loop pattern: the stage's only side-effecting imports) ──────
// runRedCheck/runBuildGate are fully scriptable per call; the deliverable
// check and the summary render are stubbed so the suite is disk-free beyond
// the temp worktree. Everything else (computeChangeGate, computeSymbolGate,
// buildGateCorrelationLine, …) stays REAL.
vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runRedCheck: vi.fn((): string => "unknown"),
		runBuildGate: vi.fn(() => ({
			pass: true,
			inScopePass: false,
			ran: ["npm test"],
			errors: [] as string[],
			outOfScopeErrors: [] as string[],
		})),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [] as string[], ran: [] as string[] })),
		resetDeliverableCheckCache: vi.fn(() => {}),
	};
});

vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, runBuildGate, type RedCheckDiagnostic } from "../src/build-runner.ts";
import { stripVolatileNoise } from "../src/fault-classification.ts";
import { BASELINE_VERIFY_ERROR_PREFIX } from "../src/build-runner/gates.ts";
import { resetJudgeBudgets } from "../src/stages/judge.ts";

const redCheck = vi.mocked(runRedCheck);
const buildGate = vi.mocked(runBuildGate);

// ─── Shared discriminating constants (run 01-02-50, held fixed by every
// replica — SCENARIO-016's replica contract) ─────────────────────────────────

const SNOW_PACKAGE = "github.com/macotestdashboard/backend-service/internal/services/snow";
const SNOW_TEST = "TestEnrichment_AreaCandidates_ClusterMatch_MatchType";
const BASELINE_SHA = "45b865ef";

/** The discriminating tail shared by every T2.1 seed: failing package, failing
 *  test, `[baseline-verify] regression` verdict (built from the REAL exported
 *  gate prefix — single-sourced, D-11), and the baseline SHA. All volatile
 *  tokens inside it (`14.439s`, `3.695s`, `(0.31s)`, `(cached)`, `[cached]`)
 *  are AC-06 noise classes and strip away — held fixed regardless. */
const SNOW_TAIL = [
	"FAIL",
	`FAIL\t${SNOW_PACKAGE}\t14.439s`,
	`ok  \t${SNOW_PACKAGE}/odata\t3.695s`,
	"ok  \tgithub.com/macotestdashboard/backend-service/internal/services/unittest\t(cached)",
	`---- FAIL: ${SNOW_TEST} (0.31s)`,
	`FAIL; ${BASELINE_VERIFY_ERROR_PREFIX} pnpm run test (whole suite) PASSES at baseline ${BASELINE_SHA} — the failure is new on this branch [cached]`,
].join("\n");

/** T2.1 control B: the same tail with the failing PACKAGE swapped
 *  (`internal/services/snow` → `internal/services/auth`) — AC-08's
 *  must-NOT-compare-equal direction. */
const AUTH_TAIL = SNOW_TAIL.replaceAll("internal/services/snow", "internal/services/auth");

// ─── Deterministic volatile-noise generators (AC-06 classes only) ───────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Deterministic hex chunk for UUID-shaped noise tokens. */
function hexChunk(seed: number, width: number): string {
	return (((seed >>> 0).toString(16).padStart(8, "0")) + "00000000").slice(0, width);
}

/** Deterministic canonical 8-4-4-4-12 UUID (multiplication by the odd golden
 *  ratio constant mod 2^32 is injective, so distinct seeds give distinct
 *  UUIDs — the fixture contract pins pairwise distinctness). */
function uuidFor(seed: number): string {
	return [
		hexChunk(seed * 2654435761, 8),
		hexChunk(seed + 40503, 4),
		hexChunk(seed * 31 + 7, 4),
		hexChunk(seed * 7 + 3, 4),
		hexChunk(seed * 1103515245 + 12345, 12),
	].join("-");
}

/** T2.1: >800 chars (post-whitespace-collapse) of PURELY volatile leading
 *  noise — SCENARIO-015's exact premise: "more than 800 characters of
 *  timestamps, UUIDs, and durations precede the discriminating content".
 *  Every token is an AC-06 class and strips to whitespace, so post-strip the
 *  entire block vanishes (the residue is whitespace-only — pinned below); the
 *  tokens vary per `variant` so the pre-fix 800-char window (inside the noise)
 *  differs every attempt. */
function leadingNoise(variant: number): string {
	const lines: string[] = [];
	for (let i = 0; i < 12; i++) {
		const ts = `2026-08-18T${pad2(9 + variant)}:${pad2(10 + i)}:02.${String(100000 + variant * 137 + i).padStart(6, "0")}+08:00`;
		lines.push(`${ts} ${uuidFor(variant * 10 + i)} ${14 + variant}.${variant}${i}s 423ms (cached) [cached]`);
	}
	return lines.join("\n");
}

// ─── SNOW_REPLICA_FAILURES — T2.2 fixture (SCENARIO-016's replica contract) ──
//
// Provenance: replicas of run 2026-08-18T01-02-50-093Z
// (~/.super-dev/runs/2026-08-18T01-02-50-093Z/run.log) — the 11 identical snow
// gate failures at run.log ~851, 944, 1019, 1089, 1194, 1276, 1366, 1461,
// 1535, 1603, 1697 (phase-01 attempts 2–12) and the go-test output block at
// ~755-760 (`backend-service: go test ./... FAILED (exit 1):` + the
// `[resolve-team] trackingID=<uuid> … duration=0.000s` JSON log lines +
// `FAIL github.com/…/internal/services/snow 14.439s` + the
// `---- FAIL: TestEnrichment_AreaCandidates_ClusterMatch_MatchType (0.31s)`
// case). Each replica varies ONLY the AC-06 volatile noise — timestamps,
// trackingID UUIDs, `duration=0.000s`, the `14.4Ns`/`3.6Ns` go-test timings,
// and the `(cached)` / `[cached]` markers (attempt 2's baseline verdict was
// FRESH — no `[cached]` suffix, run.log:851 — attempts 3+ hit the baseline
// memo and carry it, run.log:944+) — while the discriminating constants
// (`internal/services/snow`, `TestEnrichment_AreaCandidates_ClusterMatch_
// MatchType`, `[baseline-verify] regression`, baseline `45b865ef`) are held
// fixed. Replay contract (D-4): seeded with `baselineCheck` ABSENT
// (unclassified per SCENARIO-003 — today's retry path this detector guards).

function snowReplica(attempt: number): string {
	const minute = pad2(10 + attempt);
	const completedAt = `2026-08-18T10:${minute}:02.${String(496069 + attempt * 7).padStart(6, "0")}+08:00`;
	const startingAt = `2026-08-18T10:${minute}:02.${String(496892 + attempt * 11).padStart(6, "0")}+08:00`;
	return [
		"backend-service: go test ./... FAILED (exit 1):",
		`{"time":"${completedAt}","level":"INFO","msg":"[resolve-team] completed trackingID=${uuidFor(attempt)} documentType=message total=2 resolved=1 notFound=1 duration=0.000s","service_name":"backend-service","hostname":"JV4MPQJ4M2"}`,
		`{"time":"${startingAt}","level":"INFO","msg":"[resolve-team] starting trackingID=${uuidFor(attempt + 100)} documentType=message qualifyingRows=1","service_name":"backend-service","hostname":"JV4MPQJ4M2"}`,
		"FAIL",
		`FAIL\t${SNOW_PACKAGE}\t${(12 + attempt).toFixed(3)}s`,
		`ok  \t${SNOW_PACKAGE}/odata\t${(3 + attempt * 0.01).toFixed(3)}s`,
		"ok  \tgithub.com/macotestdashboard/backend-service/internal/services/unittest\t(cached)",
		`---- FAIL: ${SNOW_TEST} (0.31s)`,
		`FAIL; ${BASELINE_VERIFY_ERROR_PREFIX} pnpm run test (whole suite) PASSES at baseline ${BASELINE_SHA} — the failure is new on this branch${attempt >= 3 ? " [cached]" : ""}`,
	].join("\n");
}

/** The 11 snow failures of run 01-02-50 attempts 2–12, as in-repo replicas. */
const SNOW_REPLICA_FAILURES: string[] = Array.from({ length: 11 }, (_, i) => snowReplica(i + 2));

// ─── Shared stage harness (rc8-rc12 / red-loop pattern) ─────────────────────

function mkState(): PipelineState {
	return {
		setup: {
			worktreePath: wt,
			specDirectory: join(wt, "docs", "specifications", "sig-noise"),
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "sig-noise",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		// No deliverables, no scenarioRefs: deliverable/change/symbol gates are
		// trivially green and constant, so the ProgressSignature is driven by
		// gate.errors (the noise) + the constant claimed footprint alone.
		spec: { phases: [{ name: "P1", description: "x" }] },
	} as unknown as PipelineState;
}

interface CapturedCalls {
	tdd: AgentCall[];
	impl: AgentCall[];
	orch: AgentCall[];
	judge: AgentCall[];
	logs: string[];
	escalations: Array<{ kind: string; message: string }>;
}

function mkCtx(opts: { maxImplAttempts?: number; escalate?: RunOptions["escalate"] } = {}): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = { tdd: [], impl: [], orch: [], judge: [], logs: [], escalations: [] };
	const escalate = opts.escalate ?? ((async (failure: { kind: string; message: string }) => {
		calls.escalations.push(failure);
		return undefined;
	}) as unknown as RunOptions["escalate"]);
	const ctx: StageContext = {
		task: "",
		options: { escalate } as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				calls.tdd.push(call);
				return { text: "", control: { testFiles: ["tests/red.test.ts"] } };
			}
			if (call.agent === "implementer") {
				calls.impl.push(call);
				// Constant claimed change set ⇒ constant ProgressSignature.footprint
				// across attempts (AC-07 pins BOTH components; the trip itself is the
				// conjunction proof).
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			if (call.agent === "judge") {
				calls.judge.push(call);
				return { text: "", control: null };
			}
			if (call.agent === "tdd-coverage-classifier") {
				return { text: "", control: { allCovered: true, coveredScenarios: [], missingScenarios: [], summary: "covered" } };
			}
			if (call.agent === "code-reviewer") {
				return { text: "", control: { verdict: "strong", summary: "ok", contradictions: [] } };
			}
			calls.orch.push(call);
			return { text: "", control: {} };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		// "budget.check failing after 12 attempts": the consult fails once 12
		// implementer dispatches have happened — deterministic regardless of how
		// many guard sites consult it per attempt (for-cond, RED while, …).
		budget: {
			count: 0,
			check: () => calls.impl.length < (opts.maxImplAttempts ?? 12),
			spent() {
				this.count++;
				return true;
			},
		} satisfies Budget,
		log(m: string) {
			calls.logs.push(m);
		},
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, calls };
}

/** Seed runBuildGate with per-call sequenced error texts (repeating the last
 *  when the queue drains). `baselineCheck` is ABSENT on every result (D-4:
 *  unclassified per SCENARIO-003 — the historical retry path the no-progress
 *  detector guards). */
function gateSeq(errorsPerAttempt: string[]): void {
	let i = 0;
	buildGate.mockImplementation(() => {
		const errors = errorsPerAttempt[Math.min(i, errorsPerAttempt.length - 1)];
		i++;
		return { pass: false, inScopePass: false, ran: ["mock"], errors: [errors], outOfScopeErrors: [] } as never;
	});
}

let wt: string;

beforeEach(() => {
	resetJudgeBudgets();
	delete process.env.SUPER_DEV_DISABLE_JUDGE;
	redCheck.mockReset();
	buildGate.mockReset();
	// J9-b pattern: a real temp worktree holding the confirmed RED test, so the
	// RED snapshot/oracle plumbing runs its real (constant) path.
	wt = mkdtempSync(join(tmpdir(), "sd-signoise-"));
	mkdirSync(join(wt, "tests"), { recursive: true });
	writeFileSync(join(wt, "tests", "red.test.ts"), `import { save } from "../src/save";\nexpect(save(1)).toBe(2); // SCENARIO-014 signature noise\n`);
	redCheck.mockImplementation((_cwd: string, _targets: string[], opts?: { onResult?: (diagnostic: RedCheckDiagnostic) => void }) => {
		opts?.onResult?.({
			plan: { cwd: wt, argv: ["vitest", "run", "tests/red.test.ts"] },
			language: "backend",
			status: "red",
			exitCode: 1,
			signal: null,
			outputTail: "FAIL tests/red.test.ts > save\nexpect(save(1)).toBe(2);",
		});
		return "red";
	});
});

afterEach(() => {
	try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
});

// ─── T2.1 — strip-before-cap through the real attempt loop ──────────────────

describe("T2.1 — normalizeSignatureText strips volatile noise before the 800-cap (SCENARIO-014/015 · AC-06)", () => {
	it("FIX (RED pre-fix): two attempts differing ONLY in >800 chars of leading noise trip repeatedNoProgress at attempt 2", async () => {
		// 12 distinct noise variants (one per budgeted attempt — repeat-last is
		// never reached pre-fix, so no accidental pre-fix A/B/A match) over the
		// SHARED discriminating tail. Pre-fix, the whitespace-only normalizer's
		// 800-char window sits entirely inside the differing noise ⇒ every
		// signature is distinct ⇒ the trip never fires ⇒ the loop runs to budget.
		const seeds = Array.from({ length: 12 }, (_, i) => `${leadingNoise(i + 1)}\n${SNOW_TAIL}`);
		gateSeq(seeds);
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		// SCENARIO-017's anti-windup engages on the SECOND occurrence: the two
		// noise-only variants normalized to ONE ProgressSignature.failure.
		expect(calls.logs.some((l) => /stopped after repeated no-progress failure on attempt 2/.test(l))).toBe(true);
		// No third identical implementer spawn (SCENARIO-016/017, AC-07).
		expect(calls.impl).toHaveLength(2);
		// It stopped on no-progress, NOT on budget exhaustion.
		expect(calls.logs.some((l) => /budget exhausted/.test(l))).toBe(false);
	}, 20_000);

	it("CONTROL (green pre-fix AND post-fix): the same noise prefix on both attempts trips identically", async () => {
		const same = `${leadingNoise(7)}\n${SNOW_TAIL}`;
		gateSeq([same, same]);
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		// Pure repeatedNoProgress semantics (identical raw errors ⇒ identical
		// signatures under ANY normalizer) — guards against a trivial
		// always-trip implementation being mistaken for the fix.
		expect(calls.logs.some((l) => /stopped after repeated no-progress failure on attempt 2/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(2);
	}, 20_000);

	it("CONTROL (green pre-fix AND post-fix): an attempt-2 failing-package swap (snow→auth) does NOT trip (AC-08)", async () => {
		gateSeq([`${leadingNoise(1)}\n${SNOW_TAIL}`, `${leadingNoise(2)}\n${AUTH_TAIL}`]);
		// Budget fails after 2 dispatches: the run's ONLY question is whether
		// attempt 2 (auth) matched attempt 1 (snow). It must not — through the
		// REAL pipeline path, post-strip the failing package survives the cap
		// (SCENARIO-015's converse: signal is kept, so it still discriminates).
		const { ctx, calls } = mkCtx({ maxImplAttempts: 2 });
		await (implementationStage as Stage).run(mkState(), ctx);

		expect(calls.logs.some((l) => /repeated no-progress/.test(l))).toBe(false);
		expect(calls.impl).toHaveLength(2);
		expect(calls.logs.some((l) => /budget exhausted/.test(l))).toBe(true);
	}, 20_000);
});

// ─── T2.2 — 11-replica snow replay → ONE signature → anti-windup ────────────

describe("T2.2 — SNOW_REPLICA_FAILURES replay: one signature, anti-windup at attempt 2 (SCENARIO-016/017 · AC-07)", () => {
	it("FIX (RED pre-fix): replaying the 11 replicas stops at attempt 2 with EXACTLY two implementer dispatches", async () => {
		// The 11 replicas + one extra noise-only variant as the 12th seed, so the
		// pre-fix run NEVER repeats a signature within its 12 budgeted attempts
		// (the fixture itself stays exactly 11 replicas).
		gateSeq([...SNOW_REPLICA_FAILURES, snowReplica(13)]);
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		// The second occurrence matched the first — only possible if ALL
		// replicas normalized to ONE ProgressSignature.failure (both components:
		// the footprint is the constant claimed change set).
		expect(calls.logs.some((l) => /stopped after repeated no-progress failure on attempt 2/.test(l))).toBe(true);
		// SCENARIO-017: no third identical implementer spawn absent an explicit
		// judge/HITL continue decision.
		expect(calls.impl).toHaveLength(2);
		expect(calls.logs.some((l) => /budget exhausted/.test(l))).toBe(false);
	}, 20_000);

	it("FIX (RED pre-fix): the stop routes through the existing stage9.impl-no-progress judge/HITL machinery", async () => {
		gateSeq([...SNOW_REPLICA_FAILURES, snowReplica(13)]);
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(), ctx);

		// Judge agent consulted (resetJudgeBudgets in beforeEach ⇒ per-signature
		// budget fresh) at the impl-no-progress wiring point, carrying the scope.
		expect(calls.judge).toHaveLength(1);
		expect(calls.judge[0]!.prompt).toContain("stage9.impl-no-progress.phase-01");
		// Soft HITL mirror surfaced (headless dismissal falls through to the
		// terminal no-progress break — today's machinery, untouched).
		expect(calls.escalations).toHaveLength(1);
		expect(calls.escalations[0]!.kind).toBe("stagnation");
	}, 20_000);
});

// ─── Fixture contract (SCENARIO-016's replica contract — controls) ──────────

describe("fixture contract — SNOW_REPLICA_FAILURES (SCENARIO-016 · AC-06/AC-07)", () => {
	it("holds exactly 11 pairwise-DISTINCT replicas, each carrying the four discriminating constants and every AC-06 noise class", () => {
		expect(SNOW_REPLICA_FAILURES).toHaveLength(11);
		// Raw texts pairwise distinct (a degenerate identical fixture would trip
		// even the PRE-fix normalizer and void the RED evidence).
		expect(new Set(SNOW_REPLICA_FAILURES).size).toBe(11);
		for (const r of SNOW_REPLICA_FAILURES) {
			expect(r).toContain(SNOW_PACKAGE);
			expect(r).toContain(SNOW_TEST);
			expect(r).toContain("[baseline-verify] regression");
			expect(r).toContain(BASELINE_SHA);
			// Every AC-06 noise class present per replica: ISO-8601 timestamp with
			// timezone + fractional seconds, canonical UUID, fractional-second
			// duration, and the `(cached)` marker.
			expect(r).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\+08:00/);
			expect(r).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
			expect(r).toMatch(/\b\d+\.\d+s\b/);
			expect(r).toContain("(cached)");
		}
		// The memo-hit `[cached]` suffix varies across replicas: attempt 2's
		// baseline verdict was fresh (run.log:851), attempts 3+ memoized (944+).
		expect(SNOW_REPLICA_FAILURES[0]).not.toContain("[cached]");
		for (const r of SNOW_REPLICA_FAILURES.slice(1)) {
			expect(r).toContain("[cached]");
		}
	});

	it("normalizes to ONE signature across all 11 replicas (AC-06 both directions, via the Phase-1 primitive + the collapse/trim)", () => {
		// The `[cached]` memo-hit suffix leaves a trailing space on the stripped
		// text of attempts 3+ — exactly the residue the normalizer's AFTER-strip
		// whitespace-collapse/trim removes, so the contract is pinned on the full
		// strip → collapse → trim (→ cap) semantics the stage applies.
		const collapsed = SNOW_REPLICA_FAILURES.map((r) => stripVolatileNoise(r).replace(/\s+/g, " ").trim());
		expect(new Set(collapsed).size).toBe(1);
		// …and the full post-fix normalizeSignatureText semantics (with the
		// 800-cap) also yields exactly one signature across all 11 replicas.
		const normalized = collapsed.map((s) => s.slice(0, 800));
		expect(new Set(normalized).size).toBe(1);
	});

	it("is WHY the detector never fired on run 01-02-50: the PRE-fix normalizer sees 11 DISTINCT 800-char prefixes", () => {
		// The pre-fix whitespace-only normalizer (collapse → trim → cap 800):
		// every replica's window is pairwise distinct — the historical open-loop
		// retry this cycle closes. Includes the harness's 12th seed (replica 13).
		const preFix = [...SNOW_REPLICA_FAILURES, snowReplica(13)].map((r) => r.replace(/\s+/g, " ").trim().slice(0, 800));
		expect(new Set(preFix).size).toBe(12);
	});

	it("T2.1 premise: leadingNoise is >800 chars of PURE noise (SCENARIO-015's displacement condition)", () => {
		for (const variant of [1, 2, 12]) {
			expect(leadingNoise(variant).replace(/\s+/g, " ").length).toBeGreaterThan(800);
		}
		// Pure-noise contract: the ENTIRE block strips to whitespace-only residue,
		// so nothing of it can displace the discriminating tail post-fix.
		expect(stripVolatileNoise(leadingNoise(1)).trim()).toBe("");
		// Variants differ as raw text (pre-fix distinctness) but agree post-strip.
		expect(leadingNoise(1)).not.toBe(leadingNoise(2));
		expect(stripVolatileNoise(leadingNoise(1))).toBe(stripVolatileNoise(leadingNoise(2)));
	});
});
