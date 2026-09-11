import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * v0.3.87 (S4 decisions 8/9/10) — config-driven tool-call budgets
 * (commonToolBudget + agentToolBudget), resolved onto the native pi-subagents
 * `toolBudget { soft, hard, block }` registration field. Pins:
 *  - the resolution chain agentToolBudget[role] > commonToolBudget > none
 *    (absent config → NO budget sent; caps strictly opt-in);
 *  - bare + `sd-`-prefixed agentToolBudget keys (bare wins when both exist);
 *  - the loud per-key WARN + treated-as-absent fallback for malformed values
 *    and containers (v0.3.78 contract — NEVER throws, one warn per key);
 *  - the fixed five-family external-exploration block list, never "*";
 *  - the mechanical-classifier exemption (NEVER a budget, even explicit);
 *  - the research-assist CONFIG-ROLE-KEY fallback chain (§13: the assist
 *    dispatch reuses research-agent — no agent file exists).
 */

const getConfigImpl: { impl: () => Record<string, unknown> } = { impl: () => { throw new Error("not wired"); } };
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	return { ...real, getConfig: () => getConfigImpl.impl() };
});

import { EXTERNAL_EXPLORATION_BLOCK_LIST, resetConfigExtensionWarnsForTests, resolveToolBudget } from "../src/agents/agent-runtime.ts";
import { MECHANICAL_CLASSIFIER_ROLES } from "../src/agents/skill-domains.ts";

