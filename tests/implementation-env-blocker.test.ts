/**
 * Phase 3 (Track 30) — PRA wiring I: classifier insertion + environmental-
 * blocker quarantine/re-gate branch (tests/implementation-env-blocker.test.ts
 * — RED-first per SCENARIO-031/AC-14).
 *
 * T3.1 (SCENARIO-004 · AC-01/AC-02): the deterministic classification floor
 *   runs at the green-branch fall-through — AFTER the own-scope booleans
 *   exist, BEFORE `failureReasons`/missing-test routing/challenge re-author/
 *   signature — so an environmental blocker can never be misrouted as a
 *   challenge, re-spawn the implementer, or reach the missing-test edges.
 *   Seeded per the spec: mocked `runBuildGate` returning the regression
 *   verdict over out-of-scope-only errors (synthetic block built from the
 *   REAL `BASELINE_VERIFY_ERROR_PREFIX`), phase with no deliverables so the
 *   own-scope evidence booleans are green. Pre-fix: the same seed falls
 *   through to `failureReasons` and re-spawns the implementer — RED.
 *
 * T3.2 (SCENARIO-005/006/008/009 · AC-03): non-empty dirt inventory → scoped
 *   stash → ledger record → baseline-memo clear → EXACTLY ONE gate re-run.
 *   The dirt harness runs against a REAL temp git worktree (mkdtemp repo
 *   wired into mkState's setup.worktreePath/specDirectory, `runBuildGate`
 *   still mocked) pre-dirtied with a foreign tracked modification
 *   `internal/services/snow/enrichment.go` outside scope/claims, plus every
 *   canonical-exclusion class (spec-dir file, bookkeeping, copied env file,
 *   `.super-dev/` state, claimed file, declared-scope file, RED test file) —
 *   the quarantine pathspec must contain ONLY the foreign path.
 *
 * T3.3 (SCENARIO-007 · AC-03): green-through on the re-run result — a FRESH
 *   deliverable check (`resetDeliverableCheckCache` + `skipTests:false`,
 *   D-12) and the EXISTING GREEN / IN-SCOPE GREEN logs, with zero further
 *   implementer spawns.
 *
 * T3.4 (SCENARIO-013 · AC-05): the AC-05 log literals, asserted by substring
 *   on the ctx.log sink — `next=<quarantine+re-gate>` (dirt non-empty +
 *   switch unset) and `next=<judge: fix-environment/escalate>` (no-dirt /
 *   still-blocked-after-re-run / kill-switch / degrade paths).
 *
 * Phase 4 (Track 30) — PRA wiring II: judge routing at the blocker boundary +
 * kill-switch and degrade fallbacks.
 *
 * T4.1 (SCENARIO-010/011 · AC-04): a SINGLE runJudge hand-off reached from
 *   all five still-blocked entries (dirt empty | kill-switch | re-run budget
 *   used | re-run still blocked | quarantine failed) at scope
 *   `stage9.impl-env-blocker.<phaseId>` with allowedRoutes EXACTLY
 *   ["fix-environment"] (escalate-now implied by judge.ts), context carrying
 *   the gate tail (≤12) + baseline status/evidence + the dirt inventory
 *   (`(empty)` when none) + the one-line prior-fault count IFF the ledger
 *   exists (OQ-3/D-8), outputTails = gate tail + baseline evidence (+ gate2
 *   tail when present) so INV-2 quote verification can pass. D-13: the
 *   signature is keyed on out-of-scope subjects + baseline status — never
 *   progressSignature.failure.
 *
 * T4.2 (SCENARIO-012 · AC-04): the outcome ladder — routed fix-environment →
 *   log + soft HITL (kind "stagnation", severity "soft", stage
 *   "implementation", findings = gate tail + baseline + inventory ≤ 12) +
 *   terminal stop (terminalStopReason "failed", distinct stop log, NO
 *   applyRetryDecision — D-5); escalate/discarded/degraded (incl.
 *   SUPER_DEV_DISABLE_JUDGE=1 and budget exhaustion) → the SAME HITL surface
 *   then stop; headless → both packets LOGGED then stop. No arm continues the
 *   loop or spawns the implementer.
 *
 * T4.3 (SCENARIO-024 · AC-11/AC-04): kill-switch ordering — the detection
 *   warning literal is emitted BEFORE the judge hand-off; structurally no
 *   stash (the branch never calls quarantineDirt and the primitive
 *   short-circuits).
 *
 * T4.4 (SCENARIO-029 · AC-13): quarantine mechanism failure (real git failure:
 *   read-only `.git` makes `git stash push` exit non-zero while porcelain
 *   reads still succeed) degrades to the warning literal + the T4.1 judge
 *   hand-off; the attempt loop never throws; nothing was stashed so no
 *   recovery is owed; envBlockerRegateUsed is NOT consumed on failure.
 *
 * Phase 6 (Track 30) — PRD wiring: ledger consumers at the blocker boundary.
 *
 * T6.2 (SCENARIO-026 · AC-12): after the env-blocker judge hand-off settles,
 *   a routed/escalated VERDICT appends a `kind:"judge-environmental"`
 *   record — key set exactly {kind, paths, stashRef, reason} with null
 *   paths/stashRef and reason = "<route>: <diagnosis tail>"; discarded/
 *   degraded outcomes carry no verdict, so no record exists to write (D-14:
 *   lenient preexisting grants never record either).
 * T6.3 (SCENARIO-030 · AC-13/AC-12): an unwritable specDir (chmod 0o555,
 *   skipped as root) ⇒ the ledger appends degrade to /ledger append failed/
 *   warnings — the branch still completes through the judge route, no throw,
 *   implementer count unchanged.
 *
 * Harness (tests/implementation-rc8-rc12.test.ts + tests/signature-noise
 * .test.ts patterns): mocked `runBuildGate` with per-call sequenced results,
 * `mkState`/`mkCtx`, agent-dispatch counting, real temp git worktrees via
 * mkdtemp. `runDeliverableCheck`/`resetDeliverableCheckCache` are spied via
 * the real gates-module import (the barrel mock delegates to the REAL
 * implementations so behavior stays real while the calls are observable);
 * `clearBaselineCache` is partial-mocked with a spy (actual preserved for
 * `verifyUntouchedFailuresAgainstBaseline` — D-1a observation). Hermetic: no
 * network, no LLM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

// ─── Mocks (rc8-rc12/signature-noise pattern) ───────────────────────────────
// The barrel mock keeps everything real except the scripted oracle/gate; the
// deliverable check DELEGATES to the real gates-module implementation so the
// T3.3 skipTests:false pin observes real calls (spy/counting via the real
// gates module import), and the cache reset delegates to the real resetter.
vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const gates = await vi.importActual<typeof import("../src/build-runner/gates.ts")>("../src/build-runner/gates.ts");
	return {
		...actual,
		runRedCheck: vi.fn((): string => "unknown"),
		runBuildGate: vi.fn(() => ({
			pass: true,
			inScopePass: false,
			ran: ["mock"],
			errors: [] as string[],
			outOfScopeErrors: [] as string[],
		})),
		runDeliverableCheck: vi.fn((...args: Parameters<typeof gates.runDeliverableCheck>) => gates.runDeliverableCheck(...args)),
		resetDeliverableCheckCache: vi.fn(() => gates.resetDeliverableCheckCache()),
	};
});

// D-1a observation point: `clearBaselineCache` spied; the baseline verifier
// itself stays real (partial mock — actual for verifyUntouchedFailures-
// AgainstBaseline) so gates.ts behavior is unchanged.
vi.mock("../src/build-runner/baseline.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/build-runner/baseline.ts")>();
	return {
		...actual,
		clearBaselineCache: vi.fn(() => actual.clearBaselineCache()),
	};
});

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, runBuildGate, runDeliverableCheck, resetDeliverableCheckCache } from "../src/build-runner.ts";
import { clearBaselineCache } from "../src/build-runner/baseline.ts";
import { BASELINE_VERIFY_ERROR_PREFIX } from "../src/build-runner/gates.ts";
import { resetJudgeBudgets } from "../src/stages/judge.ts";

const redCheck = vi.mocked(runRedCheck);
const buildGate = vi.mocked(runBuildGate);
const deliverableCheckMock = vi.mocked(runDeliverableCheck);
const resetDeliverableCacheMock = vi.mocked(resetDeliverableCheckCache);
const clearBaselineCacheMock = vi.mocked(clearBaselineCache);

// ─── Env-blocker gate seeds (spec T3.1: regression over out-of-scope-only) ──

const SNOW_PACKAGE = "github.com/macotestdashboard/backend-service/internal/services/snow";
const SNOW_TEST = "TestEnrichment_AreaCandidates_ClusterMatch_MatchType";
const BASELINE_SHA = "45b865ef";

/** The out-of-scope failure block (a `gate.outOfScopeErrors` member). */
const OOS_BLOCK = [
	"FAIL",
	`FAIL\t${SNOW_PACKAGE}\t14.439s`,
	`---- FAIL: ${SNOW_TEST} (0.31s)`,
].join("\n");

