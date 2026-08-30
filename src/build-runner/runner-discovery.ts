/**
 * Agent-proposed test runner: validated under the RepoLaunch contract, cached
 * for reuse (v0.3.30 Layer C).
 *
 * Research grounding: RepoLaunch / SWE-bench-Live (arXiv 2505.23419) — an
 * agent proposes the test command under a MANDATORY contract ("must output
 * detailed pass/fail status for each test item — iterate until it does"), and
 * the harness parses the results deterministically; SWE-Factory/SWE-Builder
 * persists successful setups in a Memory Pool for reuse. The LLM NEVER
 * decides pass/fail — it proposes a runner once; the harness verifies the
 * proposal by executing it and parsing structured evidence; the cached spec
 * then feeds deterministic plans for every later oracle run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { harvestJUnitXml, sumHarvestedXml, parseTapCounts, type TestResultCounts } from "./result-parse.ts";

export interface TestRunnerSpec {
	version: 1;
	/** Shell command that runs the project's tests (quote-aware split on use). */
	command: string;
	/** Working directory relative to the project root (default: root). */
	cwd?: string;
	resultFormat: "junit-xml" | "tap" | "console";
	note?: string;
	discoveredAt: string;
}

const CACHE_BASENAME = "test-runner.json";

/** Read the cached runner spec from a spec dir. Null when absent, malformed,
 *  or missing a non-empty command (never throws). */
export function readCachedTestRunner(specDir: string | undefined): TestRunnerSpec | null {
	if (!specDir) return null;
	try {
		const p = join(specDir, CACHE_BASENAME);
		if (!existsSync(p)) return null;
		const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		const command = typeof raw.command === "string" ? raw.command.trim() : "";
		if (!command) return null;
		const format = raw.resultFormat === "tap" || raw.resultFormat === "junit-xml" || raw.resultFormat === "console" ? raw.resultFormat : "console";
		return {
			version: 1,
			command,
			...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
			resultFormat: format,
			...(typeof raw.note === "string" ? { note: raw.note } : {}),
			discoveredAt: typeof raw.discoveredAt === "string" ? raw.discoveredAt : new Date().toISOString(),
		};
	} catch { return null; }
}

/** Persist a runner spec into the spec dir (harness-owned bookkeeping — the
 *  path is boundary-excluded as runtime evidence). Best-effort boolean. */
export function writeCachedTestRunner(specDir: string | undefined, spec: TestRunnerSpec): boolean {
	if (!specDir) return false;
	try {
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, CACHE_BASENAME), JSON.stringify(spec, null, "\t") + "\n");
		return true;
	} catch { return false; }
}

/** Quote-aware shell-word splitter (single + double quotes; no escape
 *  semantics beyond quote pairing — sufficient for runner commands). */
export function splitShellCommand(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (const ch of String(command ?? "")) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (/\s/.test(ch)) {
			if (cur) { out.push(cur); cur = ""; }
			continue;
		}
		cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

export interface RunnerValidation {
	ok: boolean;
	counts?: TestResultCounts;
	evidence: string;
}

/** Resolve a runner proposal to { cwd, argv } handling the shell compounds
 *  models actually emit (run 2026-08-30T04-53-26: the judge traced a healthy
 *  TAP proposal rejected because the command was `cd <dir> && node --test …` —
 *  splitShellCommand made argv[0]="cd", spawnSync ENOENTs WITHOUT throwing,
 *  stdout/stderr are null, and the oracle reports 'no parseable per-test
 *  evidence' while the suite is perfectly red):
 *   1. a leading `cd <dir> &&` (or `;`) becomes the cwd;
 *   2. remaining shell operators (outside quotes) force `bash -c` execution;
 *   3. otherwise the plain quote-aware split (byte-identical to before).
 *  A bare `cd` with nothing left is invalid (empty argv). */
export function resolveRunnerCommand(spec: TestRunnerSpec, projectRoot: string): { cwd: string; argv: string[] } {
	let command = String(spec.command ?? "").trim();
	let cwd = resolve(projectRoot, spec.cwd ?? ".");
	const cdMatch = command.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;|;)\s*([\s\S]*)$/);
	if (cdMatch) {
		const dir = cdMatch[1] ?? cdMatch[2] ?? cdMatch[3] ?? ".";
		cwd = isAbsolute(dir) ? dir : resolve(cwd, dir);
		command = cdMatch[4].trim();
	}
	// Detect shell operators OUTSIDE quotes by masking quoted spans first.
	const masked = command.replace(/"[^"]*"|'[^']*'/g, "");
	if (/[&&;|<>]|\$\(|\$\{/.test(masked)) {
		return { cwd, argv: command ? ["bash", "-c", command] : [] };
	}
	const argv = splitShellCommand(command);
	return { cwd, argv: argv[0] === "cd" ? [] : argv };
}
/** Machine-verify an LLM-proposed runner by EXECUTING it once and requiring
 *  parseable per-test evidence: fresh JUnit XML under conventional paths, or
 *  TAP plan lines on stdout/stderr. A command that only prints prose ("all
 *  fine, trust me") is rejected — the RepoLaunch mandatory contract. */
export function validateRunnerSpec(spec: TestRunnerSpec, projectRoot: string, timeoutMs: number, signal?: AbortSignal): RunnerValidation {
	const { cwd, argv } = resolveRunnerCommand(spec, projectRoot);
	if (argv.length === 0 || !argv[0]) return { ok: false, evidence: "empty command" };
	if (signal?.aborted) return { ok: false, evidence: "aborted before validation" };
	const startedMs = Date.now();
	let combined = "";
	try {
		const r = spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		combined = `\n${r.stdout ?? ""}\n${r.stderr ?? ""}`;
	} catch (err) {
		return { ok: false, evidence: `spawn failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
	}
	const xmlCounts = sumHarvestedXml(harvestJUnitXml(cwd, startedMs));
	if (xmlCounts && xmlCounts.tests > 0) return { ok: true, counts: xmlCounts, evidence: `junit-xml (${xmlCounts.tests} tests)` };
	const tapCounts = parseTapCounts(combined);
	if (tapCounts && tapCounts.tests > 0) return { ok: true, counts: tapCounts, evidence: `tap (${tapCounts.tests} tests)` };
	const tail = combined.trim().split("\n").slice(-4).join(" | ").slice(0, 300);
	return { ok: false, evidence: `no parseable per-test evidence${tail ? ` — tail: ${tail}` : ""}` };
}

/** Deterministic RED plans from a cached/validated runner spec.
 *  KNOWN LIMITATION (review-2 F10): the proposal executes UNSCOPED — the full
 *  suite runs and classification sums project-wide XML. A pre-existing
 *  unrelated failing test would show as red on a fresh clone and block GREEN
 *  confirmation. The discovery contract steers agents toward per-test-detail
 *  output precisely so future scoping (per-class filters persisted alongside
 *  the command) can be added without changing the cache format. */
export function dynamicRedCheckPlans(projectRoot: string, _targets: string[], spec: TestRunnerSpec): Array<{ cwd: string; argv: string[] }> {
	const { cwd, argv } = resolveRunnerCommand(spec, projectRoot);
	return [{ cwd, argv }];
}
