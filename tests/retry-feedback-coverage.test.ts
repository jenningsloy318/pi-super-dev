import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrototypePrompt } from "../src/prompts.ts";

const root = process.cwd();
const src = (path: string) => readFileSync(join(root, path), "utf8");

describe("shared retry-feedback coverage", () => {
	it("routes every stage-level agent retry surface through the shared feedback renderer", () => {
		const workflow = src("src/workflow.ts");
		const stages = src("src/stages/index.ts");
		const specConvergence = src("src/stages/spec-convergence.ts");
		const implementation = src("src/stages/implementation.ts");
		const verify = src("src/stages/verify.ts");
		const subprocess = src("src/pi-spawn.ts");
		const session = src("src/session-agent.ts");

		// Foundational document gates: requirements, BDD, research.
		for (const key of ["requirements", "bdd", "research"]) {
			expect(stages).toContain(`feedbackKey: "${key}"`);
		}
		expect(specConvergence).toContain("setRetryFeedback(state");
		expect(specConvergence).toContain("setSpecFeedback(state");
		expect(workflow).toContain("convergenceRetryFeedback(state");
		expect(workflow).toContain("renderRetryFeedbackBlock(combinedFeedback)");

		// Stage 9: RED retries and GREEN implementation retries.
		for (const marker of [
			"RED coverage verifier rejected the previous test set",
			"RED oracle rejected the previous test set",
			"RED boundary rejected the previous test set",
			"Prior convergence-iteration failures",
			"Previous attempt failed the build/test gate",
			"Deliverables still missing",
			"Claimed changes not present in git",
			"Hollow deliverable files",
		]) {
			expect(implementation).toContain(marker);
		}
		expect(implementation).toContain("implementationRetrySection");
		expect(implementation).toContain("renderRetryFeedbackBlock");

		// Stage 10/legacy Stage 11 fix loops use the same fixer nodes.
		expect(verify).toContain("verificationRetryFeedbackBlock");
		expect(verify).toContain("renderRetryFeedbackBlock(feedback, \"Verification retry evidence for this fix\")");

		// Agent backend corrective retries are global retry surfaces used by all stages.
		expect(subprocess).toContain("renderRetryFeedbackBlock([feedback], \"Corrective Retry\")");
		expect(session).toContain("renderRetryFeedbackBlock([feedback], \"Corrective Re-Prompt\")");
	});

	it("renders prototype retry rounds with structured retry metadata", () => {
		const prompt = buildPrototypePrompt(
			{ worktreePath: "/tmp/w", specDirectory: "/tmp/spec/", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "x", worktreeCreated: false, initializedRepo: false },
			null,
			"validate constants",
			{ docs: ["/tmp/design.md"] },
			["timeoutMs"],
			2,
			{ verdict: "fail", measurements: ["p95 too high"], adjustments: ["lower timeout"] },
		);

		expect(prompt).toContain("Previous Prototype Round Feedback");
		expect(prompt).toContain("stage=prototype");
		expect(prompt).toContain("gate=prototype-verdict");
		expect(prompt).toContain("The harness rejected the prior attempt using external evidence");
	});
});