/** The synthetic regression strip — built from the REAL exported gate prefix
 *  (single-sourced, D-11) so the classifier's prefix match cannot drift. */
const SYNTHETIC_BLOCK = `${BASELINE_VERIFY_ERROR_PREFIX} pnpm run test (whole suite) PASSES at baseline ${BASELINE_SHA} — the failure is new on this branch`;

interface GateSeed {
	pass: boolean;
	inScopePass: boolean;
	ran: string[];
	errors: string[];
	outOfScopeErrors: string[];
	baselineCheck?: { status: "preexisting" | "regression" | "unknown"; evidence: string };
}

/** SCENARIO-004's seed: regression verdict over out-of-scope-only errors,
 *  own-scope evidence green (the phase has no deliverables). */
function envBlockerGate(): GateSeed {
	return {
		pass: false,
		inScopePass: false,
		ran: ["mock"],
		errors: [OOS_BLOCK, SYNTHETIC_BLOCK],
		outOfScopeErrors: [OOS_BLOCK],
		baselineCheck: { status: "regression", evidence: `pnpm run test (whole suite) PASSES at baseline ${BASELINE_SHA}` },
	};
}

/** A genuine in-scope failure (control): keeps today's retry semantics. */
function inScopeFailureGate(): GateSeed {
	return {
		pass: false,
		inScopePass: false,
		ran: ["mock"],
		errors: [`FAIL github.com/macotestdashboard/backend-service/internal/services/auth/handler_test.go: undefined: Handler.Foo`],
		outOfScopeErrors: [],
	};
}

/** Seed runBuildGate with per-call sequenced results (repeating the last
 *  when the queue drains). */
function gateSeq(seeds: GateSeed[]): void {
	let i = 0;
	buildGate.mockImplementation(() => {
		const seed = seeds[Math.min(i, seeds.length - 1)];
		i++;
		return { ...seed } as never;
	});
}

/** runRedCheck sequencing: the INITIAL RED oracle must be red (so a RED is
 *  accepted), every POST-implementation oracle green (so `tddClean` holds —
 *  the own-scope evidence the blocker classification requires). */
function redThenGreen(): void {
	let n = 0;
	redCheck.mockImplementation(() => {
		n++;
		return n === 1 ? "red" : "green";
	});
}

// ─── Shared stage harness (rc8-rc12 / signature-noise pattern) ──────────────

