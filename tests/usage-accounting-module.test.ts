import { afterEach, describe, expect, it, vi } from "vitest";
import { accumulateUsage, freshUsage, summarizeUsage, usageFuseError, type UsageTotalsView } from "../src/workflow/usage-accounting.ts";
import type { AgentUsage } from "../src/types.ts";

const usage = (over: Partial<AgentUsage> = {}): AgentUsage => ({
	turns: 1, toolCalls: 2, input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01, durationMs: 500, ...over,
});

describe("workflow/usage-accounting — wave 2 increment 2 (accumulators, summary, fuses)", () => {
	afterEach(() => {
		delete process.env.SUPER_DEV_MAX_RUN_COST;
		delete process.env.SUPER_DEV_MAX_RUN_TOKENS;
	});

	it("freshUsage starts at zeroed totals with empty byAgent/byStage maps (no fabricated values)", () => {
		const acc = freshUsage();
		expect(acc.totals).toEqual({ calls: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 });
		expect(acc.byAgent).toEqual({});
		expect(acc.byStage).toEqual({});
	});

	it("accumulateUsage no-ops on absent usage (P10 — absent usage is never fabricated)", () => {
		const acc = freshUsage();
		accumulateUsage(acc, "sd-impl", undefined, "implementation");
		expect(acc.totals.calls).toBe(0);
		expect(acc.byAgent).toEqual({});
	});

	it("the v0.3.75 W1 byStage bucketing: stage keys split the spend, absent/empty stage lands in (unlabeled)", () => {
		const acc = freshUsage();
		accumulateUsage(acc, "sd-a", usage({ input: 10 }), "implementation");
		accumulateUsage(acc, "sd-a", usage({ input: 20 }), "verify");
		accumulateUsage(acc, "sd-a", usage({ input: 1 }), ""); // empty string → (unlabeled)
		accumulateUsage(acc, "sd-b", usage({ input: 2 })); // absent → NOT bucketed by stage
		expect(acc.byStage).toEqual({
			implementation: expect.objectContaining({ calls: 1, input: 10 }),
			verify: expect.objectContaining({ calls: 1, input: 20 }),
			"(unlabeled)": expect.objectContaining({ calls: 1, input: 1 }),
		});
		expect(acc.byStage!["(unlabeled)"].calls).toBe(1); // the absent-stage call (sd-b) contributes NO stage row
		expect(acc.totals.calls).toBe(4); // …but every call still counts in totals
	});

	it("summarizeUsage: null on zero calls; deterministic parts order; cost trimmed to 4dp", () => {
		expect(summarizeUsage({ totals: { calls: 0 } as UsageTotalsView })).toBeNull();
		const line = summarizeUsage({ totals: { calls: 3, input: 1234, output: 567, turns: 9, toolCalls: 12, cost: 0.123456 } });
		expect(line).toBe("calls=3 input=1234 output=567 turns=9 tools=12 cost=0.1235");
		expect(summarizeUsage({ totals: { calls: 1, cost: 0 } })).toBe("calls=1"); // zero-valued fields stay absent
	});

	it("the cost fuse fails CLOSED pre-call naming spent/limit; the breaching call itself completed honestly", () => {
		process.env.SUPER_DEV_MAX_RUN_COST = "50";
		const acc = freshUsage();
		expect(usageFuseError(acc, vi.fn())).toBeNull(); // under the cap
		accumulateUsage(acc, "sd-a", usage({ cost: 50 }), "implementation");
		const err = usageFuseError(acc, vi.fn());
		expect(err).toContain("usage fuse tripped: SUPER_DEV_MAX_RUN_COST");
		expect(err).toContain(">= limit $50");
		expect(err).toContain("this call was NOT launched");
	});

	it("the token fuse counts input+output combined", () => {
		process.env.SUPER_DEV_MAX_RUN_TOKENS = "200";
		const acc = freshUsage();
		accumulateUsage(acc, "sd-a", usage({ input: 150, output: 60 }), "implementation"); // 210 >= 200
		const err = usageFuseError(acc, vi.fn());
		expect(err).toContain("SUPER_DEV_MAX_RUN_TOKENS");
		expect(err).toContain("in 150/out 60");
	});

	it("v0.3.72 M3: a set-but-unparseable cap WARNs ONCE (per variable) and never disarms the fuse silently", () => {
		process.env.SUPER_DEV_MAX_RUN_COST = "not-a-number";
		const acc = freshUsage();
		const logs: string[] = [];
		const log = (m: string) => void logs.push(m);
		expect(usageFuseError(acc, log)).toBeNull(); // proceeds unlimited, NOT a fake limit
		expect(usageFuseError(acc, log)).toBeNull(); // second call: warn already spent
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('WARN usage fuse DISABLED: SUPER_DEV_MAX_RUN_COST="not-a-number"');
	});
});
