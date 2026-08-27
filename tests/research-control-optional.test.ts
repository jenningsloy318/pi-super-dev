/**
 * Research control-miss salvage (run 2026-08-27T12-33-43-088Z).
 *
 * Stage 3 Research ran 11.5 minutes, produced a full report, and the whole
 * output was DISCARDED with `missing required control keys: openIssues` —
 * one optional-in-spirit key absent from an otherwise complete control object,
 * with no salvage and the stage still green. openIssues is semantically
 * "empty when none" (like `sources`), so it must be OPTIONAL in the schema and
 * must NOT be parsed as a required control key from the prompt.
 */
import { describe, it, expect } from "vitest";
import { ResearchData } from "../src/render/schemas.ts";
import { extractControlKeys } from "../src/control.ts";
import { buildResearchPrompt } from "../src/prompts.ts";

const setup = { worktreePath: "/tmp/wt", specDirectory: "/tmp/spec/", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "01", worktreeCreated: false, initializedRepo: false } as never;

describe("research control — openIssues optional", () => {
	it("schema does not REQUIRE openIssues (sources precedent)", () => {
		const required = (ResearchData as unknown as { required?: string[] }).required ?? [];
		expect(required).not.toContain("openIssues");
		expect(required).toContain("title"); // the genuinely required set is intact
		expect(required).toContain("options");
	});

	it("prompt control-key line does not demand openIssues (subprocess backend parity)", () => {
		const prompt = buildResearchPrompt(setup, null, "research deep links", { docPath: "r.md" }, { docPath: "b.md" }, {} as never);
		const keys = extractControlKeys(prompt);
		expect(keys).toContain("title");
		expect(keys).toContain("summary");
		expect(keys).toContain("options");
		expect(keys).toContain("sources");
		expect(keys).not.toContain("openIssues");
	});
});