function mkState(wt: string, phases?: unknown): PipelineState {
	return {
		setup: {
			worktreePath: wt,
			specDirectory: join(wt, "docs", "specifications", "env-blk"),
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "env-blk",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		// No deliverables by default: deliverable/change/symbol gates are
		// trivially green so the own-scope evidence booleans hold.
		spec: { phases: phases ?? [{ name: "P1", description: "x" }] },
	} as unknown as PipelineState;
}

interface CapturedCalls {
	tdd: AgentCall[];
	impl: AgentCall[];
	orch: AgentCall[];
	judge: AgentCall[];
	logs: string[];
	escalations: CapturedEscalation[];
}

/** The escalation failure objects surfaced at the HITL boundary (T4.2 pins
 *  kind/severity/stage and the findings packet slice). */
interface CapturedEscalation {
	kind: string;
	message: string;
	severity?: string | null;
	stage?: string | null;
	findings?: Array<{ file?: string | null; severity?: string | null; title?: string | null }>;
}

function mkCtx(opts: { maxImplAttempts?: number; judgeControl?: Record<string, unknown>; escalate?: RunOptions["escalate"] | false } = {}): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = { tdd: [], impl: [], orch: [], judge: [], logs: [], escalations: [] };
	// `escalate: false` ⇒ HEADLESS (no callback at all — the T4.2 log-packets arm);
	// a function ⇒ its decision is returned (the T4.1 no-applyRetryDecision pin);
	// undefined ⇒ the default recorder returning no decision (surface observed,
	// decision dismissed).
	const headless = opts.escalate === false;
	const decide = headless ? undefined : opts.escalate;
	const escalate: RunOptions["escalate"] | undefined = headless ? undefined : async (failure) => {
		calls.escalations.push(failure as CapturedEscalation);
		return decide ? decide(failure) : undefined;
	};
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
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			if (call.agent === "judge") {
				calls.judge.push(call);
				return { text: "", control: (opts.judgeControl ?? null) as AgentResult["control"] };
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

// ─── Real-git worktree fixture (T3.2/T3.4 dirt harness) ─────────────────────

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function writeRepoFile(root: string, rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

/**
 * A real git worktree carrying the SCENARIO-005/008 fixture: a foreign
 * tracked modification `internal/services/snow/enrichment.go` (the only
 * quarantinable path) plus one member of every canonical-exclusion class —
 * spec-dir file, harness bookkeeping inside the spec dir, copied env file,
 * `.super-dev/` state, claimed file (`filesCreated`), declared-scope file
 * (`requireFiles`), and the RED test file (`testFiles`).
 */
function mkEnvBlockerWorktree(): { wt: string; specDir: string } {
	const wt = mkdtempSync(join(tmpdir(), "sd-envblk-"));
	git(wt, "init", "-q", "-b", "main");
	git(wt, "config", "user.email", "t@t");
	git(wt, "config", "user.name", "t");
	// Foreign tracked file, committed clean…
	writeRepoFile(wt, "internal/services/snow/enrichment.go", "package snow\n\nfunc Enrich() int { return 1 }\n");
	git(wt, "add", "-A");
	git(wt, "commit", "-qm", "init");
	// …then dirtied (the pre-existing snow failure's substrate).
	writeRepoFile(wt, "internal/services/snow/enrichment.go", "package snow\n\nfunc Enrich() int { return 2 }\n");
	// Canonical-exclusion classes (must NEVER appear in the quarantine pathspec).
	const specDir = join(wt, "docs", "specifications", "env-blk");
	writeRepoFile(wt, "docs/specifications/env-blk/spec.md", "# spec\n");
	writeRepoFile(wt, "docs/specifications/env-blk/events.jsonl", "{}\n");
	writeRepoFile(wt, ".super-dev/run-state.json", "{}\n");
	writeRepoFile(wt, ".env.local", "SECRET=1\n");
	writeRepoFile(wt, "tests/red.test.ts", `import { save } from "../src/save";\nexpect(save(1)).toBe(2); // SCENARIO-004 env blocker\n`);
	writeRepoFile(wt, "src/new.ts", "export const NEW = 1;\n");
	writeRepoFile(wt, "src/in-scope.ts", "export const IN_SCOPE = 1;\n");
	return { wt, specDir };
}

const repos: string[] = [];

/** The real-git state shape: the implementer claims `src/new.ts` (created),
 *  the phase declares `src/in-scope.ts` (requireFiles), and the run's env
 *  files list carries `.env.local`. */
function mkRealGitState(wt: string): PipelineState {
	const state = mkState(wt, [{
		name: "P1",
		description: "x",
		deliverables: { requireFiles: ["src/in-scope.ts"] },
	}]);
	(state.setup as { copiedEnvFiles?: string[] }).copiedEnvFiles = [".env.local"];
	return state;
}

function realGitCtx(opts: Parameters<typeof mkCtx>[0] = {}): { ctx: StageContext; calls: CapturedCalls } {
	// Same harness, but the implementer's claim must be a file that EXISTS in
	// the real worktree (deliverable-check bridge + symbol gate read it); the
	// dispatch is still COUNTED (AC-02's spawn-count assertion reads it).
	const made = mkCtx(opts);
	const origAgent = made.ctx.agent.bind(made.ctx);
	made.ctx.agent = async (call: AgentCall): Promise<AgentResult> => {
		if (call.agent === "implementer") {
			made.calls.impl.push(call);
			return { text: "", control: { filesCreated: ["src/new.ts"] } };
		}
		return origAgent(call);
	};
	return made;
}

function readLedger(specDir: string): Array<Record<string, unknown>> {
	const text = readFileSync(join(specDir, ".environment-faults.jsonl"), "utf8");
	return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Parse the offered-route list out of a judge prompt (buildJudgePrompt's
 *  `## Routes you may choose from (closed set)` block) — the exact surface
 *  T4.1 pins as `["fix-environment"]` + the always-implied escalate-now. */
function offeredRoutes(prompt: string): string[] {
	const start = prompt.indexOf("## Routes you may choose from (closed set)");
	expect(start).toBeGreaterThanOrEqual(0);
	const routes: string[] = [];
	for (const line of prompt.slice(start).split("\n").slice(1)) {
		if (!line.startsWith("- ")) break;
		const name = line.slice(2).split(" ")[0]!.trim();
		if (!routes.includes(name)) routes.push(name);
	}
	return routes;
}

// ─── Suite lifecycle ─────────────────────────────────────────────────────────

let wt: string;

beforeEach(() => {
	resetJudgeBudgets();
	delete process.env.SUPER_DEV_DISABLE_JUDGE;
	delete process.env.SUPER_DEV_NO_DIRTY_QUARANTINE;
	redCheck.mockReset();
	buildGate.mockReset();
	deliverableCheckMock.mockReset();
	resetDeliverableCacheMock.mockReset();
	clearBaselineCacheMock.mockClear();
	// A plain (non-git) temp dir holding the confirmed RED test file, so the
	// RED snapshot/oracle plumbing runs its real (constant) path; git porcelain
	// reads fail ⇒ the dirt inventory is EMPTY (the no-dirt harness).
	wt = mkdtempSync(join(tmpdir(), "sd-envblk-plain-"));
	mkdirSync(join(wt, "tests"), { recursive: true });
	writeFileSync(join(wt, "tests", "red.test.ts"), `import { save } from "../src/save";\nexpect(save(1)).toBe(2); // SCENARIO-004 env blocker\n`);
});

afterEach(() => {
	try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
	while (repos.length) {
		const r = repos.pop()!;
		try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

// ─── T3.2 — dirt inventory → scoped stash → ledger → memo clear → ONE re-run ──

describe("T3.2 — dirt inventory → scoped stash → ledger record → memo clear → EXACTLY ONE re-run (SCENARIO-005/006/008/009 · AC-03)", () => {
	it("FIX (RED pre-fix): real-git dirt — one stash entry, one quarantine ledger line with canonical exclusions, build gate re-run EXACTLY ONCE, implementer count unchanged", async () => {
		const { wt: repo, specDir } = mkEnvBlockerWorktree();
		repos.push(repo);
		gateSeq([envBlockerGate()]); // repeats: the re-run is still blocked
		redThenGreen();
		const { ctx, calls } = realGitCtx();
		await (implementationStage as Stage).run(mkRealGitState(repo), ctx);

		// EXACTLY ONE re-run for the blocker (SCENARIO-005): original + re-run.
		expect(buildGate).toHaveBeenCalledTimes(2);
		// A recoverable quarantine ran: exactly one stash entry (AC-03a).
		expect(git(repo, "stash", "list").split("\n").filter(Boolean)).toHaveLength(1);
		// SCENARIO-006 substrate: after quarantine the porcelain no longer lists
		// the foreign path (the flip the fresh re-run consumes in T3.3).
		expect(git(repo, "status", "--porcelain")).not.toContain("internal/services/snow/enrichment.go");
		// The foreign file is recoverable from the stash (tracked mod, -u).
		expect(git(repo, "stash", "show", "--name-only")).toContain("internal/services/snow/enrichment.go");
		// Ledger: exactly one `kind:"quarantine"` line, exact key set (AC-12),
		// canonical inventory inherited — spec-dir/bookkeeping/claimed/scope/test
		// files NEVER in the quarantined paths (SCENARIO-008/009).
		const ledger = readLedger(specDir);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]!["kind"]).toBe("quarantine");
		expect(Object.keys(ledger[0]!)).toEqual(["kind", "paths", "stashRef", "reason"]);
		expect(ledger[0]!["paths"]).toEqual(["internal/services/snow/enrichment.go"]);
		expect(ledger[0]!["stashRef"]).toBe(git(repo, "rev-parse", "refs/stash"));
		expect(String(ledger[0]!["reason"])).toContain("environmental-blocker phase phase-01");
		// Recovery log (AC-10 parity): paths + stash ref + git stash pop + kill-switch.
		const recovery = calls.logs.find((l) => /quarantined foreign uncommitted state/.test(l));
		expect(recovery).toBeDefined();
		expect(recovery).toContain("internal/services/snow/enrichment.go");
		expect(recovery).toContain("git stash pop");
		expect(recovery).toContain("SUPER_DEV_NO_DIRTY_QUARANTINE=1");
		expect(recovery).toContain(String(git(repo, "rev-parse", "refs/stash")));
		// AC-02 holds through the whole interaction: ZERO further spawns.
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): clearBaselineCache is called before the re-run when dirt exists, and NEVER on the no-dirt path (D-1a)", async () => {
		// No-dirt path (plain non-git harness): zero calls.
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const plain = mkCtx();
		await (implementationStage as Stage).run(mkState(wt), plain.ctx);
		expect(clearBaselineCacheMock).toHaveBeenCalledTimes(0);

		// Dirt path (real-git harness): called at least once immediately before
		// the single re-run, so it cannot inherit a memoized pre-quarantine verdict.
		const { wt: repo } = mkEnvBlockerWorktree();
		repos.push(repo);
		clearBaselineCacheMock.mockClear();
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx } = realGitCtx();
		await (implementationStage as Stage).run(mkRealGitState(repo), ctx);
		expect(clearBaselineCacheMock.mock.calls.length).toBeGreaterThanOrEqual(1);
	}, 20_000);
});

// ─── T3.3 — green-through on the re-run result ───────────────────────────

describe("T3.3 — green-through on the re-run result: fresh deliverable check, existing branch/logs (SCENARIO-007 · AC-03)", () => {
	it("FIX (RED pre-fix): call 2 = full pass → phase ends GREEN via the re-run with a FRESH deliverable check (skipTests:false) and ZERO further spawns", async () => {
		const { wt: repo, specDir } = mkEnvBlockerWorktree();
		repos.push(repo);
		gateSeq([envBlockerGate(), { pass: true, inScopePass: false, ran: ["mock"], errors: [], outOfScopeErrors: [] }]);
		redThenGreen();
		const { ctx, calls } = realGitCtx();
		const control = await (implementationStage as Stage).run(mkRealGitState(repo), ctx) as ControlObj;

		// The EXISTING green-branch log, on the SAME attempt (the re-run happens
		// inside attempt 1 — SCENARIO-007's "through the existing branch").
		expect(calls.logs.some((l) => l === "Implementation phase-01 GREEN on attempt 1")).toBe(true);
		const phaseStatus = (control.phaseStatus as Array<{ id: string; status: string }> | undefined) ?? [];
		expect(phaseStatus.find((p) => p.id === "phase-01")?.status).toBe("green");
		expect(control.phasesCompleted).toBe(1);
		expect(control.allGreen).toBe(true);
		// D-12: the re-run green-through re-verifies deliverables against a
		// build-green state — the ORIGINAL check ran skipTests:true (build red),
		// the fresh check runs skipTests:false AFTER the cache reset.
		expect(deliverableCheckMock).toHaveBeenCalledTimes(2);
		expect((deliverableCheckMock.mock.calls[0]![2] as { skipTests?: boolean }).skipTests).toBe(true);
		expect((deliverableCheckMock.mock.calls[1]![2] as { skipTests?: boolean }).skipTests).toBe(false);
		expect(resetDeliverableCacheMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		// The quarantine happened exactly once on the way through.
		expect(git(repo, "stash", "list").split("\n").filter(Boolean)).toHaveLength(1);
		expect(buildGate).toHaveBeenCalledTimes(2);
		// ZERO further implementer spawns after the blocker (AC-02/AC-03).
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): call 2 = evidence-backed inScopePass (preexisting) → IN-SCOPE GREEN via the re-run, same no-spawn contract", async () => {
		const { wt: repo } = mkEnvBlockerWorktree();
		repos.push(repo);
		gateSeq([envBlockerGate(), {
			pass: false,
			inScopePass: true,
			ran: ["mock"],
			errors: [OOS_BLOCK],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "preexisting", evidence: `all 1 subject(s) FAIL at baseline ${BASELINE_SHA}` },
		}]);
		redThenGreen();
		const { ctx, calls } = realGitCtx();
		const control = await (implementationStage as Stage).run(mkRealGitState(repo), ctx) as ControlObj;

		expect(calls.logs.some((l) => l.startsWith("Implementation phase-01 IN-SCOPE GREEN on attempt 1"))).toBe(true);
		const phaseStatus = (control.phaseStatus as Array<{ id: string; status: string }> | undefined) ?? [];
		expect(phaseStatus.find((p) => p.id === "phase-01")?.status).toBe("green");
		expect((deliverableCheckMock.mock.calls[1]![2] as { skipTests?: boolean }).skipTests).toBe(false);
		expect(calls.impl).toHaveLength(1);
	}, 20_000);
});

// ─── T3.4 — AC-05 log lines (class + next action) ──────────────────────────

describe("T3.4 — AC-05 log lines name the fault class and the next action (SCENARIO-013 · AC-05)", () => {
	it("FIX (RED pre-fix): dirt non-empty + switch unset → `next=<quarantine+re-gate>` (real-git harness)", async () => {
		const { wt: repo } = mkEnvBlockerWorktree();
		repos.push(repo);
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = realGitCtx();
		await (implementationStage as Stage).run(mkRealGitState(repo), ctx);

		expect(calls.logs).toContain("Implementation phase-01 environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<quarantine+re-gate>");
	}, 20_000);

	it("FIX: no-dirt → `next=<judge: fix-environment/escalate>` (plain mock harness)", async () => {
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(wt), ctx);

		expect(calls.logs).toContain("Implementation phase-01 environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<judge: fix-environment/escalate>");
		// The quarantine variant is NEVER emitted when the inventory is empty.
		expect(calls.logs.some((l) => l.includes("next=<quarantine+re-gate>"))).toBe(false);
	}, 20_000);

	it("FIX: still-blocked after the single re-run → the SAME judge-next line (real-git, seed repeats)", async () => {
		const { wt: repo } = mkEnvBlockerWorktree();
		repos.push(repo);
		gateSeq([envBlockerGate()]); // re-run still blocked
		redThenGreen();
		const { ctx, calls } = realGitCtx();
		await (implementationStage as Stage).run(mkRealGitState(repo), ctx);

		// Both literals, in classification order: quarantine+re-gate first (the
		// arm we entered), then the judge-next terminal line (still blocked).
		const quarantineLine = calls.logs.indexOf("Implementation phase-01 environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<quarantine+re-gate>");
		const judgeLine = calls.logs.indexOf("Implementation phase-01 environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<judge: fix-environment/escalate>");
		expect(quarantineLine).toBeGreaterThanOrEqual(0);
		expect(judgeLine).toBeGreaterThan(quarantineLine);
		// Phase 4 (D-5): the terminal stop is terminalStopReason "failed" + a
		// DISTINCT stop log at the boundary — the generic loop-tail line carries NO
		// environmental-blocker suffix anymore (re-pinned from the Phase 3 interim
		// "(environmental blocker)" suffix when Phase 4 landed the judge hand-off).
		expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
		expect(calls.logs).toContain("Implementation phase-01 stopped after 1 attempt(s)");
	}, 20_000);
});

// ─── T3.1 — classification floor insertion + no-respawn guarantee ────────────

describe("T3.1 — classification floor insertion + no-respawn guarantee (SCENARIO-004 · AC-01/AC-02)", () => {
	it("FIX (RED pre-fix): the implementer dispatch count is IDENTICAL before and after blocker handling (adds zero)", async () => {
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(wt), ctx);

		// Attempt 1 dispatched the implementer once; the blocker boundary adds
		// ZERO further spawns (AC-02: spawn count asserted equal across the run).
		expect(calls.impl).toHaveLength(1);
		// The terminal stop names the environmental blocker (judge routing is
		// Phase 4; this phase logs the judge-next line and terminal-breaks).
		expect(calls.logs.some((l) => /environmental-blocker/.test(l))).toBe(true);
	}, 20_000);

	it("FIX (RED pre-fix): no failureReasons-driven retry log for the blocker cause, and the missing-test/challenge edges are unreached", async () => {
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(wt), ctx);

		expect(calls.logs.some((l) => /Implementation phase-01 attempt \d+ FAIL:/.test(l))).toBe(false);
		expect(calls.logs.some((l) => /routing missing-test deliverable/.test(l))).toBe(false);
		expect(calls.logs.some((l) => /implementer challenge/.test(l))).toBe(false);
		expect(calls.logs.some((l) => /judge route=/.test(l))).toBe(false);
	}, 20_000);

	it("CONTROL (green pre-fix AND post-fix): a genuine in-scope failure keeps today's retry semantics (re-spawn)", async () => {
		gateSeq([inScopeFailureGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx({ maxImplAttempts: 3 });
		await (implementationStage as Stage).run(mkState(wt), ctx);

		// The implementer IS re-spawned for the product-defect cause…
		expect(calls.impl.length).toBeGreaterThanOrEqual(2);
		// …and the env-blocker boundary never fires (AC-01 retry semantics).
		expect(calls.logs.some((l) => /environmental-blocker/.test(l))).toBe(false);
	}, 20_000);
});

// ─── T4.1 — judge at first occurrence with both evidence packets + prior-fault line ───

describe("T4.1 — single judge hand-off with both evidence packets + prior-fault line (SCENARIO-010/011 · AC-04)", () => {
	it("FIX (RED pre-fix): no-dirt — ONE judge call at stage9.impl-env-blocker.<phaseId>, allowedRoutes exactly [fix-environment] (escalate-now implied), context carries the gate tail + baseline status/evidence + the (empty) dirt inventory; NO prior-fault line when the ledger is absent", async () => {
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(wt), ctx);

		// FIRST occurrence, single hand-off (SCENARIO-010).
		expect(calls.judge).toHaveLength(1);
		expect(calls.judge[0]!.id).toBe("pipeline.judge.stage9.impl-env-blocker.phase-01");
		const prompt = calls.judge[0]!.prompt;
		expect(prompt).toContain("stage9.impl-env-blocker.phase-01");
		// D-6 (OQ-1): allowedRoutes EXACTLY ["fix-environment"] — escalate-now is
		// auto-unioned by judge.ts (implied), nothing else is offered.
		expect(offeredRoutes(prompt)).toEqual(["fix-environment", "escalate-now"]);
		// BOTH evidence packets (SCENARIO-010's And): the gate failure tail…
		expect(prompt).toContain(`FAIL\t${SNOW_PACKAGE}\t14.439s`);
		expect(prompt).toContain(SNOW_TEST);
		// …plus the baselineCheck status/evidence…
		expect(prompt).toContain("## Baseline verification");
		expect(prompt).toContain("status=regression");
		expect(prompt).toContain(`pnpm run test (whole suite) PASSES at baseline ${BASELINE_SHA}`);
		// …plus the dirt inventory — `(empty)` when none.
		expect(prompt).toContain("## Dirt inventory (foreign uncommitted state, canonical exclusions applied)");
		expect(prompt).toContain("(empty)");
		// OQ-3/D-8: the prior-fault line is present IFF the ledger exists — absent
		// file ⇒ no such line at all.
		expect(prompt).not.toContain("Prior environmental faults");
		// Never a second identical implementer spawn (AC-04's And-clause).
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): pre-seeded ledger (3 lines) ⇒ the one-line prior-fault count in the judge context (OQ-3/D-8)", async () => {
		const specDir = join(wt, "docs", "specifications", "env-blk");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, ".environment-faults.jsonl"), `${JSON.stringify({ kind: "quarantine", paths: [], stashRef: "x", reason: "r" })}\n`.repeat(3));
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState(wt), ctx);

		expect(calls.judge).toHaveLength(1);
		expect(calls.judge[0]!.prompt).toContain("## Prior environmental faults on this track: 3 (from .environment-faults.jsonl)");
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): still-blocked after the single re-run (real-git dirt) — judge fires ONCE at the blocker scope with the post-quarantine ledger count, runBuildGate exactly 2× (budget stays at 1), implementer count unchanged", async () => {
		const { wt: repo } = mkEnvBlockerWorktree();
		repos.push(repo);
		gateSeq([envBlockerGate()]); // blocker → single re-run still blocked
		redThenGreen();
		const { ctx, calls } = realGitCtx();
		await (implementationStage as Stage).run(mkRealGitState(repo), ctx);

		expect(calls.judge).toHaveLength(1);
		expect(calls.judge[0]!.prompt).toContain("stage9.impl-env-blocker.phase-01");
		// The quarantine record landed BEFORE the judge context build (SCENARIO-011:
		// the packets include the post-re-run tail and the quarantine record).
		expect(calls.judge[0]!.prompt).toContain("## Prior environmental faults on this track: 1 (from .environment-faults.jsonl)");
		expect(calls.judge[0]!.prompt).toContain("internal/services/snow/enrichment.go");
		// The one-gate-re-run budget stays at EXACTLY 1 (OQ-1): original + re-run,
		// never more — no second quarantine, no second re-run (SCENARIO-011).
		expect(buildGate).toHaveBeenCalledTimes(2);
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): routed fix-environment (verdict evidence quoting an outputTails fragment so INV-2 passes) → soft HITL with BOTH packets + terminalStopReason failed + distinct stop log; applyRetryDecision NOT called — no rollback, guidance persisted (adv-F3), no re-spawn even on retry-with-guidance (D-5)", async () => {
		const { wt: repo, specDir } = mkEnvBlockerWorktree();
		repos.push(repo);
		const headBefore = git(repo, "rev-parse", "HEAD");
		gateSeq([envBlockerGate()]); // dirt quarantined → re-run still blocked → judge
		redThenGreen();
		const { ctx, calls } = realGitCtx({
			judgeControl: {
				diagnosis: "the snow service dependency is broken in the shared environment",
				route: "fix-environment",
				confidence: 0.9,
				// The quote byte-occurs ONLY in the gate tail outputTails fragment
				// (INV-2's captured-outputs allowance) — not in the cited file.
				evidence: [{ file: "internal/services/snow/enrichment.go", quote: SNOW_TEST }],
			},
			escalate: async () => ({ choice: "retry-with-guidance", guidance: "fix the environment then re-run" }),
		});
		await (implementationStage as Stage).run(mkRealGitState(repo), ctx);

		// The judge routed fix-environment (verified evidence ⇒ routed, not degraded).
		expect(calls.judge).toHaveLength(1);
		expect(calls.logs.some((l) => /judge stage9\.impl-env-blocker\.phase-01: route=fix-environment/.test(l))).toBe(true);
		// Soft HITL surfaced with BOTH evidence packets (findings ≤ 12).
		expect(calls.escalations).toHaveLength(1);
		const esc = calls.escalations[0]!;
		expect(esc.kind).toBe("stagnation");
		expect(esc.severity).toBe("soft");
		expect(esc.stage).toBe("implementation");
		expect((esc.findings ?? []).length).toBeLessThanOrEqual(12);
		const titles = (esc.findings ?? []).map((f) => String(f.title ?? ""));
		expect(titles.some((t) => t.includes("baseline verification: status=regression") && t.includes(`PASSES at baseline ${BASELINE_SHA}`))).toBe(true);
		expect(titles.some((t) => t.includes("internal/services/snow/enrichment.go"))).toBe(true);
		expect(titles.some((t) => t.includes(SNOW_TEST))).toBe(true);
		expect(titles.some((t) => t.startsWith("judge diagnosis:"))).toBe(true);
		// The phase terminates: terminalStopReason "failed" + the DISTINCT stop log.
		expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
		expect(calls.logs).toContain("Implementation phase-01 stopped after 1 attempt(s)");
		// D-5 (adv-F3 remediation): applyRetryDecision is STILL NOT called even
		// though the user chose retry-with-guidance — no rollback (HEAD unchanged,
		// no reflog reset entry, the quarantined stash survives) — but the guidance
		// is now PERSISTED non-destructively to the track user-notes so the next
		// convergence pass consumes it (bounded, injected into later agent prompts).
		expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
		expect(git(repo, "reflog").split("\n").some((l) => /reset:/.test(l))).toBe(false);
		expect(git(repo, "stash", "list").split("\n").filter(Boolean)).toHaveLength(1);
		expect(existsSync(join(specDir, ".user-notes.json"))).toBe(true);
		expect(calls.logs.some((l) => /retry-with-guidance: guidance persisted to track user-notes/.test(l))).toBe(true);
		// …the decision itself is still LOGGED only, and the implementer is never
		// re-spawned — the outer convergence loop owns re-entry.
		expect(calls.logs.some((l) => /escalation decision: retry-with-guidance/.test(l) && /logged only, NOT applied/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(1);
		expect(calls.logs.some((l) => /retrying with user guidance/.test(l))).toBe(false);
		// adv-F2: the terminal stop trips the convergence-level anti-windup so the
		// outer loop cannot re-enter this phase until the global agent budget.
		expect(calls.logs.some((l) => /convergence blocked \(no automatic re-entry\)/.test(l))).toBe(true);
	}, 20_000);
});

