import { describe, expect, it } from "vitest";
import { redBoundaryResultFromAgent } from "../src/test-artifacts.ts";

// ─── v0.3.24 S4-1 ─────────────────────────────────────────────────────────────
// Run 2026-08-28T12-51-40-028Z (AnkiQuick, spec 17): three textbook-valid REDs
// were reverted as red-polluted because the red-boundary classifier agent
// echoed ABSOLUTE worktree paths while the harness looks up relative git-status
// paths — the exact-match byPath lookup missed every hit and fell to
// decision(path,"ambiguous",false,0,"fallback","evaluator omitted this path").
// The scaffold vocabulary and prompt were correct; the plumbing dropped the
// verdict on the floor. These tests pin suffix-tolerant matching.

describe("S4-1 redBoundaryResultFromAgent path matching", () => {
	const abs = "/home/dev/AnkiQuick/.worktree/17-x/app/src/main/java/dev/example/export/ExportFieldResolver.kt";
	const rel = "app/src/main/java/dev/example/export/ExportFieldResolver.kt";
	const testRel = "app/src/test/java/dev/example/export/ExportFieldResolverTest.kt";

	it("an absolute-path echo of a relative requested path is matched (source=agent, not fallback)", () => {
		const result = redBoundaryResultFromAgent([rel], {
			classifications: [{ path: abs, category: "scaffold", confidence: 0.9, reason: "declaration-only; error() stubs" }],
			allAllowed: true,
		});
		const scaffold = result.classifications.find((c) => c.path === rel);
		expect(scaffold).toBeDefined();
		expect(scaffold?.source).toBe("agent");
		expect(scaffold?.allowed).toBe(true);
		expect(scaffold?.category).toBe("scaffold");
		expect(result.forbiddenFiles).toEqual([]);
	});

	it("a './'-prefixed echo of a clean requested path is matched", () => {
		const result = redBoundaryResultFromAgent([testRel], {
			classifications: [{ path: `./${testRel}`, category: "test", confidence: 0.95, reason: "JUnit test file" }],
			allAllowed: true,
		});
		const test = result.classifications.find((c) => c.path === testRel);
		expect(test?.source).toBe("agent");
		expect(test?.allowed).toBe(true);
	});

	it("a basename-only echo is matched only when UNAMBIGUOUS (two same-basename candidates stay fallback)", () => {
		const result = redBoundaryResultFromAgent(["ExportFieldResolver.kt"], {
			classifications: [
				{ path: "app/src/main/java/a/ExportFieldResolver.kt", category: "scaffold", confidence: 0.9, reason: "stub" },
				{ path: "app/src/main/java/b/ExportFieldResolver.kt", category: "production", confidence: 0.9, reason: "behavior" },
			],
			allAllowed: false,
		});
		const row = result.classifications.find((c) => c.path === "ExportFieldResolver.kt");
		expect(row?.source).toBe("fallback"); // ambiguous → conservative deny, agent consulted next time with clearer paths
		expect(row?.allowed).toBe(false);
	});

	it("explicit forbiddenFiles with absolute echoes still pin production through suffix resolution", () => {
		const result = redBoundaryResultFromAgent([rel], {
			classifications: [{ path: abs, category: "scaffold", confidence: 0.9, reason: "stub" }],
			forbiddenFiles: [abs],
			allAllowed: false,
		});
		const row = result.classifications.find((c) => c.path === rel);
		expect(row?.category).toBe("production");
		expect(row?.allowed).toBe(false);
		expect(result.forbiddenFiles).toContain(rel);
	});

	it("a request the evaluator truly omitted still falls back (unmatched, no suffix fit)", () => {
		const result = redBoundaryResultFromAgent(["some/other/Path.kt"], {
			classifications: [{ path: abs, category: "scaffold", confidence: 0.9, reason: "stub" }],
			allAllowed: true,
		});
		const row = result.classifications.find((c) => c.path === "some/other/Path.kt");
		expect(row?.source).toBe("fallback");
		expect(row?.allowed).toBe(false);
	});
});
