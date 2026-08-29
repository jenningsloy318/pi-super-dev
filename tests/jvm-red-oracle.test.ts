/**
 * v0.3.30 F1 — JVM/Gradle/Maven deterministic RED-oracle support.
 *
 * Root cause (run 2026-08-28T16-09-12-785Z, AnkiQuick): the oracle has ZERO
 * JVM awareness — detectProjectCommands falls through to "mixed" for a Gradle
 * project, runRedCheck builds no plans, and every try fails as `unknown`
 * forever while the tdd agent's OWN gradle runs prove 127 tests / 122 failing.
 * These tests pin the JVM capability BEFORE it exists (RED first).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectCommands } from "../src/build-runner/detect.ts";
import { classifyRedStatus, gradleRedCheckPlans, mavenRedCheckPlans } from "../src/build-runner/gates.ts";

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

// ─── 1. detectProjectCommands recognizes JVM manifests ─────────────────────

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

// ─── 2. Scoped RED plans per test class ─────────────────────────────────────

describe("v0.3.30 F1 — gradleRedCheckPlans / mavenRedCheckPlans", () => {
	it("derives the test-class FQN and scopes the android unit-test task with --tests", () => {
		gradleAndroidProject();
		const target = "app/src/test/java/com/lmyby/ankiquicker/data/plan/ExportElementResolverTest.kt";
		const plans = gradleRedCheckPlans(root, [target]);
		expect(plans).toHaveLength(1);
		const argv = plans[0].argv.join(" ");
		expect(argv).toContain("testDebugUnitTest");
		expect(argv).toContain("--tests com.lmyby.ankiquicker.data.plan.ExportElementResolverTest");
		// cwd must be the OWNING module (app/), not the repo root
		expect(plans[0].cwd).toBe(join(root, "app"));
		// the ROOT wrapper is invoked when the module has none
		expect(plans[0].argv[0]).toBe(join(root, "gradlew"));
	});

	it("pure-jvm module uses the plain test task and falls back to `gradle` without a wrapper", () => {
		writeFileSync(join(root, "settings.gradle"), 'include ":lib"\n');
		mkdirSync(join(root, "lib", "src", "test", "java", "com", "x"), { recursive: true });
		writeFileSync(join(root, "lib", "build.gradle"), "plugins { id 'java' }\n");
		const plans = gradleRedCheckPlans(root, ["lib/src/test/java/com/x/YTest.java"]);
		expect(plans).toHaveLength(1);
		expect(plans[0].argv.join(" ")).toBe("gradle test --tests com.x.YTest");
		expect(plans[0].cwd).toBe(join(root, "lib"));
	});

	it("non-derivable layout still produces a module-level plan (never zero plans)", () => {
		gradleAndroidProject();
		const plans = gradleRedCheckPlans(root, ["app/some/weird/Test.kt"]);
		expect(plans).toHaveLength(1);
		expect(plans[0].argv.join(" ")).not.toContain("--tests");
	});

	it("maven derives -Dtest= FQN against the pom module", () => {
		writeFileSync(join(root, "pom.xml"), "<project/>");
		mkdirSync(join(root, "src", "test", "java", "com", "z"), { recursive: true });
		const plans = mavenRedCheckPlans(root, ["src/test/java/com/z/WidgetTest.java"]);
		expect(plans).toHaveLength(1);
		expect(plans[0].argv.join(" ")).toContain("-Dtest=com.z.WidgetTest");
	});
});

// ─── 3. classifyRedStatus JVM markers ───────────────────────────────────────

describe("v0.3.30 F1 — classifyRedStatus jvm branch", () => {
	const T = "app/src/test/java/com/x/ATest.kt";

	it("BUILD SUCCESSFUL + exit 0 → green (gradle + maven shapes)", () => {
		expect(classifyRedStatus("gradle", "\nBUILD SUCCESSFUL in 4s\n", true, { cwd: root, targets: [T] })).toBe("green");
		expect(classifyRedStatus("maven", "\n[INFO] BUILD SUCCESS\n", true, { cwd: root, targets: [T] })).toBe("green");
	});

	it("test failures → red (gradle task-FAILED + tests-completed summary; maven surefire)", () => {
		const gradleOut = "> Task :app:testDebugUnitTest FAILED\n\nATest > usesElement[P1] FAILED\n    org.opentest4j.AssertionFailedError at ATest.kt:42\n\n122 tests completed, 122 failed\n\nBUILD FAILED in 2m";
		expect(classifyRedStatus("gradle", "\n" + gradleOut + "\n", false, { cwd: root, targets: [T] })).toBe("red");
		const mvnOut = "[ERROR] Tests run: 9, Failures: 9, Errors: 0, Skipped: 0\n[INFO] BUILD FAILURE";
		expect(classifyRedStatus("maven", "\n" + mvnOut + "\n", false, { cwd: root, targets: [T] })).toBe("red");
	});

	it("compile errors of OTHER kinds → broken (real KGP banner/line shapes)", () => {
		// real KGP: `> Compilation error. See log for more details` banner, no "error:" token
		const syntaxKotlin = "e: file:///x/ATest.kt:12:5 Expecting a member declaration\n> Task :app:compileDebugKotlin FAILED\n\n> Compilation error. See log for more details";
		expect(classifyRedStatus("gradle", "\n" + syntaxKotlin + "\n", false, { cwd: root, targets: [T] })).toBe("broken");
		const syntaxJava = "ATest.java:[9,5] error: ';' expected\n[ERROR] COMPILATION ERROR";
		expect(classifyRedStatus("maven", "\n" + syntaxJava + "\n", false, { cwd: root, targets: [T] })).toBe("broken");
	});

	it("greenfield: compile failed with ONLY missing-symbol errors → red (run 12-51-40 trap; real KGP + maven shapes)", () => {
		// real KGP unresolved-reference shape: e: file://…:(20, 9): Unresolved reference: X — no "error:" token
		const kotlinGreenfield = "e: file:///x/ATest.kt:(20, 9): Unresolved reference: ExportElementResolver\n> Task :app:compileDebugKotlin FAILED\n\n> Compilation error. See log for more details";
		expect(classifyRedStatus("gradle", "\n" + kotlinGreenfield + "\n", false, { cwd: root, targets: [T] })).toBe("red");
		// real maven-compiler-plugin reformat: [ERROR] /path/A.java:[7,9] cannot find symbol (no lowercase "error:" token)
		const javaGreenfield = "[ERROR] /x/ATest.java:[7,9] cannot find symbol\n[ERROR]   symbol:   class ExportFieldResolver\n[INFO] 1 error\n[INFO] BUILD FAILURE";
		expect(classifyRedStatus("maven", "\n" + javaGreenfield + "\n", false, { cwd: root, targets: [T] })).toBe("red");
		const javaGreenfieldPlain = "ATest.java:[7,9] error: cannot find symbol\n  symbol:   class ExportFieldResolver\n1 error";
		expect(classifyRedStatus("maven", "\n" + javaGreenfieldPlain + "\n", false, { cwd: root, targets: [T] })).toBe("red");
	});

	it("review-2 F3: --tests filter matching ZERO tests → unknown (not a phantom red)", () => {
		const zeroMatch = "> Task :app:testDebugUnitTest FAILED\nNo tests found for given includes: [com.x.MissingTest]\nBUILD FAILED in 3s";
		expect(classifyRedStatus("gradle", "\n" + zeroMatch + "\n", false, { cwd: root, targets: [T] })).toBe("unknown");
		const mvnZero = "[ERROR]   No tests matching pattern: com.x.MissingTest\n[INFO] BUILD FAILURE";
		expect(classifyRedStatus("maven", "\n" + mvnZero + "\n", false, { cwd: root, targets: [T] })).toBe("unknown");
	});
});
