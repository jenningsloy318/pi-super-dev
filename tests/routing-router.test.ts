/**
 * M1 routing vocabulary tests — tests/routing-router.test.ts
 * Pins the contracts of docs/requirements/routing-architecture-routeback.md
 * (M1): classification truth tables, budget arithmetic (MP2), journal types
 * (G3/MP4), RouteBackSignal propagation shape (G2), determinism (MP3).
 */
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_EDGE_BUDGET,
	RouteBackSignal,
	ROUTABLE_OWNER_STAGES,
	budgetFromJournal,
	classifyEscalationChoice,
	classifyFindingRoute,
	classifyJudgeRoute,
	consumeBudget,
	consumedBudget,
	deterministicClassify,
	edgeKey,
	isRoutableOwnerStage,
	isRouteBackSignal,
	remainingBudget,
	routeBackOrEscalate,
	stagePrecedes,
	type RoutingJournal,
} from "../src/routing/router.ts";
import { REPLAN_OWNER_STAGES } from "../src/replan/owners.ts";
import { JUDGE_ROUTES } from "../src/stages/judge.ts";
import type { EscalationChoice } from "../src/types.ts";
import { FatalAbort, isFatalAbort, sequence, task } from "../src/nodes.ts";
import type { PipelineState, Stage, StageContext } from "../src/types.ts";

describe("M1 routing vocabulary — escalation-choice classification", () => {
	it("maps today's four choices onto the enum (route-back is absent today — pinned)", () => {
		expect(classifyEscalationChoice("retry-with-guidance")).toBe("retry");
		expect(classifyEscalationChoice("revise-manually")).toBe("retry");
		expect(classifyEscalationChoice("accept-limitation")).toBe("accept-limitation");
		expect(classifyEscalationChoice("abandon")).toBe("abort");
		// THE incident gap: none of the four expresses route-back today.
		expect(
			["retry-with-guidance", "revise-manually", "accept-limitation", "abandon"].map(
				classifyEscalationChoice,
			),
		).not.toContain("route-back");
	});

	it("maps the M4 route-back choice and degrades unknowns to escalate", () => {
		expect(classifyEscalationChoice("route-back")).toBe("route-back");
		expect(classifyEscalationChoice("something-new")).toBe("escalate");
	});
});

describe("M1 routing vocabulary — judge-route classification (all 8 current routes)", () => {
	it("maps every JUDGE_ROUTES member deterministically", () => {
		expect(classifyJudgeRoute("re-author-tests")).toBe("retry");
		expect(classifyJudgeRoute("challenge-test")).toBe("retry");
		expect(classifyJudgeRoute("implementer-retry")).toBe("retry");
		expect(classifyJudgeRoute("replan-upstream")).toBe("route-back");
		expect(classifyJudgeRoute("fix-environment")).toBe("escalate");
		expect(classifyJudgeRoute("allow-scaffold")).toBe("continue");
		expect(classifyJudgeRoute("continue")).toBe("continue");
		expect(classifyJudgeRoute("escalate-now")).toBe("escalate");
		expect(classifyJudgeRoute("unknown-route")).toBe("escalate");
	});
});