describe("v0.3.87 — resolveToolBudget resolution chain", () => {
	let warns: string[];
	const warn = (m: string) => warns.push(m);

	beforeEach(() => {
		warns = [];
		resetConfigExtensionWarnsForTests();
		getConfigImpl.impl = () => ({});
	});

	it("absent config → NO budget (caps are strictly opt-in; no toolBudget is sent)", () => {
		expect(resolveToolBudget("implementer", { warn })).toBeUndefined();
		expect(resolveToolBudget("research-agent", { warn })).toBeUndefined();
		expect(warns).toEqual([]);
	});

	it("agentToolBudget[role] beats commonToolBudget; common applies to every other capability role", () => {
		const config = { commonToolBudget: { soft: 2, hard: 4 }, agentToolBudget: { implementer: { soft: 8, hard: 15 } } };
		expect(resolveToolBudget("implementer", { config, warn })).toEqual({ soft: 8, hard: 15, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
		expect(resolveToolBudget("code-reviewer", { config, warn })).toEqual({ soft: 2, hard: 4, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
		expect(resolveToolBudget("research-agent", { config, warn })).toEqual({ soft: 2, hard: 4, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
	});

	it("valid values parse as-is (soft === hard allowed; positive integers)", () => {
		expect(resolveToolBudget("spec-reviewer", { config: { commonToolBudget: { soft: 3, hard: 3 } }, warn })).toEqual({ soft: 3, hard: 3, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
	});

	it("sd--prefixed agentToolBudget keys accepted; bare key wins when both are present", () => {
		const both = { agentToolBudget: { implementer: { soft: 8, hard: 15 }, "sd-implementer": { soft: 99, hard: 99 } } };
		expect(resolveToolBudget("implementer", { config: both, warn })).toEqual({ soft: 8, hard: 15, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
		const prefixedOnly = { agentToolBudget: { "sd-ui-tester": { soft: 5, hard: 9 } } };
		expect(resolveToolBudget("ui-tester", { config: prefixedOnly, warn })).toEqual({ soft: 5, hard: 9, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
	});

	it("config read failure degrades to no budget — never throws", () => {
		getConfigImpl.impl = () => { throw new Error("config unreadable"); };
		expect(() => resolveToolBudget("implementer", { warn })).not.toThrow();
		expect(resolveToolBudget("implementer", { warn })).toBeUndefined();
	});
});

describe("v0.3.87 — malformed values: loud per-key WARN + treated as absent", () => {
	let warns: string[];
	const warn = (m: string) => warns.push(m);

	beforeEach(() => {
		warns = [];
		resetConfigExtensionWarnsForTests();
		getConfigImpl.impl = () => ({});
	});

	it("malformed commonToolBudget values (wrong type, missing key, string number, soft > hard, extra keys) → undefined + exactly ONE warn naming the key", () => {
		for (const bad of [42, "8/15", { soft: 8 }, { soft: "8", hard: 15 }, { soft: 15, hard: 8 }, { soft: 8, hard: 15, block: ["*"] }, { soft: 0, hard: 4 }, { soft: 1.5, hard: 4 }, [8, 15]]) {
			warns.length = 0;
			resetConfigExtensionWarnsForTests();
			expect(resolveToolBudget("code-reviewer", { config: { commonToolBudget: bad }, warn }), JSON.stringify(bad)).toBeUndefined();
			expect(warns, JSON.stringify(bad)).toHaveLength(1);
			expect(warns[0], JSON.stringify(bad)).toContain('"commonToolBudget"');
		}
	});

	it("a stray block key in config is malformed, not a silent no-op (the block list is fixed discipline, never policy input)", () => {
		expect(resolveToolBudget("implementer", { config: { commonToolBudget: { soft: 2, hard: 4, block: ["read"] } }, warn })).toBeUndefined();
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("no other keys");
	});

	it("malformed per-role value warns once naming agentToolBudget[role] and falls THROUGH to common", () => {
		const config = { commonToolBudget: { soft: 2, hard: 4 }, agentToolBudget: { implementer: 7 } };
		expect(resolveToolBudget("implementer", { config, warn })).toEqual({ soft: 2, hard: 4, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("agentToolBudget[implementer]");
	});

	it("malformed agentToolBudget CONTAINER (non-object) warns once and is treated as absent", () => {
		const config = { commonToolBudget: { soft: 2, hard: 4 }, agentToolBudget: "nope" };
		expect(resolveToolBudget("code-reviewer", { config, warn })).toEqual({ soft: 2, hard: 4, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain('"agentToolBudget" must be an object');
	});

	it("one warn per key across repeated calls (shared memo, v0.3.78 convention)", () => {
		const config = { commonToolBudget: { soft: "2", hard: 4 } };
		expect(resolveToolBudget("implementer", { config, warn })).toBeUndefined();
		expect(resolveToolBudget("tdd-guide", { config, warn })).toBeUndefined();
		expect(warns.filter((w) => w.includes("commonToolBudget"))).toHaveLength(1);
	});

	it("null values are the documented opt-out — no warn", () => {
		expect(resolveToolBudget("implementer", { config: { commonToolBudget: null, agentToolBudget: null }, warn })).toBeUndefined();
		expect(warns).toEqual([]);
	});
});

describe("v0.3.87 — the block list: five external-exploration families, never \"*\"", () => {
	beforeEach(() => {
		resetConfigExtensionWarnsForTests();
	});

	it("EXTERNAL_EXPLORATION_BLOCK_LIST is exactly the five families (mcp carries the exact-name + prefix pair)", () => {
		expect([...EXTERNAL_EXPLORATION_BLOCK_LIST]).toEqual(["web_search", "fetch_content", "get_search_content", "source_check", "mcp", "mcp__"]);
	});

	it("every resolved budget carries the block list — never \"*\" and never a local coding tool", () => {
		const budget = resolveToolBudget("implementer", { config: { commonToolBudget: { soft: 8, hard: 15 } } });
		expect(budget?.block).toEqual([...EXTERNAL_EXPLORATION_BLOCK_LIST]);
		expect(budget?.block).not.toContain("*");
		for (const localTool of ["read", "grep", "find", "ls", "bash", "edit", "write", "lsp_diagnostics", "recall", "powershell"]) {
			expect(budget?.block, localTool).not.toContain(localTool);
		}
	});

	it("block holds under per-role resolution too (no escape hatch via config values)", () => {
		const budget = resolveToolBudget("research-agent", { config: { agentToolBudget: { "research-agent": { soft: 30, hard: 100 } } } });
		expect(budget).toEqual({ soft: 30, hard: 100, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
	});
});

describe("v0.3.87 — mechanical classifiers NEVER get a toolBudget", () => {
	beforeEach(() => {
		resetConfigExtensionWarnsForTests();
	});

	it("exempt even with BOTH an explicit per-role entry and a common budget (firmer than the extensions scope predicate)", () => {
		const config = {
			commonToolBudget: { soft: 2, hard: 4 },
			agentToolBudget: {
				"task-classifier": { soft: 50, hard: 50 },
				judge: { soft: 50, hard: 50 },
				"tdd-coverage-classifier": { soft: 50, hard: 50 },
				"red-boundary-classifier": { soft: 50, hard: 50 },
			},
		};
		for (const role of MECHANICAL_CLASSIFIER_ROLES) {
			expect(resolveToolBudget(role, { config }), role).toBeUndefined();
		}
	});

	it("the exemption covers the full classifier set from the decision (4 roles)", () => {
		expect([...MECHANICAL_CLASSIFIER_ROLES].sort()).toEqual(["judge", "red-boundary-classifier", "task-classifier", "tdd-coverage-classifier"]);
	});
});

describe("v0.3.87 — research-assist CONFIG ROLE KEY fallback chain (§13 / decisions 9+10)", () => {
	let warns: string[];
	const warn = (m: string) => warns.push(m);

	beforeEach(() => {
		warns = [];
		resetConfigExtensionWarnsForTests();
	});

	it("chain: agentToolBudget[\"research-assist\"] > agentToolBudget[\"research-agent\"] > commonToolBudget > none", () => {
		const all = { commonToolBudget: { soft: 2, hard: 4 }, agentToolBudget: { "research-agent": { soft: 30, hard: 100 }, "research-assist": { soft: 6, hard: 20 } } };
		expect(resolveToolBudget("research-assist", { config: all, warn })).toEqual({ soft: 6, hard: 20, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });

		const noAssist = { commonToolBudget: { soft: 2, hard: 4 }, agentToolBudget: { "research-agent": { soft: 30, hard: 100 } } };
		expect(resolveToolBudget("research-assist", { config: noAssist, warn })).toEqual({ soft: 30, hard: 100, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });

		const commonOnly = { commonToolBudget: { soft: 2, hard: 4 } };
		expect(resolveToolBudget("research-assist", { config: commonOnly, warn })).toEqual({ soft: 2, hard: 4, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });

		expect(resolveToolBudget("research-assist", { config: {}, warn })).toBeUndefined();
	});

	it("the research-agent fallback leg accepts the sd--prefixed key too", () => {
		const config = { agentToolBudget: { "sd-research-agent": { soft: 30, hard: 100 } } };
		expect(resolveToolBudget("research-assist", { config, warn })).toEqual({ soft: 30, hard: 100, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
	});

	it("research-agent ITSELF resolves by its own key first (the fallback leg never pollutes the direct role)", () => {
		const config = { agentToolBudget: { "research-agent": { soft: 30, hard: 100 } } };
		expect(resolveToolBudget("research-agent", { config, warn })).toEqual({ soft: 30, hard: 100, block: [...EXTERNAL_EXPLORATION_BLOCK_LIST] });
	});
});
