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

describe("R-1 no-actionable shortcut (reviewLoopUntil)", () => {
	it("breaks for human decision when nothing is actionable, build green, not approved", async () => {
		const s = {
			review: {
				verdict: "Changes Requested",
				findings: [],
				deferredFindings: [{ id: "D1", severity: "low", title: "advisory", deferralReason: "advisory (non-blocking, below high)" }],
			},
			buildGate: { pass: true, ran: [], errors: [] },
		} as unknown as PipelineState;
		const logs: string[] = [];
		const ctx = { log: (m: string) => logs.push(m), task: "", options: {}, state: {} as PipelineState } as unknown as StageContext;
		expect(await reviewLoopUntil(s, ctx)).toBe(true);
		const stag = (s as Record<string, unknown>).__stagnated as { findings?: Array<{ title?: string }> };
		expect(stag?.findings?.[0]?.title).toContain("[deferred:");
		expect(logs.join("\n")).toContain("no actionable findings remain");
	});

	it("does NOT shortcut when build gate is red (implementer still has work)", async () => {
		const s = {
			review: {
				verdict: "Changes Requested",
				findings: [],
				deferredFindings: [{ id: "D1", severity: "low", title: "advisory", deferralReason: "advisory (non-blocking, below high)" }],
			},
			buildGate: { pass: false, ran: ["npm test"], errors: ["boom"] },
		} as unknown as PipelineState;
		expect(await reviewLoopUntil(s, fakeCtx())).toBe(false);
	});

	it("keeps the legacy empty-finding behavior when buildGate is unset", async () => {
		const s = stateWith({ verdict: "Changes Requested", findings: [] });
		expect(await reviewLoopUntil(s, fakeCtx())).toBe(false);
	});
});

describe("R-1 fix routing through the full review loop", () => {
	it("advisory-only rounds never spawn the implementer; blocking findings do", async () => {
		const root = mkdtempSync(join(tmpdir(), "sd-review-r1-"));
		try {
			const specDirectory = join(root, "docs", "specifications", "01-r1") + "/";
			mkdirSync(specDirectory, { recursive: true });
			writeFileSync(join(specDirectory, "06-specification.md"), "# Specification\n");
			const state: PipelineState = {
				setup: {
					worktreePath: root,
					specDirectory,
					defaultBranch: "main",
					language: "frontend",
					isWebUi: true,
					specIdentifier: "01-r1",
					worktreeCreated: false,
					initializedRepo: false,
				},
				classify: { taskType: "feature", uiScope: "ui+arch", language: "frontend", isWebUi: true },
				spec: { specificationPath: join(specDirectory, "06-specification.md") },
				implementation: { phasesCompleted: 1, totalPhases: 1, allGreen: true },
			};
			let reviewCalls = 0;
			let fixCalls = 0;
			let escalationCalls = 0;
			const prompts: string[] = [];
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
						reviewCalls += 1;
						if (reviewCalls === 1) {
							// Round 1: one actionable blocking finding + one advisory.
							return { text: "", control: { title: "Review", date: "2026-08-15", verdict: "Changes Requested", summary: "mixed", findings: [
								{ id: "B1", severity: "high", title: "Blocking bug", detail: "must fix", file: "src/a.ts", blocking: true },
								{ id: "A1", severity: "low", title: "Style nit", detail: "advisory", file: "src/b.ts", blocking: false },
							] } };
						}
						// Round 2+: blocking bug fixed; the remaining finding is a
						// needs-human blocking concern — kept in the deferred ledger by
						// triage while the RAW verdict stays Changes Requested (C-5 keeps
						// it pinned on an open blocking finding), so the loop reaches the
						// no-actionable break → human escalation.
						return { text: "", control: { title: "Review", date: "2026-08-15", verdict: "Changes Requested", summary: "needs human", findings: [
							{ id: "H1", severity: "high", title: "Unproven concern", detail: "needs human verification", file: "src/c.ts", blocking: true, status: "needs-human" },
						] } };
					}
					if (call.agent === "adversarial-reviewer") {
						return { text: "", control: { title: "Adversarial", date: "2026-08-15", verdict: "PASS", summary: "ok", findings: [] } };
					}
					if (call.agent === "implementer") {
						fixCalls += 1;
						prompts.push(call.prompt ?? "");
						return { text: "", control: { filesCreated: [], filesModified: ["src/a.ts"], filesDeleted: [], fixesApplied: 1, summary: "fixed" } };
					}
					return { text: "", control: {} };
				},
			};

			await reviewStageNode.run(state, ctx);

			// Round 1's fix round ran ONCE (blocking finding) and its prompt carried
			// ONLY the actionable finding — the advisory nit must not be in it.
			expect(fixCalls).toBe(1);
			expect(prompts[0]).toContain("Blocking bug");
			expect(prompts[0]).not.toContain("Style nit");
			// The advisory-only follow-up round: verdict CR but no actionable work →
			// escalation, never a second implementer round.
			expect(escalationCalls).toBe(1);
			expect(logs.join("\n")).toContain("no actionable findings remain");
			const review = state.review as { deferredFindings?: Array<{ id?: string }> };
			expect(review?.deferredFindings?.some((f) => f.id === "H1")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
