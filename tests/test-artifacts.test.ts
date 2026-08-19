import { describe, expect, it } from "vitest";

import {
	classifyObviousRedPath,
	isSubstrateArtifact,
	redBoundaryResultFromAgent,
	redBoundaryResultFromClassifications,
	approveScaffoldPaths,
} from "../src/test-artifacts.ts";

describe("v0.2.8 G4 — scaffold category + judge approval", () => {
	it("a 'scaffold' classification (declaration-only) is ALLOWED, distinct from 'production'", () => {
		const r = redBoundaryResultFromAgent(["internal/stepmcp/types.go", "internal/stepmcp/impl.go"], {
			classifications: [
				{ path: "internal/stepmcp/types.go", category: "scaffold", confidence: 0.9, reason: "declaration-only const+type" },
				{ path: "internal/stepmcp/impl.go", category: "production", confidence: 0.9, reason: "real behavior" },
			],
			forbiddenFiles: ["internal/stepmcp/impl.go"],
			ambiguousFiles: [],
			allAllowed: false,
		});
		expect(r.forbiddenFiles).toContain("internal/stepmcp/impl.go");
		expect(r.forbiddenFiles).not.toContain("internal/stepmcp/types.go");
		expect(r.allAllowed).toBe(false);
	});

	it("approveScaffoldPaths re-admits a judge-approved forbidden path (allow-scaffold)", () => {
		const base = redBoundaryResultFromClassifications([
			{ path: "internal/stepmcp/types.go", category: "production", allowed: false, confidence: 0.9, source: "agent", reason: "looked like production" },
		]);
		expect(base.allAllowed).toBe(false);
		const approved = approveScaffoldPaths(base, new Set(["internal/stepmcp/types.go"]));
		expect(approved.allAllowed).toBe(true);
		expect(approved.forbiddenFiles).toHaveLength(0);
		expect(approved.classifications[0]!.category).toBe("scaffold");
	});
});

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

describe("greenfield RED substrate classification", () => {
	it("deterministically allows conventional dependency / tool-cache directories so a truly-greenfield repo can bootstrap them during RED", () => {
		// The exact pollutants observed in the failing run:
		expect(classifyObviousRedPath("node_modules/.bin/esbuild")).toMatchObject({ category: "substrate", allowed: true, source: "deterministic" });
		expect(classifyObviousRedPath("node_modules/@sinclair/typebox/dist/index.js")).toMatchObject({ category: "substrate", allowed: true });
		expect(classifyObviousRedPath(".vite/vitest/results.json")).toMatchObject({ category: "substrate", allowed: true });
		// Other languages' conventional caches:
		expect(classifyObviousRedPath("src/__pycache__/persistence.cpython-313.pyc")).toMatchObject({ category: "substrate", allowed: true });
		expect(classifyObviousRedPath(".pytest_cache/v/cache/lastfailed")).toMatchObject({ category: "substrate", allowed: true });
		expect(classifyObviousRedPath("target/debug/deps/libfoo.rmeta")).toMatchObject({ category: "ambiguous", allowed: false });
	});

	it("matches substrate by path segment anywhere in the tree (nested node_modules, dot-cache dirs)", () => {
		expect(isSubstrateArtifact("packages/app/node_modules/react/index.js")).toBe(true);
		expect(isSubstrateArtifact(".turbo/build.log")).toBe(true);
		expect(isSubstrateArtifact(".next/server/chunks/main.js")).toBe(true);
	});

	it("does NOT misclassify generic source directory names that happen to share build/cache vocabulary", () => {
		// build / dist / bin / obj / target / coverage are deliberately excluded
		// because real projects hand-write source under those names.
		expect(classifyObviousRedPath("src/build/config.ts")).toMatchObject({ category: "ambiguous", allowed: false });
		expect(classifyObviousRedPath("commands/target/deploy.ts")).toMatchObject({ category: "ambiguous", allowed: false });
		expect(classifyObviousRedPath("src/bin/cli.ts")).toMatchObject({ category: "ambiguous", allowed: false });
		expect(classifyObviousRedPath("dist/report.ts")).toMatchObject({ category: "ambiguous", allowed: false });
	});

	it("keeps substrate files out of both forbiddenFiles and ambiguousFiles so they are never sent to the boundary evaluator", () => {
		const result = redBoundaryResultFromClassifications([
			classifyObviousRedPath("src/persistence.test.ts"),
			classifyObviousRedPath("node_modules/vitest/dist/cli.js"),
			classifyObviousRedPath(".vite/vitest/results.json"),
		]);
		expect(result.allAllowed).toBe(true);
		expect(result.forbiddenFiles).toEqual([]);
		expect(result.ambiguousFiles).toEqual([]); // substrate never needs the evaluator
	});
});
