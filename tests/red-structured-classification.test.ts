/**
 * v0.3.30 Layer A wiring — runRedCheck classifies from STRUCTURED results
 * (JUnit XML) before falling back to console regexes, end-to-end.
 *
 * The fixture is a REAL tmp gradle project whose `gradlew` is a fake shell
 * script that writes a JUnit XML into build/test-results/test/ and exits 1 —
 * deterministically reproducing the AnkiQuick shape (tests ran, 122 failed)
 * with zero network, zero real gradle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRedCheck } from "../src/build-runner/gates.ts";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "sd-xmlrun-")); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

function fakeGradleProject(xml: string, exitCode: number): void {
	writeFileSync(join(root, "settings.gradle"), 'include ":app"\n');
	writeFileSync(join(root, "build.gradle"), "");
	mkdirSync(join(root, "app", "src", "test", "java", "com", "x"), { recursive: true });
	writeFileSync(join(root, "app", "build.gradle"), "plugins { id 'com.android.application' }\n");
	const gw = join(root, "gradlew");
	writeFileSync(gw, [
		"#!/bin/sh",
		'mkdir -p "$(dirname "$0")/app/build/test-results/testDebugUnitTest"',
		'cat > "$(dirname "$0")/app/build/test-results/testDebugUnitTest/TEST-com.x.ATest.xml" <<\'XMLEOF\'',
		xml,
		"XMLEOF",
		`exit ${exitCode}`,
		"",
	].join("\n"));
	chmodSync(gw, 0o755);
}

const FAILING_XML = `<?xml version="1.0"?><testsuite name="com.x.ATest" tests="3" failures="3" errors="0" skipped="0"><testcase name="a"><failure message="boom"/></testcase></testsuite>`;
const ERROR_XML = `<?xml version="1.0"?><testsuite name="com.x.ATest" tests="2" failures="0" errors="2" skipped="0"><testcase name="a"><error message="NPE"/></testcase></testsuite>`;
const PASSING_XML = `<?xml version="1.0"?><testsuite name="com.x.ATest" tests="3" failures="0" errors="0" skipped="0"/>`;

describe("v0.3.30 A — runRedCheck XML-first classification", () => {
	it("failures>0 in harvested XML → red, even though gradle exited 1", () => {
		fakeGradleProject(FAILING_XML, 1);
		const status = runRedCheck(root, ["app/src/test/java/com/x/ATest.kt"], { timeoutMs: 30_000 });
		expect(status).toBe("red");
	});

	it("errors>0 in harvested XML → red (review-2 F4: a stub-throwing production method surfaces as <error>, the textbook greenfield RED)", () => {
		fakeGradleProject(ERROR_XML, 1);
		const status = runRedCheck(root, ["app/src/test/java/com/x/ATest.kt"], { timeoutMs: 30_000 });
		expect(status).toBe("red");
	});

	it("clean XML + exit 0 → green", () => {
		fakeGradleProject(PASSING_XML, 0);
		const status = runRedCheck(root, ["app/src/test/java/com/x/ATest.kt"], { timeoutMs: 30_000 });
		expect(status).toBe("green");
	});

	it("no XML produced → falls back to console classification (gradle BUILD SUCCESSFUL → green)", () => {
		// a gradlew that only prints and exits 0 with no XML anywhere
		writeFileSync(join(root, "settings.gradle"), 'include ":app"\n');
		writeFileSync(join(root, "build.gradle"), "");
		mkdirSync(join(root, "app", "src", "test", "java", "com", "x"), { recursive: true });
		writeFileSync(join(root, "app", "build.gradle"), "plugins { id 'com.android.application' }\n");
		const gw = join(root, "gradlew");
		writeFileSync(gw, "#!/bin/sh\necho 'BUILD SUCCESSFUL in 1s'\nexit 0\n");
		chmodSync(gw, 0o755);
		const status = runRedCheck(root, ["app/src/test/java/com/x/ATest.kt"], { timeoutMs: 30_000 });
		expect(status).toBe("green");
	});
});
