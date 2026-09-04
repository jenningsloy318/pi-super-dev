/**
 * Shared agent-runtime utilities (moved from the deleted pi-spawn.ts in
 * v0.3.64): role classification, timeout tiers, per-agent extension-package
 * resolution (now feeding the sd-* registration's per-agent `extensions`),
 * tool-call summaries, and the thinking precedence chain. Subprocess-argv /
 * stream-parsing suites were deleted with the subprocess backend.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodeWritingAgent, defaultAgentTimeoutMs, needsWebResearch, resolveExtensionEntry, resolveExtensionEntries, summarizeToolCall, resolveThinking } from "../src/agents/agent-runtime.ts";

vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return { ...actual, getConfig: () => actual.DEFAULT_CONFIG };
});

describe("isCodeWritingAgent / defaultAgentTimeoutMs", () => {
	it("classifies the code-writing agents", () => {
		expect(isCodeWritingAgent("implementer")).toBe(true);
		expect(isCodeWritingAgent("tdd-guide")).toBe(true);
		expect(isCodeWritingAgent("research-agent")).toBe(false);
		expect(isCodeWritingAgent("spec-writer")).toBe(false);
		expect(isCodeWritingAgent("orchestrator")).toBe(false);
	});
	it("gives code-writers 30 minutes and other roles the 20-minute default", () => {
		// v0.3.14: doc-writers (spec/bdd/research/review) previously got 480s while
		// code-writers got 20 min. Big-spec writers burn ~70% of the budget
		// re-verifying anchors, then the 480s hard wall kills them mid-compose and
		// discards the whole structured_output (run 2026-08-23T00-59-32 rounds 2/4).
		// v0.3.42: code-writers raised to 30 min — 20 aborted two healthy writers
		// on 2026-08-30 (AQ phase-02 commit, CC phase-03 implementer, both on
		// glm-5.3:max thinking), each costing the full window plus a recovery round.
		expect(defaultAgentTimeoutMs("implementer")).toBe(1_800_000);
		expect(defaultAgentTimeoutMs("tdd-guide")).toBe(1_800_000);
		expect(defaultAgentTimeoutMs("research-agent")).toBe(1_200_000);
		expect(defaultAgentTimeoutMs("spec-writer")).toBe(1_200_000);
		expect(defaultAgentTimeoutMs("orchestrator")).toBe(1_200_000);
	});
});

describe("web-research agent classification", () => {
	it("needsWebResearch is true only for research-agent", () => {
		expect(needsWebResearch("research-agent")).toBe(true);
		expect(needsWebResearch("code-assessor")).toBe(false);
		expect(needsWebResearch("implementer")).toBe(false);
		expect(needsWebResearch("qa-agent")).toBe(false);
	});


	it("resolveExtensionEntry returns the manifest extension entry when installed, null otherwise", () => {
		const tmp = mkdtempSync(join(tmpdir(), "sd-ext-"));
		const pkgDir = join(tmp, "npm", "node_modules", "pi-web-access");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
		writeFileSync(join(pkgDir, "index.ts"), "// stub");
		expect(resolveExtensionEntry("pi-web-access", tmp)).toBe(join(pkgDir, "index.ts"));
		expect(resolveExtensionEntry("pi-mcp-adapter", tmp)).toBeNull();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("resolveExtensionEntries expands manifest directory entries into loadable files", () => {
		const tmp = mkdtempSync(join(tmpdir(), "sd-ext-dir-"));
		const pkgDir = join(tmp, "npm", "node_modules", "pi-browser-cdp-extension");
		const extDir = join(pkgDir, "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(join(extDir, "browser-execute.ts"), "// browser tool");
		writeFileSync(join(extDir, "README.md"), "ignored");
		expect(resolveExtensionEntries("pi-browser-cdp-extension", tmp)).toEqual([join(extDir, "browser-execute.ts")]);
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("summarizeToolCall", () => {
	it("summarizes a write/edit/read by path (full, no abbreviation)", () => {
		expect(summarizeToolCall("write", { path: "docs/01-requirements.md" })).toBe("write docs/01-requirements.md");
		expect(summarizeToolCall("read", { path: "src/index.ts" })).toBe("read src/index.ts");
	});
	it("shows the full bash command (no artificial truncation)", () => {
		expect(summarizeToolCall("bash", { command: "npm test && npm run build" })).toBe("$ npm test && npm run build");
		expect(summarizeToolCall("bash", { command: "x".repeat(200) })).toBe(`$ ${"x".repeat(200)}`);
	});
	it("shows the FULL multi-line bash/python command (not just the first line)", () => {
		const cmd = "python3 -c \"\nimport sys\nprint(sys.version)\n\"";
		expect(summarizeToolCall("bash", { command: cmd })).toBe(`$ ${cmd}`);
	});
	it("summarizes ffgrep/fffind by pattern", () => {
		expect(summarizeToolCall("ffgrep", { pattern: "TODO" })).toBe('ffgrep "TODO"');
	});
	it("falls back to the tool name for unknown tools", () => {
		expect(summarizeToolCall("mystery", { x: 1 })).toBe("mystery");
	});
});

const saveEnv = (...keys: string[]) => {
	const snapshot: Record<string, string | undefined> = {};
	for (const k of keys) snapshot[k] = process.env[k];
	return {
		clear: () => { for (const k of keys) delete process.env[k]; },
		restore: () => {
			for (const k of keys) {
				if (snapshot[k] === undefined) delete process.env[k];
				else process.env[k] = snapshot[k] as string;
			}
		},
	};
};

describe("resolveThinking — v0.3.43 reordered precedence (ROLE TIER above INHERITED) [SCENARIO-005/006 amended]", () => {
	const env = saveEnv("SUPER_DEV_THINKING");
	beforeEach(env.clear);
	afterEach(env.restore);

	it("per-call override wins over SUPER_DEV_THINKING env, the INHERITED level, and the role default", () => {
		process.env.SUPER_DEV_THINKING = "low";
		// "design" role default is "high"; inherited "xhigh" must NOT win over per-call.
		expect(resolveThinking("design", "minimal", "xhigh")).toBe("minimal");
	});

	it("SUPER_DEV_THINKING env wins over the INHERITED level and the role tier when no per-call override", () => {
		process.env.SUPER_DEV_THINKING = "low";
		expect(resolveThinking("design", undefined, "xhigh")).toBe("low");
		expect(resolveThinking("slug", undefined, "high")).toBe("low");
	});

	it("v0.3.43 root-cause fix: the ROLE TIER wins over the inherited main-session level for TIERED agents", () => {
		// A `:max` parent session must NOT inflate tiered specialists — measured
		// as the #1 throughput root cause on the 2026-08-30 run pair.
		expect(resolveThinking("design", undefined, "xhigh")).toBe("high");
		expect(resolveThinking("implementer", undefined, "max")).toBe("medium");
		expect(resolveThinking("tdd-guide", undefined, "max")).toBe("medium");
		expect(resolveThinking("slug", undefined, "high")).toBe("minimal");
		expect(resolveThinking("tdd-coverage-classifier", undefined, "max")).toBe("low");
		expect(resolveThinking("red-boundary-classifier", undefined, "max")).toBe("low");
		expect(resolveThinking("task-classifier", undefined, "xhigh")).toBe("low");
		expect(resolveThinking("judge", undefined, "max")).toBe("high");
		expect(resolveThinking("code-reviewer", undefined, "max")).toBe("high");
	});

	it("UNTIERED agents still inherit the main-session level (SCENARIO-006 semantics preserved where they belong)", () => {
		// prototype-runner / orchestrator / bdd-writer have no explicit tier —
		// the inherited main-session level keeps applying to them.
		expect(resolveThinking("prototype-runner", undefined, "xhigh")).toBe("xhigh");
		expect(resolveThinking("orchestrator", undefined, "low")).toBe("low");
	});

	it("falls back to the role default when nothing (per-call/env/inherited) is supplied", () => {
		expect(resolveThinking("design")).toBe("high");
		expect(resolveThinking("implementer")).toBe("medium");
	});

	it("the widened signature stays backward-compatible with the legacy 2-arg call shape", () => {
		// Existing call sites (buildSpawnArgs, runAgentViaSession) still pass only
		// (agent, perCall) and must keep resolving identically to before.
		expect(resolveThinking("code-reviewer")).toBe("high");
		expect(resolveThinking("code-reviewer", "off")).toBe("off");
	});
});

