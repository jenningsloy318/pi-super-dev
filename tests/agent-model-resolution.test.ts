/**
 * Plan 1 — per-agent model resolution (cross-model review). Precedence A:
 * explicit call.model > config.agentModels[role] > global --model/SUPER_DEV_MODEL
 * > undefined (backend then falls back to the inherited main-session model).
 * A config-declared cross-model policy must OVERRIDE a one-off global --model.
 */
import { describe, it, expect } from "vitest";
import { resolveAgentModel } from "../src/workflow.ts";

describe("resolveAgentModel (precedence A)", () => {
	const models = { "code-reviewer": "openai/gpt-5.4", "adversarial-reviewer": "google/gemini-3-pro" };

	it("uses the per-role config model over the global model (cross-model policy wins)", () => {
		expect(resolveAgentModel({ agent: "code-reviewer" }, models, "anthropic/claude-sonnet")).toBe("openai/gpt-5.4");
	});

	it("falls back to the global model for an unlisted role", () => {
		expect(resolveAgentModel({ agent: "implementer" }, models, "anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet");
	});

	it("an explicit per-call model beats both config and global", () => {
		expect(resolveAgentModel({ agent: "code-reviewer", model: "x/y" }, models, "anthropic/claude-sonnet")).toBe("x/y");
	});

	it("returns undefined when nothing supplies a model (backend inherits session model)", () => {
		expect(resolveAgentModel({ agent: "implementer" }, {}, undefined)).toBeUndefined();
	});

	it("ignores blank/whitespace values at each tier", () => {
		expect(resolveAgentModel({ agent: "code-reviewer", model: "  " }, models, "g/m")).toBe("openai/gpt-5.4");
		expect(resolveAgentModel({ agent: "code-reviewer" }, { "code-reviewer": "  " }, "g/m")).toBe("g/m");
	});

	it("empty config map => global model (today's behavior)", () => {
		expect(resolveAgentModel({ agent: "code-reviewer" }, {}, "g/m")).toBe("g/m");
	});
});
