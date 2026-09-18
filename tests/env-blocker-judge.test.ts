/**
 * The environmental-blocker judge hand-off — contract test for the v0.4.39
 * extraction (increment 11 of the stage.ts split, the final env-blocker
 * sub-block).
 *
 * The SEVENTH control-flow conversion: ONE `break` (the D-5 terminal stop)
 * and ONE fall-through (the G3 audited product override). The break became
 * `terminal-stop` (carrying the null-or-value blockReason — null exactly when
 * the retry-with-guidance re-entry was granted); the fall-through became
 * `override-retry` (fault class + judge feedback + null-or-value post-regate
 * errors).
 *
 * The judge is driven through a fake ctx agent lane (the protection-strikes
 * pattern — no module mocking); the escalation surface rides ctx.options.
 * envBlockedPhases (Set) and phaseGuidanceReentryUsed (Record) are in/out and
 * asserted by identity of mutation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { handOffEnvBlockerJudge } from "../src/stages/implementation/env-blocker-judge.ts";
import { resetJudgeBudgets } from "../src/stages/judge.ts";
import type { BuildGateResult } from "../src/build-runner.ts";
import type { AgentCall, AgentResult, PipelineState, StageContext } from "../src/types.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const GATE = (over: Partial<BuildGateResult> = {}): BuildGateResult => ({
	pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false,
	ran: ["mock"], errors: ["FAIL tests/census.test.ts > lockstep"], outOfScopeErrors: ["FAIL tests/census.test.ts > lockstep"],
	baselineCheck: { status: "regression", evidence: "suite passes at baseline abc" },
	...over,
});

const judgeCtx = (verdict: Record<string, unknown> | null, out: { logs: string[]; calls: AgentCall[]; escalate?: unknown; error?: string }): StageContext => ({
	task: "t", options: { escalate: out.escalate }, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
	async agent(call: AgentCall): Promise<AgentResult> {
		out.calls.push(call);
		// F3: mark the dispatch IN the log stream so ordering tests can prove a
		// log precedes/follows the judge call itself (not just other logs)
		out.logs.push(`[agent-dispatch] ${call.id}`);
		return out.error !== undefined ? { text: "", control: null, error: out.error } : { text: "", control: verdict as Record<string, unknown> };
	},
} as unknown as StageContext);

/** A real worktree carrying the cited evidence file — INV-2 verification reads
 *  the file (or falls back to the outputTails); the file makes the route stick. */
function makeWorktree(): string {
	const wt = mkdtempSync(join(tmpdir(), "sd-envj-wt-"));
	worktrees.push(wt);
	mkdirSync(join(wt, "tests"), { recursive: true });
	writeFileSync(join(wt, "tests/census.test.ts"), "// census lockstep mirror\n");
	writeFileSync(join(wt, "tests/fresh.test.ts"), "// new failure mirror\n");
	return wt;
}

const baseInput = (over: Partial<Parameters<typeof handOffEnvBlockerJudge>[0]> = {}) => ({
	worktreePath: makeWorktree(),
	ctx: judgeCtx(null, { logs: [], calls: [] }),
	state: {} as PipelineState,
	specDirectory: "",
	phaseId: "phase-02",
	phaseName: "wire-screen",
	gate: GATE(),
	gate2: null as BuildGateResult | null,
	dirtPaths: ["src/foreign.ts"],
	phaseGuidanceReentryUsed: {} as Record<string, true>,
	envBlockedPhases: new Set<string>(),
	...over,
});

const worktrees: string[] = [];
beforeEach(() => { vi.clearAllMocks(); resetJudgeBudgets(); });
afterEach(() => { for (const wt of worktrees.splice(0)) rmSync(wt, { recursive: true, force: true }); });

