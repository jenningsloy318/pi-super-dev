import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	JUDGE_CONTROL_KEYS,
	JUDGE_ROUTES,
	judgeBudgetState,
	resetJudgeBudgets,
	runJudge,
	verifyJudgeEvidence,
	type JudgeVerdict,
} from "../src/stages/judge.ts";
import { buildJudgePrompt } from "../src/prompts.ts";
import { extractControlKeys } from "../src/control.ts";
import { readRunEvents } from "../src/runlog.ts";
import type { StageContext, AgentResult } from "../src/types.ts";

function makeCtx(agentImpl?: (call: { id: string; agent: string; prompt: string }) => Partial<AgentResult>) {
	const logs: string[] = [];
	const calls: Array<{ id: string; agent: string; prompt: string }> = [];
	const ctx = {
		task: "test task",
		options: {},
		state: {},
		budget: { check: () => true },
		log: (m: string) => logs.push(m),
		agent: vi.fn(async (call: { id: string; agent: string; prompt: string }) => {
			calls.push(call);
			return { text: "", control: null, ...(agentImpl?.(call) ?? {}) } as AgentResult;
		}),
		helper: vi.fn(async () => ({ text: "", control: null }) as never),
	} as unknown as StageContext;
	return { ctx, logs, calls };
}

function tmpWorktree(): string {
	return mkdtempSync(join(tmpdir(), "judge-test-"));
}

const baseVerdict = (over: Partial<Record<string, unknown>>): Record<string, unknown> => ({
	diagnosis: "the test imports a module the runner cannot resolve because the toolchain output is unenumerated",
	route: "re-author-tests",
	confidence: 0.9,
	evidence: [{ file: "src/a.test.ts", quote: "import { thing } from \"./missing-module\";" }],
	...over,
});