// ─── adv-F5 — re-run re-classification (product evidence never hits the environmental judge) ───

describe("adv-F5 — post-quarantine re-run with a FAILING fresh deliverable check routes as product, not environmental (review remediation)", () => {
	it("green re-run + fresh deliverable FAIL → re-classified non-environmental → falls through to failureReasons (implementer retry), environmental judge NEVER called", async () => {
		const { wt: repo } = mkEnvBlockerWorktree();
		repos.push(repo);
		gateSeq([envBlockerGate(), { pass: true, inScopePass: false, ran: ["mock"], errors: [], outOfScopeErrors: [] }]);
		redThenGreen();
		// Deliverable sequencing: 1st check (attempt 1, skipTests:true) passes so the
		// blocker classification sees own-scope green; the FRESH post-quarantine check
		// (skipTests:false) FAILS — product evidence per adv-F5.
		let dn = 0;
		deliverableCheckMock.mockImplementation(() => {
			dn++;
			if (dn >= 2) {
				return { pass: false, missing: ["contains:src/in-scope.ts:missing-after-rerun"], ran: ["mock"] } as never;
			}
			return { pass: true, missing: [], ran: ["mock"] } as never;
		});
		const { ctx, calls } = realGitCtx({});
		await (implementationStage as Stage).run(mkRealGitState(repo), ctx);

		// The environmental judge hand-off NEVER fired (no env-blocker judge call).
		expect(calls.judge.filter((j) => String(j.id).includes("impl-env-blocker"))).toHaveLength(0); // the ENV-BLOCKER judge never fires (the product no-progress judge may)
		// The re-classification log names the product class + retry next-action.
		expect(calls.logs.some((l) => /post-quarantine re-run classified \S+ \(own-scope evidence not green\) — class=product; next=<implementer-retry> — environmental judge skipped/.test(l))).toBe(true);
		// Product semantics: the implementer IS re-spawned (retry), unlike every
		// environmental arm which never spawns.
		expect(calls.impl.length).toBeGreaterThanOrEqual(2);
	}, 20_000);
});

