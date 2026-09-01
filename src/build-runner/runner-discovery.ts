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

/** v0.3.57 review P2: WHERE the exec-family's pm-owned `--` sits. Prefix
 *  detection is restricted to the EMPIRICALLY-ESTABLISHED flag eaters —
 *  `npm exec` and `npx` (real-toolchain L2 evidence only; P9 environment
 *  assumptions asserted, not presumed). pnpm/yarn exec and bun x pass child
 *  args verbatim per their documented CLI grammar, so a ` -- ` inserted there
 *  would be forwarded to the child and corrupt its arg stream — those
 *  executors stay UNGUARDED (pre-v0.3.56 behavior, believed working).
 *  sepIdx = index of the pm-owned `--` when one already separates the tool
 *  from the first child dash token (POSITION-AWARE — a `--` after child dash
 *  tokens like `npm exec vitest run --reporter=tap -- x` does NOT mean
 *  guarded; npm would still eat `--reporter=tap`), else -1. Null when the
 *  argv is not an exec-family shape at all. Single source of truth shared by
 *  insertNpmExecGuard and the coverage gate (P2 one-builder rule). */
export interface ExecGuardInfo {
	/** Index of the child tool token. */
	toolIdx: number;
	/** Index of an existing pm-owned `--`, or -1 when unguarded. */
	sepIdx: number;
}
export function execGuardInfo(argv: string[]): ExecGuardInfo | null {
	if (argv.length < 2) return null;
	const pm = argv[0]!;
	let prefixEnd: number;
	if (pm === "npx") prefixEnd = 1;
	else if (pm === "npm" && argv[1] === "exec") prefixEnd = 2;
	else return null;
	if (prefixEnd >= argv.length) return null;
	// The child tool is the first non-flag token after the pm's own flags.
	let tool = prefixEnd;
	while (tool < argv.length && argv[tool]!.startsWith("-")) tool++;
	if (tool >= argv.length) return null;
	for (let i = tool + 1; i < argv.length; i++) {
		if (argv[i] === "--") return { toolIdx: tool, sepIdx: i };
		if (argv[i]!.startsWith("-")) return { toolIdx: tool, sepIdx: -1 };
	}
	return { toolIdx: tool, sepIdx: -1 };
}

/** v0.3.56 F1 (escape class B — unenumerated grammar; P2 single-helper rule):
 *  npm/npx exec forms CONSUME `--flag=value` tokens after the child tool as
 *  npm config ("npm warn Unknown cli config --reporter" — the v0.3.41
 *  incident on the string-command path). This is the ONE shared guard for
 *  every exec-family ARGV builder (conventions pmExec, baseline pmExecLocal):
 *  insert ` -- ` after the child tool token when child dash tokens follow and
 *  no pm-owned `--` already separates them. Mirrors the string-form guard in
 *  resolveRunnerCommand below (same position, same conditions); no-op on every
 *  other shape, so plain `npm test` and guardless argvs are byte-identical. */
export function insertNpmExecGuard(argv: string[]): string[] {
	const info = execGuardInfo(argv);
	if (!info || info.sepIdx >= 0) return argv;
	// Guard only when child flags actually follow the tool (else nothing to protect).
	if (!argv.slice(info.toolIdx + 1).some((a) => a.startsWith("-"))) return argv;
	return [...argv.slice(0, info.toolIdx + 1), "--", ...argv.slice(info.toolIdx + 1)];
}

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
	// npm exec/npx (and dlx variants) CONSUME `--flag=value` tokens after the
	// subcommand as npm config ("npm warn Unknown cli config --reporter" — run
	// 2026-08-30T08-17-36-563Z: the validated vitest TAP runner silently lost
	// --reporter=tap, the oracle got ANSI FAIL blocks instead of TAP, and every
	// RED try honestly degraded to red-unverified). Guard: insert ` -- ` right
	// after the package token so flags reach the child binary. Only for the
	// exec/dlx shapes where npm owns args; plain `npm test` is untouched.
	// v0.3.57 review P2: guard ONLY the empirically-established eaters (npm
	// exec, npx — same table as the argv guard); pnpm/yarn dlx pass child args
	// verbatim, so a ` -- ` there would be forwarded and corrupt the child.
	const npmExec = command.match(/^(npm\s+exec|npx)(\s+(?!--)\S+)?/);
	if (npmExec) {
		const subEnd = (npmExec.index ?? 0) + npmExec[0].length;
		const after = command.slice(subEnd);
		if (!/^\s*--(\s|$)/.test(after) && /(^|\s)-{1,2}[^\s]/.test(after)) {
			command = `${command.slice(0, subEnd)} --${after}`;
		}
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
	// v0.3.57 review P3: a degenerate spec (command "" or bare `cd` — only
	// reachable via corrupted/hand-edited cache; validation rejects empty
	// commands before caching) must fall through to the conventions fallback
	// upstream instead of blocking it with an unspawneable empty-argv plan.
	return argv.length > 0 ? [{ cwd, argv }] : [];
}

