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

// ─── v0.3.38: shell-compound runner proposals ────────────────────────────────
// Run 2026-08-30T04-53-26 (cosmic-clock): the debug-analyzer proposed the
// judge-verified-healthy `cd <worktree> && node --test --test-reporter=tap …`
// but splitShellCommand made argv[0]="cd" — spawnSync ENOENTs WITHOUT throwing
// (error on the result, stdout/stderr null) — so the oracle logged "proposal
// REJECTED (no parseable per-test evidence)" while the suite was perfectly red.
// The judge burned an 8-minute escalation diagnosing it as a toolchain defect.
describe("v0.3.38: shell-compound runner proposals resolve sanely", () => {
	it("a leading `cd <dir> &&` becomes the cwd and the real command runs (live TAP validated)", async () => {
		const { resolveRunnerCommand } = await import("../src/build-runner/runner-discovery.ts");
		const spec = { version: 1, command: `cd ${root} && node -e "console.log('TAP version 13\\n1..2\\nok 1 a\\nnot ok 2 b\\n# tests 2')"`, resultFormat: "tap", discoveredAt: "x" };
		const out = validateRunnerSpec(spec as never, "/tmp", 30_000);
		expect(out.ok).toBe(true);
		expect(out.counts).toMatchObject({ tests: 2 });
		expect(out.evidence).toContain("tap");
		const plans = dynamicRedCheckPlans("/tmp", [], spec as never);
		expect(plans[0].cwd).toBe(root);
		expect(plans[0].argv[0]).toBe("node");
	}, 60_000);

	it("remaining shell operators (pipes/redirects/&&) route through bash -c", async () => {
		const { resolveRunnerCommand } = await import("../src/build-runner/runner-discovery.ts");
		const { argv } = resolveRunnerCommand({ version: 1, command: "npm test 2>&1 | tee out.log", resultFormat: "tap", discoveredAt: "x" }, root);
		expect(argv).toEqual(["bash", "-c", "npm test 2>&1 | tee out.log"]);
		// operators INSIDE quotes never trigger the shell path
		const plain = resolveRunnerCommand({ version: 1, command: `node -e "console.log('a && b')"` , resultFormat: "tap", discoveredAt: "x" }, root);
		expect(plain.argv[0]).toBe("node");
	}, 60_000);

	it("a bare `cd` with nothing left is an empty (invalid) command", async () => {
		const { resolveRunnerCommand } = await import("../src/build-runner/runner-discovery.ts");
		const { argv } = resolveRunnerCommand({ version: 1, command: "cd app", resultFormat: "tap", discoveredAt: "x" }, root);
		expect(argv).toEqual([]);
	}, 60_000);
});

