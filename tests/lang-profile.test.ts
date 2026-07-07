/**
 * Unit tests for per-language specialist profiles (Gap 4.1):
 * loadLangProfile + route-specialist wiring.
 */

import { describe, it, expect } from "vitest";
import { loadLangProfile } from "../src/agents.ts";
import { runHelper } from "../src/helpers.ts";

describe("loadLangProfile", () => {
	it("returns prose profiles for known languages", () => {
		expect(loadLangProfile("rust")).toMatch(/cargo/i);
		expect(loadLangProfile("rust")).toMatch(/thiserror/i);
		expect(loadLangProfile("go")).toMatch(/go test/i);
		expect(loadLangProfile("go")).toMatch(/fmt\.Errorf/);
		expect(loadLangProfile("python")).toMatch(/pytest/i);
		expect(loadLangProfile("frontend")).toMatch(/react/i);
		expect(loadLangProfile("backend")).toMatch(/vitest|pytest/i);
	});

	it("mentions the mandatory test file-organization rule", () => {
		for (const lang of ["rust", "go", "python", "frontend", "backend"]) {
			expect(loadLangProfile(lang)).toMatch(/test.*file|separate.*file|MANDATORY/i);
		}
	});

	it("returns '' for mixed and unknown languages (graceful fallback)", () => {
		expect(loadLangProfile("mixed")).toBe("");
		expect(loadLangProfile("cobol")).toBe("");
		expect(loadLangProfile("")).toBe("");
	});
});

describe("route-specialist: language profile injection", () => {
	it("returns the per-language profile as languageInstructions", async () => {
		const r = await runHelper({ name: "route-specialist", sources: { "classify-task": { language: "rust" } } });
		expect(r.value.specialistAgent).toBe("implementer");
		expect(r.value.languageInstructions).toMatch(/cargo/i);
	});

	it("returns empty languageInstructions for mixed", async () => {
		const r = await runHelper({ name: "route-specialist", sources: { "classify-task": { language: "mixed" } } });
		expect(r.value.languageInstructions).toBe("");
	});

	it("reports missing upstream classify-task", async () => {
		const r = await runHelper({ name: "route-specialist", sources: {} });
		expect(r.value.specialistAgent).toBe("implementer");
		expect(r.value.languageInstructions).toBe("");
	});
});
