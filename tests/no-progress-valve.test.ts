/**
 * The no-progress valve — contract test for the v0.4.40 extraction
 * (increment 12 of the stage.ts split).
 *
 * The EIGHTH control-flow conversion and the one with the MOST exits: FOUR
 * `continue`s (challenge-test, re-author-tests, the judge continue route, the
 * HITL retry-with-guidance) and TWO `break`s (the contradiction replan stop,
 * the terminal no-progress stop). They became a FIVE-way outcome union; each
 * arm carries ONLY its bindings (the v0.4.33 discipline), with
 * challengeConsumed driving the caller-side counter increment.
 *
 * The judge is driven through a fake ctx agent lane with resetJudgeBudgets
 * (module-scoped signature budget) and a REAL worktree carrying the cited
 * evidence file (INV-2 verification reads it); the escalation surface rides
 * ctx.options.escalate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { adjudicateNoProgress } from "../src/stages/implementation/no-progress-valve.ts";
import { resetJudgeBudgets } from "../src/stages/judge.ts";
import type { AgentCall, AgentResult, PipelineState, StageContext } from "../src/types.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const worktrees: string[] = [];
const specDirs: string[] = [];

/** A real worktree carrying the cited evidence file (INV-2 reads it). */
function makeWorktree(): string {
	const wt = mkdtempSync(join(tmpdir(), "sd-npv-wt-"));
	worktrees.push(wt);
	mkdirSync(join(wt, "tests"), { recursive: true });
	writeFileSync(join(wt, "tests/phase2.test.ts"), "// the phase-2 contract lockstep\n");
	return wt;
}

const judgeCtx = (verdict: Record<string, unknown> | null, out: { logs: string[]; calls: AgentCall[]; escalate?: unknown; error?: string }): StageContext => ({
	task: "t", options: { escalate: out.escalate }, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
	async agent(call: AgentCall): Promise<AgentResult> {
		out.calls.push(call);
		out.logs.push(`[agent-dispatch] ${call.id}`);
		return out.error !== undefined ? { text: "", control: null, error: out.error } : { text: "", control: verdict as Record<string, unknown> };
	},
} as unknown as StageContext);

const ACCEPTED_RED = { status: "red" as const, testFiles: ["tests/phase2.test.ts"], changedFiles: [] };

const baseInput = (over: Partial<Parameters<typeof adjudicateNoProgress>[0]> = {}) => ({
	ctx: judgeCtx(null, { logs: [], calls: [] }),
	state: {} as PipelineState,
	worktreePath: makeWorktree(),
	specDirectory: "",
	specIdentifier: "001",
	phaseId: "phase-02",
	phaseName: "wire-screen",
	framePhaseName: "wire-screen",
	attempt: 3,
	signatureRepeat: true,
	faultRecurrence: false,
	zeroLandedChange: false,
	attemptFaultClass: "product-defect",
	faultClassStreakCount: 1,
	boundaryRevertHits: 0,
	boundaryLeakOwners: [] as string[],
	boundaryLeakFiles: [] as string[],
	crossScopeConflict: false,
	crossScopeCites: [] as Array<{ file: string; ownerPhases: string[] }>,
	failureReasons: ["FAIL tests/phase2.test.ts > lockstep", "gate: build failed"],
	progressSignatureFailure: "sig-abc",
	implTextTail: "the assertion cannot be satisfied because the registry is frozen",
	implDefects: [] as Array<{ testFile: string; lines?: string; reason: string }>,
	acceptedRed: ACCEPTED_RED,
	testFiles: ["tests/phase2.test.ts"],
	challengeReauthors: 0,
	...over,
});

beforeEach(() => { vi.clearAllMocks(); resetJudgeBudgets(); });
afterEach(() => {
	for (const wt of worktrees.splice(0)) rmSync(wt, { recursive: true, force: true });
	for (const sd of specDirs.splice(0)) rmSync(sd, { recursive: true, force: true });
});

