/**
 * The inherited-red tier ladder — contract test for the v0.4.37 extraction
 * (increment 9 of the stage.ts split).
 *
 * The FIFTH control-flow conversion and the one with the most exits: one
 * `continue` (Tier-0 retry), two `break`s (flake-green, handoff-routed) and
 * TWO `throw new FatalAbort`s (Tier-3 second occurrence, handoff-unavailable).
 * The breaks became outcome variants; the throws STAY throws inside the module
 * and must propagate out unchanged.
 *
 * The v0.4.33 cross-iteration discipline (pinned): every outcome carries
 * attemptErrorsAppend (uniformly applied by the caller BEFORE interpretation);
 * ONLY flake-green replaces attemptErrors; in-place mutations (phaseStatus
 * upsert, lastFailures splice, flake-grant flag) happen inside the module on
 * the caller's objects, exactly where the inline code mutated them.
 *
 * Fixtures mirror tests/inherited-red.test.ts (mkGate / OWN_SCOPE_GREEN /
 * CENSUS_BLOCK / SYNTHETIC); the Tier-0 revert tests use real git repos; the
 * flake-green test exploits runBuildGate's greenfield semantics (no build
 * config → ran=[] → pass) on a bare temp repo.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { accessSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { adjudicateInheritedRedLadder } from "../src/stages/implementation/inherited-red-ladder.ts";
import { appendInheritedRedEvent, normalizeRepoPath } from "../src/stages/inherited-red.ts";
import { FatalAbort } from "../src/nodes.ts";
import { BASELINE_VERIFY_ERROR_PREFIX } from "../src/build-runner/gates/index.ts";
import type { BuildGateResult } from "../src/build-runner.ts";
import type { PipelineState, StageContext } from "../src/types.ts";
import { implementationSources } from "./helpers/implementation-source.ts";
import { maxPhaseAttempts } from "../src/stages/implementation/phase-reentry.ts";

// ─── fixtures (the inherited-red.test.ts pattern) ────────────────────────────

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

function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src/prod.ts"), "export const A = 1;\n");
	writeFileSync(join(repo, "src/leak.ts"), "export const BASE = 1;\n"); // tracked: Tier-0 revertable
	git("add", "-A");
	git("commit", "-qm", "seed");
	return repo;
}

function ctxOf(out: { logs: string[] }): StageContext {
	return {
		task: "t", options: {}, state: {} as PipelineState,
		budget: { count: 0, check: () => true, spent: () => true },
		log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
	} as unknown as StageContext;
}

const baseInput = (over: Partial<Parameters<typeof adjudicateInheritedRedLadder>[0]> = {}) => ({
	ctx: ctxOf({ logs: [] }),
	state: {} as PipelineState,
	worktreePath: "",
	specDirectory: "",
	specIdentifier: "001",
	defaultBranch: undefined as string | undefined,
	phaseId: "phase-02",
	idx: 1,
	phases: [] as Array<Record<string, unknown>>,
	gate: mkGate(),
	ownScope: { ...OWN_SCOPE_GREEN },
	coverageBlocked: false,
	declaredScope: scope(["src/prod.ts"]),
	dirtPaths: [] as string[],
	phaseStartSet: new Set<string>(),
	attempt: 1,
	lastFailures: [] as Array<{ phaseId: string; reasons: string[] }>,
	phaseStatus: [] as Array<{ id: string; status: string }>,
	flakeGrant: { used: false },
	announceActivity: () => {},
	emitPhaseStatus: () => {},
	attemptDetail: (n: number) => `attempt ${n}`,
	...over,
});

describe("inherited-red ladder (v0.4.37 increment-9 extraction)", () => {
	it("NOT the boundary shape (in-scope failure) → pass with NOTHING appended", async () => {
		const out = await adjudicateInheritedRedLadder(baseInput({
			declaredScope: scope(["tests/census-mirror.test.ts"]), // the failing subject IS declared
		}));
		expect(out).toEqual({ kind: "pass", attemptErrorsAppend: [] });
	});

	it("not-evaluable (absent baseline) → pass, metrics-only, today's retry semantics stand", async () => {
		const gate = mkGate({ baselineCheck: { status: "unknown", evidence: "baseline verify did not complete" } });
		const logs: string[] = [];
		const out = await adjudicateInheritedRedLadder(baseInput({ gate, ctx: ctxOf({ logs }) }));
		expect(out.kind).toBe("pass");
		expect(logs.some((l) => l.includes("NOT EVALUABLE"))).toBe(true);
	});

	it("TIER 0 own-leak: tracked out-of-scope dirt is REVERTED on disk and the retry carries the revert errors", async () => {
		const repo = makeRepo("sd-irl-t0-");
		try {
			writeFileSync(join(repo, "src/leak.ts"), "undeclared edit\n"); // a TRACKED file modified — revertable (untracked new files are live work, never destroyed)
			const out = await adjudicateInheritedRedLadder(baseInput({
				worktreePath: repo,
				dirtPaths: ["src/leak.ts"],
				phaseStartSet: new Set<string>(), // clean at phase start → own-leak
				attempt: maxPhaseAttempts() - 1, // env-proof: the retry predicate attempt < max holds in ANY env
			}));
			expect(out.kind).toBe("tier0-retry");
			if (out.kind !== "tier0-retry") return;
			expect(out.attemptErrorsAppend).toEqual(["inherited-red-own-leak-reverted: src/leak.ts"]);
			// the leak was mechanically reverted to HEAD
			const porcelain = String(spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).stdout ?? "");
			expect(porcelain.trim()).toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("TIER 0 at an EXHAUSTED attempt budget → pass (boundary logic proceeds) but the revert errors STILL land", async () => {
		const repo = makeRepo("sd-irl-t0x-");
		try {
			writeFileSync(join(repo, "src/leak.ts"), "undeclared edit\n");
			const logs: string[] = [];
			const out = await adjudicateInheritedRedLadder(baseInput({
				ctx: ctxOf({ logs }),
				worktreePath: repo,
				dirtPaths: ["src/leak.ts"],
				phaseStartSet: new Set<string>(),
				attempt: maxPhaseAttempts(), // exhausted in ANY env
			}));
			expect(out.kind).toBe("pass");
			expect(out.attemptErrorsAppend).toEqual(["inherited-red-own-leak-reverted: src/leak.ts"]); // the uniform-append contract
			expect(logs.some((l) => l.includes("attempt budget exhausted"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("TIER 0 non-destructive (code-gate F1): an UNTRACKED out-of-scope file is LIVE WORK — kept on disk, named in the log, NEVER reverted", async () => {
		const repo = makeRepo("sd-irl-t0live-");
		try {
			writeFileSync(join(repo, "src/live-work.ts"), "implementer's live fix\n"); // UNTRACKED — never git-added
			const logs: string[] = [];
			const out = await adjudicateInheritedRedLadder(baseInput({
				ctx: ctxOf({ logs }),
				worktreePath: repo,
				dirtPaths: ["src/live-work.ts"],
				phaseStartSet: new Set<string>(),
				attempt: maxPhaseAttempts(), // exhausted → pass (no retry noise)
			}));
			expect(out.kind).toBe("pass");
			// LIVE WORK SURVIVES: still on disk, still porcelain-dirty
			expect(() => accessSync(join(repo, "src/live-work.ts"))).not.toThrow();
			const porcelain = String(spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).stdout ?? "");
			expect(porcelain).toContain("src/live-work.ts");
			// nothing was revertable → no revert errors, and the log NAMES the live work
			expect(out.attemptErrorsAppend).toEqual([]);
			expect(logs.some((l) => l.includes("live-work path(s) in place, never destroyed"))).toBe(true);
			expect(logs.some((l) => l.includes("src/live-work.ts"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("TIER 0 porcelain FAIL-SAFE (code-gate F1): a non-git worktreePath yields [] entries — NOTHING is reverted, no crash", async () => {
		const notARepo = mkdtempSync(join(tmpdir(), "sd-irl-t0fail-"));
		const logs: string[] = [];
		try {
			const out = await adjudicateInheritedRedLadder(baseInput({
				ctx: ctxOf({ logs }),
				worktreePath: notARepo, // porcelainEntries degrades to [] on git failure
				dirtPaths: ["src/leak.ts"],
				phaseStartSet: new Set<string>(),
				attempt: maxPhaseAttempts(),
			}));
			// fail-safe: no destructive op on unknown state — pass, no appends
			expect(out).toEqual({ kind: "pass", attemptErrorsAppend: [] });
			expect(logs.some((l) => l.includes("attempt budget exhausted"))).toBe(true);
		} finally {
			rmSync(notARepo, { recursive: true, force: true });
		}
	});

	it("TIER 1 flake filter: a bare repo re-run is greenfield-PASS → flake-green replaces attemptErrors with the re-run verdict", async () => {
		const repo = mkdtempSync(join(tmpdir(), "sd-irl-t1-")); // NO git, NO build config → ran=[] → pass
		const logs: string[] = [];
		const lastFailures = [{ phaseId: "phase-02", reasons: ["old"] }];
		const phaseStatus: Array<{ id: string; status: string }> = [];
		const announced: string[] = [];
		const emitted: string[] = [];
		try {
			const out = await adjudicateInheritedRedLadder(baseInput({
				ctx: ctxOf({ logs }),
				worktreePath: repo,
				specDirectory: repo,
				// attribution inherited: baseline regression + pre-phase dirt
				dirtPaths: ["tests/census-mirror.test.ts"],
				phaseStartSet: new Set(["tests/census-mirror.test.ts"]),
				lastFailures: lastFailures as never,
				phaseStatus: phaseStatus as never,
				flakeGrant: { used: false },
				announceActivity: (a?: string) => { if (a) announced.push(a); },
				emitPhaseStatus: (s) => { emitted.push(s); },
			}));
			expect(out.kind).toBe("flake-green");
			if (out.kind !== "flake-green") return;
			expect(out.gateErrors).toEqual([]); // the greenfield re-run has no errors
			// the in-place mutations happened INSIDE the module, as inline
			expect(phaseStatus[0]).toMatchObject({ id: "phase-02", status: "green" });
			expect(lastFailures).toEqual([]); // the phase's row was spliced out
			expect(emitted).toContain("ok");
			expect(announced.join()).toContain("flake filter");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("TIER 2 occurrence #1: grant pre-spent, replan routes (real spec dir) → handoff-routed with the terminal error", async () => {
		const repo = mkdtempSync(join(tmpdir(), "sd-irl-t2-"));
		const specDir = mkdtempSync(join(tmpdir(), "sd-irl-t2-spec-"));
		const logs: string[] = [];
		try {
			const out = await adjudicateInheritedRedLadder(baseInput({
				ctx: ctxOf({ logs }),
				state: { setup: { worktreePath: repo, specDirectory: specDir } } as unknown as PipelineState,
				worktreePath: repo,
				specDirectory: specDir,
				dirtPaths: ["tests/census-mirror.test.ts"],
				phaseStartSet: new Set(["tests/census-mirror.test.ts"]),
				flakeGrant: { used: true }, // skip the re-run — the classification stands
			}));
			expect(out.kind).toBe("handoff-routed");
			if (out.kind !== "handoff-routed") return;
			expect(out.attemptErrorsAppend[0]).toContain("inherited-red:");
			expect(out.attemptErrorsAppend[0]).toContain("declared handoff routed");
			expect(logs.some((l) => l.includes("Tier 2 (declared handoff): occurrence 1"))).toBe(true);
			expect(logs.some((l) => l.includes("per-run grant already spent"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("TIER 3 second occurrence (a prior occurrence row exists) → FatalAbort propagates, naming the subjects", async () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-irl-t3-spec-"));
		const logs: string[] = [];
		try {
			appendInheritedRedEvent(specDir, { event: "occurrence", phaseId: "phase-01", outcome: "tier2-handoff-routed", subjects: ["tests/old.test.ts"], attribution: "inherited", baseline: "regression" }, () => {});
			await expect(adjudicateInheritedRedLadder(baseInput({
				ctx: ctxOf({ logs }),
				specDirectory: specDir,
				dirtPaths: ["tests/census-mirror.test.ts"],
				phaseStartSet: new Set(["tests/census-mirror.test.ts"]),
				flakeGrant: { used: true },
			}))).rejects.toThrow(FatalAbort);
			expect(logs.some((l) => l.includes("SECOND OCCURRENCE"))).toBe(true);
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("TIER 2 handoff UNAVAILABLE (replan marker set) → FatalAbort — the tally consumed, stop-the-line", async () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-irl-t2u-spec-"));
		const logs: string[] = [];
		try {
			await expect(adjudicateInheritedRedLadder(baseInput({
				ctx: ctxOf({ logs }),
				state: { setup: { specDirectory: specDir }, __replan: { at: "now" } } as unknown as PipelineState,
				specDirectory: specDir,
				dirtPaths: ["tests/census-mirror.test.ts"],
				phaseStartSet: new Set(["tests/census-mirror.test.ts"]),
				flakeGrant: { used: true },
			}))).rejects.toThrow(/declared handoff unavailable/);
			expect(logs.some((l) => l.includes("declared handoff UNAVAILABLE"))).toBe(true);
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});
	describe("adversarial F2 — the caller interpretation seam (source pins; the 14 mechanical lines that map outcomes to loop control)", () => {
		it("the append lands BEFORE kind interpretation, and ONLY flake-green replaces attemptErrors", () => {
			const impl = implementationSources();
			// the uniform append (length-guarded) precedes every kind arm
			const appendIdx = impl.indexOf("if (irOutcome.attemptErrorsAppend.length > 0) attemptErrors = [...attemptErrors, ...irOutcome.attemptErrorsAppend];");
			const retryIdx = impl.indexOf('if (irOutcome.kind === "tier0-retry")');
			const greenIdx = impl.indexOf('if (irOutcome.kind === "flake-green")');
			const routedIdx = impl.indexOf('if (irOutcome.kind === "handoff-routed")');
			for (const [name, idx] of [["tier0-retry", retryIdx], ["flake-green", greenIdx], ["handoff-routed", routedIdx]] as const) {
				expect(idx, `${name} arm present`).toBeGreaterThan(-1);
				expect(idx, `${name} arm AFTER the uniform append`).toBeGreaterThan(appendIdx);
			}
			// ONLY flake-green replaces (the re-run verdict IS the attempt's verdict)
			expect(impl).toContain("green = true;");
			expect(impl).toContain("attemptErrors = irOutcome.gateErrors;");
			expect(impl).toContain('terminalStopReason = "inherited-red";');
			// the arms keep their loop semantics
			expect(impl).toMatch(/if \(irOutcome\.kind === "tier0-retry"\) \{\s*continue;/);
			expect(impl).toMatch(/if \(irOutcome\.kind === "handoff-routed"\) \{\s*terminalStopReason = "inherited-red";\s*break;/);
		});
	});
});
