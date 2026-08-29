/**
 * v0.3.30 Layer C — agent-proposed test runner, validated under the
 * RepoLaunch contract, cached for reuse (SWE-Builder Memory Pool pattern).
 *
 * When the deterministic registry knows nothing about a stack (the run
 * 16-09-12 class), instead of burning retries on `unknown`:
 *   1. check the cache (spec-dir test-runner.json),
 *   2. ONE discovery agent call proposes a command under a MANDATORY contract
 *      (the command must emit per-test pass/fail detail — JUnit XML or TAP),
 *   3. the harness VALIDATES the proposal by actually running it and parsing
 *      structured output (LLM proposes, machine verifies — never the reverse),
 *   4. on success the spec is cached and feeds runRedCheck's dynamic plans;
 *      on failure the honest unknown path (v0.3.30 F2/F3) continues.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readCachedTestRunner,
	writeCachedTestRunner,
	validateRunnerSpec,
	dynamicRedCheckPlans,
	splitShellCommand,
	type TestRunnerSpec,
} from "../src/build-runner/runner-discovery.ts";

let root = "";
let specDir = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sd-runnerdisc-"));
	specDir = join(root, "docs", "specifications", "17-x");
	mkdirSync(specDir, { recursive: true });
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

const TAP_COMMAND = `node -e "console.log('TAP version 13\\nok 1 resolves\\nnot ok 2 aliases')"`;

describe("v0.3.30 C — cache roundtrip", () => {
	it("writes and reads a spec from the spec dir", () => {
		const spec: TestRunnerSpec = { version: 1, command: TAP_COMMAND, resultFormat: "tap", discoveredAt: "2026-08-29T00:00:00Z" };
		expect(writeCachedTestRunner(specDir, spec)).toBe(true);
		expect(readCachedTestRunner(specDir)).toEqual(spec);
	});
	it("returns null when absent or malformed (never throws)", () => {
		expect(readCachedTestRunner(specDir)).toBeNull();
		writeFileSync(join(specDir, "test-runner.json"), "{not json");
		expect(readCachedTestRunner(specDir)).toBeNull();
	});
});

describe("v0.3.30 C — splitShellCommand", () => {
	it("splits respecting single and double quotes", () => {
		expect(splitShellCommand(`node -e "console.log('a b')"`)).toEqual(["node", "-e", "console.log('a b')"]);
		expect(splitShellCommand("./gradlew test --tests 'com.x.Y Test'")).toEqual(["./gradlew", "test", "--tests", "com.x.Y Test"]);
	});
});

describe("v0.3.30 C — validateRunnerSpec (machine verification of the LLM proposal)", () => {
	it("accepts a command whose output is parseable TAP and returns the counts", () => {
		const out = validateRunnerSpec({ version: 1, command: TAP_COMMAND, resultFormat: "tap", discoveredAt: "x" }, root, 30_000);
		expect(out.ok).toBe(true);
		expect(out.counts).toEqual({ tests: 2, failures: 1, errors: 0, skipped: 0 });
	}, 60_000);

	it("rejects a command with no parseable per-test evidence", () => {
		const out = validateRunnerSpec({ version: 1, command: `node -e "console.log('all fine, trust me')"`, resultFormat: "console", discoveredAt: "x" }, root, 30_000);
		expect(out.ok).toBe(false);
	}, 60_000);

	it("rejects a non-executable command without throwing", () => {
		const out = validateRunnerSpec({ version: 1, command: "definitely-not-a-real-binary-xyz --run", resultFormat: "tap", discoveredAt: "x" }, root, 5_000);
		expect(out.ok).toBe(false);
	}, 60_000);
});

describe("v0.3.30 C — dynamicRedCheckPlans", () => {
	it("builds a scoped plan from a cached spec (cwd relative to the project root)", () => {
		const spec: TestRunnerSpec = { version: 1, command: "./gradlew test --tests com.x.Y", resultFormat: "junit-xml", discoveredAt: "x" };
		const plans = dynamicRedCheckPlans(root, ["app/src/test/java/com/x/Y.kt"], spec);
		expect(plans).toHaveLength(1);
		expect(plans[0].cwd).toBe(root);
		expect(plans[0].argv).toEqual(["./gradlew", "test", "--tests", "com.x.Y"]);
	});
});