// ─── T4.2 — unoffered/unverified route degrades to escalate; HITL carries both packets ───

describe("T4.2 — outcome ladder: degrades hit the SAME soft HITL surface, every arm stops (SCENARIO-012 · AC-04)", () => {
	it("FIX (RED pre-fix): unoffered route (re-author-tests) → degrades per existing judge behavior (escalate-now) → the SAME soft HITL surface with both packets + terminal stop; implementer count never increases", async () => {
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx({
			judgeControl: {
				diagnosis: "the RED tests are unsatisfiable",
				route: "re-author-tests",
				confidence: 0.9,
				evidence: [{ file: "tests/red.test.ts", quote: "SCENARIO-004 env blocker" }],
			},
		});
		await (implementationStage as Stage).run(mkState(wt), ctx);

		expect(calls.judge).toHaveLength(1);
		// Existing judge degrade: the unoffered route escalates instead.
		expect(calls.logs.some((l) => l.includes('route "re-author-tests" not offered'))).toBe(true);
		// The SAME HITL surface carries BOTH evidence packets.
		expect(calls.escalations).toHaveLength(1);
		const esc = calls.escalations[0]!;
		expect(esc.kind).toBe("stagnation");
		expect(esc.severity).toBe("soft");
		expect(esc.stage).toBe("implementation");
		expect((esc.findings ?? []).length).toBeLessThanOrEqual(12);
		const titles = (esc.findings ?? []).map((f) => String(f.title ?? ""));
		expect(titles.some((t) => t.includes("baseline verification: status=regression"))).toBe(true);
		expect(titles.some((t) => t.includes("(empty)"))).toBe(true);
		expect(titles.some((t) => t.includes(SNOW_TEST))).toBe(true);
		// Terminal stop; NO implementer re-spawn on any arm (AC-04).
		expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): fabricated evidence (quote fails INV-2 verification) → discarded → the SAME soft HITL surface + terminal stop", async () => {
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx({
			judgeControl: {
				diagnosis: "fabricated diagnosis",
				route: "fix-environment",
				confidence: 0.9,
				evidence: [{ file: "tests/red.test.ts", quote: "THIS QUOTE EXISTS NOWHERE 000000" }],
			},
		});
		await (implementationStage as Stage).run(mkState(wt), ctx);

		expect(calls.logs.some((l) => /verdict DISCARDED — evidence verification failed/.test(l))).toBe(true);
		expect(calls.escalations).toHaveLength(1);
		const esc = calls.escalations[0]!;
		expect(esc.kind).toBe("stagnation");
		expect(esc.severity).toBe("soft");
		const titles = (esc.findings ?? []).map((f) => String(f.title ?? ""));
		expect(titles.some((t) => t.includes("baseline verification: status=regression"))).toBe(true);
		expect(titles.some((t) => t.includes("(empty)"))).toBe(true);
		expect(titles.some((t) => t.includes(SNOW_TEST))).toBe(true);
		expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): SUPER_DEV_DISABLE_JUDGE=1 → degraded (no judge agent call) → the SAME soft HITL surface with both packets + terminal stop", async () => {
		process.env.SUPER_DEV_DISABLE_JUDGE = "1";
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx();
		try {
			await (implementationStage as Stage).run(mkState(wt), ctx);
		} finally {
			delete process.env.SUPER_DEV_DISABLE_JUDGE;
		}

		// Degraded BEFORE any agent dispatch (INV-6).
		expect(calls.judge).toHaveLength(0);
		// …but the SAME HITL surface still fires with both packets.
		expect(calls.escalations).toHaveLength(1);
		const esc = calls.escalations[0]!;
		expect(esc.kind).toBe("stagnation");
		expect(esc.severity).toBe("soft");
		const titles = (esc.findings ?? []).map((f) => String(f.title ?? ""));
		expect(titles.some((t) => t.includes("baseline verification: status=regression"))).toBe(true);
		expect(titles.some((t) => t.includes("(empty)"))).toBe(true);
		expect(titles.some((t) => t.includes(SNOW_TEST))).toBe(true);
		expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): headless (no escalate callback) → BOTH packets LOGGED + terminal stop; no escalation object, no spawn", async () => {
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx({ escalate: false });
		await (implementationStage as Stage).run(mkState(wt), ctx);

		expect(calls.escalations).toHaveLength(0);
		const headless = calls.logs.find((l) => l.includes("headless"));
		expect(headless).toBeDefined();
		expect(headless).toContain(SNOW_TEST);
		expect(headless).toContain("status=regression");
		expect(headless).toContain(`PASSES at baseline ${BASELINE_SHA}`);
		expect(headless).toContain("(empty)");
		expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(1);
	}, 20_000);
});

