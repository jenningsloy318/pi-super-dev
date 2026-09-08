/**
 * v0.3.79 Wave A2 — judge evidence failure is NEVER a silent discard
 * (spec-25 deep analysis: run 2026-09-07T14-14-09-937Z burned the
 * no-progress escape valve twice — "judge verdict DISCARDED — evidence
 * verification failed: evidence is malformed: every item is empty/whitespace"
 * at 03:24 and 08:38 — so the phase loop had no exit and kept re-attempting
 * for hours; the escape valve failed exactly when it was needed).
 *
 * New contract (fail-open floor, arXiv:2509.02761 critique-and-retry pattern):
 *  - on an evidence-verification failure that would DISCARD, the judge gets
 *    ONE corrective re-call with the failures fed back into the prompt;
 *  - a corrective verdict that verifies routes normally;
 *  - a corrective verdict that STILL fails verification escalates to the
 *    human with the diagnosis preserved (status "escalate"), NEVER a silent
 *    discard — the diagnosis is the product (F4 doctrine extended to the
 *    malformed/fabricated class).
 *
 * Fabrication discipline is preserved: an unverified verdict is never routed
 * on its claimed route — the only floor is escalate.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetJudgeBudgets, runJudge } from "../src/stages/judge.ts";
import type { StageContext, AgentResult } from "../src/types.ts";

let wt: string;
beforeEach(() => {
	wt = mkdtempSync(join(tmpdir(), "sd-jfailopen-"));
	resetJudgeBudgets();
	mkdirSync(join(wt, "src"), { recursive: true });
	writeFileSync(join(wt, "src", "a.test.ts"), `import { thing } from "./missing-module";\nexpect(thing).toBeDefined();\n`);
});
afterEach(() => {
	rmSync(wt, { recursive: true, force: true });
});

function makeCtx(script: Array<Partial<AgentResult> | { thrown: string }>) {
	const logs: string[] = [];
	const calls: Array<{ prompt: string; agent: string }> = [];
	let i = 0;
	const ctx = {
		task: "test task",
		options: {},
		state: {},
		budget: { check: () => true },
		log: (m: string) => logs.push(m),
		agent: async (call: { prompt: string; agent: string }) => {
			calls.push(call);
			const step = script[Math.min(i++, script.length - 1)];
			if ("thrown" in step) throw new Error(step.thrown);
			return { text: "", control: null, ...step } as AgentResult;
		},
		helper: async () => ({ text: "", control: null }) as never,
	} as unknown as StageContext;
	return { ctx, logs, calls };
}

const goodControl = {
	diagnosis: "the test imports a module the runner cannot resolve",
	route: "re-author-tests",
	confidence: 0.9,
	evidence: [{ file: "src/a.test.ts", quote: 'import { thing } from "./missing-module";' }],
};

const fabricatedControl = {
	diagnosis: "d",
	route: "re-author-tests",
	confidence: 0.9,
	evidence: [{ file: "src/a.test.ts", quote: "THIS QUOTE DOES NOT EXIST IN THE FILE" }],
};

const malformedControl = {
	diagnosis: "d",
	route: "re-author-tests",
	confidence: 0.9,
	evidence: [{ file: "", quote: "   " }],
};

const req = (ctx: StageContext) => ({
	ctx,
	r: {
		scope: "stage9.test-failopen",
		signature: "sig-failopen-1",
		worktreePath: wt,
		context: "## test context",
		allowedRoutes: ["re-author-tests", "continue"] as const,
		outputTails: ["tail"],
	},
});

describe("v0.3.79 A2 judge evidence fail-open", () => {
	it("fabricated evidence → ONE corrective re-call whose prompt carries the verification failures; a verified corrective verdict routes", async () => {
		const { ctx, calls } = makeCtx([{ control: fabricatedControl }, { control: goodControl }]);
		const out = await runJudge(ctx, req(ctx).r);
		expect(calls).toHaveLength(2);
		expect(out.status).toBe("routed");
		expect(out.status === "routed" && out.verdict.route).toBe("re-author-tests");
		expect(calls[1].prompt).toContain("evidence verification failed");
		expect(calls[1].prompt.toLowerCase()).toContain("escalate");
	});

	it("malformed evidence (all items empty/whitespace — the run 14-14 class) → corrective retry, then escalate floor (never discarded)", async () => {
		const { ctx, calls, logs } = makeCtx([{ control: malformedControl }, { control: malformedControl }]);
		const out = await runJudge(ctx, req(ctx).r);
		expect(calls).toHaveLength(2);
		expect(out.status).toBe("escalate");
		expect(out.status === "escalate" && out.verdict.route).toBe("escalate-now");
		expect(logs.join("\n")).not.toMatch(/verdict DISCARDED/);
		expect(logs.join("\n").toLowerCase()).toContain("escalat");
	});

	it("fabricated evidence twice → escalate with the corrective verdict's diagnosis preserved", async () => {
		const { ctx, calls } = makeCtx([
			{ control: fabricatedControl },
			{ control: { ...fabricatedControl, diagnosis: "corrective attempt: the import stays unresolvable at this phase — plan revision needed" } },
		]);
		const out = await runJudge(ctx, req(ctx).r);
		expect(calls).toHaveLength(2);
		expect(out.status).toBe("escalate");
		if (out.status === "escalate") {
			expect(out.verdict.route).toBe("escalate-now");
			expect(out.verdict.diagnosis).toContain("plan revision needed");
		}
	});

	it("corrective retry is bounded: a passing first verdict makes exactly one call", async () => {
		const { ctx, calls } = makeCtx([{ control: goodControl }]);
		const out = await runJudge(ctx, req(ctx).r);
		expect(calls).toHaveLength(1);
		expect(out.status).toBe("routed");
	});

	it("corrective second attempt with an unparseable control degrades honestly (agent-failed path), not escalate", async () => {
		const { ctx } = makeCtx([{ control: fabricatedControl }, { error: "agent died" }]);
		const out = await runJudge(ctx, req(ctx).r);
		// the corrective attempt failed as an AGENT failure → degraded (existing semantics)
		expect(out.status).toBe("degraded");
	});

	it("CR-v0379-P1: the escalate floor carries EMPTY evidence — unverified quotes must never reach judgeEscalateEvidencePresent consumers (FatalAbort on non-empty)", async () => {
		const { ctx } = makeCtx([{ control: malformedControl }, { control: fabricatedControl }]);
		const out = await runJudge(ctx, req(ctx).r);
		expect(out.status).toBe("escalate");
		if (out.status === "escalate") {
			expect(out.verdict.evidence).toEqual([]);
		}
	});

	it("ADV-v0379-7: budget-exhausted signature still discards honestly (the one remaining silent-discard path, now pinned)", async () => {
		// first call ROUTES (consumes signature slot 1, no corrective);
		// second call same signature fabricates → corrective gate sees the
		// signature at cap → the documented discard fallback.
		const { ctx, calls } = makeCtx([{ control: goodControl }, { control: fabricatedControl }]);
		const first = await runJudge(ctx, req(ctx).r);
		expect(first.status).toBe("routed");
		const second = await runJudge(ctx, req(ctx).r);
		expect(second.status).toBe("discarded");
		expect(calls).toHaveLength(2); // routed + fabricated attempt; NO corrective third call
	});

	it("second verdict with missing-evidence escalate-now still follows the F4 degrade-to-escalate path", async () => {
		const { ctx, calls } = makeCtx([
			{ control: fabricatedControl },
			{ control: { diagnosis: "owned upstream", route: "escalate-now", confidence: 0.9, evidence: [] } },
		]);
		const out = await runJudge(ctx, req(ctx).r);
		expect(calls).toHaveLength(2);
		expect(out.status).toBe("escalate");
	});
});
