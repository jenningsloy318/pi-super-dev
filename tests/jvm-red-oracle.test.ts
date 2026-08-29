/**
 * v0.3.31 — JVM/Gradle/Maven oracle support through CONVENTIONS DATA.
 *
 * v0.3.30 added hardcoded JVM branches to the engine; v0.3.31 moves every
 * ecosystem fact into the conventions table (src/build-runner/conventions.ts)
 * and deletes the engine's per-language code entirely. These tests re-pin the
 * SAME end-to-end capabilities through the new seam:
 *
 *  1. detectProjectCommands (environment/setup detection — unchanged).
 *  2. conventionPlansFor: scoped per-class plans (FQN --tests, android task,
 *     owning module cwd, wrapper discovery, maven -Dtest).
 *  3. classifyFromEvidence: JVM console prose NEVER classifies (Bazel
 *     principle); green/red/broken come only from fresh JUnit XML counts.
 *  4. runRedCheck e2e with a FAKE gradlew that writes JUnit XML — the exact
 *     AnkiQuick shape from run 2026-08-28T16-09-12-785Z.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectCommands } from "../src/build-runner/detect.ts";
import { classifyFromEvidence, runRedCheck } from "../src/build-runner/gates.ts";
import { conventionPlansFor } from "../src/build-runner/conventions.ts";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "sd-jvm-")); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

function gradleAndroidProject(): string {
	writeFileSync(join(root, "settings.gradle"), 'include ":app"\n');
	writeFileSync(join(root, "gradlew"), "#!/bin/sh\n");
	writeFileSync(join(root, "build.gradle"), "");
	mkdirSync(join(root, "app"), { recursive: true });
	writeFileSync(join(root, "app", "build.gradle"), "plugins { id 'com.android.application' }\n");
	return root;
}

// ─── 1. detectProjectCommands recognizes JVM manifests (setup detection) ───

describe("v0.3.30 F1 — detectProjectCommands: gradle/maven branches", () => {
	it("android gradle project → language gradle, testDebugUnitTest, compile build", () => {
		gradleAndroidProject();
		const cmds = detectProjectCommands(root);
		expect(cmds.language).toBe("gradle");
		expect(cmds.test?.join(" ")).toContain("testDebugUnitTest");
		expect(cmds.build?.join(" ")).toContain("compileDebugSources");
		expect(cmds.test?.[0]).toContain("gradlew");
	});

	it("pure JVM gradle project (kts, no android) → language gradle, plain test task", () => {
		writeFileSync(join(root, "settings.gradle.kts"), 'include ":lib"\n');
		writeFileSync(join(root, "build.gradle.kts"), "plugins { kotlin(\"jvm\") }\n");
		const cmds = detectProjectCommands(root);
		expect(cmds.language).toBe("gradle");
		expect(cmds.test?.join(" ")).toBe("gradle test");
		expect(cmds.build).toBeDefined();
	});

	it("maven pom.xml → language maven, mvn test", () => {
		writeFileSync(join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
		const cmds = detectProjectCommands(root);
		expect(cmds.language).toBe("maven");
		expect(cmds.test?.join(" ")).toContain("mvn");
		expect(cmds.test?.join(" ")).toContain("test");
	});
});

// ─── 2. Scoped RED plans per test class (conventions data) ──────────────────

describe("v0.3.31 — conventions: gradle/maven scoped plans", () => {
	it("derives the test-class FQN and scopes the android unit-test task with --tests", () => {
		gradleAndroidProject();
		const target = "app/src/test/java/com/lmyby/ankiquicker/data/plan/ExportElementResolverTest.kt";
		const plans = conventionPlansFor(root, [target]);
		expect(plans).toHaveLength(1);
		expect(plans[0].conventionId).toBe("gradle");
		const argv = plans[0].argv.join(" ");
		expect(argv).toContain("testDebugUnitTest");
		expect(argv).toContain("--tests com.lmyby.ankiquicker.data.plan.ExportElementResolverTest");
		// cwd must be the OWNING module (app/), not the repo root
		expect(plans[0].cwd).toBe(join(root, "app"));
		// the ROOT wrapper is invoked when the module has none
		expect(plans[0].argv[0]).toBe(join(root, "gradlew"));
		// structured channel declared as data
		expect(plans[0].channel).toMatchObject({ format: "junit-xml" });
	});

	it("pure-jvm module uses the plain test task and falls back to `gradle` without a wrapper", () => {
		writeFileSync(join(root, "settings.gradle"), 'include ":lib"\n');
		mkdirSync(join(root, "lib", "src", "test", "java", "com", "x"), { recursive: true });
		writeFileSync(join(root, "lib", "build.gradle"), "plugins { id 'java' }\n");
		const plans = conventionPlansFor(root, ["lib/src/test/java/com/x/YTest.java"]);
		expect(plans).toHaveLength(1);
		expect(plans[0].argv.join(" ")).toBe("gradle test --tests com.x.YTest");
		expect(plans[0].cwd).toBe(join(root, "lib"));
	});

	it("non-derivable layout still produces a module-level plan (never zero plans)", () => {
		gradleAndroidProject();
		const plans = conventionPlansFor(root, ["app/some/weird/Test.kt"]);
		expect(plans).toHaveLength(1);
		expect(plans[0].argv.join(" ")).not.toContain("--tests");
	});

	it("maven derives -Dtest= FQN against the pom module", () => {
		writeFileSync(join(root, "pom.xml"), "<project/>");
		mkdirSync(join(root, "src", "test", "java", "com", "z"), { recursive: true });
		const plans = conventionPlansFor(root, ["src/test/java/com/z/WidgetTest.java"]);
		expect(plans).toHaveLength(1);
		expect(plans[0].argv.join(" ")).toContain("-Dtest=com.z.WidgetTest");
	});
});

// ─── 3. Universal classification: JVM prose NEVER classifies ─────────────────

describe("v0.3.31 — classifyFromEvidence: jvm console reality", () => {
	const T = "app/src/test/java/com/x/ATest.kt";

	it("BUILD SUCCESSFUL + exit 0 with NO XML → unknown (green REQUIRES structured evidence)", () => {
		// Bazel principle: prose has no significance. A real gradle run writes
		// build/test-results/**/TEST-*.xml; the harvest+counts path confirms
		// green. The console banner alone must never confirm green.
		expect(classifyFromEvidence(true, null)).toBe("unknown");
	});

	it("test failures in PROSE only → unknown; the same counts from XML → red", () => {
		const gradleOut = "> Task :app:testDebugUnitTest FAILED\n122 tests completed, 122 failed\nBUILD FAILED";
		void gradleOut;
		expect(classifyFromEvidence(false, null)).toBe("unknown");
		expect(classifyFromEvidence(false, { tests: 122, failures: 122, errors: 0, skipped: 0 })).toBe("red");
	});

	it("compile errors (ANY kind, incl. greenfield) → unknown without XML — red/broken split needs structured evidence; the judge routes (allow-scaffold) own the escape", () => {
		const kotlinGreenfield = "e: file:///x/ATest.kt:(20, 9): Unresolved reference: ExportElementResolver\n> Compilation error. See log for more details";
		void kotlinGreenfield;
		expect(classifyFromEvidence(false, null)).toBe("unknown");
		// compile failure in reality = no fresh XML → harvest returns null →
		// unknown → fail-closed retry → judge routes (fix-environment /
		// allow-scaffold per v0.3.24/v0.3.29), never a phantom verdict.
	});

	it("review-2 F3 zero-match stays unknown (now for the universal reason: no per-test evidence)", () => {
		expect(classifyFromEvidence(false, null)).toBe("unknown");
	});

	it("stub-throw RED via XML <error> counts → red (v0.3.30 F4 semantics preserved)", () => {
		expect(classifyFromEvidence(false, { tests: 3, failures: 0, errors: 3, skipped: 0 })).toBe("red");
	});
});