describe("M1 routing vocabulary — finding classification", () => {
	it("blocking + upstream routable owner → route-back with the owner as destination", () => {
		const r = classifyFindingRoute(
			{ id: "F-001", ownerStage: "requirements", blocking: true, status: "open", severity: "P1" },
			"bdd",
		);
		expect(r).toEqual({ action: "route-back", to: "requirements", findingId: "F-001" });
	});

	it("the incident shape: needs-human does NOT defeat an upstream-owned blocker", () => {
		// run 2026-08-21T03-23-47: needs-human status made the old path non-routable.
		const r = classifyFindingRoute(
			{ id: "F-001", ownerStage: "requirements", blocking: true, status: "needs-human", severity: "P1" },
			"bdd",
		);
		expect(r.action).toBe("route-back");
	});

	it("blocking + own stage (or fixer-domain/downstream owner) → retry, never route-back", () => {
		expect(
			classifyFindingRoute({ id: "B-1", ownerStage: "bdd", blocking: true }, "bdd").action,
		).toBe("retry");
		// implementation is NOT in the routable owner set → same-stage retry.
		expect(
			classifyFindingRoute({ id: "I-1", ownerStage: "implementation", blocking: true }, "verify").action,
		).toBe("retry");
		// a DOWNSTREAM routable owner is not a back-edge (F-2): spec-owned seen at bdd → retry.
		expect(
			classifyFindingRoute({ id: "D-1", ownerStage: "spec", blocking: true }, "bdd").action,
		).toBe("retry");
		// environment-owned blockers are same-stage product work, never a jump (F-2).
		expect(
			classifyFindingRoute({ id: "E-1", ownerStage: "environment", blocking: true }, "spec").action,
		).toBe("retry");
	});

	it("non-blocking needs-human + high severity → escalate; plain advisories → continue", () => {
		expect(
			classifyFindingRoute({ id: "N-1", blocking: false, status: "needs-human", severity: "critical" }, "bdd"),
		).toEqual({ action: "escalate", findingId: "N-1", escalationKind: "needs-human" });
		expect(classifyFindingRoute({ id: "A-1", blocking: false, severity: "low" }, "bdd")).toEqual({
			action: "continue",
			findingId: "A-1",
		});
	});

	it("routable owner set IS the imported REPLAN_OWNER_STAGES (drift-impossible)", () => {
		expect([...ROUTABLE_OWNER_STAGES]).toEqual([...REPLAN_OWNER_STAGES]);
		expect(isRoutableOwnerStage("requirements")).toBe(true);
		expect(isRoutableOwnerStage("spec")).toBe(true);
		expect(isRoutableOwnerStage("implementation")).toBe(false);
		expect(isRoutableOwnerStage("verify")).toBe(false);
		expect(isRoutableOwnerStage("draft")).toBe(false); // phantom member removed (review F-1)
	});

	it("stagePrecedes verifies skeleton order — downstream owners are NOT upstream (F-2)", () => {
		expect(stagePrecedes("requirements", "bdd")).toBe(true);
		expect(stagePrecedes("design", "spec")).toBe(true);
		expect(stagePrecedes("spec", "requirements")).toBe(false); // downstream — no back-edge
		expect(stagePrecedes("bdd", "bdd")).toBe(false); // equal
		expect(stagePrecedes("not-a-stage", "bdd")).toBe(false); // unknown — safe direction
	});
});

describe("M1 budget (MP2 — persisted-state arithmetic, pure)", () => {
	it("starts at the default cap and decrements immutably", () => {
		const empty = { edges: {} };
		expect(remainingBudget(empty, "bdd", "requirements")).toBe(DEFAULT_EDGE_BUDGET);
		const one = consumeBudget(empty, "bdd", "requirements");
		expect(remainingBudget(one, "bdd", "requirements")).toBe(DEFAULT_EDGE_BUDGET - 1);
		expect(consumedBudget(one, "bdd", "requirements")).toBe(1);
		// purity: the original state is untouched.
		expect(consumedBudget(empty, "bdd", "requirements")).toBe(0);
		// other edges are unaffected.
		expect(remainingBudget(one, "spec", "requirements")).toBe(DEFAULT_EDGE_BUDGET);
	});

	it("hydrates from a journal — the persisted source of truth", () => {
		const journal: RoutingJournal = {
			entries: [
				{
					seq: 1,
					kind: "route-back",
					from: "bdd",
					to: "requirements",
					reason: "r1",
					findingIds: ["F-001"],
					resumeFromIndex: 2,
					invalidated: ["requirements", "bdd"],
					budgetBefore: 2,
					budgetAfter: 1,
					at: "2026-08-21T00:00:00Z",
				},
				{
					seq: 2,
					kind: "route-back",
					from: "bdd",
					to: "requirements",
					reason: "r2",
					findingIds: ["F-002"],
					resumeFromIndex: 2,
					invalidated: ["requirements", "bdd"],
					budgetBefore: 1,
					budgetAfter: 0,
					at: "2026-08-21T00:01:00Z",
				},
			],
		};
		const budget = budgetFromJournal(journal);
		expect(remainingBudget(budget, "bdd", "requirements")).toBe(0);
	});
});

