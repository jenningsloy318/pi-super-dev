// Coverage gate (v0.3.49): deterministic post-GREEN coverage enforcement for
// the TARGET program under development. The user mandate (2026-08-31): test
// coverage is a HARD GATE at ≥85% lines on phase production files, striving
// for 100%. Measurable runner families gate hard; unmeasurable ones degrade
// to a loud actionable advisory (never a silent pass, never a dead-lock).
//
// Ground-truthed output formats (2026-08-31, /tmp lanes — see
// docs/testing-strategy.md §L2 "never trust a recalled format"):
//   vitest  --coverage.reporter=json-summary → coverage-summary.json
//           { "total": {...}, "/abs/file.ts": { lines: {pct, covered, total}, ... } }
//   node --test --experimental-test-coverage --test-reporter=tap → TAP comment
//           table; directory rows carry empty pcts, file rows carry the tree
//           path via indentation; KNOWN ARTIFACT: single-line function bodies
//           report as covered lines (V8 span attribution) — funcs% is honest,
//           we gate on lines% and log funcs% alongside.
//   go test -coverprofile=cover.out → "mode: set" + "f.go:l.c,l.c numStmts count"
//           per-file statement coverage = Σ(count>0 ? numStmts) / Σ numStmts.

import { spawnSync } from "node:child_process"; // used by spawnCoverageCommand
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveRunnerCommand, type TestRunnerSpec } from "./runner-discovery.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

/** Hard-gate floor for phase production-file line coverage (percent). */
export const DEFAULT_COVERAGE_THRESHOLD = 85;

/** Kill switch: SUPER_DEV_NO_COVERAGE_GATE=1 skips the gate entirely. */
export function coverageGateEnabled(): boolean {
	return process.env.SUPER_DEV_NO_COVERAGE_GATE !== "1";
}

/** SUPER_DEV_COVERAGE_THRESHOLD overrides the default floor (0–100). */
export function coverageThreshold(): number {
	const raw = Number(process.env.SUPER_DEV_COVERAGE_THRESHOLD);
	return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : DEFAULT_COVERAGE_THRESHOLD;
}

// ─── Recipe selection ────────────────────────────────────────────────────────

export type CoverageRecipe = "vitest" | "node-test" | "go";

/** Which deterministic coverage recipe a validated runner command supports.
 *  Null = unmeasurable family (pytest/jest/gradle/…) → actionable advisory. */
export function pickCoverageRecipe(command: string): CoverageRecipe | null {
	const argv = command.split(/\s+/).filter(Boolean);
	const lower = argv.map((a) => a.toLowerCase());
	if (lower.some((a) => a === "vitest" || a.endsWith("/vitest"))) return "vitest";
	if (lower.some((a) => a === "go") && lower.includes("test")) return "go";
	if (lower.some((a) => a === "node" || a.endsWith("/node")) && lower.some((a) => a === "--test" || a.startsWith("--test"))) return "node-test";
	return null;
}

// ─── Result model ────────────────────────────────────────────────────────────

export interface PerFileCoverage {
	file: string;          // normalized path as reported by the tool
	linesPct: number;
	functionsPct?: number;
	branchesPct?: number;
	uncoveredHint?: string; // e.g. "6-9" (node TAP) — best-effort
}

export interface CoverageGateResult {
	status: "pass" | "below-threshold" | "unmeasurable" | "skipped";
	recipe?: CoverageRecipe;
	threshold: number;
	/** Aggregate lines % over the phase's matched production files (undefined
	 *  unless measured). vitest/go are true weighted counts; node-test
	 *  approximates with the per-file mean (the TAP table carries no counts). */
	linesPct?: number;
	perFile: PerFileCoverage[];
	detail: string;
}

// ─── Path matching ───────────────────────────────────────────────────────────

/** Repo-path normalizer: forward slashes, no leading ./. */
export function normPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True when a tool-reported path refers to one of the phase's production
 *  files. Accepts equality, absolute-prefix, and either-direction
 *  slash-anchored suffix (the same semantics runnerCoversTargets uses —
 *  tools report repo-relative, absolute, or module-prefixed paths). */
