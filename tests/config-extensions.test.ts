import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.3.78 — config-driven extension entries (commonExtensions +
 * agentExtensions), riding the additive subagentOnlyExtensions registration
 * channel. Scope decision (user 2026-09-08): commonExtensions load for every
 * CAPABILITY agent — mechanical one-shot classifiers (MECHANICAL_CLASSIFIER_
 * ROLES) are excluded; explicit agentExtensions[role] is honored for ANY role
 * (explicit config beats defaults). npm:-prefixed package names are
 * normalized. Missing packages degrade to absent with ONE warn per package
 * per process. Never throws (config unreadable → []).
 */

const getConfigImpl: { impl: () => Record<string, unknown> } = { impl: () => { throw new Error("not wired"); } };
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	return { ...real, getConfig: () => getConfigImpl.impl() };
});

import {
	buildToolIndex,
	buildToolIndexFromTools,
	configExtensionEntriesForAgent,
	configExtensionToolsForAgent,
	resetConfigExtensionWarnsForTests,
} from "../src/agents/agent-runtime.ts";
import { MECHANICAL_CLASSIFIER_ROLES } from "../src/agents/skill-domains.ts";

/** Fixture agent dir with two fake extension packages (manifest + entry) and
 *  no third. Mirrors pi's <agentDir>/npm/node_modules layout. */
function makeFixtureAgentDir(): string {
	const root = mkdtempSync(join(tmpdir(), "sd378-ext-"));
	for (const pkg of ["fake-mem", "fake-lsp"]) {
		const dir = join(root, "npm", "node_modules", pkg);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, pi: { extensions: ["./index.ts"] } }));
		writeFileSync(join(dir, "index.ts"), "export default () => {};\n");
	}
	return root;
}

