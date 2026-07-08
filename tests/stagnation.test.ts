/**
 * Unit tests for verify-loop stagnation detection (Gap 4.6).
 * No LLM; drives the `reviewLoopUntil` predicate with a synthetic state + ctx.
 */

import { describe, it, expect } from "vitest";
import { findingsSignature, reviewLoopUntil } from "../src/stages/verify.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

const findings = (file: string, severity: string, title: string) => ({ id: "x", severity, title, detail: "d", file });

function stateWith(review: Record<string, unknown> | undefined, prior?: string[]): PipelineState {
	const s = { review } as unknown as PipelineState;
	if (prior) (s as Record<string, unknown>).__reviewSignatures = prior;
	return s;
}
const fakeCtx = (): StageContext => ({ log: () => {}, task: "", options: {}, state: {} as PipelineState } as unknown as StageContext);

describe("findingsSignature", () => {
	it("is empty when there are no findings", () => {
		expect(findingsSignature(stateWith({ findings: [] }))).toBe("");
		expect(findingsSignature(stateWith(undefined))).toBe("");
	});
	it("is order-independent (sorted tuples)", () => {
		const a = stateWith({ findings: [findings("a.ts", "high", "X"), findings("b.ts", "low", "Y")] });
		const b = stateWith({ findings: [findings("b.ts", "low", "Y"), findings("a.ts", "high", "X")] });
		expect(findingsSignature(a)).toBe(findingsSignature(b));
	});
	it("ignores detail wording (only file|severity|title)", () => {
		const a = stateWith({ findings: [{ id: "1", severity: "high", title: "T", detail: "one", file: "a.ts" }] });
		const b = stateWith({ findings: [{ id: "1", severity: "high", title: "T", detail: "two different", file: "a.ts" }] });
		expect(findingsSignature(a)).toBe(findingsSignature(b));
	});
	it("changes when severity changes", () => {
		const a = stateWith({ findings: [findings("a.ts", "high", "T")] });
		const b = stateWith({ findings: [findings("a.ts", "low", "T")] });
		expect(findingsSignature(a)).not.toBe(findingsSignature(b));
	});
});

describe("reviewLoopUntil (stagnation)", () => {
	it("does not break on the first review round (nothing to compare)", async () => {
		// review NOT approved, so the only exit would be stagnation
		const s = stateWith({ verdict: "Changes Requested", findings: [findings("a.ts", "high", "T")] });
		expect(await reviewLoopUntil(s, fakeCtx())).toBe(false);
	});

	it("breaks (returns true) when the same findings recur on the second round", async () => {
		const s1 = stateWith({ verdict: "Changes Requested", findings: [findings("a.ts", "high", "T")] });
		await reviewLoopUntil(s1, fakeCtx()); // round 1 → records signature
		// simulate the next loop iteration: same findings, history carried in state
		const s2 = stateWith({ verdict: "Changes Requested", findings: [findings("a.ts", "high", "T")] }, (s1 as unknown as Record<string, unknown>).__reviewSignatures as string[]);
		expect(await reviewLoopUntil(s2, fakeCtx())).toBe(true);
	});

	it("does NOT break when findings change between rounds", async () => {
		const s1 = stateWith({ verdict: "Changes Requested", findings: [findings("a.ts", "high", "T")] });
		await reviewLoopUntil(s1, fakeCtx());
		const s2 = stateWith({ verdict: "Changes Requested", findings: [findings("a.ts", "high", "T"), findings("b.ts", "low", "U")] }, (s1 as unknown as Record<string, unknown>).__reviewSignatures as string[]);
		expect(await reviewLoopUntil(s2, fakeCtx())).toBe(false);
	});

	it("never treats an empty-finding round as stagnant", async () => {
		const s1 = stateWith({ verdict: "Changes Requested", findings: [] });
		await reviewLoopUntil(s1, fakeCtx());
		const s2 = stateWith({ verdict: "Changes Requested", findings: [] }, (s1 as unknown as Record<string, unknown>).__reviewSignatures as string[]);
		expect(await reviewLoopUntil(s2, fakeCtx())).toBe(false);
	});
});