export function coverageMatches(reported: string, phaseFiles: string[]): boolean {
	const r = normPath(reported);
	for (const pf of phaseFiles) {
		const p = normPath(pf);
		if (r === p) return true;
		if (isAbsolute(r) && r.endsWith("/" + p)) return true;
		if (r.endsWith("/" + p) || p.endsWith("/" + r)) return true;
	}
	return false;
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

/** Parse a go coverprofile (mode: set/count/atomic). Per-file statement
 *  coverage from Σ covered / Σ total statements. Pure — fixture-testable. */
export function parseGoCoverProfile(text: string): Map<string, { covered: number; total: number }> {
	const out = new Map<string, { covered: number; total: number }>();
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("mode:")) continue;
		const m = /^(.+?):\d+\.\d+,\d+\.\d+\s+(\d+)\s+(\d+)$/.exec(line.trim());
		if (!m) continue;
		const file = m[1] as string;
		const stmts = Number(m[2]);
		const count = Number(m[3]);
		const acc = out.get(file) ?? { covered: 0, total: 0 };
		acc.total += stmts;
		if (count > 0) acc.covered += stmts;
		out.set(file, acc);
	}
	return out;
}

/** Parse the node --test TAP coverage table. Directory rows carry empty
 *  percentages and nest by indentation; file rows report basename + pcts.
 *  Returns normalized relative paths ("src/big.js"). Pure — fixture-testable. */
export function parseNodeTapCoverage(tapText: string): PerFileCoverage[] {
	const rows: PerFileCoverage[] = [];
	const dirStack: Array<{ depth: number; name: string }> = [];
	for (const line of tapText.split("\n")) {
		if (!line.startsWith("#")) continue;
		const body = line.slice(1);
		// Data rows: "# name | pct | pct | pct | hint". Pipe count separates
		// them from prose comments ("# tests 4" has no pipes).
		if (!body.includes("|")) continue;
		const m = /^(\s*)(.*?)\s*\|\s*([0-9.]+)?\s*\|\s*([0-9.]+)?\s*\|\s*([0-9.]+)?\s*\|\s*(.*)$/.exec(body);
		if (!m) continue;
		const indent = (m[1] ?? "").length;
		const name = (m[2] ?? "").trim();
		const lines = m[3];
		if (!name || name === "file" || name.startsWith("all files")) continue;
		const depth = Math.max(0, Math.floor(indent / 2));
		if (lines === undefined) {
			// directory row — rebuild the stack at this depth
			while (dirStack.length > depth) dirStack.pop();
			dirStack[depth] = { depth, name };
			continue;
		}
		while (dirStack.length > depth) dirStack.pop();
		const dir = dirStack.slice(0, depth).map((d) => d.name).join("/");
		rows.push({
			file: dir ? `${dir}/${name}` : name,
			linesPct: Number(lines),
			...(m[4] !== undefined ? { branchesPct: Number(m[4]) } : {}),
			...(m[5] !== undefined ? { functionsPct: Number(m[5]) } : {}),
			...((m[6] ?? "").trim() ? { uncoveredHint: (m[6] ?? "").trim() } : {}),
		});
	}
	return rows;
}

/** Parse vitest json-summary: every key except "total" is a file record. */
export function parseVitestSummary(json: Record<string, unknown>): PerFileCoverage[] {
	const rows: PerFileCoverage[] = [];
	for (const [key, value] of Object.entries(json)) {
		if (key === "total" || typeof value !== "object" || value === null) continue;
		const axes = value as Record<string, { pct?: number } | undefined>;
		const lines = axes.lines?.pct;
		if (typeof lines !== "number") continue;
		rows.push({
			file: key,
			linesPct: lines,
			...(typeof axes.functions?.pct === "number" ? { functionsPct: axes.functions.pct } : {}),
			...(typeof axes.branches?.pct === "number" ? { branchesPct: axes.branches.pct } : {}),
		});
	}
	return rows;
}

