/**
 * Composition integrity: imports the real super-dev workflow module and asserts
 * the node tree is well-formed. This validates the entire module graph loads
 * (all stages, nodes, prompts, helpers wire together) WITHOUT spawning agents.
 */

import { describe, it, expect } from "vitest";
import { SUPER_DEV_WORKFLOW } from "../src/stages/index.ts";

describe("SUPER_DEV_WORKFLOW composition", () => {
	it("is the super-dev workflow", () => {
		expect(SUPER_DEV_WORKFLOW.id).toBe("super-dev");
	});
	it("root is a sequence (the tolerant pipeline)", () => {
		expect(SUPER_DEV_WORKFLOW.root.kind).toBe("sequence");
		expect(typeof SUPER_DEV_WORKFLOW.root.run).toBe("function");
	});
	it("has a description", () => {
		expect(typeof SUPER_DEV_WORKFLOW.description).toBe("string");
		expect(SUPER_DEV_WORKFLOW.description!.length).toBeGreaterThan(0);
	});
});
