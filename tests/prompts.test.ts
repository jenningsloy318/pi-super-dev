/**
 * Tests for computed spec-doc numbering. The number = (count of existing
 * numbered docs on disk) + 1, so it's dense, follows actual execution order,
 * and skipped stages consume no number. Local tmp dirs only — no spawns.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequirementsPrompt, buildBddPrompt, buildDebugPrompt, buildAssessmentPrompt, buildSpecPrompt } from "../src/prompts.ts";
import type { SetupControl } from "../src/types.ts";

function mkSetup(dir: string): SetupControl {
	return { worktreePath: dir, specDirectory: `${dir}/`, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "test", worktreeCreated: true, initializedRepo: false };
}
const put = (dir: string, name: string) => writeFileSync(join(dir, name), "x");

describe("spec-doc numbering (computed from disk: count + 1)", () => {
	let dir: string;
	let s: SetupControl;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-doc-")); s = mkSetup(dir); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("first doc is 01", () => {
		expect(buildRequirementsPrompt(s, null, "t")).toContain("01-requirements.md");
	});

	it("next doc counts existing + 1", () => {
		put(dir, "01-requirements.md");
		// BDD now returns structured data (render pipeline); check for data-shape guidance, not a doc path
		expect(buildBddPrompt(s, null, "t", null)).toContain("features");
		expect(buildBddPrompt(s, null, "t", null)).toContain("structured output");
	});

	it("excludes the stage's own slug so gate retries don't inflate the number", () => {
		put(dir, "01-requirements.md"); // a prior requirements attempt is on disk
		expect(buildRequirementsPrompt(s, null, "t")).toContain("01-requirements.md");
	});

	it("code-assessment is 04 when debug is skipped (feature task)", () => {
		put(dir, "01-requirements.md"); put(dir, "02-bdd-scenarios.md"); put(dir, "03-research-report.md");
		expect(buildAssessmentPrompt(s, null, "t", null, null)).toContain("04-code-assessment.md");
	});

	it("debug takes 04 when it runs (bug), pushing code-assessment to 05", () => {
		put(dir, "01-requirements.md"); put(dir, "02-bdd-scenarios.md"); put(dir, "03-research-report.md");
		expect(buildDebugPrompt(s, null, "t", null, null)).toContain("04-debug-analysis.md");
		put(dir, "04-debug-analysis.md");
		expect(buildAssessmentPrompt(s, null, "t", null, null)).toContain("05-code-assessment.md");
	});

	it("spec writes three consecutive docs (base, base+1, base+2)", () => {
		put(dir, "01-requirements.md"); put(dir, "02-bdd-scenarios.md"); put(dir, "03-research-report.md");
		put(dir, "04-code-assessment.md"); put(dir, "05-design.md");
		const p = buildSpecPrompt(s, null, "t", null, null, null, null, null);
		expect(p).toContain("06-specification.md");
		expect(p).toContain("07-implementation-plan.md");
		expect(p).toContain("08-task-list.md");
	});
});