// ─── v0.3.40: cached-runner phase scoping ────────────────────────────────────
// Run 2026-08-30T08-30-00-814Z phase 2: the phase-1-validated runner pinned
// `… phase1-shell.test.mjs`; the oracle judged phase-2's engine tests against
// phase-1's GREEN output and logged a false "tests passed before
// implementation", burning retries. Stale scope must invalidate, not mis-judge.
describe("v0.3.40: runnerCoversTargets — cached runner phase scoping", () => {
	it("a runner naming specific test files covers only phases whose targets match", async () => {
		const { runnerCoversTargets } = await import("../src/build-runner/runner-discovery.ts");
		const phase1: TestRunnerSpec = { version: 1, command: "node --test --test-reporter=tap cosmic-clock-3d/tests/phase1-shell.test.mjs", resultFormat: "tap", discoveredAt: "x" };
		expect(runnerCoversTargets(phase1, ["cosmic-clock-3d/tests/phase1-shell.test.mjs"])).toBe(true);
		expect(runnerCoversTargets(phase1, ["cosmic-clock-3d/tests/phase2-engine.test.mjs"])).toBe(false);
		expect(runnerCoversTargets(phase1, ["tests/agent-roster.test.ts"])).toBe(false);
	});
	it("suite-wide commands (no file tokens) cover every phase", async () => {
		const { runnerCoversTargets } = await import("../src/build-runner/runner-discovery.ts");
		for (const command of ["npm test", "./gradlew testDebugUnitTest", "npm exec vitest run --reporter=tap"]) {
			expect(runnerCoversTargets({ version: 1, command, resultFormat: "tap", discoveredAt: "x" } as TestRunnerSpec, ["any/phase9.test.ts"])).toBe(true);
		}
	});
	it("matches either direction (runner token as suffix of, or equal to, the target)", async () => {
		const { runnerCoversTargets } = await import("../src/build-runner/runner-discovery.ts");
		expect(runnerCoversTargets({ version: 1, command: "npm exec vitest run --reporter=tap tests/agent-roster.test.ts", resultFormat: "tap", discoveredAt: "x" } as TestRunnerSpec, ["tests/agent-roster.test.ts"])).toBe(true);
	});
	// Run 2026-08-31T03-25-44-485Z phase 1 try 2: the validated glob runner
	// `node --test cosmic-clock-3d/tests/*.test.mjs` was dropped by the guard
	// (glob token != exact target), forcing re-discovery + a judge round
	// (~20 min). A directory glob DOES execute every file it matches.
	it("v0.3.50: glob tokens cover every target they match", async () => {
		const { runnerCoversTargets } = await import("../src/build-runner/runner-discovery.ts");
		const glob: TestRunnerSpec = { version: 1, command: "node --test cosmic-clock-3d/tests/*.test.mjs", resultFormat: "tap", discoveredAt: "x" };
		expect(runnerCoversTargets(glob, ["cosmic-clock-3d/tests/phase1-shell.test.mjs"])).toBe(true);
		expect(runnerCoversTargets(glob, ["cosmic-clock-3d/tests/phase2-engine.test.mjs"])).toBe(true);
		// * does not cross `/` — a deeper directory is NOT covered by a one-level glob
		expect(runnerCoversTargets(glob, ["cosmic-clock-3d/tests/deep/nested.test.mjs"])).toBe(false);
		// bare glob matches by basename
		expect(runnerCoversTargets({ version: 1, command: "node --test *.test.mjs", resultFormat: "tap", discoveredAt: "x" } as TestRunnerSpec, ["cosmic-clock-3d/tests/phase1-shell.test.mjs"])).toBe(true);
		// a glob for a DIFFERENT directory still does not cover
		expect(runnerCoversTargets(glob, ["other/tests/phase1-shell.test.mjs"])).toBe(false);
		// `?` single-char metacharacter
		expect(runnerCoversTargets({ version: 1, command: "node --test cosmic-clock-3d/tests/phase?-shell.test.mjs", resultFormat: "tap", discoveredAt: "x" } as TestRunnerSpec, ["cosmic-clock-3d/tests/phase1-shell.test.mjs"])).toBe(true);
	});
});

// ─── v0.3.41: npm exec flag-swallowing ───────────────────────────────────────
// OM run 2026-08-30T08-17-36-563Z: `npm exec vitest run --reporter=tap tests/x`
// logged "npm warn Unknown cli config --reporter" — npm ATE the child's
// --reporter flag, the oracle received ANSI FAIL blocks instead of TAP, and
// every RED try honestly degraded to red-unverified. resolveRunnerCommand
// inserts ` -- ` after the exec/dlx subcommand so flags reach the child.
describe("v0.3.41: npm exec / npx forward child flags after --", () => {
	it("inserts ` -- ` after the subcommand when child flags are present", async () => {
		const { resolveRunnerCommand } = await import("../src/build-runner/runner-discovery.ts");
		const a = resolveRunnerCommand({ version: 1, command: "npm exec vitest run --reporter=tap tests/agent-roster.test.ts", resultFormat: "tap", discoveredAt: "x" }, root);
		expect(a.argv).toEqual(["npm", "exec", "vitest", "--", "run", "--reporter=tap", "tests/agent-roster.test.ts"]);
		const b = resolveRunnerCommand({ version: 1, command: "npx vitest run --reporter=tap", resultFormat: "tap", discoveredAt: "x" }, root);
		expect(b.argv).toEqual(["npx", "vitest", "--", "run", "--reporter=tap"]);
	});
	it("leaves already-guarded and flag-free commands untouched", async () => {
		const { resolveRunnerCommand } = await import("../src/build-runner/runner-discovery.ts");
		const guarded = resolveRunnerCommand({ version: 1, command: "npm exec -- vitest run --reporter=tap x.test.ts", resultFormat: "tap", discoveredAt: "x" }, root);
		expect(guarded.argv).toEqual(["npm", "exec", "--", "vitest", "run", "--reporter=tap", "x.test.ts"]);
		const plain = resolveRunnerCommand({ version: 1, command: "npm test", resultFormat: "tap", discoveredAt: "x" }, root);
		expect(plain.argv).toEqual(["npm", "test"]);
	});
});

