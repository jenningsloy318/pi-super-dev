/**
 * v0.3.30 Layer A — universal STRUCTURED result classification (JUnit XML / TAP).
 *
 * Research grounding (docs/references + online): every serious harness either
 * curates per-repo test specs (swebench — 68 annotators for 1.6k instances),
 * lets the agent eyeball output (aider/codex/superpowers — no honest RED gate),
 * or parses STRUCTURED results deterministically (flake: "most ecosystems can
 * emit either JUnit XML, TAP, or TRX — immediate coverage beyond native
 * parsers"; GitLab/Harness CI: JUnit XML is the de-facto interchange).
 *
 * Gradle and Maven write JUnit XML to conventional paths by default — so for
 * the exact stack that killed run 2026-08-28T16-09-12-785Z, classification
 * should come from STRUCTURED counts (failures/errors/tests), with console
 * regexes demoted to fallback. These tests pin the parsers + precedence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJUnitXmlCounts, parseTapCounts, harvestJUnitXml, classifyFromStructuredCounts } from "../src/build-runner/result-parse.ts";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "sd-resparse-")); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

const GRADLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.lmyby.ankiquicker.data.plan.ExportElementResolverTest" tests="5" skipped="0" failures="3" errors="0" timestamp="2026-08-28T17:48:00" hostname="local" time="0.42">
  <testcase name="canonicalIds()" classname="com.lmyby...Test" time="0.1" />
  <testcase name="dictAliases()" classname="com.lmyby...Test" time="0.1"><failure message="expected: &lt;bold&gt; but was: &lt;null&gt;" type="org.opentest4j.AssertionFailedError">...</failure></testcase>
</testsuite>`;

const MAVEN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="com.z.WidgetTest" time="0.5" tests="4" errors="2" skipped="0" failures="0">
  <testcase name="renders" classname="com.z.WidgetTest" time="0.1" />
  <testcase name="saves" classname="com.z.WidgetTest" time="0.2"><error message="NPE" type="java.lang.NullPointerException">...</error></testcase>
</testsuite>`;

const NESTED_XML = `<?xml version="1.0"?>
<testsuites name="all" tests="10" failures="6" errors="0" skipped="1">
  <testsuite name="A" tests="5" failures="3" errors="0" skipped="0"/>
  <testsuite name="B" tests="5" failures="3" errors="0" skipped="1"/>
</testsuites>`;

const TAP = `TAP version 13
ok 1 resolves canonical ids
not ok 2 resolves dict aliases
# noise line
ok 3 skips nothing
not ok 4 pronunciation negatives`;

describe("v0.3.30 A — parseJUnitXmlCounts", () => {
	it("parses a gradle-shaped testsuite (failures vs errors distinguished)", () => {
		expect(parseJUnitXmlCounts(GRADLE_XML)).toEqual({ tests: 5, failures: 3, errors: 0, skipped: 0 });
	});
	it("parses a maven surefire testsuite (errors counted)", () => {
		expect(parseJUnitXmlCounts(MAVEN_XML)).toEqual({ tests: 4, failures: 0, errors: 2, skipped: 0 });
	});
	it("aggregates nested testsuites by SUM (flake parity: attribute may live on either level)", () => {
		expect(parseJUnitXmlCounts(NESTED_XML)).toEqual({ tests: 10, failures: 6, errors: 0, skipped: 1 });
	});
	it("returns null on non-XML garbage", () => {
		expect(parseJUnitXmlCounts("BUILD SUCCESSFUL in 3s")).toBeNull();
		expect(parseJUnitXmlCounts("")).toBeNull();
	});
});

describe("v0.3.30 A — parseTapCounts", () => {
	it("counts ok/not-ok lines", () => {
		expect(parseTapCounts(TAP)).toEqual({ tests: 4, failures: 2, errors: 0, skipped: 0 });
	});
	it("returns null when no TAP markers", () => {
		expect(parseTapCounts("hello world")).toBeNull();
	});
});

describe("v0.3.30 A — classifyFromStructuredCounts (precedence over console regexes)", () => {
	it("failures>0 → red (tests RAN and failed — the honest RED)", () => {
		expect(classifyFromStructuredCounts({ tests: 127, failures: 122, errors: 0, skipped: 5 }, false)).toBe("red");
	});
	it("errors>0 with tests>0 → red (review-2 F4: JUnit <error> = runtime exception thrown BY a test — the textbook stub-throw RED; TODO()/NotImplementedError report as <error>)", () => {
		expect(classifyFromStructuredCounts({ tests: 4, failures: 0, errors: 2, skipped: 0 }, false)).toBe("red");
	});
	it("all pass + exit 0 → green", () => {
		expect(classifyFromStructuredCounts({ tests: 9, failures: 0, errors: 0, skipped: 0 }, true)).toBe("green");
	});
	it("tests ran clean but exit non-zero → null (defer to console/other signals)", () => {
		expect(classifyFromStructuredCounts({ tests: 9, failures: 0, errors: 0, skipped: 0 }, false)).toBeNull();
	});
	it("zero tests executed + non-zero exit → broken (compile/collect never ran tests)", () => {
		expect(classifyFromStructuredCounts({ tests: 0, failures: 0, errors: 0, skipped: 0 }, false)).toBe("broken");
	});
});

describe("v0.3.30 A — harvestJUnitXml (conventional result paths, freshness filter)", () => {
	it("harvests gradle + surefire + failsafe paths newer than `since`, ignoring stale ones", () => {
		const since = Date.now() - 1000;
		mkdirSync(join(root, "app", "build", "test-results", "testDebugUnitTest"), { recursive: true });
		const fresh = join(root, "app", "build", "test-results", "testDebugUnitTest", "TEST-a.xml");
		writeFileSync(fresh, GRADLE_XML);
		const stale = join(root, "app", "build", "test-results", "testDebugUnitTest", "TEST-old.xml");
		writeFileSync(stale, GRADLE_XML);
		utimesSync(stale, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
		mkdirSync(join(root, "target", "surefire-reports"), { recursive: true });
		writeFileSync(join(root, "target", "surefire-reports", "TEST-b.xml"), MAVEN_XML);
		const found = harvestJUnitXml(root, since);
		expect(found.length).toBe(2);
		expect(found.some((x) => x.includes("TEST-a.xml"))).toBe(true);
		expect(found.some((x) => x.includes("surefire-reports"))).toBe(true);
	});
	it("returns [] for dirs with no result files (never throws)", () => {
		expect(harvestJUnitXml(root, 0)).toEqual([]);
	});
});
