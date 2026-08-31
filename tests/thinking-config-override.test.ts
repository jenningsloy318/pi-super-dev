/**
 * v0.3.44: config.agentThinking — per-agent thinking-level overrides from
 * ~/.super-dev/config.json.
 *
 * Contract (resolveThinking precedence, v0.3.43 + v0.3.44):
 *   per-call → SUPER_DEV_THINKING env → config.agentThinking[role]
 *   → built-in role tier (tiered roles) → inherited → "medium".
 *
 * This file mocks ../src/render/super-dev-dir.ts#getConfig so the tests are
 * hermetic — they never read (or break on) the real ~/.super-dev/config.json.
 * The mock preserves every other export (superDevEnv included) via
 * importOriginal spread.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MOCK_AGENT_THINKING: Record<string, string> = {
	implementer: "high", // tiered (medium) — config beats the built-in tier
	"tdd-guide": "low", // tiered (medium) — config beats the built-in tier
	"task-classifier": "minimal", // tiered (low) — config beats the built-in tier
	"requirements-clarifier": "low", // UNTIERED — config beats inherited :max
	"totally-unknown-agent": "xhigh", // no tier at all — config beats "medium"
	badlevel: "ultra", // invalid level — ignored, tier behavior remains
};

// v0.3.45: agentModels entries may carry a `:level` suffix — colocated
// model+thinking sugar at the SAME config tier (below the dedicated map).
const MOCK_AGENT_MODELS: Record<string, string> = {
	design: "zai-coding-cn/glm-5.3:max", // tiered (high) — suffix beats the tier
	"code-reviewer": "zai-coding-cn/glm-5.3-flash:low", // tiered (high) — suffix beats the tier
	"requirements-reviewer": "zai-coding-cn/glm-5.3-flash:high", // UNTIERED — suffix beats inherited
	implementer: "zai-coding-cn/glm-5.3:minimal", // DEDICATED map (high) must WIN over this suffix
	slug: "zai/glm-flash:low", // has a suffix AND no agentThinking — covers the pure-lookup path
};

vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return {
		...actual,
		getConfig: () => ({ ...actual.DEFAULT_CONFIG, agentThinking: MOCK_AGENT_THINKING, agentModels: MOCK_AGENT_MODELS }),
	};
});

import { agentThinkingFromConfig, agentModelThinkingFromConfig, resolveThinking, splitModelThinking, type ThinkingLevel } from "../src/pi-spawn.ts";

describe("agentThinkingFromConfig (pure lookup)", () => {
	it("returns the configured level for a listed agent", () => {
		expect(agentThinkingFromConfig("implementer", { implementer: "high" })).toBe("high");
	});
	it("returns undefined for an unlisted agent", () => {
		expect(agentThinkingFromConfig("design", { implementer: "high" })).toBeUndefined();
	});
	it("ignores invalid levels (typo → tier behavior, not a crash)", () => {
		expect(agentThinkingFromConfig("implementer", { implementer: "ultra" })).toBeUndefined();
		expect(agentThinkingFromConfig("implementer", { implementer: "" })).toBeUndefined();
	});
	it("trims whitespace around the configured level", () => {
		expect(agentThinkingFromConfig("implementer", { implementer: "  high  " })).toBe("high");
	});
	it("returns undefined for an empty map", () => {
		expect(agentThinkingFromConfig("implementer", {})).toBeUndefined();
	});
	it("an explicit undefined map defers to the lazily-read config", () => {
		// `undefined` is the no-override signal: the real dispatch path never
		// passes a map, so it falls through to getConfig() (here mocked).
		expect(agentThinkingFromConfig("implementer", undefined)).toBe("high");
	});
});

describe("resolveThinking — config.agentThinking tier (v0.3.44)", () => {
	beforeEach(() => {
		delete process.env.SUPER_DEV_THINKING;
	});
	afterEach(() => {
		delete process.env.SUPER_DEV_THINKING;
	});

	it("config beats the built-in role tier (implementer medium→high, tdd-guide medium→low)", () => {
		expect(resolveThinking("implementer")).toBe("high");
		expect(resolveThinking("tdd-guide")).toBe("low");
	});
	it("config beats the classifier tier (task-classifier low→minimal)", () => {
		expect(resolveThinking("task-classifier")).toBe("minimal");
	});
	it("config beats INHERITED for untiered agents (clarifier would otherwise inherit :max)", () => {
		expect(resolveThinking("requirements-clarifier", undefined, "max")).toBe("low");
	});
	it("config beats the medium fallback for agents with no tier at all", () => {
		expect(resolveThinking("totally-unknown-agent")).toBe("xhigh");
	});
	it("invalid config levels are ignored → tier behavior remains (design stays high)", () => {
		expect(resolveThinking("badlevel")).toBe("medium");
	});
	it("SUPER_DEV_THINKING env still beats config (global kill-switch)", () => {
		process.env.SUPER_DEV_THINKING = "off";
		expect(resolveThinking("implementer")).toBe("off");
	});
	it("per-call override still beats config", () => {
		expect(resolveThinking("implementer", "minimal")).toBe("minimal");
	});
	it("unlisted agents keep v0.3.43 behavior (spec-writer→high, judge→high, orchestrator inherits)", () => {
		expect(resolveThinking("spec-writer")).toBe("high");
		expect(resolveThinking("judge")).toBe("high");
		expect(resolveThinking("orchestrator", undefined, "xhigh")).toBe("xhigh");
		expect(resolveThinking("orchestrator")).toBe("medium");
	});
	it("resolved config level is always a valid ThinkingLevel", () => {
		const valid: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		for (const a of Object.keys(MOCK_AGENT_THINKING)) {
			if (a === "badlevel") continue;
			expect(valid, a).toContain(resolveThinking(a));
		}
	});
});

describe("agentModels `:level` suffix (v0.3.45)", () => {
	beforeEach(() => {
		delete process.env.SUPER_DEV_THINKING;
	});
	afterEach(() => {
		delete process.env.SUPER_DEV_THINKING;
	});

	it("splitModelThinking splits only VALID level words", () => {
		expect(splitModelThinking("zai-coding-cn/glm-5.3:high")).toEqual({ model: "zai-coding-cn/glm-5.3", thinking: "high" });
		expect(splitModelThinking("provider/model:latest")).toEqual({ model: "provider/model:latest", thinking: undefined });
		expect(splitModelThinking("bare")).toEqual({ model: "bare", thinking: undefined });
		expect(splitModelThinking("")).toEqual({ model: "", thinking: undefined });
		expect(splitModelThinking(undefined)).toEqual({ model: "", thinking: undefined });
		expect(splitModelThinking(" zai/glm:MAX ")).toEqual({ model: "zai/glm", thinking: "max" });
	});

	it("agentModelThinkingFromConfig reads the suffix off config.agentModels", () => {
		expect(agentModelThinkingFromConfig("design", { design: "zai/glm:max" })).toBe("max");
		expect(agentModelThinkingFromConfig("design", { design: "zai/glm" })).toBeUndefined();
		expect(agentModelThinkingFromConfig("design", {})).toBeUndefined();
		// undefined map → lazily-read config (mocked): design carries :max there
		expect(agentModelThinkingFromConfig("design", undefined)).toBe("max");
	});

	it("suffix beats the built-in role tier (design high→max, code-reviewer high→low)", () => {
		expect(resolveThinking("design")).toBe("max");
		expect(resolveThinking("code-reviewer")).toBe("low");
	});

	it("suffix beats INHERITED for untiered agents (requirements-reviewer would inherit :max)", () => {
		expect(resolveThinking("requirements-reviewer", undefined, "max")).toBe("high");
	});

	it("the DEDICATED agentThinking map wins over the suffix (implementer high, not minimal)", () => {
		expect(resolveThinking("implementer")).toBe("high");
	});

	it("agents with neither config source keep tier behavior (judge stays high)", () => {
		expect(resolveThinking("judge")).toBe("high");
	});

	it("per-call override and SUPER_DEV_THINKING env still beat the suffix", () => {
		expect(resolveThinking("design", "low")).toBe("low");
		process.env.SUPER_DEV_THINKING = "off";
		expect(resolveThinking("design")).toBe("off");
	});
});