// ─── T4.3 — kill-switch disables the in-loop quarantine: detection warning + judge ───

describe("T4.3 — kill-switch: detection warning then judge, structurally no stash (SCENARIO-024 · AC-11/AC-04)", () => {
	it("FIX (RED pre-fix): SUPER_DEV_NO_DIRTY_QUARANTINE=1 + real-git dirt — `git stash list` EMPTY, foreign mod still present, the exact detection-warning literal BEFORE the judge call, judge at the blocker scope with the (observed) inventory, implementer count unchanged", async () => {
		const { wt: repo } = mkEnvBlockerWorktree();
		repos.push(repo);
		process.env.SUPER_DEV_NO_DIRTY_QUARANTINE = "1";
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = realGitCtx();
		try {
			await (implementationStage as Stage).run(mkRealGitState(repo), ctx);
		} finally {
			delete process.env.SUPER_DEV_NO_DIRTY_QUARANTINE;
		}

		// Structurally no stash (the branch never calls quarantineDirt and the
		// primitive short-circuits): `git stash list` is EMPTY.
		expect(git(repo, "stash", "list").trim()).toBe("");
		// Worktree untouched: the foreign tracked modification is still there.
		expect(git(repo, "status", "--porcelain")).toContain("internal/services/snow/enrichment.go");
		// The EXACT detection-warning literal (AC-05 class + next pattern).
		const warnIdx = calls.logs.indexOf("Implementation phase-01 dirty-quarantine kill-switch SUPER_DEV_NO_DIRTY_QUARANTINE=1 set — detection only, worktree untouched — class=environment; next=<judge: fix-environment/escalate>");
		expect(warnIdx).toBeGreaterThanOrEqual(0);
		// Ordering: the warning precedes the judge hand-off (runJudgeInner logs its
		// call line before dispatching the agent).
		const judgeCallIdx = calls.logs.findIndex((l) => l.startsWith("judge stage9.impl-env-blocker.phase-01: call"));
		expect(judgeCallIdx).toBeGreaterThan(warnIdx);
		// The branch routes to the T4.1 judge hand-off with BOTH packets —
		// detection observes, so the judge sees the (non-empty) inventory.
		expect(calls.judge).toHaveLength(1);
		expect(calls.judge[0]!.prompt).toContain("stage9.impl-env-blocker.phase-01");
		expect(calls.judge[0]!.prompt).toContain("internal/services/snow/enrichment.go");
		expect(offeredRoutes(calls.judge[0]!.prompt)).toEqual(["fix-environment", "escalate-now"]);
		// The quarantine arm is structurally unreachable: no re-gate line, no re-run.
		expect(calls.logs.some((l) => l.includes("next=<quarantine+re-gate>"))).toBe(false);
		expect(buildGate).toHaveBeenCalledTimes(1);
		// Implementer count unchanged (AC-02 holds through the kill-switch arm).
		expect(calls.impl).toHaveLength(1);
	}, 20_000);
});

