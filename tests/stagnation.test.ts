/**
 * Unit tests for verify-loop stagnation detection (Gap 4.6).
 * No LLM; drives the `reviewLoopUntil` predicate with a synthetic state + ctx.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { findingsSignature, reviewLoopUntil, reviewStageNode } from "../src/stages/verify.ts";
import { runHelper } from "../src/helpers.ts";
import type { PipelineState, StageContext, AgentCall } from "../src/types.ts";

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

describe("reviewStageNode terminal re-review", () => {
	it("re-reviews after a stagnation break so stale pre-fix findings do not block merge", async () => {
		const root = mkdtempSync(join(tmpdir(), "sd-review-stale-"));
		try {
			const specDirectory = join(root, "docs", "specifications", "01-review") + "/";
			mkdirSync(specDirectory, { recursive: true });
			writeFileSync(join(specDirectory, "06-specification.md"), "# Specification\n");
			const state: PipelineState = {
				setup: {
					worktreePath: root,
					specDirectory,
					defaultBranch: "main",
					language: "frontend",
					isWebUi: true,
					specIdentifier: "01-review",
					worktreeCreated: false,
					initializedRepo: false,
				},
				classify: { taskType: "feature", uiScope: "ui+arch", language: "frontend", isWebUi: true },
				spec: { specificationPath: join(specDirectory, "06-specification.md") },
				implementation: { phasesCompleted: 1, totalPhases: 1, allGreen: true },
			};
			let codeReviewCalls = 0;
			let fixCalls = 0;
			let escalationCalls = 0;
			const logs: string[] = [];
			const ctx: StageContext = {
				task: "implement feature",
				options: { escalate: async () => { escalationCalls += 1; return undefined; } },
				state,
				budget: { check: () => true, spent: () => true, count: 0 },
				log: (m: string) => logs.push(m),
				phase: () => {},
				events: new EventEmitter(),
				results: [],
				helper: runHelper,
				parallel: async () => [],
				agent: async (call: AgentCall) => {
					if (call.agent === "code-reviewer") {
						codeReviewCalls += 1;
						if (codeReviewCalls <= 2) {
							return { text: "", control: { title: "Review", date: "2026-08-02", verdict: "Changes Requested", summary: "same issue", findings: [{ id: "F-1", severity: "High", title: "Fix me", detail: "still present", file: "src/a.ts" }] } };
						}
						return { text: "", control: { title: "Review", date: "2026-08-02", verdict: "Approved", summary: "fixed", findings: [] } };
					}
					if (call.agent === "adversarial-reviewer") {
						return { text: "", control: { title: "Adversarial", date: "2026-08-02", verdict: "PASS", summary: "ok", findings: [] } };
					}
					if (call.agent === "implementer") {
						fixCalls += 1;
						return { text: "", control: { filesCreated: [], filesModified: ["src/a.ts"], filesDeleted: [], fixesApplied: 1, summary: "fixed" } };
					}
					return { text: "", control: {} };
				},
			};

			await reviewStageNode.run(state, ctx);

			expect(fixCalls).toBe(2);
			expect(codeReviewCalls).toBe(3);
			expect(state.review?.verdict).toBe("Approved");
			expect(escalationCalls).toBe(0);
			expect((state as Record<string, unknown>).__stagnated).toBeUndefined();
			expect(logs.join("\n")).toContain("final safety re-review approved after stagnation");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
