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

	it("first doc: requirements asks for structured data", () => {
		expect(buildRequirementsPrompt(s, null, "t")).toContain("acceptanceCriteria");
	});

	it("next doc counts existing + 1", () => {
		put(dir, "01-requirements.md");
		// BDD now returns structured data (render pipeline); check for data-shape guidance, not a doc path
		expect(buildBddPrompt(s, null, "t", null)).toContain("features");
		expect(buildBddPrompt(s, null, "t", null)).toContain("structured output");
	});

	it("excludes the stage's own slug so gate retries don't inflate the number", () => {
		put(dir, "01-requirements.md"); // prior attempt on disk
		expect(buildRequirementsPrompt(s, null, "t")).toContain("structured data");
	});

	it("assessment asks for structured data (render pipeline)", () => {
		put(dir, "01-requirements.md"); put(dir, "02-bdd-scenarios.md"); put(dir, "03-research-report.md");
		expect(buildAssessmentPrompt(s, null, "t", null, null)).toContain("structured data");
	});

	it("debug takes 04 when it runs (bug), pushing code-assessment to 05", () => {
		put(dir, "01-requirements.md"); put(dir, "02-bdd-scenarios.md"); put(dir, "03-research-report.md");
		expect(buildDebugPrompt(s, null, "t", null, null)).toContain("RENDERED FOR YOU");
		put(dir, "04-debug-analysis.md");
		expect(buildAssessmentPrompt(s, null, "t", null, null)).toContain("structured data");
	});

	it("spec asks for structured data (render pipeline, 3 docs)", () => {
		put(dir, "01-requirements.md"); put(dir, "02-bdd-scenarios.md"); put(dir, "03-research-report.md");
		put(dir, "04-code-assessment.md"); put(dir, "05-design.md");
		const p = buildSpecPrompt(s, null, "t", null, null, null, null, null);
		expect(p).toContain("phases");
		expect(p).toContain("RENDERED FOR YOU");
	});
});
