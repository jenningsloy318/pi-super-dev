/**
 * Phase 1 of the unified verify-loop: the verify node is a loop that runs BOTH
 * reviewers (code-review + adversarial) in parallel → merge → fix. This guards
 * the structure so Phase 2 (adding the api/ui test step) doesn't accidentally
 * drop a reviewer or break the loop shape.
 */
import { describe, it, expect } from "vitest";
import { reviewLoopNode } from "../src/stages/verify.ts";

describe("reviewLoopNode (Phase 1)", () => {
	it("is a loop node (review → fix, iterating until approved)", () => {
		expect(reviewLoopNode.kind).toBe("loop");
		expect(typeof reviewLoopNode.run).toBe("function");
	});
});