describe("v0.3.52: package-glob and JVM-selector scoping", () => {
	const mk = (command: string): TestRunnerSpec => ({ version: 1, command, resultFormat: "tap", discoveredAt: "2026-01-01T00:00:00Z" });
	// Go package globs scope to a subtree but carry no file extension — before
	// v0.3.52 they read as suite-wide and a stale subtree runner survived for
	// other phases (the v0.3.40 false-covers class reborn for Go).
	it("go package globs scope coverage by prefix", async () => {
		const { runnerCoversTargets } = await import("../src/build-runner/runner-discovery.ts");
		expect(runnerCoversTargets(mk("go test ./..."), ["x/y_test.go"])).toBe(true);
		expect(runnerCoversTargets(mk("go test ./pkg/a/..."), ["pkg/a/engine_test.go"])).toBe(true);
		expect(runnerCoversTargets(mk("go test ./pkg/a/..."), ["pkg/b/other_test.go"])).toBe(false);
		expect(runnerCoversTargets(mk("go test pkg/a/..."), ["pkg/a/e_test.go"])).toBe(true);
	});
	// JVM selectors pin a class: `--tests X` has no path/extension, `-Dtest=X`
	// starts with a flag dash — both were invisible before v0.3.52.
	it("gradle --tests / maven -Dtest selectors scope coverage by class", async () => {
		const { runnerCoversTargets } = await import("../src/build-runner/runner-discovery.ts");
		expect(runnerCoversTargets(mk("./gradlew test --tests FooTest"), ["app/src/test/java/FooTest.kt"])).toBe(true);
		expect(runnerCoversTargets(mk("./gradlew test --tests FooTest"), ["app/src/test/java/BarTest.kt"])).toBe(false);
		expect(runnerCoversTargets(mk("./gradlew test --tests=FooTest"), ["app/src/FooTest.kt"])).toBe(true);
		expect(runnerCoversTargets(mk("./gradlew test --tests FooTest,BarTest"), ["app/BarTest.kt"])).toBe(true);
		expect(runnerCoversTargets(mk("./gradlew test --tests com.x.FooTest"), ["app/src/com/x/FooTest.kt"])).toBe(true);
		expect(runnerCoversTargets(mk("./gradlew test --tests Export*Test"), ["app/ExportFieldResolverTest.kt"])).toBe(true);
		expect(runnerCoversTargets(mk("mvn test -Dtest=FooTest"), ["src/test/java/BarTest.java"])).toBe(false);
		expect(runnerCoversTargets(mk("mvn test -Dtest=FooTest"), ["src/test/java/FooTest.java"])).toBe(true);
	});
	// The prior grammar classes stay pinned (v0.3.40 exact/stale, v0.3.50 glob).
	it("file-token grammar is unchanged", async () => {
		const { runnerCoversTargets } = await import("../src/build-runner/runner-discovery.ts");
		expect(runnerCoversTargets(mk("node --test tests/phase1.test.mjs"), ["tests/phase1.test.mjs"])).toBe(true);
		expect(runnerCoversTargets(mk("node --test tests/phase1.test.mjs"), ["tests/phase2.test.mjs"])).toBe(false);
		expect(runnerCoversTargets(mk("node --test tests/*.test.mjs"), ["tests/phase2.test.mjs"])).toBe(true);
		expect(runnerCoversTargets(mk("npm test"), ["tests/x.test.ts"])).toBe(true);
	});
});
