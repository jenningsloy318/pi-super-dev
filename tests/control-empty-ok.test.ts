/**
 * v0.3.56 F5/F8 — the honest-empty-array contract across all three backends.
 *
 * F5 (class D — implicit cross-backend contract): the session backend's hand
 * copy of the empty-array allow-set omitted `findings`, so zero-findings review
 * approvals fired a false corrective re-prompt under the default backend only.
 * F8: five required keys whose honest value is [] counted as missing.
 * Defense layer: shared constant at common-ancestor scope (methodology P6) +
 * a source-contract invariant so the three backends can never drift again
 * (docs/methodology/04-quality.md §2).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EMPTY_ARRAY_OK, missingControlKeys } from "../src/control.ts";
import { missingKeys } from "../src/bench/session-agent.ts";

describe("DEFAULT_EMPTY_ARRAY_OK — the shared honest-empty set (F5+F8)", () => {
	it("contains findings plus the five honest-empty required keys", () => {
		for (const key of [
			"findings",
			"sources", "adjustments", "regressions", "failures", "deviationsDocumented",
			"filesCreated", "filesModified", "filesDeleted",
		]) {
			expect(DEFAULT_EMPTY_ARRAY_OK, key).toContain(key);
		}
		// v0.3.47 decision preserved: dimensions is REQUIRED-non-empty — an empty
		// dimensions array is NOT an honest value (a review must score 8 dims).
		expect(DEFAULT_EMPTY_ARRAY_OK).not.toContain("dimensions");
	});
});

describe("missingControlKeys with the shared base — no false corrective retries", () => {
	it("a zero-findings review approval is complete (F5)", () => {
		const control = { title: "t", date: "d", verdict: "Approved", summary: "s", findings: [] };
		const keys = ["title", "date", "verdict", "summary", "findings"];
		expect(missingKeys(control, keys, { allowEmptyArraysFor: new Set([...DEFAULT_EMPTY_ARRAY_OK]) })).toEqual([]);
	});
	it("each F8 honest-empty key passes as []", () => {
		for (const key of ["sources", "adjustments", "regressions", "failures", "deviationsDocumented"]) {
			const control: Record<string, unknown> = { summary: "s" };
			control[key] = [];
			expect(missingControlKeys(control, ["summary", key], { allowEmptyArraysFor: new Set([...DEFAULT_EMPTY_ARRAY_OK, "summary"]) }), key).toEqual([]);
		}
	});
	it("still flags genuinely-missing keys and non-allowed empty arrays", () => {
		expect(missingControlKeys({ summary: "s" }, ["summary", "dimensions"], { allowEmptyArraysFor: new Set([...DEFAULT_EMPTY_ARRAY_OK, "summary"]) }))
			.toEqual(["dimensions"]);
	});
});

describe("source-contract invariant — agent-execution modules import the shared set (P6)", () => {
	const repoRoot = join(import.meta.dirname, "..");
	const cases: Array<[string, RegExp]> = [
		["src/bench/session-agent.ts", /import \{[^}]*DEFAULT_EMPTY_ARRAY_OK[^}]*\} from "\.\.\/control\.ts"/],
		["src/agents/delegation-backend.ts", /import \{[^}]*DEFAULT_EMPTY_ARRAY_OK[^}]*\} from "\.\.\/control\.ts"/],
	];
	for (const [file, re] of cases) {
		it(`${file} resolves the base set from control.ts`, () => {
			const src = readFileSync(join(repoRoot, file), "utf8");
			expect(src, file).toMatch(re);
			// And no backend re-declares a private hand copy of the file-list keys.
			expect(src, `${file} must not hand-declare the allow-set`).not.toMatch(/\[\s*"filesCreated",\s*"filesModified",\s*"filesDeleted"/);
		});
	}
});