describe("judge unit", () => {
	let wt: string;
	beforeEach(() => {
		wt = tmpWorktree();
		resetJudgeBudgets();
		delete process.env.SUPER_DEV_DISABLE_JUDGE;
		mkdirSync(join(wt, "src"), { recursive: true });
		writeFileSync(join(wt, "src", "a.test.ts"), `import { thing } from "./missing-module";\nexpect(thing).toBeDefined();\n`);
	});

	it("closed route set is frozen", () => {
		expect([...JUDGE_ROUTES]).toEqual(["re-author-tests", "challenge-test", "fix-environment", "continue", "escalate-now"]);
	});

	it("evidence verification passes a verbatim quote from the worktree", () => {
		const v = baseVerdict({}) as unknown as JudgeVerdict;
		expect(verifyJudgeEvidence(v, wt, [])).toEqual([]);
	});

	it("evidence verification fails a fabricated quote", () => {
		const v = baseVerdict({ evidence: [{ file: "src/a.test.ts", quote: "this quote does not exist in the file at all" }] }) as unknown as JudgeVerdict;
		expect(verifyJudgeEvidence(v, wt, []).join(" ")).toContain("quote not found");
	});

	it("evidence verification fails a file outside the worktree (process cwd never consulted)", () => {
		// A file that exists in the HOST repo but not the worktree must not verify.
		const v = baseVerdict({ evidence: [{ file: "package.json", quote: "this is not in the worktree copy" }] }) as unknown as JudgeVerdict;
		expect(verifyJudgeEvidence(v, wt, []).join(" ")).toContain("file not found");
	});

	it("evidence verification accepts a quote from captured outputs", () => {
		const v = baseVerdict({ evidence: [{ file: "src/a.test.ts", quote: "Error: cannot classify this brand-new toolchain failure mode" }] }) as unknown as JudgeVerdict;
		expect(verifyJudgeEvidence(v, wt, ["oracle output tail: Error: cannot classify this brand-new toolchain failure mode (exit 1)"])).toEqual([]);
	});

	it("non-continue routes require at least one evidence item", () => {
		const v = baseVerdict({ route: "challenge-test", evidence: [] }) as unknown as JudgeVerdict;
		expect(verifyJudgeEvidence(v, wt, []).join(" ")).toContain("at least 1 evidence");
	});

	it("continue route allows empty evidence", () => {
		const v = baseVerdict({ route: "continue", evidence: [] }) as unknown as JudgeVerdict;
		expect(verifyJudgeEvidence(v, wt, [])).toEqual([]);
	});

	it("quote length bounds are enforced", () => {
		const tooShort = baseVerdict({ evidence: [{ file: "src/a.test.ts", quote: "short" }] }) as unknown as JudgeVerdict;
		expect(verifyJudgeEvidence(tooShort, wt, []).join(" ")).toContain("outside 8-200");
	});

	it("runJudge routes a verified verdict", async () => {
		const { ctx, logs } = makeCtx(() => ({ control: baseVerdict({}) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-1", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("routed");
		if (out.status === "routed") expect(out.verdict.route).toBe("re-author-tests");
		expect(logs.join(" ")).toContain("route=re-author-tests");
	});

	it("runJudge discards an unverified verdict (escalates, never permissive)", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ evidence: [{ file: "src/a.test.ts", quote: "fabricated quote not present anywhere" }] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-2", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests", "continue"] });
		expect(out.status).toBe("discarded");
	});

	it("runJudge maps an unknown closed-set route to discarded", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "approve-everything" }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-3", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("discarded");
	});

	it("runJudge forces escalate-now when the route is not offered at the wiring point", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "fix-environment" }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-4", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("escalate");
		if (out.status === "escalate") expect(out.verdict.route).toBe("escalate-now");
	});

	it("runJudge forces escalate-now below the confidence floor", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ confidence: 0.4, route: "continue", evidence: [] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-5", worktreePath: wt, context: "ctx", allowedRoutes: ["continue"] });
		expect(out.status).toBe("escalate");
	});

	it("runJudge degrades on kill switch without spawning the agent", async () => {
		process.env.SUPER_DEV_DISABLE_JUDGE = "1";
		try {
			const { ctx, calls } = makeCtx(() => ({ control: baseVerdict({}) as Record<string, unknown> }));
			const out = await runJudge(ctx, { scope: "test", signature: "sig-6", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests"] });
			expect(out.status).toBe("degraded");
			expect(calls.length).toBe(0);
		} finally {
			delete process.env.SUPER_DEV_DISABLE_JUDGE;
		}
	});

	it("runJudge degrades when the judge agent itself fails (INV-6)", async () => {
		const { ctx } = makeCtx(() => ({ control: null, error: "Model \"x\" not found" }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-7", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("degraded");
	});

	it("per-signature budget exhausts after 2 calls", async () => {
		const { ctx, calls } = makeCtx(() => ({ control: baseVerdict({}) as Record<string, unknown> }));
		const req: import("../src/stages/judge.ts").JudgeRequest = { scope: "test", signature: "same-sig", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests"] };
		expect((await runJudge(ctx, req)).status).toBe("routed");
		expect((await runJudge(ctx, req)).status).toBe("routed");
		const third = await runJudge(ctx, req);
		expect(third.status).toBe("degraded");
		if (third.status === "degraded") expect(third.reason).toContain("per-signature");
		expect(calls.length).toBe(2);
	});

	it("run budget spans signatures", async () => {
		process.env.SUPER_DEV_MAX_JUDGE_CALLS = "1";
		resetJudgeBudgets();
		try {
			const { ctx } = makeCtx(() => ({ control: baseVerdict({}) as Record<string, unknown> }));
			expect((await runJudge(ctx, { scope: "t", signature: "a", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] })).status).toBe("routed");
			expect((await runJudge(ctx, { scope: "t", signature: "b", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] })).status).toBe("degraded");
		} finally {
			delete process.env.SUPER_DEV_MAX_JUDGE_CALLS;
		}
	});

	it("audit jsonl is appended to the spec directory", async () => {
		const spec = join(wt, "docs", "specifications", "01-x");
		const { ctx } = makeCtx(() => ({ control: baseVerdict({}) as Record<string, unknown> }));
		await runJudge(ctx, { scope: "test-audit", signature: "sig-a", worktreePath: wt, specDirectory: spec, context: "ctx", allowedRoutes: ["re-author-tests"] });
		const line = readFileSync(join(spec, ".judge.jsonl"), "utf8").trim().split("\n").pop();
		expect(JSON.parse(line as string).scope).toBe("test-audit");
	});

	it("P1.5: every judge call double-writes judge.called to the event ledger", async () => {
		const spec = join(wt, "docs", "specifications", "01-ledger");
		const { ctx } = makeCtx(() => ({ control: baseVerdict({}) as Record<string, unknown> }));
		// routed path (stage10 scope → stage attribution "verify")
		await runJudge(ctx, { scope: "stage10.stagnation", signature: "sig-l1", worktreePath: wt, specDirectory: spec, context: "ctx", allowedRoutes: ["re-author-tests"] });
		// degraded path (budget-starved: same signature again ×2 exhausts per-signature)
		await runJudge(ctx, { scope: "stage10.stagnation", signature: "sig-l1", worktreePath: wt, specDirectory: spec, context: "ctx", allowedRoutes: ["re-author-tests"] });
		await runJudge(ctx, { scope: "stage10.stagnation", signature: "sig-l1", worktreePath: wt, specDirectory: spec, context: "ctx", allowedRoutes: ["re-author-tests"] });
		const events = readRunEvents(spec).filter((e) => e.type === "judge.called");
		expect(events).toHaveLength(3);
		const routed = events[0];
		expect(routed.data.status).toBe("routed");
		expect(routed.data.route).toBe("re-author-tests");
		expect(routed.stage).toBe("verify");
		expect(routed.agent).toBe("judge");
		const degraded = events[2];
		expect(degraded.data.status).toBe("degraded");
		expect(String(degraded.data.reason)).toContain("budget");
	});

	it("prompt control line extracts exactly the judge key set", () => {
		const prompt = buildJudgePrompt("scope-1", "context block", ["re-author-tests", "escalate-now"]);
		expect(extractControlKeys(prompt)).toEqual([...JUDGE_CONTROL_KEYS]);
		expect(prompt).toContain("- re-author-tests");
		expect(prompt).toContain("- escalate-now (always available");
	});
});

describe("judge prompt control contracts", () => {
	it("prompt is self-contained (no undefined ctxBlock)", () => {
		const prompt = buildJudgePrompt("s", "c", ["continue"]);
		expect(prompt).not.toContain("undefined");
		expect(prompt).not.toContain("null,");
	});
});

// ─── J10: judge diagnosis at the Stage 10 break boundaries ──────────────────

import { reviewLoopUntil } from "../src/stages/verify.ts";
import type { PipelineState } from "../src/types.ts";

describe("J10 stage10 stagnation diagnosis", () => {
	let wt: string;
	beforeEach(() => {
		resetJudgeBudgets();
		wt = tmpWorktree();
		mkdirSync(join(wt, "src"), { recursive: true });
		writeFileSync(join(wt, "src", "a.ts"), "export const a = 1;\n");
	});
	afterEach(() => {
		try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
	});

	const mkState = (withHist: boolean): PipelineState => {
		const s = {
			setup: { worktreePath: wt, specDirectory: join(wt, "docs", "specifications", "x"), defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "x", worktreeCreated: false, initializedRepo: false },
			review: { verdict: "Changes Requested", findings: [{ id: "F1", severity: "high", title: "T", file: "src/a.ts" }] },
			buildGate: { pass: true, ran: [], errors: [] },
		} as unknown as PipelineState;
		if (withHist) (s as Record<string, unknown>).__reviewSignatures = ["old-sig", "old-sig"];
		return s;
	};

	it("J10-a: the stagnation break carries a verified judge diagnosis as the leading finding", async () => {
		const { ctx } = makeCtx(() => ({
			control: {
				diagnosis: "the fixer cannot converge because the finding is owned by the spec stage, not the code",
				route: "escalate-now",
				confidence: 0.9,
				evidence: [{ file: "src/a.ts", quote: "export const a = 1;" }],
			} as Record<string, unknown>,
		}));
		const s = mkState(true); // prior signatures identical to current → stagnant
		// seed identical history so the CURRENT signature repeats
		const cur = (await import("../src/stages/verify.ts")).findingsSignature(s);
		(s as Record<string, unknown>).__reviewSignatures = [cur, cur];
		const broke = await reviewLoopUntil(s, ctx);
		expect(broke).toBe(true);
		const stag = (s as Record<string, unknown>).__stagnated as { findings?: Array<{ title?: string }> };
		expect(stag?.findings?.[0]?.title).toContain("judge diagnosis:");
		expect(stag?.findings?.[0]?.title).toContain("owned by the spec stage");
	}, 10_000);

	it("J10 degraded (judge fails) keeps the break without a diagnosis finding", async () => {
		const { ctx } = makeCtx(() => ({ control: null, error: "infra down" }));
		const s = mkState(true);
		const cur = (await import("../src/stages/verify.ts")).findingsSignature(s);
		(s as Record<string, unknown>).__reviewSignatures = [cur, cur];
		const broke = await reviewLoopUntil(s, ctx);
		expect(broke).toBe(true);
		const stag = (s as Record<string, unknown>).__stagnated as { findings?: Array<{ title?: string }> };
		expect(stag?.findings?.[0]?.title ?? "").not.toContain("judge diagnosis:");
	}, 10_000);
});