describe("M1 routeBackOrEscalate — budget-gated jump", () => {
	it("grants a route-back with the downstream invalidation set (G3)", () => {
		const cmd = routeBackOrEscalate("bdd", "requirements", "phantom AC-03 verdict field", ["F-001"], {
			edges: {},
		});
		expect(cmd.action).toBe("route-back");
		if (cmd.action === "route-back") {
			expect(cmd.to).toBe("requirements");
			expect(cmd.resumeFromIndex).toBe(-1); // walker fills it (M2)
			// edges.ts downstreamOf(requirements) includes bdd, spec, …
			expect(cmd.invalidated).toContain("requirements");
			expect(cmd.invalidated).toContain("bdd");
		}
	});

	it("degrades to escalate at budget exhaustion — never an unbounded back-edge", () => {
		const exhausted = { edges: { [edgeKey("bdd", "requirements")]: DEFAULT_EDGE_BUDGET } };
		const cmd = routeBackOrEscalate("bdd", "requirements", "again", ["F-9"], exhausted);
		expect(cmd.action).toBe("escalate");
		if (cmd.action === "escalate") {
			expect(cmd.escalationKind).toBe("budget-exhausted");
			expect(cmd.reason).toContain("edge budget exhausted");
		}
	});
});

describe("M1 drift pins — classification tables track the REAL vocabularies", () => {
	it("every JUDGE_ROUTES member has a pinned mapping (a new route breaks this snapshot)", () => {
		const map = Object.fromEntries(JUDGE_ROUTES.map((r) => [r, classifyJudgeRoute(r)]));
		expect(map).toEqual({
			"re-author-tests": "retry",
			"challenge-test": "retry",
			"fix-environment": "escalate",
			"implementer-retry": "retry",
			"replan-upstream": "route-back",
			"allow-scaffold": "continue",
			continue: "continue",
			"escalate-now": "escalate",
		});
	});

	it("every EscalationChoice member maps without hitting the default branch", () => {
		// Compile-time exhaustiveness: adding a 5th EscalationChoice member
		// fails tsc HERE first (Record<EscalationChoice, …> requires every key),
		// before the runtime pin below can drift (review N-3).
		const exhaustive: Record<EscalationChoice, string> = {
			"retry-with-guidance": classifyEscalationChoice("retry-with-guidance"),
			"revise-manually": classifyEscalationChoice("revise-manually"),
			"accept-limitation": classifyEscalationChoice("accept-limitation"),
			abandon: classifyEscalationChoice("abandon"),
		};
		expect(exhaustive).toEqual({
			"retry-with-guidance": "retry",
			"revise-manually": "retry",
			"accept-limitation": "accept-limitation",
			abandon: "abort",
		});
	});
});

