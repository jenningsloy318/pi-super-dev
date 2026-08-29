/**
 * Universal STRUCTURED test-result classification (v0.3.30 Layer A).
 *
 * Research grounding (docs/references + 2026-08-29 online deep-dive):
 *   - flake (result-parsing lib): "Most ecosystems can emit either JUnit XML,
 *     TAP, or TRX. This gives immediate coverage beyond native parsers."
 *   - GitLab / Harness / cdviz CI docs: JUnit XML is the de-facto interchange
 *     format; Gradle and Maven write it to conventional paths BY DEFAULT
 *     (build/test-results/**, target/surefire-reports/).
 *   - RepoLaunch (arXiv 2505.23419) mandates per-test pass/fail detail as the
 *     verifiable contract for any proposed runner.
 *
 * Layering: STRUCTURED counts (this module) take PRECEDENCE over per-language
 * console regexes; the regexes stay as the fallback for runners that emit
 * nothing structured. Pure functions + bounded filesystem reads; no spawn;
 * never throws.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface TestResultCounts {
	tests: number;
	failures: number;
	errors: number;
	skipped: number;
}

export function sumResultCounts(list: TestResultCounts[]): TestResultCounts {
	const out: TestResultCounts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
	for (const c of list) {
		out.tests += c.tests;
		out.failures += c.failures;
		out.errors += c.errors;
		out.skipped += c.skipped;
	}
	return out;
}

function attrCount(tag: string, name: string): number {
	const m = new RegExp(`\\b${name}="(-?\\d+)"`, "i").exec(tag);
	return m ? Math.max(0, Number.parseInt(m[1], 10)) : 0;
}

/** Parse JUnit XML test counts. When a `<testsuites>` wrapper carries its own
 *  numeric totals those are used alone (they are the sum of children —
 *  summing both would double-count); otherwise every `<testsuite>` element is
 *  summed (Gradle/Surefire write one per file). Null when no numeric tests
 *  attribute exists anywhere (not XML / garbage). */
export function parseJUnitXmlCounts(text: string): TestResultCounts | null {
	const src = String(text ?? "");
	if (/<testsuites\b/i.test(src)) {
		const m = /<testsuites\b[^>]*\btests="(-?\d+)"/i.exec(src);
		if (m) {
			const wrapper = src.slice(m.index, src.indexOf(">", m.index) + 1);
			return { tests: attrCount(wrapper, "tests"), failures: attrCount(wrapper, "failures"), errors: attrCount(wrapper, "errors"), skipped: attrCount(wrapper, "skipped") };
		}
	}
	const counts: TestResultCounts[] = [];
	const suiteRe = /<testsuite\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = suiteRe.exec(src)) !== null) {
		counts.push({ tests: attrCount(m[0], "tests"), failures: attrCount(m[0], "failures"), errors: attrCount(m[0], "errors"), skipped: attrCount(m[0], "skipped") });
	}
	return counts.length > 0 ? sumResultCounts(counts) : null;
}

/** Parse TAP (Test Anything Protocol) counts from console output. TAP lines:
 *  `ok N <name>`, `not ok N <name>`; directives `# SKIP` (not a pass/failure)
 *  and `# TODO` (known-not-passing, NOT a failure). Null without plan lines. */