describe("no-progress valve (v0.4.40 increment-12 extraction)", () => {
	it("judge replan-upstream with an armed contradiction frame + a routing replan → replan-routed carrying the diagnosis", async () => {
		const specDir = (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })();
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		try {
			const out = await adjudicateNoProgress(baseInput({
				ctx: judgeCtx({ diagnosis: "the boundary reverts block the only satisfiable fix", route: "replan-upstream", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls }),
				state: { setup: { specDirectory: specDir } } as unknown as PipelineState,
				specDirectory: specDir,
				boundaryRevertHits: 2, // arm the cfFrame
				boundaryLeakOwners: ["phase-04"],
				boundaryLeakFiles: ["src/later.ts"],
			}));
			expect(out.kind).toBe("replan-routed");
			if (out.kind !== "replan-routed") return;
			expect(out.diagnosis).toContain("boundary reverts");
			// the frame context rode the judge prompt
			expect(calls[0]!.prompt).toContain("phase-boundary");
			// replan-upstream was OFFERED only because the frame armed it
			expect(calls[0]!.prompt).toContain("replan-upstream");
			expect(logs.some((l) => l.includes("contradiction routed to REPLAN"))).toBe(true);
			expect(logs.some((l) => l.includes("2 boundary revert(s) observed"))).toBe(true);
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("WITHOUT a frame, replan-upstream is NOT offered (the default route set is challenge/re-author/continue)", async () => {
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		await adjudicateNoProgress(baseInput({
			ctx: judgeCtx({ diagnosis: "d", route: "continue", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls }),
			specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
		}));
		expect(calls[0]!.prompt).toContain("challenge-test");
		expect(calls[0]!.prompt).not.toContain("replan-upstream");
	});

	it("NPV-3 — the frames take the RAW name: an unnamed phase renders NO parenthetical in the judge prompt", async () => {
		const calls: AgentCall[] = [];
		await adjudicateNoProgress(baseInput({
			ctx: judgeCtx({ diagnosis: "d", route: "continue", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs: [], calls }),
			specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
			boundaryRevertHits: 1, // arm the cfFrame
			boundaryLeakOwners: ["phase-04"],
			boundaryLeakFiles: ["src/later.ts"],
			framePhaseName: "", // the RAW name: unnamed phase — NOT the phaseName fallback
			phaseName: "wire-screen", // the loop-normalized name (the escalation message)
		}));
		// the frame context renders WITHOUT the parenthetical (inline `phases[idx]?.name ?? ""`)
		expect(calls[0]!.prompt).toContain("Phase phase-02 has repeated the SAME failure signature"); // the cfFrame context (no parenthetical)
		expect(calls[0]!.prompt).not.toContain("Phase phase-02 (");
	});

	it("judge challenge-test (accepted RED, budget available) → reauthor with challengeConsumed", async () => {
		const logs: string[] = [];
		const out = await adjudicateNoProgress(baseInput({
			ctx: judgeCtx({ diagnosis: "tests/phase2.test.ts is stale — it pins the old contract", route: "challenge-test", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls: [] }),
			specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
		}));
		expect(out.kind).toBe("reauthor");
		if (out.kind !== "reauthor") return;
		expect(out.challengeConsumed).toBe(true);
		expect(out.reauthorEvidence).toContain("stale");
		expect(logs.some((l) => l.includes("route=challenge-test: re-authoring RED"))).toBe(true);
	});

	it("judge challenge-test at an EXHAUSTED challenge budget → NOT the reauthor arm (falls through to the surface)", async () => {
		const logs: string[] = [];
		const out = await adjudicateNoProgress(baseInput({
			ctx: judgeCtx({ diagnosis: "stale test", route: "challenge-test", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls: [] }),
			specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
			challengeReauthors: 99, // >= MAX_CHALLENGE_REAUTHORS
		}));
		expect(out.kind).toBe("terminal"); // not vacuously: the ONLY remaining arm after the budget guard
	});

	it("judge re-author-tests → reauthor WITHOUT consuming the challenge budget", async () => {
		const logs: string[] = [];
		const out = await adjudicateNoProgress(baseInput({
			ctx: judgeCtx({ diagnosis: "the whole suite must be re-authored", route: "re-author-tests", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls: [] }),
			specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
		}));
		expect(out.kind).toBe("reauthor");
		if (out.kind !== "reauthor") return;
		expect(out.challengeConsumed).toBe(false);
		expect(out.reauthorEvidence).toContain("re-authored");
	});

	it("judge continue → continue-guided carrying the guidance for the NEXT implementer prompt", async () => {
		const logs: string[] = [];
		const out = await adjudicateNoProgress(baseInput({
			ctx: judgeCtx({ diagnosis: "bind the assertion to the registry output", route: "continue", confidence: 0.85, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls: [] }),
			specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
		}));
		expect(out.kind).toBe("continue-guided");
		if (out.kind !== "continue-guided") return;
		expect(out.judgeGuidance).toContain("Judge guidance for this attempt");
		expect(out.judgeGuidance).toContain("bind the assertion to the registry output");
	});

	it("HITL retry-with-guidance → retry-with-guidance carrying the evidence-backed re-author", async () => {
		const specDir = (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })();
		const logs: string[] = [];
		try {
			const out = await adjudicateNoProgress(baseInput({
				ctx: judgeCtx(null, {
					logs,
					calls: [],
					error: "judge disabled", // degrade past the arms to the HITL
					escalate: (async () => ({ choice: "retry-with-guidance", guidance: "relax the frozen assertion" })) as never,
				}),
				state: { setup: { specDirectory: specDir } } as unknown as PipelineState,
				specDirectory: specDir,
			}));
			expect(out.kind).toBe("retry-with-guidance");
			if (out.kind !== "retry-with-guidance") return;
			expect(out.reauthorEvidence.length).toBeGreaterThan(0);
			expect(logs.some((l) => l.includes("retrying with user guidance"))).toBe(true);
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("headless terminal stop → the P10 stop-class log names WHICH valve fired", async () => {
		const logs: string[] = [];
		const out = await adjudicateNoProgress(baseInput({
			ctx: judgeCtx(null, { logs, calls: [], error: "judge disabled" }),
			specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
			signatureRepeat: true,
		}));
		expect(out).toEqual({ kind: "terminal" });
		expect(logs.some((l) => l.includes("stopped after repeated no-progress failure"))).toBe(true);
	});

	it("F3 — a DECLINED replan (contradiction valve) falls through to the surface: no replan-routed, no break", async () => {
		const specDir = (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })();
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		try {
			// state.__replan set → triggerReplanForFindings declines → the inline code
			// fell THROUGH to the next arms (challenge-test etc.) — never a break
			const out = await adjudicateNoProgress(baseInput({
				ctx: judgeCtx({ diagnosis: "the boundary reverts block the fix", route: "replan-upstream", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls }),
				state: { setup: { specDirectory: specDir }, __replan: { at: "now" } } as unknown as PipelineState,
				specDirectory: specDir,
				boundaryRevertHits: 1,
				boundaryLeakOwners: ["phase-04"],
				boundaryLeakFiles: ["src/later.ts"],
			}));
			expect(out.kind).not.toBe("replan-routed"); // the decline fell through
			// the verdict route (replan-upstream) matches no later arm → the surface
			expect(["terminal"]).toContain(out.kind);
			expect(logs.some((l) => l.includes("contradiction routed to REPLAN"))).toBe(false);
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("F3 — a cross-scope conflict arms the csFrame: the cs finding shape and replan log are used", async () => {
		const specDir = (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })();
		const logs: string[] = [];
		const calls: AgentCall[] = [];
		try {
			const out = await adjudicateNoProgress(baseInput({
				ctx: judgeCtx({ diagnosis: "the cited test belongs to phase-03", route: "replan-upstream", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls }),
				state: { setup: { specDirectory: specDir } } as unknown as PipelineState,
				specDirectory: specDir,
				crossScopeConflict: true,
				crossScopeCites: [{ file: "tests/phase2.test.ts", ownerPhases: ["phase-03"] }],
			}));
			expect(out.kind).toBe("replan-routed");
			// the CS replan log variant (not the boundary-revert one)
			expect(logs.some((l) => l.includes("cross-scope contract conflict routed to REPLAN"))).toBe(true);
			expect(logs.some((l) => l.includes("boundary revert(s) observed"))).toBe(false);
			// the csFrame context rode the prompt and replan-upstream was offered
			expect(calls[0]!.prompt).toContain("ANOTHER phase's requireTests scope"); // the csFrame context text
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("F3 — the challenge-test log interpolates N+1 (the module never increments; the caller does)", async () => {
		const logs: string[] = [];
		const out = await adjudicateNoProgress(baseInput({
			ctx: judgeCtx({ diagnosis: "stale", route: "challenge-test", confidence: 0.9, evidence: [{ file: "tests/phase2.test.ts", quote: "lockstep" }] }, { logs, calls: [] }),
				specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
			challengeReauthors: 1, // one prior implementer challenge consumed
		}));
		expect(out.kind).toBe("reauthor");
		if (out.kind !== "reauthor") return;
		expect(out.challengeConsumed).toBe(true);
		// the log shows 2/MAX (N+1 of the input 1) — byte-identical to inline's post-increment form
		expect(logs.some((l) => l.includes("route=challenge-test: re-authoring RED with the verified diagnosis (2/"))).toBe(true);
	});

	it("the fault-class-recurrence stop class names the class × streak", async () => {
		const logs: string[] = [];
		await adjudicateNoProgress(baseInput({
			ctx: judgeCtx(null, { logs, calls: [], error: "judge disabled" }),
			specDirectory: (() => { const d = mkdtempSync(join(tmpdir(), "sd-npv-spec-")); specDirs.push(d); return d; })(),
			signatureRepeat: false,
			faultRecurrence: true,
			attemptFaultClass: "product-defect",
			faultClassStreakCount: 3,
		}));
		expect(logs.some((l) => l.includes("failure-category recurrence (product-defect × 3 consecutive attempts"))).toBe(true);
	});
});