// ─── The gate ────────────────────────────────────────────────────────────────

export interface CoverageGateOptions {
	runnerSpec: TestRunnerSpec;   // the VALIDATED cached test runner (command + cwd)
	phaseFiles: string[];         // phase production files (declared ∪ claimed)
	testFiles: string[];          // RED/GREEN test files — never gated
	threshold?: number;
	timeoutMs?: number;
	log?: (message: string) => void;
}

/** Run the deterministic post-GREEN coverage gate. NEVER throws — every
 *  failure mode maps onto an honest status + actionable detail. */
export function runCoverageGate(worktreePath: string, opts: CoverageGateOptions): CoverageGateResult {
	const threshold = opts.threshold ?? coverageThreshold();
	const phaseFiles = Array.from(new Set(opts.phaseFiles.map(normPath)))
		.filter((f) => f && !opts.testFiles.map(normPath).includes(f));
	if (!coverageGateEnabled()) {
		return { status: "skipped", threshold, perFile: [], detail: "coverage gate disabled (SUPER_DEV_NO_COVERAGE_GATE=1)" };
	}
	if (!opts.runnerSpec.command.trim() || phaseFiles.length === 0) {
		return { status: "skipped", threshold, perFile: [], detail: "no runner command or no phase production files to gate" };
	}
	const recipe = pickCoverageRecipe(opts.runnerSpec.command);
	if (!recipe) {
		return {
			status: "unmeasurable", threshold, perFile: [],
			detail: `coverage is a hard gate (≥${threshold}% lines on phase production files) but this runner family has no deterministic recipe — wire coverage into the test command (vitest: install @vitest/coverage-v8; node --test: add --experimental-test-coverage; go: add -coverprofile) or set SUPER_DEV_NO_COVERAGE_GATE=1 consciously`,
		};
	}

	const tmp = mkdtempSync(join(tmpdir(), "super-dev-cov-"));
	try {
		const measured = measure(recipe, opts, worktreePath, tmp);
		if (measured.error) {
			return { status: "unmeasurable", recipe, threshold, perFile: [], detail: measured.error };
		}
		const perFile = measured.rows.filter((r) => coverageMatches(r.file, phaseFiles));
		if (perFile.length === 0) {
			return {
				status: "unmeasurable", recipe, threshold, perFile: [],
				detail: `coverage ran but reported none of this phase's production files (${phaseFiles.slice(0, 4).join(", ")}${phaseFiles.length > 4 ? ", …" : ""}) — check the runner's include patterns`,
			};
		}
		const linesPct = weightedLines(measured.counts, perFile);
		const worst = [...perFile].sort((a, b) => a.linesPct - b.linesPct).slice(0, 8);
		const worstLines = worst.map((w) => `${w.file} ${w.linesPct.toFixed(1)}%${w.uncoveredHint ? ` (uncovered ${w.uncoveredHint})` : ""}${typeof w.functionsPct === "number" ? ` funcs ${w.functionsPct.toFixed(1)}%` : ""}`);
		const funcsPct = perFile.filter((f) => typeof f.functionsPct === "number");
		const detail = perFile.length === 0 ? "" :
			`${linesPct.toFixed(1)}% lines across ${perFile.length} phase file(s) — worst: ${worstLines.join("; ")}${measured.counts ? "" : " (per-file mean; TAP table carries no line counts)"}`;
		if (linesPct < threshold) {
			return { status: "below-threshold", recipe, threshold, linesPct, perFile, detail: `coverage ${detail} — BELOW the ${threshold}% floor; add unit tests for the uncovered behavior` };
		}
		return { status: "pass", recipe, threshold, linesPct, perFile, detail: `coverage gate PASS — ${detail}${funcsPct.length ? `, aggregate funcs mean ${(funcsPct.reduce((s, f) => s + (f.functionsPct ?? 0), 0) / funcsPct.length).toFixed(1)}%` : ""}` };
	} finally {
		try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface Measured {
	rows: PerFileCoverage[];
	/** True covered/total line counts per reported file (vitest/go). Absent
	 *  for node TAP (table carries percentages only). */
	counts?: Map<string, { covered: number; total: number }>;
	error?: string;
}

function weightedLines(counts: Map<string, { covered: number; total: number }> | undefined, perFile: PerFileCoverage[]): number {
	if (counts && counts.size > 0) {
		let covered = 0, total = 0;
		for (const f of perFile) {
			const c = lookupCount(counts, f.file);
			if (c) { covered += c.covered; total += c.total; }
		}
		if (total > 0) return (100 * covered) / total;
	}
	// mean of per-file pcts (node TAP approximation)
	return perFile.reduce((s, f) => s + f.linesPct, 0) / perFile.length;
}

function lookupCount(counts: Map<string, { covered: number; total: number }>, file: string): { covered: number; total: number } | undefined {
	if (counts.has(file)) return counts.get(file);
	for (const [k, v] of counts) {
		if (k.endsWith("/" + file) || file.endsWith("/" + k)) return v;
	}
	return undefined;
}

/** True for POSITIONAL tokens that point at specific test FILES (not flags,
 *  not directories). Coverage must run the WHOLE suite: file-scoped commands
 *  would never pick up the new test files a coverage retry adds, and the gate
 *  would loop forever on an unraisable number. Directory positionals stay
 *  (a dir-scoped command already discovers new files inside it). */
function isFilePositional(token: string): boolean {
	if (token.startsWith("-") || token.endsWith("/")) return false;
	const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(token);
	const looksTesty = /\.(test|spec)\./i.test(token) || /(^|\/)(tests?|__tests__)\//i.test(token);
	return hasExtension && looksTesty;
}

function stripFilePositionals(argv: string[]): string[] {
	return argv.filter((a, i) => i === 0 || a.startsWith("-") || !isFilePositional(a));
}

function measure(recipe: CoverageRecipe, opts: CoverageGateOptions, worktreePath: string, tmp: string): Measured {
	const timeoutMs = opts.timeoutMs ?? 600_000;
	const resolved = resolveRunnerCommand(opts.runnerSpec, worktreePath);
	const cwd = resolved.cwd
		? (isAbsolute(resolved.cwd) ? resolved.cwd : join(worktreePath, resolved.cwd))
		: worktreePath;

	if (recipe === "vitest") {
		// Insert coverage flags BEFORE any standalone "--" separator (vitest
		// treats post-"--" positionals as test-file filters).
		const covFlags = ["--coverage.enabled", "--coverage.reporter=json-summary", `--coverage.reportsDirectory=${join(tmp, "vitest")}`];
		// Suite-wide: strip file-scoped positionals so tests added by a coverage
		// retry are picked up by vitest's default discovery (dir positionals stay).
		const stripped = stripFilePositionals(resolved.argv);
		const sepIdx = stripped.indexOf("--");
		const argv = sepIdx >= 0
			? [...stripped.slice(0, sepIdx), ...covFlags, ...stripped.slice(sepIdx)]
			: insertBeforeFirstPositional(stripped, ...covFlags);
		const run = spawnCoverageCommand(argv, cwd, timeoutMs);
		if (run.error || (run.status !== 0)) {
			const err = (run.stderr ?? "") + (run.error?.message ?? "");
			if (/coverage provider|@vitest\/coverage|Coverage report is disabled/i.test(err)) {
				return { rows: [], error: `vitest coverage provider unavailable — add @vitest/coverage-v8 (matching the vitest version) to the project's devDependencies (first stderr line: ${firstLine(err) || "none"})` };
			}
			return { rows: [], error: `vitest coverage run failed (exit ${run.status ?? "?"}): ${firstLine(err) || "no stderr"}` };
		}
		const summaryPath = join(tmp, "vitest", "coverage-summary.json");
		if (!existsSync(summaryPath)) return { rows: [], error: "vitest coverage ran but coverage-summary.json was not produced" };
		try {
			const json = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
			const counts = new Map<string, { covered: number; total: number }>();
			for (const [key, value] of Object.entries(json)) {
				if (key === "total" || typeof value !== "object" || value === null) continue;
				const lines = (value as { lines?: { covered?: number; total?: number } }).lines;
				if (typeof lines?.covered === "number" && typeof lines.total === "number" && lines.total > 0) {
					counts.set(key, { covered: lines.covered, total: lines.total });
				}
			}
			return { rows: parseVitestSummary(json), counts };
		} catch (e) {
			return { rows: [], error: `vitest coverage-summary.json unparseable: ${(e as Error).message}` };
		}
	}

	if (recipe === "node-test") {
		// Flags AFTER the first positional are IGNORED by node --test (verified
		// 2026-08-31: the coverage table silently never prints) — insert the
		// flag before the first non-flag token instead of appending.
		// Suite-wide (same rationale as the vitest branch): strip file-scoped
		// positionals; bare `node --test` then discovers per its default patterns.
		const stripped = stripFilePositionals(resolved.argv);
		const argv = stripped.some((a) => a === "--experimental-test-coverage")
			? stripped
			: insertBeforeFirstPositional(stripped, "--experimental-test-coverage");
		const run = spawnCoverageCommand(argv, cwd, timeoutMs);
		if (run.error || run.status === null) return { rows: [], error: `node coverage run failed to start: ${run.error?.message ?? "unknown"}` };
		const rows = parseNodeTapCoverage(run.stdout ?? "");
		if (rows.length === 0) {
			return { rows: [], error: `node --test coverage produced no parseable table (exit ${run.status}; first stderr: ${firstLine(run.stderr ?? "") || "none"}); node ≥ v20 with --experimental-test-coverage is required` };
		}
		return { rows };
	}

	// go
	const profile = join(tmp, "cover.out");
	const argv = resolved.argv.some((a) => a.startsWith("-coverprofile="))
		? resolved.argv
		: [...resolved.argv.slice(0, 2), `-coverprofile=${profile}`, ...resolved.argv.slice(2)];
	const run = spawnCoverageCommand(argv, cwd, timeoutMs);
	if (run.error || (run.status !== 0)) {
		return { rows: [], error: `go coverage run failed (exit ${run.status ?? "?"}): ${firstLine(run.stderr ?? "") || firstLine(run.stdout ?? "") || "no stderr"}` };
	}
	if (!existsSync(profile)) return { rows: [], error: "go test ran but the coverprofile was not produced" };
	const parsed = parseGoCoverProfile(readFileSync(profile, "utf8"));
	const rows: PerFileCoverage[] = [];
	const counts = new Map<string, { covered: number; total: number }>();
	for (const [file, c] of parsed) {
		if (c.total === 0) continue;
		// go profiles report "module/file.go" (or import-path-prefixed) paths
		const short = file.replace(/^[\w.-]+\//, (m, _r) => (file.includes("/") ? "" : m));
		const rel = short === file ? file : short;
		counts.set(file, c);
		counts.set(rel, c);
		rows.push({ file: rel, linesPct: (100 * c.covered) / c.total });
	}
	return { rows, counts };
}

/** Insert `flags` before the first positional (non-dash) argument — runners
 *  like `node --test` ignore flags that appear after a positional token. */
function insertBeforeFirstPositional(argv: string[], ...flags: string[]): string[] {
	const idx = argv.findIndex((a, i) => i > 0 && !a.startsWith("-"));
	return idx === -1 ? [...argv, ...flags] : [...argv.slice(0, idx), ...flags, ...argv.slice(idx)];
}

/** Execute a coverage command via bash with the project's node_modules/.bin
 *  prepended to PATH (bare `vitest`/`npx`-less forms stay runnable). */
function spawnCoverageCommand(argv: string[], cwd: string, timeoutMs: number) {
	const quoted = argv.map((a) => (/[\"\s]/.test(a) ? JSON.stringify(a) : a)).join(" ");
	const binDir = join(cwd, "node_modules", ".bin");
	const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
	return spawnSync("bash", ["-c", quoted], { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0]?.slice(0, 200) ?? "";
}