export function parseTapCounts(text: string): TestResultCounts | null {
	const lines = String(text ?? "").split(/\r?\n/);
	let tests = 0;
	let failures = 0;
	let skipped = 0;
	for (const raw of lines) {
		const line = raw.trim();
		if (/^not ok\s+\d+\b/.test(line)) {
			tests++;
			if (!/#\s*TODO\b/i.test(line)) failures++;
		} else if (/^ok\s+\d+\b/.test(line)) {
			tests++;
			if (/#\s*(SKIP|SKIPPED)\b/i.test(line)) skipped++;
		}
	}
	return tests > 0 ? { tests, failures, errors: 0, skipped } : null;
}

/** Deterministic classification from STRUCTURED counts (the oracle contract).
 *  Review-2 F4 corrected semantics: JUnit XML `<error>` entries are RUNTIME
 *  exceptions raised BY tests — the textbook greenfield stub-throw RED
 *  (TODO()/NotImplementedError; Gradle and Surefire report a thrown exception
 *  as `<error>`, not `<failure>`). Compile failures produce NO XML at all
 *  (tests===0 → broken via the failing exit). So: tests ran (tests>0) and
 *  any of them failed or errored → red; zero tests + failing exit → broken
 *  (compile/collect never reached the tests); clean + exit 0 → green.
 *  Null = no opinion (defer to console classification). */
export function classifyFromStructuredCounts(counts: TestResultCounts, exitOk: boolean): "red" | "green" | "broken" | null {
	if (counts.tests > 0 && (counts.failures > 0 || counts.errors > 0)) return "red";
	if (counts.tests === 0 && !exitOk) return "broken";
	if (exitOk && counts.tests > 0) return "green";
	return null;
}

const HARVEST_DIRS = new Set(["test-results", "surefire-reports", "failsafe-reports"]);
const HARVEST_PRUNE = new Set(["node_modules", ".git", ".gradle", "dist", "out", "vendor", ".cache"]);

/** Harvest fresh JUnit XML result files under `cwd` from conventional build
 *  output directories (build/test-results/**, target/surefire-reports/,
 *  target/failsafe-reports/). Only files modified at/after `sinceMs` count
 *  (a previous run's XML must never classify this one). Returns absolute
 *  paths, sorted; never throws; depth-bounded. */
export function harvestJUnitXml(cwd: string, sinceMs: number): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 8) return;
		let entries: Dirent[];
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (HARVEST_PRUNE.has(entry.name)) continue;
				walk(p, depth + 1);
				continue;
			}
			if (!entry.isFile() || !/\.xml$/i.test(entry.name)) continue;
			// Gradle nests a variant dir under test-results (…/test-results/
			// testDebugUnitTest/TEST-x.xml), so check the ancestor chain, not just
			// the immediate parent (bounded to 3 levels above the file).
			let anc = dirname(p);
			let inResultsTree = false;
			for (let i = 0; i < 4 && anc && anc !== "/"; i++) {
				if (HARVEST_DIRS.has(basename(anc))) { inResultsTree = true; break; }
				const next = dirname(anc);
				if (next === anc) break;
				anc = next;
			}
			if (!inResultsTree) continue;
			try {
				if (statSync(p).mtimeMs + 1 >= sinceMs) out.push(p);
			} catch { /* unreadable — skip */ }
		}
	};
	try { walk(resolve(cwd), 0); } catch { /* never throws */ }
	return out.sort();
}

/** Read + parse + SUM a list of harvested JUnit XML files (missing/unparsable
 *  files are skipped, not fatal). Returns null when nothing parses. */
export function sumHarvestedXml(files: string[]): TestResultCounts | null {
	const counts: TestResultCounts[] = [];
	for (const f of files) {
		try {
			const c = parseJUnitXmlCounts(readFileSync(f, "utf8"));
			if (c) counts.push(c);
		} catch { /* skip */ }
	}
	return counts.length > 0 ? sumResultCounts(counts) : null;
}

/** Parse `go test -json` (test2json) TestEvent lines. Terminal events carry
 *  Action pass/fail/skip with a Test name; package-level events have
 *  Test === "" and do not count as tests. A run that only emits package-level
 *  events (e.g. build failure) still yields counts (tests=0) so the
 *  classifier can distinguish broken from unknown. Null when no events parse
 *  (prose output). (v0.3.31 — gotestsum-grounded; the -json flag is the
 *  runner's own structured channel, no external tool needed.) */
export function parseGoTestJson(text: string): TestResultCounts | null {
	const out: TestResultCounts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
	let events = 0;
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line.startsWith("{")) continue;
		let ev: { Action?: string; Test?: string };
		try {
			ev = JSON.parse(line) as { Action?: string; Test?: string };
		} catch {
			continue;
		}
		if (typeof ev.Action !== "string") continue;
		events++;
		if (!ev.Test) continue; // package-level event
		if (ev.Action === "pass") out.tests++;
		else if (ev.Action === "fail") {
			out.tests++;
			out.failures++;
		} else if (ev.Action === "skip") {
			out.tests++;
			out.skipped++;
		}
	}
	return events > 0 ? out : null;
}

/** Parse a DECLARED count-line pattern (parser-as-data). The pattern must use
 *  named groups `failed` and `passed` (optional `skipped`, `total`). ALL
 *  matches are summed — runners like cargo print one summary line per test
 *  binary. Null when nothing matches (honest unknown). (v0.3.31.) */
export function parseCountsPattern(text: string, pattern: RegExp): TestResultCounts | null {
	const out: TestResultCounts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
	const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
	let matched = false;
	let m: RegExpExecArray | null;
	while ((m = re.exec(String(text ?? ""))) !== null) {
		if (m[0].length === 0) { re.lastIndex++; continue; }
		const g = m.groups ?? {};
		if (g.failed === undefined && g.passed === undefined && g.skipped === undefined && g.total === undefined) {
			continue; // matched the literal but no count group — not evidence
		}
		matched = true;
		const failed = Number.parseInt(g.failed ?? "0", 10) || 0;
		const passed = Number.parseInt(g.passed ?? "0", 10) || 0;
		const skipped = Number.parseInt(g.skipped ?? "0", 10) || 0;
		const total = g.total !== undefined ? Number.parseInt(g.total, 10) || 0 : failed + passed + skipped;
		out.failures += failed;
		out.skipped += skipped;
		out.tests += total;
	}
	if (!matched) return null;
	return out;
}
