/**
 * Root-cause regression guard for the verify-loop DEADLOCK observed in run
 * 2026-08-10T10-54-20-663Z (only 1/3 phases implemented).
 *
 * First-principles failure: the RED author (`tdd-guide`, driven by
 * `buildTddPrompt`) is graded by the deterministic deliverable gate on
 * `phase.deliverables.requireTests` — exact test-NAME strings — but the prompt
 * never told it those names. So it named `it(...)`/`test(...)` cases freely, the
 * gate reported `missing test: <name>` every attempt, and the only agent allowed
 * to add tests later (the implementer) was FORBIDDEN from touching RED files
 * (`tdd-tests-modified-during-green`). Two gates, mutually unsatisfiable →
 * `no-progress` → phase failed → later phases never ran.
 *
 * The fix: surface the exact `requireTests` (and `requireFiles`) contract in the
 * RED prompt so the author produces the required names UP FRONT
 * (context-over-procedure, per arXiv:2603.17973 "TDD prompting paradox").
 *
 * These assertions lock that in: the required test names MUST appear verbatim in
 * the RED prompt, and a phase with no deliverables MUST render unchanged.
 */
import { describe, it, expect } from "vitest";
import { buildTddPrompt, buildImplementPrompt } from "../src/prompts.ts";
import type { SetupControl } from "../src/types.ts";

function mkSetup(language = "frontend"): SetupControl {
	return {
		worktreePath: "/tmp/repo",
		specDirectory: "/tmp/repo/specs/",
		defaultBranch: "main",
		language,
		isWebUi: false,
		specIdentifier: "deadlock-guard",
		worktreeCreated: true,
		initializedRepo: false,
	};
}

const REQUIRED_TESTS = [
	"redirects protected route when non-secure session_data is expired",
	"does not synthesize session success from stale session_token",
];

describe("buildTddPrompt surfaces the requireTests deliverable contract (deadlock root-cause fix)", () => {
	it("renders every requireTests name verbatim so the RED author produces the exact graded names", () => {
		const phase = {
			name: "Phase 2 - Frontend stale-cookie guards",
			description: "BFF public-route compatibility",
			deliverables: { requireTests: REQUIRED_TESTS, requireFiles: ["frontend/proxy.ts"] },
		};
		const out = buildTddPrompt(mkSetup(), null, phase, null);
		expect(out).toContain("## Required Deliverables");
		for (const name of REQUIRED_TESTS) expect(out).toContain(name);
		// requireFiles are surfaced too so the tests land in the graded file.
		expect(out).toContain("frontend/proxy.ts");
		// The author is explicitly told the implementer cannot add these later.
		expect(out).toContain("FORBIDDEN");
	});

	it("omits the Required Deliverables block entirely when a phase declares no deliverables (backward compat)", () => {
		const phase = { name: "Phase A", description: "no contract" };
		const out = buildTddPrompt(mkSetup(), null, phase, null);
		expect(out).not.toContain("## Required Deliverables");
	});

	it("ignores a deliverables object with no requireTests/requireFiles", () => {
		const phase = {
			name: "Phase B",
			description: "only a not-contains guard",
			deliverables: { requireNotContains: [{ file: "x.ts", pattern: "TODO" }] },
		};
		const out = buildTddPrompt(mkSetup(), null, phase, null);
		expect(out).not.toContain("## Required Deliverables");
	});
});

describe("buildImplementPrompt surfaces gradeable deliverables up front (gate-criteria-in-prompt invariant)", () => {
	it("renders requireFiles + requireContains so the implementer sees the gate criteria on attempt 1", () => {
		const phase = {
			name: "Phase 1",
			description: "wire it",
			deliverables: {
				requireFiles: ["auth-service/src/session-lifetime.ts"],
				requireContains: [{ file: "auth-service/src/auth.ts", pattern: "cookieCache" }],
			},
		};
		const out = buildImplementPrompt(mkSetup(), null, phase, null, null);
		expect(out).toContain("## Required Deliverables");
		expect(out).toContain("auth-service/src/session-lifetime.ts");
		expect(out).toContain("cookieCache in auth-service/src/auth.ts");
	});

	it("does NOT surface requireTests/requireScenarios to the implementer (RED author owns tests; implementer is forbidden from editing them)", () => {
		const phase = {
			name: "Phase 1",
			description: "wire it",
			deliverables: {
				requireFiles: ["src/x.ts"],
				requireTests: ["does the forbidden thing"],
				requireScenarios: ["SCENARIO-024"],
			},
		};
		const out = buildImplementPrompt(mkSetup(), null, phase, null, null);
		expect(out).toContain("src/x.ts");
		expect(out).not.toContain("does the forbidden thing");
		expect(out).not.toContain("SCENARIO-024");
	});

	it("omits the Required Deliverables block when a phase declares no file/pattern deliverables (backward compat)", () => {
		const out = buildImplementPrompt(mkSetup(), null, { name: "P", description: "d" }, null, null);
		expect(out).not.toContain("## Required Deliverables");
	});
});