/** File-like tokens (paths or *.test.* / *.spec.* names) in a runner command.
 *  Suite-wide commands (`npm test`, `./gradlew test`) carry none and cover
 *  every phase (the F10 full-suite behavior). */
function fileLikeTokens(command: string): string[] {
	return splitShellCommand(command).filter((t) => (/\.(test|spec)\.[a-z0-9]+$/i.test(t) || (t.includes("/") && /\.[a-z0-9]+$/i.test(t))) && !t.startsWith("-"));
}

/** Go/Java-style package glob tokens (`./...`, `./pkg/...`, `pkg/a/...`).
 *  v0.3.52: these SCOPE the run to a subtree but carry no file extension, so
 *  the file-token grammar saw nothing and every package-glob runner read as
 *  suite-wide — a stale `go test ./pkg/a/...` runner would be trusted for a
 *  pkg/b phase (the v0.3.40 false-covers class reborn for Go). */
function packageGlobTokens(command: string): string[] {
	return splitShellCommand(command).filter((t) => !t.startsWith("-") && (t === "..." || (t.endsWith("...") && t.includes("/"))));
}

/** JVM selector values (`--tests X`, `--tests=X`, `-Dtest=X[,Y]`).
 *  v0.3.52: `--tests FooTest` / `-Dtest=FooTest` pin one class — the value has
 *  no path or file extension and the `-D` form starts with a flag dash, so
 *  both scoping forms were invisible to the token grammar (false covers for
 *  the Gradle/Maven worlds — AnkiQuick-class Kotlin projects). */
function selectorTokens(command: string): string[] {
	const out: string[] = [];
	for (const m of command.matchAll(/(?:--tests(?:=|\s+)|-D(?:test|tests)=)([\w.*?,\\[\]]+)/g)) {
		const v = m[1].replace(/^["']|["']$/g, "");
		for (const part of v.split(",")) if (part.trim()) out.push(part.trim());
	}
	return out;
}

/** Package-glob prefix match: `./pkg/a/...` covers targets under pkg/a. */
function packageGlobMatchesTarget(tok: string, t: string): boolean {
	const prefix = tok.replace(/^\.\//, "").replace(/\.{3}$/, "").replace(/\/$/, "");
	if (prefix === "") return true; // `./...` (or bare `...`) is the whole tree
	const nt = t.replace(/^\.\//, "");
	return nt === prefix || nt.startsWith(`${prefix}/`);
}

/** Selector match: `FooTest` covers `.../FooTest.kt` / `FooTest.java`; FQCN
 *  selectors match by suffix; wildcards (`Foo*Test`) match the basename stem. */
function selectorMatchesTarget(sel: string, t: string): boolean {
	const nt = t.replace(/^\.\//, "");
	const stem = nt.slice(nt.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "");
	const selStem = sel.slice(sel.lastIndexOf(".") + 1); // FQCN → simple class name
	if (sel === stem || selStem === stem || nt.endsWith(sel)) return true;
	if (/[*?]/.test(sel)) {
		const re = new RegExp(`^${sel.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
		return re.test(stem);
	}
	return false;
}

/** Convert a shell glob (only * and ? as metacharacters) to a RegExp.
 *  `*` and `?` do not cross `/` (path-glob semantics); a bare glob like
 *  `*.test.mjs` also matches target basenames via the `(^|/)` anchor. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
	return new RegExp(`(^|/)${escaped}$`);
}

function tokenMatchesTarget(tok: string, t: string): boolean {
	if (tok === t || t.endsWith(tok) || tok.endsWith(t)) return true;
	if (/[*?]/.test(tok)) return globToRegExp(tok).test(t);
	return false;
}

/** True when a cached runner command actually executes the claimed targets.
 *  Run 2026-08-30T08-30-00-814Z phase 2: the phase-1-validated runner pinned
 *  `… phase1-shell.test.mjs` and the oracle judged phase-2's engine tests
 *  against phase-1's GREEN output — a false `red-not-confirmed` verdict that
 *  burned retries. A runner that names specific test files covers a phase only
 *  when at least one claimed target matches (either direction, suffix-safe;
 *  glob tokens match by wildcard since a `tests/*.test.mjs` runner does
 *  execute every file in that directory); a suite-wide command always covers.
 *  v0.3.52: Go package globs (`./pkg/a/...`) and JVM selectors (`--tests X`,
 *  `-Dtest=X`) also SCOPE the run — they now participate in the same union so
 *  a stale subtree/class-scoped runner can no longer masquerade as suite-wide. */
export function runnerCoversTargets(spec: TestRunnerSpec, targets: string[]): boolean {
	const files = fileLikeTokens(spec.command);
	const pkgs = packageGlobTokens(spec.command);
	const sels = selectorTokens(spec.command);
	if (files.length === 0 && pkgs.length === 0 && sels.length === 0) return true;
	return targets.some((t) =>
		files.some((tok) => tokenMatchesTarget(tok, t))
		|| pkgs.some((tok) => packageGlobMatchesTarget(tok, t))
		|| sels.some((sel) => selectorMatchesTarget(sel, t)));
}