describe("v0.3.78 — configExtensionEntriesForAgent", () => {
	let agentDir: string;
	let warns: string[];
	const warn = (m: string) => warns.push(m);

	beforeEach(() => {
		agentDir = makeFixtureAgentDir();
		warns = [];
		resetConfigExtensionWarnsForTests();
		getConfigImpl.impl = () => ({});
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("capability agent resolves commonExtensions entry paths (npm: prefix normalized)", () => {
		const entries = configExtensionEntriesForAgent("requirements-clarifier", {
			config: { commonExtensions: ["npm:fake-mem", "fake-lsp"] },
			agentDir,
			warn,
		});
		expect(entries).toEqual([join(agentDir, "npm", "node_modules", "fake-mem", "index.ts"), join(agentDir, "npm", "node_modules", "fake-lsp", "index.ts")]);
		expect(warns).toEqual([]);
	});

	it("mechanical one-shot classifiers are excluded from commonExtensions (scope decision 2026-09-08)", () => {
		for (const role of MECHANICAL_CLASSIFIER_ROLES) {
			const entries = configExtensionEntriesForAgent(role, {
				config: { commonExtensions: ["fake-mem"] },
				agentDir,
				warn,
			});
			expect(entries, `role ${role}`).toEqual([]);
		}
	});

	it("explicit agentExtensions[role] is honored even for a mechanical role (explicit config beats scope defaults)", () => {
		const entries = configExtensionEntriesForAgent("task-classifier", {
			config: { commonExtensions: ["fake-mem"], agentExtensions: { "task-classifier": ["fake-lsp"] } },
			agentDir,
			warn,
		});
		expect(entries).toEqual([join(agentDir, "npm", "node_modules", "fake-lsp", "index.ts")]);
	});

	it("agentExtensions merge with commonExtensions for capability agents, deduplicated", () => {
		const entries = configExtensionEntriesForAgent("implementer", {
			config: { commonExtensions: ["fake-mem", "fake-mem"], agentExtensions: { implementer: ["fake-mem", "fake-lsp"] } },
			agentDir,
			warn,
		});
		expect(entries).toEqual([
			join(agentDir, "npm", "node_modules", "fake-mem", "index.ts"),
			join(agentDir, "npm", "node_modules", "fake-lsp", "index.ts"),
		]);
	});

	it("missing package degrades to absent with exactly ONE warn per package across calls", () => {
		const config = { commonExtensions: ["fake-absent", "fake-mem"] };
		const first = configExtensionEntriesForAgent("code-reviewer", { config, agentDir, warn });
		const second = configExtensionEntriesForAgent("adversarial-reviewer", { config, agentDir, warn });
		expect(first).toEqual([join(agentDir, "npm", "node_modules", "fake-mem", "index.ts")]);
		expect(second).toEqual(first);
		expect(warns.filter((w) => w.includes("fake-absent"))).toHaveLength(1);
		expect(warns[0]).toContain("pi install npm:fake-absent");
	});

	it("config read failure degrades to [] (never throws, role-hardcoded extensions unaffected)", () => {
		getConfigImpl.impl = () => { throw new Error("config unreadable"); };
		expect(() => configExtensionEntriesForAgent("implementer", { warn })).not.toThrow();
		expect(configExtensionEntriesForAgent("implementer", { warn })).toEqual([]);
	});
});

/** v0.3.78 review fixes (dual fresh-context 2026-09-08): malformed container
 *  values must NOT throw (crash path verified by both reviewers — a bad
 *  commonExtensions unregistered all capability agents); sd--prefixed
 *  agentExtensions keys accepted (name users see in pi listings);
 *  configExtensionToolsForAgent (adv-F1): config-declared extension tool
 *  names merged into the per-agent tools allowlist — pi-coding-agent filters
 *  extension tools not in `tools`, so hook-side value alone under-delivers
 *  the advertised lsp_* / recall tool capabilities. */
describe("v0.3.78 review fixes — container hardening + sd- keys", () => {
	let agentDir: string;
	let warns: string[];
	const warn = (m: string) => warns.push(m);

	beforeEach(() => {
		agentDir = makeFixtureAgentDir();
		warns = [];
		resetConfigExtensionWarnsForTests();
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("non-array commonExtensions (number) never throws → [] + one warn naming the key", () => {
		expect(() => configExtensionEntriesForAgent("implementer", { config: { commonExtensions: 42 }, agentDir, warn })).not.toThrow();
		expect(configExtensionEntriesForAgent("implementer", { config: { commonExtensions: 42 }, agentDir, warn })).toEqual([]);
		expect(warns.filter((w) => w.includes("commonExtensions"))).toHaveLength(1);
	});

	it("string commonExtensions (most plausible typo) does NOT degrade to per-character packages", () => {
		const entries = configExtensionEntriesForAgent("implementer", { config: { commonExtensions: "fake-mem" }, agentDir, warn });
		expect(entries).toEqual([]);
		expect(warns.some((w) => w.includes('package "f"'))).toBe(false);
		expect(warns.filter((w) => w.includes("commonExtensions"))).toHaveLength(1);
	});

	it("non-array agentExtensions[role] is guarded → perRole treated as []", () => {
		expect(() => configExtensionEntriesForAgent("implementer", { config: { agentExtensions: { implementer: 7 } }, agentDir, warn })).not.toThrow();
		expect(configExtensionEntriesForAgent("implementer", { config: { agentExtensions: { implementer: 7 } }, agentDir, warn })).toEqual([]);
		expect(warns.filter((w) => w.includes("agentExtensions"))).toHaveLength(1);
	});

	it("sd--prefixed agentExtensions keys are accepted (pi listings show sd-<role>)", () => {
		const entries = configExtensionEntriesForAgent("ui-tester", {
			config: { agentExtensions: { "sd-ui-tester": ["fake-lsp"] } },
			agentDir,
			warn,
		});
		expect(entries).toEqual([join(agentDir, "npm", "node_modules", "fake-lsp", "index.ts")]);
	});
});

describe("v0.3.82 — explicit tool-name keys REMOVED; allTools boolean mode", () => {
	let warns: string[];
	const warn = (m: string) => warns.push(m);

	beforeEach(() => {
		warns = [];
		resetConfigExtensionWarnsForTests();
		getConfigImpl.impl = () => ({});
	});

	it("leftover commonExtensionTools/agentExtensionTools keys in config are IGNORED (no merge, no warn)", () => {
		const out = configExtensionToolsForAgent("implementer", {
			config: { commonExtensionTools: ["lsp_diagnostics"], agentExtensionTools: { implementer: ["recall"] } } as never,
			warn,
		});
		expect(out).toEqual([]); // mechanical-only now
		expect(warns).toEqual([]);
	});

	it("toolsWildcardForAgent: allTools true → wildcard (capability agents)", async () => {
		const { toolsWildcardForAgent } = await import("../src/agents/agent-runtime.ts");
		expect(toolsWildcardForAgent("implementer", { config: { allTools: true } })).toBe(true);
		expect(toolsWildcardForAgent("spec-reviewer", { config: { allTools: true } })).toBe(true);
	});

	it("toolsWildcardForAgent: mechanical classifiers scoped out of allTools; per-role explicit beats scope", async () => {
		const { toolsWildcardForAgent } = await import("../src/agents/agent-runtime.ts");
		expect(toolsWildcardForAgent("task-classifier", { config: { allTools: true } })).toBe(false);
		expect(toolsWildcardForAgent("task-classifier", { config: { agentAllTools: { "task-classifier": true } } })).toBe(true);
		expect(toolsWildcardForAgent("ui-tester", { config: { agentAllTools: { "sd-ui-tester": true } } })).toBe(true);
	});

	it("toolsWildcardForAgent: false/absent/malformed → false, never throws", async () => {
		const { toolsWildcardForAgent } = await import("../src/agents/agent-runtime.ts");
		expect(toolsWildcardForAgent("implementer", { config: {} })).toBe(false);
		expect(toolsWildcardForAgent("implementer", { config: { allTools: "yes" as never } })).toBe(false);
		expect(toolsWildcardForAgent("implementer", { config: { agentAllTools: { implementer: "nope" as never } } })).toBe(false);
	});
});

describe("v0.3.82 — mechanical tool-index merge (declaring an extension suffices)", () => {
	const idx = (entries: Record<string, string[]>): ReadonlyMap<string, readonly string[]> => new Map(Object.entries(entries));

	beforeEach(() => {
		resetConfigExtensionWarnsForTests();
		getConfigImpl.impl = () => ({});
	});

	it("commonExtensions declares pi-lsp → its toolIndex tools merge mechanically (no commonExtensionTools needed)", () => {
		getConfigImpl.impl = () => ({ commonExtensions: ["pi-lsp"] });
		const out = configExtensionToolsForAgent("spec-reviewer", {
			toolIndex: idx({ "pi-lsp": ["lsp_diagnostics", "lsp_hover"] }),
		});
		expect(out).toEqual(["lsp_diagnostics", "lsp_hover"]);
	});

	it("agentExtensions per-role merges mechanically for that role only", () => {
		getConfigImpl.impl = () => ({ agentExtensions: { "research-agent": ["pi-web-access"] } });
		const out = configExtensionToolsForAgent("research-agent", {
			toolIndex: idx({ "pi-web-access": ["web_search", "fetch_content"], "pi-lsp": ["lsp_diagnostics"] }),
		});
		expect(out).toEqual(["web_search", "fetch_content"]);
	});

	it("role-hardcoded packages merge WITHOUT any config (browser/web-research static names)", () => {
		const out = configExtensionToolsForAgent("research-agent", {
			toolIndex: idx({ "pi-web-access": ["web_search"], "pi-browser-cdp-extension": ["browser_execute"], "pi-lsp": ["lsp_diagnostics"] }),
		});
		expect(out).toContain("web_search");
		expect(out).not.toContain("lsp_diagnostics"); // undeclared for this agent
	});

	it("mechanical classifiers never mechanically merge common extensions", () => {
		getConfigImpl.impl = () => ({ commonExtensions: ["pi-lsp"] });
		const out = configExtensionToolsForAgent("task-classifier", {
			toolIndex: idx({ "pi-lsp": ["lsp_diagnostics"] }),
		});
		expect(out).toEqual([]);
	});

	it("undeclared package tools are NOT merged (scoping holds)", () => {
		getConfigImpl.impl = () => ({ commonExtensions: ["pi-lsp"] });
		const out = configExtensionToolsForAgent("spec-reviewer", {
			toolIndex: idx({ "pi-lsp": ["lsp_diagnostics"], "pi-browser-cdp-extension": ["browser_execute"] }),
		});
		expect(out).toEqual(["lsp_diagnostics"]);
	});

	it("mechanical output is exactly the declared packages' tools (no config key carries tool names anymore)", () => {
		getConfigImpl.impl = () => ({ commonExtensions: ["pi-lsp"] });
		const out = configExtensionToolsForAgent("spec-reviewer", {
			toolIndex: idx({ "pi-lsp": ["lsp_diagnostics", "lsp_hover"] }),
		});
		expect(out).toEqual(["lsp_diagnostics", "lsp_hover"]);
	});

	it("extensionPackagesForAgent: role ∪ common ∪ perRole, npm: normalized, classifiers scoped", async () => {
		const { extensionPackagesForAgent } = await import("../src/agents/agent-runtime.ts");
		getConfigImpl.impl = () => ({ commonExtensions: ["npm:pi-lsp", "pi-blackhole"], agentExtensions: { "qa-agent": ["pi-extra"] } });
		expect(extensionPackagesForAgent("spec-reviewer")).toEqual(["pi-lsp", "pi-blackhole"]);
		expect(extensionPackagesForAgent("qa-agent")).toEqual(["pi-browser-cdp-extension", "pi-lsp", "pi-blackhole", "pi-extra"]); // qa-agent is a browser role
		expect(extensionPackagesForAgent("task-classifier")).toEqual([]);
		expect(extensionPackagesForAgent("research-agent")).toContain("pi-web-access"); // role-hardcoded
	});
});


describe("v0.3.82 dual-review fixes — index build, zero-contribution WARN, malformed allTools", () => {
	beforeEach(() => resetConfigExtensionWarnsForTests());

	it("buildToolIndexFromTools: npm: source attribution + scoped path fallback + builtin/pi-package skip", () => {
		const idx = buildToolIndexFromTools([
			{ name: "lsp_hover", sourceInfo: { source: "npm:pi-lsp", path: "/x/node_modules/pi-lsp/index.ts" } },
			{ name: "lsp_hover_alias", sourceInfo: { source: undefined, path: "/x/node_modules/@earendil-works/some-pkg/index.ts" } },
			{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
			{ name: "bash", sourceInfo: { path: "/mise/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js" } },
			{ name: "mcp", sourceInfo: { source: "npm:pi-mcp-adapter" } },
		]);
		expect(idx.get("pi-lsp")).toEqual(["lsp_hover"]);
		expect(idx.get("@earendil-works/some-pkg")).toEqual(["lsp_hover_alias"]); // scoped FULL name (adv-F3: naive capture gave "@earendil-works")
		expect(idx.get("pi-mcp-adapter")).toEqual(["mcp"]);
		expect(idx.has("builtin")).toBe(false);
		expect(idx.has("@earendil-works")).toBe(false); // no truncated scoped fragment
		expect(idx.has("@earendil-works/pi-coding-agent")).toBe(false); // pi package guard (dead pre-fix)
	});

	it("r2 code-R2-1: malformed commonExtensions warns EXACTLY once across the registration-order double consumption (tools-channel first, entries-channel second)", () => {
		const warns: string[] = [];
		const cfg = { commonExtensions: "nowledge-mem-pi" as never }; // the single-string typo
		// Registration order: registerOne evaluates configToolsFor (tools channel) BEFORE
		// configExtensionEntriesForAgent (entries channel). Pre-fix the tools channel called
		// extensionPackagesForAgent with NO warn sink — silently consuming the shared memo and
		// muting the entries channel's loud fallback (zero warns total).
		const tools = configExtensionToolsForAgent("spec-reviewer", { config: cfg, warn: (m) => warns.push(m), toolIndex: new Map() });
		const entries = configExtensionEntriesForAgent("spec-reviewer", { config: cfg, warn: (m) => warns.push(m) });
		expect(tools).toEqual([]);
		expect(entries).toEqual([]);
		const malformed = warns.filter((l) => l.includes('"commonExtensions" must be an array of strings'));
		expect(malformed).toHaveLength(1); // loud, exactly once across BOTH consumers
	});

	it("buildToolIndex NEVER throws on a throwing getAllTools (the BLOCKER shape) — returns empty index + error text", () => {
		const r = buildToolIndex({ getAllTools: () => { throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading."); } });
		expect(r.toolIndex.size).toBe(0);
		expect(r.error).toMatch(/not initialized/i);
		const r2 = buildToolIndex({}); // missing method entirely
		expect(r2.toolIndex.size).toBe(0);
		expect(r2.error).toBeUndefined();
	});

	it("zero-contribution merge is LOUD: declared package absent from the index warns once per package (adv-F2 silent-loss fix)", () => {
		const warns: string[] = [];
		const idx = new Map([["pi-lsp", ["lsp_diagnostics"]]]);
		const cfg = { commonExtensions: ["pi-lsp", "nowledge-mem-pi"] };
		const out1 = configExtensionToolsForAgent("spec-reviewer", { config: cfg as never, warn: (m) => warns.push(m), toolIndex: idx });
		const out2 = configExtensionToolsForAgent("code-reviewer", { config: cfg as never, warn: (m) => warns.push(m), toolIndex: idx });
		expect(out1).toEqual(["lsp_diagnostics"]);
		expect(out2).toEqual(["lsp_diagnostics"]);
		expect(warns.filter((w) => w.includes("nowledge-mem-pi"))).toHaveLength(1); // once per package, not per agent
		expect(warns[0]).toMatch(/contributed no tools/);
	});

	it("malformed allTools / agentAllTools values warn ONCE per key and degrade to false (code-F4 loud-fallback contract)", async () => {
		const { toolsWildcardForAgent } = await import("../src/agents/agent-runtime.ts");
		const warns: string[] = [];
		const w = (m: string) => warns.push(m);
		expect(toolsWildcardForAgent("spec-reviewer", { config: { allTools: "yes" } as never, warn: w })).toBe(false);
		expect(toolsWildcardForAgent("code-reviewer", { config: { allTools: 42 } as never, warn: w })).toBe(false);
		expect(toolsWildcardForAgent("implementer", { config: { agentAllTools: { implementer: "true" } } as never, warn: w })).toBe(false);
		expect(warns).toHaveLength(2); // allTools once + agentAllTools[implementer] once
		expect(warns[0]).toContain('"allTools" must be a boolean');
		expect(warns[1]).toContain("agentAllTools[implementer]");
		// well-formed booleans never warn
		warns.length = 0;
		expect(toolsWildcardForAgent("spec-reviewer", { config: { allTools: true }, warn: w })).toBe(true);
		expect(toolsWildcardForAgent("implementer", { config: { agentAllTools: { implementer: false } }, warn: w })).toBe(false);
		expect(warns).toHaveLength(0);
	});
});
