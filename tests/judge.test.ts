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
		expect([...JUDGE_ROUTES]).toEqual(["re-author-tests", "challenge-test", "fix-environment", "implementer-retry", "replan-upstream", "allow-scaffold", "continue", "escalate-now"]);
	});

	// ── v0.2.8 (run 2026-08-19T08-32-47-962Z): replan-upstream routes an
	// upstream-artifact contradiction (an AC referencing a non-existent code
	// baseline; a spec citing a non-existent scenario/AC) back to the owning
	// stage. It is EVIDENCE-REQUIRED (NOT missing-evidence-exempt): re-running
	// upstream stages is consequential, so the judge must quote the offending
	// artifact text + the contradicting reality; a zero-evidence verdict discards.
	// SCENARIO-002
	it("v0.2.8: a zero-evidence replan-upstream verdict DISCARDS (evidence-required, NOT missing-evidence-exempt)", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "replan-upstream", evidence: [] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-ru-empty", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests", "fix-environment", "replan-upstream"] });
		expect(out.status).toBe("discarded");
	});

	// SCENARIO-003
	it("v0.2.8: an evidence-backed replan-upstream verdict ROUTES", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "replan-upstream" }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-ru-ok", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests", "fix-environment", "replan-upstream"] });
		expect(out.status).toBe("routed");
		if (out.status === "routed") expect(out.verdict.route).toBe("replan-upstream");
	});

	// allow-scaffold is likewise evidence-required (not missing-evidence-exempt).
	it("v0.2.8: a zero-evidence allow-scaffold verdict DISCARDS; an evidence-backed one ROUTES", async () => {
		const empty = makeCtx(() => ({ control: baseVerdict({ route: "allow-scaffold", evidence: [] }) as Record<string, unknown> }));
		expect((await runJudge(empty.ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-as-empty", worktreePath: wt, context: "ctx", allowedRoutes: ["allow-scaffold", "re-author-tests"] })).status).toBe("discarded");
		const ok = makeCtx(() => ({ control: baseVerdict({ route: "allow-scaffold" }) as Record<string, unknown> }));
		const out = await runJudge(ok.ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-as-ok", worktreePath: wt, context: "ctx", allowedRoutes: ["allow-scaffold", "re-author-tests"] });
		expect(out.status).toBe("routed");
		if (out.status === "routed") expect(out.verdict.route).toBe("allow-scaffold");
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

	// ── F4 (RC4 + adversarial F4-JUDGE-INTEGRITY): escalate-now with NO evidence
	// degrades to escalate (the diagnosis is the product — run
	// 2026-08-17T08-56-53-706Z discarded the one component that had root-caused
	// the loop); escalate-now with a FABRICATED quote still discards.
	it("runJudge escalates (not discards) an escalate-now verdict with NO evidence", async () => {
		const { ctx, logs } = makeCtx(() => ({ control: baseVerdict({ route: "escalate-now", evidence: [] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-f4a", worktreePath: wt, context: "ctx", allowedRoutes: ["escalate-now"] });
		expect(out.status).toBe("escalate");
		if (out.status === "escalate") expect(out.verdict.route).toBe("escalate-now");
		expect(logs.join(" ")).toContain("unverified escalate accepted");
	});

	it("runJudge still DISCARDS an escalate-now verdict with a fabricated quote", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "escalate-now", evidence: [{ file: "src/a.test.ts", quote: "a fabricated quote that appears nowhere in the file at all" }] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-f4b", worktreePath: wt, context: "ctx", allowedRoutes: ["escalate-now"] });
		expect(out.status).toBe("discarded");
	});

	// ── J5 (run 2026-08-19T02-01-12-840Z): the RED no-progress recovery routes
	// re-author-tests / fix-environment are DIAGNOSIS-DRIVEN — the harness re-runs
	// bounded deterministic authoring/environment work with the diagnosis and
	// never acquits a gate (INV-1) — so a MISSING-evidence verdict on them must
	// ROUTE (with a documented INV-2 exemption), not discard into the no-progress
	// deadlock that killed that run at 0/7 phases. FABRICATED / MALFORMED evidence
	// still discards; challenge-test (can drop an accepted RED) is NOT exempt.

	// SCENARIO-001
	it("J5: re-author-tests with NO evidence ROUTES (does not discard) with a documented exemption", async () => {
		const spec = join(wt, "docs", "specifications", "31-j5-reauthor");
		const { ctx, logs } = makeCtx(() => ({ control: baseVerdict({ route: "re-author-tests", evidence: [] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-j5a", worktreePath: wt, specDirectory: spec, context: "ctx", allowedRoutes: ["re-author-tests", "fix-environment"] });
		expect(out.status).toBe("routed");
		if (out.status === "routed") expect(out.verdict.route).toBe("re-author-tests");
		const line = readFileSync(join(spec, ".judge.jsonl"), "utf8").trim().split("\n").pop();
		const entry = JSON.parse(line as string) as { routed?: boolean; reason?: string };
		expect(entry.routed).toBe(true);
		expect(String(entry.reason ?? "")).toContain("NO evidence");
	});

	// SCENARIO-002
	it("J5: fix-environment with NO evidence ROUTES (does not discard)", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "fix-environment", evidence: [] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-j5b", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests", "fix-environment"] });
		expect(out.status).toBe("routed");
		if (out.status === "routed") expect(out.verdict.route).toBe("fix-environment");
	});

	// SCENARIO-003
	it("J5: re-author-tests with a FABRICATED quote still DISCARDS (fabrication guard unchanged)", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "re-author-tests", evidence: [{ file: "src/a.test.ts", quote: "this quote is fabricated and appears nowhere in the file" }] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-j5c", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests", "fix-environment"] });
		expect(out.status).toBe("discarded");
	});

	// SCENARIO-004
	it("J5: re-author-tests with MALFORMED (all-empty) evidence still DISCARDS", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "re-author-tests", evidence: [{ file: "", quote: "" }] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-j5d", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests", "fix-environment"] });
		expect(out.status).toBe("discarded");
		if (out.status === "discarded") expect(out.reason).toContain("malformed");
	});

	// SCENARIO-005 — FLIPPED in v0.2.11 (run 2026-08-19T14-54-22-165Z): the
	// challenge-test exclusion killed that run — the judge's 0.92-confidence
	// joint-unsatisfiability diagnosis (stale spec-01 pin vs the phase's
	// confirmed RED oracle) was DISCARDED for an empty evidence list, no route
	// actuated, and the run died at 0/12 phases. The original exclusion
	// rationale ("can drop an accepted RED gate") applied equally to the
	// already-exempt re-author-tests; challenge-test is additionally bounded by
	// MAX_CHALLENGE_REAUTHORS and the re-authored test must still pass RED
	// strength review.
	it("v0.2.11: challenge-test with NO evidence ROUTES (INV-2 exemption, documented in .judge.jsonl)", async () => {
		const spec = join(wt, "docs", "specifications", "31-v0211-challenge");
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "challenge-test", evidence: [], diagnosis: "Provable test contradiction: tests/interface-contracts-ownership.test.ts:618 demands the schema accept {} while the confirmed-RED oracle mandates a closed 13-field Type.Object." }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.impl-no-progress.phase-01", signature: "sig-v0211a", worktreePath: wt, specDirectory: spec, context: "ctx", allowedRoutes: ["challenge-test", "re-author-tests", "continue"] });
		expect(out.status).toBe("routed");
		if (out.status === "routed") expect(out.verdict.route).toBe("challenge-test");
		const line = readFileSync(join(spec, ".judge.jsonl"), "utf8").trim().split("\n").pop();
		const entry = JSON.parse(line as string) as { routed?: boolean; reason?: string };
		expect(entry.routed).toBe(true);
		expect(String(entry.reason ?? "")).toContain("NO evidence");
	});

	it("v0.2.11: challenge-test with FABRICATED evidence still DISCARDS (fabrication guard unchanged)", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "challenge-test", evidence: [{ file: "src/a.test.ts", quote: "this quote is fabricated and appears nowhere in the file" }] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.impl-no-progress.phase-01", signature: "sig-v0211b", worktreePath: wt, context: "ctx", allowedRoutes: ["challenge-test", "re-author-tests"] });
		expect(out.status).toBe("discarded");
	});

	// SCENARIO-006
	it("J5: a below-confidence exempt route still ESCALATES (confidence gate applied after evidence)", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "re-author-tests", confidence: 0.3, evidence: [] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "stage9.red-no-progress.phase-01", signature: "sig-j5f", worktreePath: wt, context: "ctx", allowedRoutes: ["re-author-tests", "fix-environment"] });
		expect(out.status).toBe("escalate");
		if (out.status === "escalate") expect(out.verdict.route).toBe("escalate-now");
	});

	// ─── T7.7 (NFR-6 pinning): the judge fix-in-pass quartet ─────────────────
	//
	// B3 — a `continue` verdict with ZERO evidence still routes (bounded impact:
	// it preserves the loop's deterministic machinery), but the exemption from
	// INV-2's machine-verification rule must be EXPLICIT in the audit trail, not
	// silent.
	it("B3: an evidence-less continue verdict routes with an explicit zero-evidence audit line", async () => {
		const spec = join(wt, "docs", "specifications", "01-b3");
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "continue", confidence: 0.9, evidence: [] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test-b3", signature: "sig-b3", worktreePath: wt, specDirectory: spec, context: "ctx", allowedRoutes: ["continue"] });
		expect(out.status).toBe("routed");
		const line = readFileSync(join(spec, ".judge.jsonl"), "utf8").trim().split("\n").pop();
		const entry = JSON.parse(line as string) as { routed?: boolean; reason?: string };
		expect(entry.routed).toBe(true);
		// RED today: the routed audit entry carries no reason at all — the INV-2
		// exemption is invisible in the audit trail.
		expect(String(entry.reason ?? "")).toContain("zero evidence");
	});

	// B4 — a judge that attaches GARBAGE evidence (every item empty/whitespace)
	// fabricated its evidence; that is MALFORMED, not MISSING — it discards on
	// EVERY route (including escalate-now), never degrades via the
	// missing-evidence path. "attached nothing" ≠ "attached garbage".
	it("B4: an all-empty evidence array classifies as malformed and DISCARDS even on escalate-now", async () => {
		const { ctx } = makeCtx(() => ({ control: baseVerdict({ route: "escalate-now", evidence: [{ file: "", quote: "" }] }) as Record<string, unknown> }));
		const out = await runJudge(ctx, { scope: "test", signature: "sig-b4", worktreePath: wt, context: "ctx", allowedRoutes: ["escalate-now"] });
		// RED today: parseJudgeControl filters the empty item away, so the verdict
		// looks evidence-LESS and takes the escalate degrade.
		expect(out.status).toBe("discarded");
		if (out.status === "discarded") expect(out.reason).toContain("malformed");
	});

	it("B4 (unit): verifyJudgeEvidence flags an all-empty-whitespace evidence array as malformed", () => {
		const v = baseVerdict({ evidence: [{ file: "  ", quote: "" }, { file: "", quote: "   " }] }) as unknown as JudgeVerdict;
		const failures = verifyJudgeEvidence(v, wt, []).join(" ");
		expect(failures).toContain("malformed");
	});

	// B5 — RELATIVE evidence paths are contained under the worktree: the
	// documented contract ("file resolves under the worktree") must hold for
	// `..` traversal too, not just for names that happen to exist. ABSOLUTE
	// paths stay allowed by design (documented allowance).
	it("B5: a relative evidence path escaping the worktree via .. is rejected even when the file exists and the quote matches", () => {
		const outer = mkdtempSync(join(tmpdir(), "judge-b5-"));
		try {
			const wt2 = join(outer, "wt");
			mkdirSync(join(wt2, "src"), { recursive: true });
			writeFileSync(join(wt2, "src", "foo.ts"), "export const foo = 1;\n");
			writeFileSync(join(outer, "secret.txt"), "HOST SECRET CONTENT\n");
			// escapes via ..: exists AND the quote byte-occurs — only the
		// containment check can catch it (RED today: this verifies).
			const escaping = baseVerdict({ evidence: [{ file: "../secret.txt", quote: "HOST SECRET CONTENT" }] }) as unknown as JudgeVerdict;
			expect(verifyJudgeEvidence(escaping, wt2, []).join(" ")).toContain("outside the worktree");
			// a contained relative path passes
			const contained = baseVerdict({ evidence: [{ file: "src/foo.ts", quote: "export const foo = 1;" }] }) as unknown as JudgeVerdict;
			expect(verifyJudgeEvidence(contained, wt2, [])).toEqual([]);
		} finally { rmSync(outer, { recursive: true, force: true }); }
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

	// ─── J1/J2 (v0.2.4): timeout budget + retry-on-timeout ─────────────────────

	it("J1: judge timeout defaults to 240s and honors SUPER_DEV_JUDGE_TIMEOUT_MS", async () => {
		const { ctx, calls } = makeCtx(() => ({ control: baseVerdict({}) as Record<string, unknown> }));
		await runJudge(ctx, { scope: "t-j1", signature: "sig-j1", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
		expect((calls[0] as { timeoutMs?: number }).timeoutMs).toBe(240_000);
		process.env.SUPER_DEV_JUDGE_TIMEOUT_MS = "65000";
		try {
			const r2 = makeCtx(() => ({ control: baseVerdict({}) as Record<string, unknown> }));
			await runJudge(r2.ctx, { scope: "t-j1b", signature: "sig-j1b", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
			expect((r2.calls[0] as { timeoutMs?: number }).timeoutMs).toBe(65_000);
		} finally {
			delete process.env.SUPER_DEV_JUDGE_TIMEOUT_MS;
		}
	});

	it("J2: a timeout with no control retries once within the per-signature budget and routes the second attempt's verdict", async () => {
		let n = 0;
		const { ctx, calls, logs } = makeCtx(() => {
			n++;
			if (n === 1) return { control: null, error: "timed out after 240s" };
			return { control: baseVerdict({}) as Record<string, unknown> };
		});
		const out = await runJudge(ctx, { scope: "t-j2a", signature: "sig-j2a", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("routed");
		expect(calls.length).toBe(2);
		expect(logs.some((l) => l.includes("timeout on attempt 1") && l.includes("retrying"))).toBe(true);
	});

	it("J2: a second timeout degrades after exactly 2 attempts (Temporal-faithful attempt counting)", async () => {
		const { ctx, calls } = makeCtx(() => ({ control: null, error: "timed out after 240s" }));
		const out = await runJudge(ctx, { scope: "t-j2b", signature: "sig-j2b", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("degraded");
		if (out.status === "degraded") expect(out.reason).toContain("timed out");
		expect(calls.length).toBe(2);
		// Attempt accounting: a later call for the SAME signature is per-signature
		// exhausted — the timeout retry consumed both slots.
		const again = await runJudge(ctx, { scope: "t-j2b", signature: "sig-j2b", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
		expect(again.status).toBe("degraded");
		if (again.status === "degraded") expect(again.reason).toContain("per-signature");
	});

	it("J2 CONTROL: a non-timeout infra error never retries (deterministic failures fail fast)", async () => {
		const { ctx, calls, logs } = makeCtx(() => ({ control: null, error: 'Model "x" not found' }));
		const out = await runJudge(ctx, { scope: "t-j2c", signature: "sig-j2c", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("degraded");
		expect(calls.length).toBe(1);
		expect(logs.some((l) => l.includes("retrying"))).toBe(false);
	});

	it("J2 CONTROL: the timeout retry respects the run budget", async () => {
		process.env.SUPER_DEV_MAX_JUDGE_CALLS = "1";
		resetJudgeBudgets();
		try {
			const { ctx, calls } = makeCtx(() => ({ control: null, error: "timed out after 240s" }));
			const out = await runJudge(ctx, { scope: "t-j2d", signature: "sig-j2d", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
			expect(out.status).toBe("degraded");
			expect(calls.length).toBe(1);
		} finally {
			delete process.env.SUPER_DEV_MAX_JUDGE_CALLS;
		}
	});

	it("J2 (review F-1): a THROWN timeout (pi-spawn no-output shape) retries once and routes the second attempt's verdict", async () => {
		let n = 0;
		const { ctx, calls, logs } = makeCtx(() => {
			n++;
			if (n === 1) throw new Error("super-dev [pipeline.judge.t]: agent timed out after 240s. stderr: (empty)");
			return { control: baseVerdict({}) as Record<string, unknown> };
		});
		const out = await runJudge(ctx, { scope: "t-j2e", signature: "sig-j2e", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("routed");
		expect(calls.length).toBe(2);
		expect(logs.some((l) => l.includes("timeout on attempt 1") && l.includes("retrying"))).toBe(true);
	});

	it("J2 (review F-1): a thrown NON-timeout error degrades without retry", async () => {
		const { ctx, calls } = makeCtx(() => { throw new Error("spawn pi ENOENT"); });
		const out = await runJudge(ctx, { scope: "t-j2f", signature: "sig-j2f", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("degraded");
		if (out.status === "degraded") expect(out.reason).toContain("judge agent failed");
		expect(calls.length).toBe(1); // one attempt, no retry
	});

	it("J2 (review F-2): timeout→retry→success audits BOTH the timed-out attempt and the verdict", async () => {
		const spec = join(wt, "docs", "specifications", "01-j2audit");
		let n = 0;
		const { ctx } = makeCtx(() => {
			n++;
			if (n === 1) return { control: null, error: "timed out after 240s" };
			return { control: baseVerdict({}) as Record<string, unknown> };
		});
		const out = await runJudge(ctx, { scope: "t-j2g", signature: "sig-j2g", worktreePath: wt, specDirectory: spec, context: "c", allowedRoutes: ["re-author-tests"] });
		expect(out.status).toBe("routed");
		const lines = readFileSync(join(spec, ".judge.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines.some((l) => l.error && l.attempt === 1 && l.retried === true)).toBe(true);
		expect(lines.some((l) => l.verdict && l.routed)).toBe(true);
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


// ─── v0.2.11 F1b: firstCitedTestFile ───────────────────────────────────────
describe("firstCitedTestFile (v0.2.11 F1b)", () => {
	it("extracts the stale-pin test path from the verbatim incident diagnosis, :line stripped", async () => {
		const { firstCitedTestFile } = await import("../src/stages/judge.ts");
		const diagnosis = "Provable test contradiction, not an implementation defect. The failing pin tests/interface-contracts-ownership.test.ts:618 (SCENARIO-035) demands StageArtifactSchema accept {} while the confirmed-RED oracle stage-artifact-schema.test.ts mandates a closed 13-required-field Type.Object.";
		expect(firstCitedTestFile(diagnosis)).toBe("tests/interface-contracts-ownership.test.ts");
	});

	it("prefers a test-looking path over an earlier non-test citation", async () => {
		const { firstCitedTestFile } = await import("../src/stages/judge.ts");
		const diagnosis = "src/schemas.ts registers the shape; the contradiction is at tests/stale-pin.test.ts:42 vs the oracle.";
		expect(firstCitedTestFile(diagnosis)).toBe("tests/stale-pin.test.ts");
	});

	it("falls back to the first cited path when nothing looks like a test", async () => {
		const { firstCitedTestFile } = await import("../src/stages/judge.ts");
		expect(firstCitedTestFile("see src/schemas.ts:381 for the registration")).toBe("src/schemas.ts");
	});

	it("returns null on path-free text", async () => {
		const { firstCitedTestFile } = await import("../src/stages/judge.ts");
		expect(firstCitedTestFile("The two tests are jointly unsatisfiable; no file was cited.")).toBeNull();
	});
});

// ── M4 (v0.3.8): the env-blocker override consults the shared vocabulary ────

describe("M4 G3 fold — classifyJudgeRoute drives the override arms", () => {
	it("implementer-retry → retry; fix-environment → escalate (single source of truth)", async () => {
		const { classifyJudgeRoute } = await import("../src/routing/router.ts");
		expect(classifyJudgeRoute("implementer-retry")).toBe("retry");
		expect(classifyJudgeRoute("fix-environment")).toBe("escalate");
		// source pin: the implementation override arm requires the classifier's "retry"
		const src = readFileSync("src/stages/implementation.ts", "utf8");
		expect(src).toContain('classifyJudgeRoute(judgeOut.verdict.route) === "retry"');
	});
});
