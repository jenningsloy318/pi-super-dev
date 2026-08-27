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

	describe("v0.3.20: modern-guidelines distillation (JetBrains Go / Trail of Bits Python / Microsoft Rust)", () => {
		it("go profile teaches version detection from go.mod and version-gated idioms", () => {
			const go = loadLangProfile("go");
			expect(go).toMatch(/go\.mod/); // detect version first (JetBrains methodology)
			expect(go).toMatch(/wg\.Go/); // 1.25
			expect(go).toMatch(/errors\.AsType/); // 1.26
			expect(go).toMatch(/slices\.Contains/); // 1.21 baseline helpers
			expect(go).toMatch(/cmp\.Or/); // 1.22
			expect(go).toMatch(/omitzero/); // 1.24
			expect(go).toMatch(/encoding\/json\/v2/); // 1.27
			expect(go).toMatch(/authoritative/i); // modern idioms win over nearby old code
		});

		it("python profile teaches uv-only workflow (Trail of Bits modern-python)", () => {
			const py = loadLangProfile("python");
			expect(py).toMatch(/uv add/);
			expect(py).toMatch(/uv run/);
			expect(py).toMatch(/dependency-groups/); // PEP 735, not optional-dependencies
			expect(py).toMatch(/PEP 723/);
			expect(py).toMatch(/ruff/);
		});

		it("rust profile teaches Microsoft Pragmatic Rust rules", () => {
			const rs = loadLangProfile("rust");
			expect(rs).toMatch(/#\[expect/); // M-LINT-OVERRIDE-EXPECT
			expect(rs).toMatch(/ground truth/i); // M-TAUTOLOGICAL-TESTS
			expect(rs).toMatch(/From<.*> for/); // M-FROM-ERROR
			expect(rs).toMatch(/edition = "2024"/); // M-LATEST-EDITION
			expect(rs).toMatch(/last resort/i); // M-MACRO-LAST-RESORT
		});

		it("backend profile teaches TypeScript 5.x patterns", () => {
			const be = loadLangProfile("backend");
			expect(be).toMatch(/satisfies/);
			expect(be).toMatch(/\{ cause: err \}/); // Error causes
			expect(be).toMatch(/structuredClone/);
			expect(be).toMatch(/AbortSignal/);
		});

		it("frontend profile keeps version discipline and platform-first rules", () => {
			const fe = loadLangProfile("frontend");
			expect(fe).toMatch(/Version discipline/);
			expect(fe).toMatch(/React Compiler/);
			expect(fe).toMatch(/platform/);
		});
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