// ─── T4.4 — quarantine mechanism failure degrades to warning + judge, never fatal ───

describe("T4.4 — quarantine git failure: warning + judge, never fatal (SCENARIO-029 · AC-13)", () => {
	// Read-only `.git` (skipped as root — root ignores file modes) is a REAL git
	// failure mode: porcelain reads still succeed (the inventory is computed)
	// while `git stash push` cannot write the index and exits non-zero.
	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"FIX (RED pre-fix): forced git failure (read-only .git) → the quarantine-FAILED warning literal + judge at the blocker scope, no throw, no stash entry, implementer count unchanged, no gate re-run (the budget was NOT consumed by the failed attempt)",
		async () => {
			const { wt: repo } = mkEnvBlockerWorktree();
			repos.push(repo);
			chmodSync(join(repo, ".git"), 0o555);
			gateSeq([envBlockerGate()]);
			redThenGreen();
			const { ctx, calls } = realGitCtx();
			let threw = false;
			try {
				await (implementationStage as Stage).run(mkRealGitState(repo), ctx);
			} catch {
				threw = true;
			} finally {
				chmodSync(join(repo, ".git"), 0o755); // restore for the git asserts + cleanup
			}

			// Never fatal: the stage completed without throwing (AC-13).
			expect(threw).toBe(false);
			// The exact warning literal (T4.4), carrying the git error tail.
			expect(calls.logs.some((l) => l.startsWith("Implementation phase-01 quarantine FAILED (nothing stashed — degrading to judge route) — class=environment; next=<judge: fix-environment/escalate>:"))).toBe(true);
			// …then the T4.1 judge hand-off at the blocker scope with both packets.
			expect(calls.judge).toHaveLength(1);
			expect(calls.judge[0]!.prompt).toContain("stage9.impl-env-blocker.phase-01");
			expect(calls.judge[0]!.prompt).toContain("internal/services/snow/enrichment.go");
			// Nothing was stashed — no recovery owed (SCENARIO-029's And-clause).
			expect(git(repo, "stash", "list").trim()).toBe("");
			// envBlockerRegateUsed is NOT consumed on failure (the budget counts a
			// COMPLETED state change): no gate re-run happened at all.
			expect(buildGate).toHaveBeenCalledTimes(1);
			// The attempt loop never re-spawned the implementer.
			expect(calls.impl).toHaveLength(1);
			// The phase still terminal-stops through the ladder.
			expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
		}, 20_000);
});

