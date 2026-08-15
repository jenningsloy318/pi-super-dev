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
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
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

	it("never treats an empty-finding round as STAGNANT — but a repeated dead state (empty findings, no build driver, gate absent) breaks for the human boundary (liveness)", async () => {
		const s1 = stateWith({ verdict: "Changes Requested", findings: [] });
		await reviewLoopUntil(s1, fakeCtx());
		const s2 = stateWith({ verdict: "Changes Requested", findings: [] }, (s1 as unknown as Record<string, unknown>).__reviewSignatures as string[]);
		// R-5 companion liveness: after one full round with nothing actionable and
		// no build driver, the loop can never change state — breaking (true) is the
		// dead-state exit to HITL, distinct from signature stagnation.
		expect(await reviewLoopUntil(s2, fakeCtx())).toBe(true);
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

	it("cold start (no completed round yet) does NOT fire the dead-state break even with empty findings", async () => {
		const s = stateWith({ verdict: "Changes Requested", findings: [] });
		// sigHist empty → roundsCompleted 0 → the loop must run its first body.
		expect(await reviewLoopUntil(s, fakeCtx())).toBe(false);
	});
});

describe("R-1 fix routing through the full review loop", () => {
	it("advisory-only rounds never spawn the implementer; blocking findings do", async () => {
		const root = mkdtempSync(join(tmpdir(), "sd-review-r1-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
			writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
			writeFileSync(join(root, "src", "c.ts"), "export const c = 1;\n");
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

describe("R-2 tests/validation third review angle", () => {
	it("specDeclaresTestDeliverables keys on structured spec fields only", async () => {
		const { specDeclaresTestDeliverables } = await import("../src/stages/verify.ts");
		expect(specDeclaresTestDeliverables(null)).toBe(false);
		expect(specDeclaresTestDeliverables({})).toBe(false);
		expect(specDeclaresTestDeliverables({ phases: [{ name: "p" }] })).toBe(false);
		expect(specDeclaresTestDeliverables({ phases: [{ name: "p", deliverables: { requireTests: ["a.test.ts"] } }] })).toBe(true);
		expect(specDeclaresTestDeliverables({ phases: [{ name: "p", deliverables: { requireScenarios: ["SCENARIO-001"] } }] })).toBe(true);
		expect(specDeclaresTestDeliverables({ scenarioRefs: ["SCENARIO-001"] })).toBe(true);
	});

	it("third reviewer runs only when the spec declares test deliverables and joins the verdict", async () => {
		const root = mkdtempSync(join(tmpdir(), "sd-review-r2-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "a.test.ts"), "import { it } from \"vitest\";\nit(\"placeholder\", () => {});\n");
			const specDirectory = join(root, "docs", "specifications", "01-r2") + "/";
			mkdirSync(specDirectory, { recursive: true });
			writeFileSync(join(specDirectory, "06-specification.md"), "# Specification\n");
			const state: PipelineState = {
				setup: {
					worktreePath: root,
					specDirectory,
					defaultBranch: "main",
					language: "frontend",
					isWebUi: true,
					specIdentifier: "01-r2",
					worktreeCreated: false,
					initializedRepo: false,
				},
				classify: { taskType: "feature", uiScope: "ui+arch", language: "frontend", isWebUi: true },
				spec: {
					specificationPath: join(specDirectory, "06-specification.md"),
					scenarioRefs: ["SCENARIO-001"],
					phases: [{ name: "core", deliverables: { requireScenarios: ["SCENARIO-001"] } }],
				},
				implementation: { phasesCompleted: 1, totalPhases: 1, allGreen: true },
			};
			let testsReviewCalls = 0;
			let fixCalls = 0;
			const prompts: string[] = [];
			const ctx: StageContext = {
				task: "implement feature",
				options: {},
				state,
				budget: { check: () => true, spent: () => true, count: 0 },
				log: () => {},
				phase: () => {},
				events: new EventEmitter(),
				results: [],
				helper: runHelper,
				parallel: async () => [],
				agent: async (call: AgentCall) => {
					if (call.id === "pipeline.verify.tests-review") {
						testsReviewCalls += 1;
						prompts.push(call.prompt ?? "");
						return { text: "", control: { title: "Tests Review", date: "2026-08-15", verdict: "Changes Requested", summary: "scenario tag missing", findings: [
							{ id: "TR-1", severity: "high", title: "SCENARIO-001 not bound in tests", detail: "verbatim tag absent", file: "src/a.test.ts", blocking: true },
						] } };
					}
					if (call.agent === "code-reviewer") {
						return { text: "", control: { title: "Review", date: "2026-08-15", verdict: "Approved", summary: "ok", findings: [] } };
					}
					if (call.agent === "adversarial-reviewer") {
						return { text: "", control: { title: "Adversarial", date: "2026-08-15", verdict: "PASS", summary: "ok", findings: [] } };
					}
					if (call.agent === "implementer") {
						fixCalls += 1;
						return { text: "", control: { filesCreated: [], filesModified: ["src/a.test.ts"], filesDeleted: [], fixesApplied: 1, summary: "bound tag" } };
					}
					return { text: "", control: {} };
				},
			};

			// Round 1: both primary reviewers approve but the tests angle blocks on a
			// missing scenario binding → merged verdict must be Changes Requested.
			const { reviewStep } = await import("../src/stages/verify.ts");
			await reviewStep.run(state, ctx);
			expect(testsReviewCalls).toBe(1);
			expect(prompts[0]).toContain("TESTS AND VALIDATION");
			const review = state.review as { verdict?: string; findings?: Array<{ id?: string }> };
			expect(review?.verdict).toBe("Changes Requested");
			expect(review?.findings?.some((f) => f.id === "TR-1")).toBe(true);
			expect(fixCalls).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("R-2 third reviewer skip path", () => {
	it("never spawns the tests-reviewer when the spec declares no test deliverables", async () => {
		const root = mkdtempSync(join(tmpdir(), "sd-review-r2skip-"));
		try {
			const specDirectory = join(root, "docs", "specifications", "01-r2s") + "/";
			mkdirSync(specDirectory, { recursive: true });
			writeFileSync(join(specDirectory, "06-specification.md"), "# Specification\n");
			const state: PipelineState = {
				setup: {
					worktreePath: root,
					specDirectory,
					defaultBranch: "main",
					language: "frontend",
					isWebUi: true,
					specIdentifier: "01-r2s",
					worktreeCreated: false,
					initializedRepo: false,
				},
				classify: { taskType: "refactor", uiScope: "none", language: "frontend", isWebUi: false },
				spec: { specificationPath: join(specDirectory, "06-specification.md") },
				implementation: { phasesCompleted: 1, totalPhases: 1, allGreen: true },
			};
			const agentIds: string[] = [];
			const ctx: StageContext = {
				task: "chore",
				options: {},
				state,
				budget: { check: () => true, spent: () => true, count: 0 },
				log: () => {},
				phase: () => {},
				events: new EventEmitter(),
				results: [],
				helper: runHelper,
				parallel: async () => [],
				agent: async (call: AgentCall) => {
					agentIds.push(call.id);
					if (call.agent === "code-reviewer") return { text: "", control: { title: "Review", date: "2026-08-15", verdict: "Approved", summary: "ok", findings: [] } };
					if (call.agent === "adversarial-reviewer") return { text: "", control: { title: "Adversarial", date: "2026-08-15", verdict: "PASS", summary: "ok", findings: [] } };
					return { text: "", control: {} };
				},
			};
			const { reviewStep } = await import("../src/stages/verify.ts");
			await reviewStep.run(state, ctx);
			expect(agentIds).not.toContain("pipeline.verify.tests-review");
			expect((state.review as { verdict?: string }).verdict).toBe("Approved");
			expect((state as { testsReview?: unknown }).testsReview).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("R-5 finding location verification", () => {
	it("demotes fix-now findings citing nonexistent files to the ledger", async () => {
		const root = mkdtempSync(join(tmpdir(), "sd-review-r5-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "real.ts"), "export const x = 1;\n");
			const specDirectory = join(root, "docs", "specifications", "01-r5") + "/";
			mkdirSync(specDirectory, { recursive: true });
			writeFileSync(join(specDirectory, "06-specification.md"), "# Specification\n");
			const state: PipelineState = {
				setup: {
					worktreePath: root,
					specDirectory,
					defaultBranch: "main",
					language: "frontend",
					isWebUi: true,
					specIdentifier: "01-r5",
					worktreeCreated: false,
					initializedRepo: false,
				},
				classify: { taskType: "feature", uiScope: "ui+arch", language: "frontend", isWebUi: true },
				spec: { specificationPath: join(specDirectory, "06-specification.md") },
				implementation: { phasesCompleted: 1, totalPhases: 1, allGreen: true },
			};
			const ctx: StageContext = {
				task: "implement feature",
				options: {},
				state,
				budget: { check: () => true, spent: () => true, count: 0 },
				log: () => {},
				phase: () => {},
				events: new EventEmitter(),
				results: [],
				helper: runHelper,
				parallel: async () => [],
				agent: async (call: AgentCall) => {
					if (call.agent === "code-reviewer") {
						return { text: "", control: { title: "Review", date: "2026-08-15", verdict: "Changes Requested", summary: "two highs", findings: [
							{ id: "OK-1", severity: "high", title: "Real file issue", detail: "d", file: "src/real.ts", blocking: true },
							{ id: "GHOST-1", severity: "high", title: "Fabricated path", detail: "d", file: "src/does-not-exist.ts", blocking: true },
						] } };
					}
					if (call.agent === "adversarial-reviewer") {
						return { text: "", control: { title: "Adversarial", date: "2026-08-15", verdict: "PASS", summary: "ok", findings: [] } };
					}
					return { text: "", control: {} };
				},
			};
			const { reviewStep } = await import("../src/stages/verify.ts");
			await reviewStep.run(state, ctx);
			const review = state.review as { findings?: Array<{ id?: string }>; deferredFindings?: Array<{ id?: string; deferralReason?: string }> };
			expect(review?.findings?.map((f) => f.id)).toEqual(["OK-1"]);
			const ghost = review?.deferredFindings?.find((f) => f.id === "GHOST-1");
			expect(ghost?.deferralReason).toContain("unverifiable location");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