describe("env-blocker judge hand-off (v0.4.39 increment-11 extraction)", () => {
	it("routed fix-environment → terminal-stop with the anti-windup block reason; the phase joins envBlockedPhases", async () => {
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		const envBlockedPhases = new Set<string>();
		const out = await handOffEnvBlockerJudge(baseInput({
			ctx: judgeCtx({ diagnosis: "the sandbox lacks network egress", route: "fix-environment", confidence: 0.9, evidence: [{ file: "tests/census.test.ts", quote: "lockstep" }] }, { logs, calls }),
			specDirectory: mkdtempSync(join(tmpdir(), "sd-envj-")),
			envBlockedPhases,
		}));
		expect(out.kind).toBe("terminal-stop");
		if (out.kind !== "terminal-stop") return;
		expect(out.stopReason).toBe("failed");
		expect(out.blockReason).toContain("environmental-blocker:");
		expect(out.blockReason).toContain("judge route=fix-environment awaiting environment fix");
		// the judge dispatch itself (the T4.1 single hand-off)
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]!.id).toContain("stage9.impl-env-blocker.phase-02");
		// in/out: the phase is excluded from stage-close re-verification
		expect(envBlockedPhases.has("phase-02")).toBe(true);
		expect(logs.some((l) => l.includes("route=fix-environment"))).toBe(true);
	});

	it("routed implementer-retry (G3) → override-retry: product-defect class, diagnosis feedback, the re-run's errors when present", async () => {
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		const gate2 = GATE({ errors: ["FAIL tests/fresh.test.ts > new failure"], outOfScopeErrors: ["FAIL tests/fresh.test.ts > new failure"] });
		const envBlockedPhases = new Set<string>();
		const out = await handOffEnvBlockerJudge(baseInput({
			ctx: judgeCtx({ diagnosis: "NOT environmental — cross-phase sequencing conflict the implementer must absorb", route: "implementer-retry", confidence: 0.85, evidence: [{ file: "tests/fresh.test.ts", quote: "new failure" }] }, { logs, calls }),
			specDirectory: mkdtempSync(join(tmpdir(), "sd-envj-")),
			gate2,
			envBlockedPhases,
		}));
		expect(out.kind).toBe("override-retry");
		if (out.kind !== "override-retry") return;
		expect(out.faultClass).toBe("product-defect");
		expect(out.judgeOverrideFeedback[0]).toContain("judge override");
		expect(out.judgeOverrideFeedback[0]).toContain("cross-phase sequencing conflict");
		expect(out.postRegateErrors).toEqual(gate2.errors); // the re-run's errors are the truth
		// the override arm neither terminal-stops nor blocks convergence
		expect(envBlockedPhases.has("phase-02")).toBe(false);
		expect(logs.some((l) => l.includes("OVERRIDDEN by judge diagnosis"))).toBe(true);
	});

	it("override-retry with NO re-run → postRegateErrors null (the existing carrier is kept)", async () => {
		const out = await handOffEnvBlockerJudge(baseInput({
			ctx: judgeCtx({ diagnosis: "product defect", route: "implementer-retry", confidence: 0.9, evidence: [{ file: "tests/census.test.ts", quote: "lockstep" }] }, { logs: [], calls: [] }),
			specDirectory: mkdtempSync(join(tmpdir(), "sd-envj-")),
			gate2: null,
		}));
		expect(out.kind).toBe("override-retry");
		if (out.kind !== "override-retry") return;
		expect(out.postRegateErrors).toBeNull();
	});

	it("headless (no escalation surface) → terminal-stop with BOTH evidence packets logged", async () => {
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		const out = await handOffEnvBlockerJudge(baseInput({
			ctx: judgeCtx({ diagnosis: "env broken", route: "fix-environment", confidence: 0.9, evidence: [{ file: "tests/census.test.ts", quote: "lockstep" }] }, { logs, calls }),
			specDirectory: mkdtempSync(join(tmpdir(), "sd-envj-")),
		}));
		expect(out.kind).toBe("terminal-stop");
		expect(logs.some((l) => l.includes("headless — no escalation surface"))).toBe(true);
		expect(logs.some((l) => l.includes("gate tail:"))).toBe(true);
		expect(logs.some((l) => l.includes("dirt inventory"))).toBe(true);
	});

	it("the kill-switch detection warning fires BEFORE the judge when dirt exists and the switch is set", async () => {
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		vi.stubEnv("SUPER_DEV_NO_DIRTY_QUARANTINE", "1");
		try {
			await handOffEnvBlockerJudge(baseInput({
				ctx: judgeCtx({ diagnosis: "env", route: "fix-environment", confidence: 0.9, evidence: [{ file: "tests/census.test.ts", quote: "lockstep" }] }, { logs, calls }),
				specDirectory: mkdtempSync(join(tmpdir(), "sd-envj-")),
			}));
			const ksIdx = logs.findIndex((l) => l.includes("kill-switch"));
			expect(ksIdx).toBeGreaterThanOrEqual(0);
			// F3 (blind-spot close): the warning must precede the DISPATCH ITSELF
			// (the in-lane marker), and the dispatch precedes nothing the warning
			// follows — a joint relocation of both logs below the judge call now fails
			const dispatchIdx = logs.findIndex((l) => l.includes("[agent-dispatch] pipeline.judge."));
			expect(dispatchIdx).toBeGreaterThan(ksIdx);
			// T4.3 ordering: the warning is the FIRST env-blocker line
			const classIdx = logs.findIndex((l) => l.includes("out-of-scope-only failures, baseline=regression")); // the AC-05 line (the kill-switch line shares the next= suffix)
			expect(ksIdx).toBeLessThan(classIdx);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("the T6.2 verdict record lands in the ledger only for routed/escalate outcomes", async () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-envj-ledger-"));
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		try {
			await handOffEnvBlockerJudge(baseInput({
				ctx: judgeCtx({ diagnosis: "env broken", route: "fix-environment", confidence: 0.9, evidence: [{ file: "tests/census.test.ts", quote: "lockstep" }] }, { logs, calls }),
				specDirectory: specDir,
			}));
			const ledger = join(specDir, ".environment-faults.jsonl");
			expect(existsSync(ledger)).toBe(true);
			const rows = readFileSync(ledger, "utf8").trim().split("\n").map((r) => JSON.parse(r));
			expect(rows.some((r) => r.kind === "judge-environmental" && String(r.reason).startsWith("fix-environment:"))).toBe(true);
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("retry-with-guidance (escalate surface) → guidance persisted, the one-shot re-entry granted, blockReason NULL (no anti-windup)", async () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-envj-guide-"));
		const logs: string[] = [];
		const guidanceUsed: Record<string, true> = {};
		try {
			const out = await handOffEnvBlockerJudge(baseInput({
				ctx: judgeCtx({ diagnosis: "env broken", route: "fix-environment", confidence: 0.9, evidence: [{ file: "tests/census.test.ts", quote: "lockstep" }] }, {
					logs,
					calls: [],
					// an escalate surface whose decision is retry-with-guidance
					escalate: (async () => ({ choice: "retry-with-guidance", guidance: "restart the DB container first" })) as never,
				}),
				specDirectory: specDir,
				phaseGuidanceReentryUsed: guidanceUsed,
			}));
			expect(out.kind).toBe("terminal-stop");
			if (out.kind !== "terminal-stop") return;
			// the granted re-entry declines the anti-windup block
			expect(out.blockReason).toBeNull();
			expect(guidanceUsed["phase-02"]).toBe(true); // in/out: the one-shot grant is recorded
			// the guidance persisted to the track user-notes (.user-notes.json, 063 S2)
			const notes = join(specDir, ".user-notes.json");
			expect(existsSync(notes)).toBe(true);
			expect(readFileSync(notes, "utf8")).toContain("restart the DB container first");
			expect(logs.some((l) => l.includes("re-entry granted (1/1, per phase ever)"))).toBe(true);
			// a SECOND ask finds the budget spent → no new grant, the blocked stop
			const out2 = await handOffEnvBlockerJudge(baseInput({
				ctx: judgeCtx({ diagnosis: "env broken again", route: "fix-environment", confidence: 0.9, evidence: [{ file: "tests/census.test.ts", quote: "lockstep" }] }, {
					logs,
					calls: [],
					escalate: (async () => ({ choice: "retry-with-guidance", guidance: "second ask" })) as never,
				}),
				specDirectory: specDir,
				phaseGuidanceReentryUsed: guidanceUsed,
			}));
			if (out2.kind !== "terminal-stop") throw new Error("expected terminal-stop");
			expect(out2.blockReason).not.toBeNull(); // the anti-windup block IS set
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("a degraded judge outcome (disabled/budget) → the SAME terminal-stop surface, verdict record absent", async () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-envj-deg-"));
		const logs: string[] = [];
		try {
			const out = await handOffEnvBlockerJudge(baseInput({
				ctx: judgeCtx(null, { logs, calls: [], error: "judge disabled (SUPER_DEV_DISABLE_JUDGE=1)" }),
				specDirectory: specDir,
			}));
			expect(out.kind).toBe("terminal-stop");
			if (out.kind !== "terminal-stop") return;
			expect(out.blockReason).toContain(`judge degraded`);
			expect(logs.some((l) => l.includes("judge degraded at the environmental-blocker boundary"))).toBe(true);
			// T6.2: no verdict record for a degraded outcome
			const ledger = join(specDir, ".environment-faults.jsonl");
			if (existsSync(ledger)) {
				const rows = readFileSync(ledger, "utf8").trim().split("\n").map((r) => JSON.parse(r));
				expect(rows.some((r) => r.kind === "judge-environmental")).toBe(false);
			}
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});
});
