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

describe("v0.3.78 review fixes — configExtensionToolsForAgent (adv-F1 tool allowlist merge)", () => {
	let warns: string[];
	const warn = (m: string) => warns.push(m);

	beforeEach(() => {
		warns = [];
		resetConfigExtensionWarnsForTests();
	});

	it("capability agent merges commonExtensionTools (deduped, trimmed)", () => {
		expect(configExtensionToolsForAgent("implementer", { config: { commonExtensionTools: ["lsp_diagnostics", "lsp_diagnostics", " recall "] }, warn }))
			.toEqual(["lsp_diagnostics", "recall"]);
	});

	it("mechanical one-shot classifiers are excluded from commonExtensionTools (same scope predicate)", () => {
		for (const role of MECHANICAL_CLASSIFIER_ROLES) {
			expect(configExtensionToolsForAgent(role, { config: { commonExtensionTools: ["lsp_diagnostics"] }, warn }), `role ${role}`).toEqual([]);
		}
	});

	it("explicit agentExtensionTools[role] honored for ANY role; sd--prefixed keys accepted", () => {
		expect(configExtensionToolsForAgent("task-classifier", { config: { agentExtensionTools: { "task-classifier": ["recall"] } }, warn })).toEqual(["recall"]);
		expect(configExtensionToolsForAgent("ui-tester", { config: { agentExtensionTools: { "sd-ui-tester": ["browser_execute"] } }, warn })).toEqual(["browser_execute"]);
	});

	it("malformed containers never throw → [] + one warn naming the key", () => {
		expect(() => configExtensionToolsForAgent("implementer", { config: { commonExtensionTools: "lsp_diagnostics" }, warn })).not.toThrow();
		expect(configExtensionToolsForAgent("implementer", { config: { commonExtensionTools: 42 }, warn })).toEqual([]);
		expect(() => configExtensionToolsForAgent("implementer", { config: { agentExtensionTools: { implementer: {} } }, warn })).not.toThrow();
		expect(warns.filter((w) => w.includes("commonExtensionTools"))).toHaveLength(1);
		expect(warns.filter((w) => w.includes("agentExtensionTools"))).toHaveLength(1);
	});
});
