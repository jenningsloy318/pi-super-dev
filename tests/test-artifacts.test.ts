import { describe, expect, it } from "vitest";

import {
	classifyObviousRedPath,
	redBoundaryResultFromAgent,
} from "../src/test-artifacts.ts";

describe("RED boundary path classification", () => {
	it("deterministically allows obvious test artifacts without language-specific tables", () => {
		expect(classifyObviousRedPath("backend/internal/performance/jmx_resource_manifest_test.go")).toMatchObject({
			path: "backend/internal/performance/jmx_resource_manifest_test.go",
			category: "test",
			allowed: true,
			source: "deterministic",
		});
		expect(classifyObviousRedPath("tests/fixtures/sample.json")).toMatchObject({
			category: "test",
			allowed: true,
		});
	});

	it("leaves production-looking paths ambiguous for the evaluator instead of hardcoding every language", () => {
		expect(classifyObviousRedPath("src/runtime/manifest.ts")).toMatchObject({
			category: "ambiguous",
			allowed: false,
			source: "deterministic",
		});
	});

	it("accepts high-confidence evaluator decisions for ambiguous test support files", () => {
		const result = redBoundaryResultFromAgent(["src/runtime/manifest.fixture.ts"], {
			classifications: [
				{
					path: "src/runtime/manifest.fixture.ts",
					category: "support",
					confidence: 0.91,
					reason: "This is a test fixture used only by the new RED test target.",
				},
			],
		});

		expect(result.allAllowed).toBe(true);
		expect(result.forbiddenFiles).toEqual([]);
		expect(result.classifications[0]).toMatchObject({ source: "agent", allowed: true });
	});

	it("defaults invalid or low-confidence evaluator output to forbidden", () => {
		const result = redBoundaryResultFromAgent(["src/runtime/manifest.ts"], {
			ambiguousFiles: ["src/runtime/manifest.ts"],
			classifications: [
				{
					path: "src/runtime/manifest.ts",
					category: "test",
					confidence: 0.95,
					reason: "Maybe a test helper, but still marked ambiguous.",
				},
			],
		});

		expect(result.allAllowed).toBe(false);
		expect(result.forbiddenFiles).toEqual(["src/runtime/manifest.ts"]);
		expect(result.ambiguousFiles).toEqual(["src/runtime/manifest.ts"]);
	});
});
