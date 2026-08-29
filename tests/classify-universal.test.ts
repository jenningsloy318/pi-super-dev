/**
 * v0.3.31 — universal classification (TDD RED).
 *
 * The Bazel principle, pinned: exit code is the ONLY authoritative gate;
 * console PROSE never classifies. Per-test detail comes solely from
 * structured channels (JUnit XML, TAP, go-test-json, declared count lines).
 * Without structured evidence the honest status is `unknown` — for a FAILING
 * exit (cannot tell red from broken) AND for a PASSING exit (scope-miss
 * false-green guard: pytest exit 5, `no tests to run` exit 0, vitest filter
 * miss).
 *
 * classifyRedStatus and every per-language regex/greenfield predicate are
 * DELETED; these tests pin the replacement truth table.
 */

import { describe, it, expect } from "vitest";
import { classifyFromEvidence } from "../src/build-runner/gates.ts";

const CASES: Array<{ name: string; exitOk: boolean; counts: { tests: number; failures: number; errors: number; skipped: number } | null; want: string }> = [
	// Structured red: tests ran and failed/errored (error = stub-throw RED, F4 semantics).
	{ name: "xml failures>0 → red", exitOk: false, counts: { tests: 12, failures: 5, errors: 0, skipped: 0 }, want: "red" },
	{ name: "xml errors>0 (stub throw) → red", exitOk: false, counts: { tests: 3, failures: 0, errors: 3, skipped: 0 }, want: "red" },
	{ name: "tap not-ok lines → red", exitOk: false, counts: { tests: 4, failures: 1, errors: 0, skipped: 0 }, want: "red" },
	// Structured green: tests ran, none failed, exit 0.
	{ name: "all passed + exit0 → green", exitOk: true, counts: { tests: 2992, failures: 0, errors: 0, skipped: 0 }, want: "green" },
	// Structured broken: zero tests + failing exit (compile/collection never reached tests).
	{ name: "tests=0 + fail exit → broken", exitOk: false, counts: { tests: 0, failures: 0, errors: 0, skipped: 0 }, want: "broken" },
	// Scope-miss guard: zero tests + exit 0 is NOT green.
	{ name: "tests=0 + exit0 → unknown (false-green guard)", exitOk: true, counts: { tests: 0, failures: 0, errors: 0, skipped: 0 }, want: "unknown" },
	// No structured evidence: prose is NEVER authoritative — failing or passing.
	{ name: "no counts + fail exit (old rust compile fixture) → unknown", exitOk: false, counts: null, want: "unknown" },
	{ name: "no counts + fail exit (old pytest banner) → unknown", exitOk: false, counts: null, want: "unknown" },
	{ name: "no counts + exit0 (old cargo green shortcut) → unknown", exitOk: true, counts: null, want: "unknown" },
];

describe("classifyFromEvidence — structured-only truth table", () => {
	for (const c of CASES) it(c.name, () => expect(classifyFromEvidence(c.exitOk, c.counts)).toBe(c.want));

	it("still says red when failures>0 even if exit were 0 (paranoid runner)", () => {
		expect(classifyFromEvidence(true, { tests: 5, failures: 2, errors: 0, skipped: 0 })).toBe("red");
	});
	it("all passed but exit≠0 → unknown (ambiguous, fail closed)", () => {
		expect(classifyFromEvidence(false, { tests: 5, failures: 0, errors: 0, skipped: 0 })).toBe("unknown");
	});
});
