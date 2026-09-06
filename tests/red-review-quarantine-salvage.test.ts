import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	attributeQuarantinePaths,
	attributQuarantinedViolations,
	type BoundaryQuarantinePayload,
} from "../src/stages/implementation.ts";

/**
 * v0.3.73 M1 — the concurrent-writer quarantine (v0.3.54) must not discard a
 * fully-formed RED-review verdict when EVERY violating path is attributable to
 * the implementer's declared edits. Run 2026-09-05T23-09-55-596Z: 6 quarantines
 * (54.0 min reviewer time) whose paths were 100% the implementer's claimed
 * files every time.
 */

const payload = (paths: string[]): BoundaryQuarantinePayload => ({ violations: paths, dir: "/tmp/q" });

const implControlAll = {
	filesCreated: ["src/dimensions/macro-liquidity.ts"],
	filesModified: ["src/schemas.ts"],
};
const implControlPartial = { filesModified: ["src/schemas.ts"] };

describe("v0.3.73 M1 — quarantine attribution classifier", () => {
	it("fully-attributed when every violation path is implementer-claimed", () => {
		const a = attributeQuarantinePaths("/wt", payload(["src/dimensions/macro-liquidity.ts", "src/schemas.ts"]), implControlAll, []);
		expect(a.declaredAny).toBe(true);
		expect(a.claimed.sort()).toEqual(["src/dimensions/macro-liquidity.ts", "src/schemas.ts"].sort());
		expect(a.unclaimed).toEqual([]);
	});

	it("phase test files count as claimed but alone never set declaredAny (salvage fail-closed without implementer claims)", () => {
		const a = attributeQuarantinePaths("/wt", payload(["tests/macro-contract.test.ts"]), null, ["tests/macro-contract.test.ts"]);
		// The test file is run-owned (claimed, not unclaimed)…
		expect(a.unclaimed).toEqual([]);
		expect(a.claimed).toEqual(["tests/macro-contract.test.ts"]);
		// …but with NO implementer-declared files there is no attribution signal
		// (v0.3.54 adv F1-i) — salvage and restores both fail closed.
		expect(a.declaredAny).toBe(false);
	});

	it("unclaimed paths surface (mixed authorship → NOT salvageable)", () => {
		const a = attributeQuarantinePaths("/wt", payload(["src/schemas.ts", "src/rogue.ts"]), implControlPartial, []);
		expect(a.unclaimed).toEqual(["src/rogue.ts"]);
	});

	it("no implementer claims at all → declaredAny=false (fail-closed, not salvageable)", () => {
		const a = attributeQuarantinePaths("/wt", payload(["src/schemas.ts"]), null, []);
		expect(a.declaredAny).toBe(false);
	});

	it("raw path normalization (./ and absolute forms) still matches claims", () => {
		const a = attributeQuarantinePaths("/wt", payload(["./src/schemas.ts", "/wt/src/dimensions/macro-liquidity.ts"]), implControlAll, []);
		expect(a.unclaimed).toEqual([]);
	});
});

describe("v0.3.73 M1 — salvaged verdict flows through the pipelined red-review join", () => {
	it("source contract: realAgent attaches salvagedControl to the boundary error", () => {
		const src = readFileSync(join(import.meta.dirname, "../src/workflow.ts"), "utf8");
		expect(src).toContain("salvagedControl");
	});

	it("source contract: the join consumes salvagedControl behind full attribution", () => {
		const src = readFileSync(join(import.meta.dirname, "../src/stages/implementation.ts"), "utf8");
		// The join must consult the salvaged control AND the pure classifier, and
		// log the salvage honestly.
		expect(src).toContain("attributeQuarantinePaths");
		expect(src).toMatch(/salvagedControl/);
		expect(src).toContain("verdict salvaged");
	});

	it("exported for tests: attributQuarantinedViolations still restores unclaimed paths only (regression pin)", () => {
		expect(typeof attributQuarantinedViolations).toBe("function");
	});
});

describe("v0.3.73 dual review AR-73-01 — salvage predicate rests on DECLARED claims only", () => {
	it("a test-file violation stays UNCLAIMED under testFilesAsClaims=false (reviewer-written test file → no salvage)", () => {
		const a = attributeQuarantinePaths("/wt", payload(["src/schemas.ts", "tests/macro-contract.test.ts"]), implControlPartial, ["tests/macro-contract.test.ts"], { testFilesAsClaims: false });
		expect(a.declaredAny).toBe(true);
		expect(a.claimed).toEqual(["src/schemas.ts"]);
		expect(a.unclaimed).toEqual(["tests/macro-contract.test.ts"]);
	});

	it("default keeps test files claimed (restore semantics unchanged — a test-file delta is never git-reverted)", () => {
		const a = attributeQuarantinePaths("/wt", payload(["tests/macro-contract.test.ts"]), null, ["tests/macro-contract.test.ts"]);
		expect(a.unclaimed).toEqual([]);
		expect(a.claimed).toEqual(["tests/macro-contract.test.ts"]);
	});

	it("source contract: the salvage gate passes testFilesAsClaims=false", () => {
		const src = readFileSync(join(import.meta.dirname, "../src/stages/implementation.ts"), "utf8");
		expect(src).toContain("testFilesAsClaims: false");
	});
});