// ─── T6.2 — judge-environmental verdict records ─────────────────────────────

describe("T6.2 — judge-environmental verdict records (SCENARIO-026 · AC-12)", () => {
	it("FIX (RED pre-fix): routed fix-environment (verified evidence) — the verdict record coexists with the T3.2 quarantine record as exactly two lines, exact key set, null paths/stashRef, non-empty reason", async () => {
		const { wt: repo, specDir } = mkEnvBlockerWorktree();
		repos.push(repo);
		gateSeq([envBlockerGate()]); // dirt quarantined → re-run still blocked → judge
		redThenGreen();
		const { ctx, calls } = realGitCtx({
			judgeControl: {
				diagnosis: "the snow service dependency is broken in the shared environment",
				route: "fix-environment",
				confidence: 0.9,
				// The quote byte-occurs in the gate-tail outputTails fragment (INV-2)
				// so the verdict ROUTES instead of degrading.
				evidence: [{ file: "internal/services/snow/enrichment.go", quote: SNOW_TEST }],
			},
		});
		await (implementationStage as Stage).run(mkRealGitState(repo), ctx);

		// The quarantine event line (SCENARIO-025, T3.2) and the verdict line
		// (SCENARIO-026, T6.2) COEXIST as exactly two records.
		const ledger = readLedger(specDir);
		expect(ledger).toHaveLength(2);
		expect(ledger[0]!["kind"]).toBe("quarantine");
		expect(ledger[0]!["paths"]).toEqual(["internal/services/snow/enrichment.go"]);
		expect(ledger[1]!["kind"]).toBe("judge-environmental");
		// Verdict-record shape: null paths/stashRef, reason = "<route>: <diagnosis
		// tail>" (≤200 chars) — SCENARIO-026's And-clauses.
		expect(Object.keys(ledger[1]!)).toEqual(["kind", "paths", "stashRef", "reason"]);
		expect(ledger[1]!["paths"]).toBeNull();
		expect(ledger[1]!["stashRef"]).toBeNull();
		expect(String(ledger[1]!["reason"])).toBe("fix-environment: the snow service dependency is broken in the shared environment");
		// BOTH records share the EXACT key set (AC-12's pin, one shape for both kinds).
		expect(Object.keys(ledger[0]!)).toEqual(["kind", "paths", "stashRef", "reason"]);
		// The boundary still terminal-stops with zero further spawns.
		expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("FIX (RED pre-fix): an ESCALATED verdict (unoffered route → escalate-now, verified evidence) also records — reason carries the escalate-now route + diagnosis; no dirt ⇒ it is the ONLY record", async () => {
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx({
			judgeControl: {
				diagnosis: "the RED tests are unsatisfiable",
				route: "re-author-tests", // unoffered at this wiring point ⇒ escalate
				confidence: 0.9,
				evidence: [{ file: "tests/red.test.ts", quote: "SCENARIO-004 env blocker" }],
			},
		});
		await (implementationStage as Stage).run(mkState(wt), ctx);

		const ledgerPath = join(wt, "docs", "specifications", "env-blk", ".environment-faults.jsonl");
		const lines = readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim() !== "");
		expect(lines).toHaveLength(1); // no dirt ⇒ no quarantine record; one verdict record
		const record = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(record["kind"]).toBe("judge-environmental");
		expect(Object.keys(record)).toEqual(["kind", "paths", "stashRef", "reason"]);
		expect(record["paths"]).toBeNull();
		expect(record["stashRef"]).toBeNull();
		expect(String(record["reason"])).toBe("escalate-now: the RED tests are unsatisfiable");
		expect(calls.impl).toHaveLength(1);
	}, 20_000);

	it("GUARD (verdict-records-only pin): a DEGRADED outcome (SUPER_DEV_DISABLE_JUDGE=1 — no verdict exists) appends NO judge-environmental record", async () => {
		process.env.SUPER_DEV_DISABLE_JUDGE = "1";
		gateSeq([envBlockerGate()]);
		redThenGreen();
		const { ctx, calls } = mkCtx();
		try {
			await (implementationStage as Stage).run(mkState(wt), ctx);
		} finally {
			delete process.env.SUPER_DEV_DISABLE_JUDGE;
		}

		expect(calls.judge).toHaveLength(0);
		// No quarantine happened (no dirt) and no verdict exists ⇒ no ledger at all.
		expect(existsSync(join(wt, "docs", "specifications", "env-blk", ".environment-faults.jsonl"))).toBe(false);
	}, 20_000);
});

// ─── T6.3 — unwritable ledger in-loop: the branch proceeds through the judge route ───

describe("T6.3 — unwritable ledger in-loop: the branch still completes through the judge route, never fatal (SCENARIO-030 · AC-13/AC-12)", () => {
	// Unlike the setup e2e (whose specDir hosts the fail-closed AC-30 run lock),
	// the in-loop specDir has no lock — the literal spec mechanism (chmod 0o555
	// the ledger's directory, skipped as root) works directly here.
	it("PIN: env-blocker harness with an unwritable specDir (chmod 0o555, skipped as root) ⇒ the quarantine still runs, the ledger appends degrade to warnings, the judge route completes, no throw, implementer count unchanged", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores 0o555
		const { wt: repo, specDir } = mkEnvBlockerWorktree();
		repos.push(repo);
		chmodSync(specDir, 0o555);
		gateSeq([envBlockerGate()]); // dirt present: quarantine → re-run still blocked → judge
		redThenGreen();
		const { ctx, calls } = realGitCtx();
		let threw = false;
		try {
			await (implementationStage as Stage).run(mkRealGitState(repo), ctx);
		} catch {
			threw = true;
		} finally {
			chmodSync(specDir, 0o755); // restore for the asserts + cleanup
		}

		// Never fatal: the stage completed without throwing (AC-13).
		expect(threw).toBe(false);
		// The branch still completed THROUGH the judge route (the T4.1 hand-off).
		expect(calls.judge).toHaveLength(1);
		expect(calls.judge[0]!.prompt).toContain("stage9.impl-env-blocker.phase-01");
		// The quarantine itself succeeded — the ledger failure never blocks the
		// state change (the stash exists)…
		expect(git(repo, "stash", "list").split("\n").filter(Boolean)).toHaveLength(1);
		// …but no record could be written: the append degraded, never threw.
		expect(existsSync(join(specDir, ".environment-faults.jsonl"))).toBe(false);
		// The degrade warning through the log sink (the primitive's exact literal).
		expect(calls.logs.filter((l) => /ledger append failed/.test(l)).length).toBeGreaterThanOrEqual(1);
		expect(calls.logs.some((l) => l.startsWith("environment-fault ledger append failed (continuing; never fatal):"))).toBe(true);
		// Implementer count unchanged (AC-02 holds through the degrade).
		expect(calls.impl).toHaveLength(1);
		// The terminal stop still fired — never fatal, never a loop continue.
		expect(calls.logs.some((l) => /environmental-blocker terminal stop after judge hand-off/.test(l))).toBe(true);
	}, 20_000);
});