describe("M1 RouteBackSignal (G2 — FatalAbort subclass)", () => {
	it("propagates through task() and a TOLERANT sequence — actually executed", async () => {
		const cmd = routeBackOrEscalate("bdd", "requirements", "test", [], { edges: {} });
		if (cmd.action !== "route-back") throw new Error("unreachable");
		const signal = new RouteBackSignal(cmd);
		expect(signal instanceof FatalAbort).toBe(true);
		expect(isFatalAbort(signal)).toBe(true);
		expect(isRouteBackSignal(signal)).toBe(true);
		expect(isRouteBackSignal(new FatalAbort("plain"))).toBe(false);
		expect(signal.command.to).toBe("requirements");
		expect(signal.message).toContain("ROUTE-BACK bdd→requirements");

		// REAL combinator execution (review F-3/F-4): a stage that throws the
		// signal inside task() must surface OUT of a tolerant sequence.
		const throwingStage: Stage = {
			id: "thrower",
			label: "thrower",
			async run() {
				throw signal;
			},
		};
		const ctx = {
			task: "",
			options: {},
			state: {},
			results: [] as Array<{ id: string; status: string }>,
			events: { emit() {} } as unknown as StageContext["events"],
			budget: { count: 0, check: () => true, spent() { return true; } },
			log() {},
			auditAppend() {},
			withScope: <T, >(_s: string, fn: () => Promise<T>) => fn(),
			async agent() { throw new Error("no agent"); },
			async helper() { throw new Error("no helper"); },
			async parallel<T>(calls: Array<() => Promise<T>>) { return Promise.all(calls.map((c) => c())); },
		} as unknown as StageContext;
		const tolerant = sequence([task(throwingStage)], { tolerant: true });
		await expect(tolerant.run({} as PipelineState, ctx)).rejects.toSatisfy(
			(e: unknown) => isRouteBackSignal(e),
		);
	});
});

describe("M1 determinism contract (MP3)", () => {
	it("classification is referentially transparent — same input, same output", () => {
		const finding = {
			id: "F-003",
			ownerStage: "design",
			blocking: true,
			status: "open",
			severity: "high",
		} as const;
		const check = deterministicClassify(() => classifyFindingRoute(finding, "spec"));
		expect(check.stable).toBe(true);
		expect(check.first).toEqual(check.second);
	});

	it("budget arithmetic never mints time or randomness (pure JSON state)", () => {
		const a = consumeBudget(consumeBudget({ edges: {} }, "spec", "design"), "spec", "design");
		const b = consumeBudget(consumeBudget({ edges: {} }, "spec", "design"), "spec", "design");
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(a).toEqual(b);
	});
});

describe("M1 gate() RouteBackSignal guard (round-2 N-2)", () => {
	it("a RouteBackSignal escaping the gate escalation block is re-thrown, never swallowed", async () => {
		vi.mock("../src/escalation.ts", () => ({
			runEscalation: async () => {
				throw new RouteBackSignal(
					routeBackOrEscalate("bdd", "requirements", "guard test", [], { edges: {} }) as import("../src/routing/router.ts").RouteBackCommand & { action: "route-back" },
				);
			},
			applyRetryDecision: () => {},
		}));
		const { gate } = await import("../src/nodes.ts");
		const failing: Stage = {
			id: "g",
			label: "g",
			async run() {
				throw new Error("stage failed");
			},
		};
		const ctx = {
			task: "",
			options: { escalate: (() => undefined) as unknown as StageContext["options"]["escalate"] },
			state: {},
			results: [] as Array<{ id: string; status: string }>,
			events: { emit() {} } as unknown as StageContext["events"],
			budget: { count: 0, check: () => true, spent() { return true; } },
			log() {},
			auditAppend() {},
			withScope: <T, >(_s: string, fn: () => Promise<T>) => fn(),
			async agent() { throw new Error("no agent"); },
			async helper() { throw new Error("no helper"); },
			async parallel<T>(calls: Array<() => Promise<T>>) { return Promise.all(calls.map((c) => c())); },
		} as unknown as StageContext;
		const g = gate({ attempts: 1, validate: () => Promise.resolve({ pass: false, errors: ["x"] }), fatal: true, feedbackKey: "bdd" }, task(failing));
		await expect(g.run({} as PipelineState, ctx)).rejects.toSatisfy((e: unknown) =>
			e instanceof Error && e.name === "RouteBackSignal",
		);
		vi.resetModules();
	});
});