// ─── 4. runRedCheck e2e: fake gradlew writing JUnit XML (AnkiQuick shape) ────

describe("v0.3.31 — runRedCheck e2e via conventions + XML", () => {
	it("fake gradlew task writes TEST-*.xml under build/test-results → RED confirmed", () => {
		gradleAndroidProject();
		const target = "app/src/test/java/com/x/ATest.kt";
		mkdirSync(join(root, "app", "src", "test", "java", "com", "x"), { recursive: true });
		writeFileSync(join(root, target), "class ATest\n");
		// fake gradlew: on `testDebugUnitTest --tests ...` write fresh XML then exit 1
		const xml = `<?xml version='1.0'?><testsuite name="com.x.ATest" tests="5" failures="0" errors="5" skipped="0"></testsuite>`;
		const script = [
			"#!/bin/sh",
			`mkdir -p "$PWD/app/build/test-results/testDebugUnitTest"`,
			`cat > "$PWD/app/build/test-results/testDebugUnitTest/TEST-com.x.ATest.xml" <<'X'`,
			xml,
			"X",
			"exit 1",
		].join("\n");
		writeFileSync(join(root, "gradlew"), script);
		chmodSync(join(root, "gradlew"), 0o755);
		const status = runRedCheck(root, [target], { timeoutMs: 30_000 });
		expect(status).toBe("red");
	});

	it("fake gradlew green path (exit 0, passing XML) → green", () => {
		gradleAndroidProject();
		const target = "app/src/test/java/com/x/BTest.kt";
		mkdirSync(join(root, "app", "src", "test", "java", "com", "x"), { recursive: true });
		writeFileSync(join(root, target), "class BTest\n");
		const xml = `<?xml version='1.0'?><testsuite name="com.x.BTest" tests="4" failures="0" errors="0" skipped="0"></testsuite>`;
		const script = [
			"#!/bin/sh",
			`mkdir -p "$PWD/app/build/test-results/testDebugUnitTest"`,
			`cat > "$PWD/app/build/test-results/testDebugUnitTest/TEST-com.x.BTest.xml" <<'X'`,
			xml,
			"X",
			"exit 0",
		].join("\n");
		writeFileSync(join(root, "gradlew"), script);
		chmodSync(join(root, "gradlew"), 0o755);
		expect(runRedCheck(root, [target], { timeoutMs: 30_000 })).toBe("green");
	});
});
