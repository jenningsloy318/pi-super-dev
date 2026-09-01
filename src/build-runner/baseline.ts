import { spawnSync } from "node:child_process";
import { superDevEnv } from "../render/super-dev-dir.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFailingNpmTestFiles } from "./scope.ts";
import { pmExec } from "./conventions.ts";

/**
 * B-6 — baseline comparison for out-of-scope (untouched) test failures.
 *
 * The phase gates grant `inScopePass` when EVERY failing test subject is
 * outside the implementer's touched-file/crate scope — the "all out-of-scope
 * ⇒ lenient pass" formula shared by the npm-family classifier
 * (`classifyOutOfScopeNpmErrors`, file granularity) and the rust classifier
 * (`classifyOutOfScopeErrors`, crate granularity). That formula silently
 * commits REGRESSIONS the implementer caused in untouched pre-existing test
 * files: a failure in an untouched file is treated as pre-existing without
 * ever checking that it actually was.
 *
 * This module closes the gap: when a gate is about to grant the lenient pass,
 * the SAME failing subjects are re-run in an isolated temp checkout of the
 * merge-base (the branch point vs the default branch):
 *   - subjects FAIL at baseline  ⇒ genuinely pre-existing ⇒ "preexisting"
 *     (lenient pass stands — now evidence-backed instead of assumed);
 *   - subjects PASS at baseline  ⇒ the failure is NEW on this branch ⇒
 *     "regression" (the gate must NOT grant the lenient pass);
 *   - anything ambiguous (no default branch, no merge-base, worktree spawn
 *     failure, baseline run timeout, unparseable output, cargo usage/network
 *     errors, SUPER_DEV_DISABLE_BASELINE_CHECK=1) ⇒ "unknown" and the caller
 *     degrades to the CURRENT lenient behavior — never stricter by accident
 *     and never more lenient than today.
 *
 * Cross-language by construction: node family (vitest/jest file subjects,
 * deps shared via a node_modules symlink), python (pytest file subjects via
 * the worktree's venv when present), go (package dirs of failing _test.go
 * subjects mapped through the baseline go.mod module path), rust (out-of-scope
 * crate subjects via `cargo test -p`).
 *
 * Results are memoized per (cwd, merge-base, language, sorted subjects) so a
 * multi-phase run that keeps hitting the same out-of-scope failures spawns at
 * most ONE baseline worktree per distinct signature. NEVER throws.
 */

export interface BaselineCheckResult {
	status: "preexisting" | "regression" | "unknown";
	evidence: string;
}

export type BaselineRunner = (
	cwd: string,
	argv: string[],
	opts: { timeoutMs: number },
) => { status: number | null; stdout: string; stderr: string; timedOut?: boolean };

export interface BaselineVerifyInput {
	/** Feature worktree (the pipeline's worktreePath). */
	cwd: string;
	/** Default branch (setup.defaultBranch) — without it nothing can be proven. */
	defaultBranch?: string;
	/** detectProjectCommands().language of the FEATURE worktree. */
	language: string;
	/** Package manager for the node family (npm/pnpm/yarn/bun/deno). */
	pm?: string;
	/**
	 * Failing subjects: test FILE paths (node/python/go) or crate names (rust).
	 * Repo-relative, forward slashes, no leading "./".
	 */
	subjects: string[];
	/** v0.2.9 G6: repo-relative subdir of the subject's module (nested go.mod/
	 *  Cargo.toml); the baseline command runs here. ""/undefined = repo root. */
	moduleSubdir?: string;
	signal?: AbortSignal;
	/** Per-run timeout for the baseline command (default 300s). */
	timeoutMs?: number;
	/** Injectable runner (tests). Defaults to spawnSync. */
	runner?: BaselineRunner;
}

const DEFAULT_BASELINE_TIMEOUT_MS = 300_000;
const CACHE_MAX = 100;

const baselineCache = new Map<string, BaselineCheckResult>();

/** Test hook — clears the memoization cache. */
export function clearBaselineCache(): void {
	baselineCache.clear();
}

function defaultRunner(cwd: string, argv: string[], opts: { timeoutMs: number }): { status: number | null; stdout: string; stderr: string; timedOut?: boolean } {
	const res = spawnSync(argv[0], argv.slice(1), {
		cwd,
		timeout: opts.timeoutMs,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		env: process.env,
	});
	if (res.error) {
		return { status: null, stdout: "", stderr: String(res.error.message ?? res.error) };
	}
	return {
		status: res.status ?? null,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
		...(res.signal === "SIGTERM" ? { timedOut: true } : {}),
	};
}

function gitOk(cwd: string, args: string[], timeoutMs = 30_000): string | null {
	try {
		const res = spawnSync("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: process.env });
		if (res.error || res.status !== 0) return null;
		return (res.stdout ?? "").trim();
	} catch {
		return null;
	}
}

/** Local copy of gates.ts readGoModuleName (avoids a gates↔baseline import cycle). */
function readGoModuleNameLocal(cwd: string): string | null {
	try {
		const goModPath = join(cwd, "go.mod");
		if (!existsSync(goModPath)) return null;
		const text = readFileSync(goModPath, "utf8") as string;
		const m = /^module\s+(\S+)/m.exec(text);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

/** v0.3.56 F1: delegates to the conventions pmExec (which owns the npm-exec
 *  `--` guard) — the old hand copy predated the guard and would have silently
 *  fed child flags to npm config. */
function pmExecLocal(pm: string, tool: string, args: string[]): string[] {
	return pmExec(pm, tool, args);
}

function shortSha(sha: string): string {
	return sha.slice(0, 8);
}

/** Unique + sorted subject list (stable cache key, stable evidence). */
function normalizeSubjects(subjects: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of subjects ?? []) {
		const v = String(s ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
		if (v && !seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out.sort();
}

/**
 * Interpret a baseline run for FILE-granular subjects (node/python/go).
 * All subjects fail at baseline ⇒ preexisting; a strict subset ⇒ regression
 * (the remainder is new); none matched but the output parsed ⇒ regression
 * (subjects pass at baseline); unparseable ⇒ unknown.
 */
function classifyFileSubjects(
	subjects: string[],
	failingAtBaseline: string[],
	label: string,
	strictPositive = false,
): BaselineCheckResult {
	if (failingAtBaseline.length === 0) {
		return { status: "unknown", evidence: `${label}: baseline failed but no recognizable failure markers` };
	}
	const base = new Set(failingAtBaseline.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")));
	const matched = subjects.filter((s) => base.has(s));
	const unmatched = subjects.filter((s) => !base.has(s));
	if (matched.length === subjects.length) {
		return { status: "preexisting", evidence: `${label}: all ${subjects.length} subject(s) also fail at baseline (${subjects.join(", ")})` };
	}
	if (matched.length === 0) {
		// Sweep-3 G40: on the whole-suite FALLBACK plan the runner may print in a
		// format we cannot parse (mocha/tap lack vitest/jest markers) — a partial
		// parse must NOT read as "subjects pass at baseline". Downgrade to unknown
		// unless every subject's failure was POSITIVELY observed.
		if (strictPositive) return { status: "unknown", evidence: `${label}: whole-suite fallback output not positively parsed for subjects (matched 0 of ${subjects.length}) — refusing the regression inference` };
		return { status: "regression", evidence: `${label}: subjects pass at baseline; baseline failures are unrelated (${failingAtBaseline.join(", ")})` };
	}
	// Sweep-3 CR-8 (scoped after the baseline-verify pin): the partial-match
	// regression inference is the PINNED contract for positively-parsed output
	// (vitest markers listing other failing files) — kept. The strict-positive
	// refusal applies ONLY to the matched==0 shape above (no subject positively
	// observed; mocha/tap partial parses).
	return {
		status: "regression",
		evidence: `${label}: ${unmatched.join(", ")} pass at baseline (only ${matched.join(", ")} fail there) — new failure(s) on this branch`,
	};
}

function parsePytestFailingFiles(output: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (raw: string) => {
		const p = raw.replace(/[\\]$/, "").replace(/\\/g, "/").replace(/^\.\//, "");
		if (p && !seen.has(p)) {
			seen.add(p);
			out.push(p);
		}
	};
	let m: RegExpExecArray | null;
	const failed = /^FAILED\s+(\S+?)(?=\s|::|$)/gm;
	while ((m = failed.exec(output)) !== null) add(m[1]);
	const collect = /^ERROR\s+collecting\s+(\S+)/gm;
	while ((m = collect.exec(output)) !== null) add(m[1]);
	return out;
}

function parseGoFailingPackages(output: string): string[] {
	const out: string[] = [];
	let m: RegExpExecArray | null;
	// [ \t] (NOT \s) after FAIL: a bare "FAIL\n" summary line must not match —
	// \s+ would swallow the newline and capture the NEXT line's leading "FAIL"
	// token, skipping the real `FAIL\t<pkg>\t<time>` package line entirely.
	const re = /^FAIL[ \t]+(\S+)/gm;
	while ((m = re.exec(output)) !== null) {
		const p = m[1].replace(/^FAIL$/, "").trim();
		if (p && p !== "[build failed]" && !p.startsWith("[")) out.push(p);
	}
	return out;
}

/** Build the baseline argv for the language family, or null when impossible. */
function buildBaselinePlan(
	tmpCwd: string,
	featureCwd: string,
	language: string,
	pm: string | undefined,
	subjects: string[],
): { argv: string[]; label: string } | null {
	if (language === "rust") {
		// subjects are crate names — one cargo invocation, repeated -p flags.
		const argv = ["cargo", "test", "--quiet"];
		for (const c of subjects) argv.push("-p", c);
		return { argv, label: `cargo test -p ${subjects.join(" -p ")}` };
	}
	if (language === "go") {
		const dirs = [...new Set(subjects.filter((s) => s.endsWith(".go")).map((s) => dirname(s)))].sort();
		if (dirs.length === 0) return null;
		const args = dirs.map((d) => (d === "." ? "./." : `./${d}`));
		return { argv: ["go", "test", ...args], label: `go test ${args.join(" ")}` };
	}
	if (language === "python") {
		const py = existsSync(join(featureCwd, ".venv/bin/python"))
			? join(featureCwd, ".venv/bin/python")
			: existsSync(join(featureCwd, ".venv/Scripts/python.exe"))
				? join(featureCwd, ".venv/Scripts/python.exe")
				: "python3";
		return { argv: [py, "-m", "pytest", "-q", "-p", "no:cacheprovider", ...subjects], label: `pytest ${subjects.join(" ")}` };
	}
	if (language === "frontend" || language === "backend") {
		// Share the feature worktree's installed deps with the baseline checkout.
		// A plain symlink keeps the baseline run cheap; when it cannot be created
		// (or the feature has no node_modules) we degrade to unknown.
		const nm = join(featureCwd, "node_modules");
		if (existsSync(nm) && !existsSync(join(tmpCwd, "node_modules"))) {
			try {
				symlinkSync(nm, join(tmpCwd, "node_modules"), "dir");
			} catch {
				return null;
			}
		}
		if (existsSync(join(tmpCwd, "node_modules/.bin/vitest"))) {
			return { argv: pmExecLocal(pm ?? "npm", "vitest", ["run", ...subjects]), label: `vitest run ${subjects.join(" ")}` };
		}
		if (existsSync(join(tmpCwd, "node_modules/.bin/jest"))) {
			return { argv: pmExecLocal(pm ?? "npm", "jest", subjects), label: `jest ${subjects.join(" ")}` };
		}
		// No runner binary reachable — fall back to the baseline's own test
		// script (whole-suite) if it declares one.
		try {
			const pkgRaw = readFileSync(join(tmpCwd, "package.json"), "utf8") as string;
			const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
			const t = pkg?.scripts?.test;
			if (typeof t === "string" && t.trim()) {
				return { argv: [pm ?? "npm", "run", "test"], label: `${pm ?? "npm"} run test (whole suite)` };
			}
		} catch {
			return null;
		}
		return null;
	}
	return null;
}

/**
 * Verify whether the given failing subjects also fail at the merge-base of
 * HEAD and defaultBranch, in an isolated temp worktree. NEVER throws.
 */
export function verifyUntouchedFailuresAgainstBaseline(input: BaselineVerifyInput): BaselineCheckResult {
	const unknown = (evidence: string): BaselineCheckResult => ({ status: "unknown", evidence });
	try {
		const subjects = normalizeSubjects(input.subjects ?? []);
		if (subjects.length === 0) return unknown("no out-of-scope subjects to verify");
		if (input.signal?.aborted) return unknown("aborted before baseline run");
		try {
			if (superDevEnv("SUPER_DEV_DISABLE_BASELINE_CHECK")) {
				return unknown("baseline check disabled via SUPER_DEV_DISABLE_BASELINE_CHECK");
			}
		} catch {
			/* env read guard — proceed */
		}
		if (!input.defaultBranch) return unknown("no default branch in setup context");
		const mergeBase = gitOk(input.cwd, ["merge-base", "HEAD", input.defaultBranch]);
		if (!mergeBase) return unknown(`merge-base HEAD..${input.defaultBranch} unavailable`);

		const cacheKey = JSON.stringify([input.cwd, mergeBase, input.language, input.pm ?? "", subjects]);
		const hit = baselineCache.get(cacheKey);
		if (hit) return { status: hit.status, evidence: `${hit.evidence} [cached]` };
		if (baselineCache.size >= CACHE_MAX) baselineCache.clear();

		const runner = input.runner ?? defaultRunner;
		const timeoutMs = input.timeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS;

		const tmp = mkdtempSync(join(tmpdir(), "sd-baseline-"));
		let result: BaselineCheckResult;
		try {
			const added = gitOk(input.cwd, ["worktree", "add", "--detach", tmp, mergeBase], 60_000);
			if (!added) {
				result = unknown(`git worktree add for baseline ${shortSha(mergeBase)} failed`);
			} else {
				// v0.2.9 G6: run the baseline command in the SUBJECT's module dir (a
				// nested go.mod/Cargo.toml lives in a subdir, e.g. backend-service/).
				// moduleSubdir "" ⇒ repo root (today's behavior). go.mod/module reads
				// and the plan spawn both use this dir so a nested Go module verifies
				// correctly instead of failing "go.mod unreadable".
				const runCwd = input.moduleSubdir ? join(tmp, input.moduleSubdir) : tmp;
				const featCwd = input.moduleSubdir ? join(input.cwd, input.moduleSubdir) : input.cwd;
				const plan = buildBaselinePlan(runCwd, featCwd, input.language, input.pm, subjects);
				if (!plan) {
					result = unknown(`cannot construct a baseline command for language "${input.language}"`);
				} else {
					const res = runner(runCwd, plan.argv, { timeoutMs });
					const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
					if (res.timedOut || res.status === null) {
						result = unknown(`${plan.label} at baseline ${shortSha(mergeBase)} did not produce an exit status (timeout/spawn failure)`);
					} else if (input.language === "rust") {
						if (/package ID specification .* did not match any packages/.test(out)) {
							result = unknown("cargo rejected the baseline -p selection (subject resolution mismatch)");
						} else if (/failed to download|network|offline/i.test(out)) {
							result = unknown("baseline cargo run hit a dependency/network failure");
						} else if (res.status === 0) {
							result = { status: "regression", evidence: `${plan.label} PASSES at baseline ${shortSha(mergeBase)} — the failure is new on this branch` };
						} else {
							result = { status: "preexisting", evidence: `${plan.label} FAILS at baseline ${shortSha(mergeBase)} (exit ${res.status}) — out-of-scope crate(s) were already failing` };
						}
					} else if (res.status === 0) {
						result = { status: "regression", evidence: `${plan.label} PASSES at baseline ${shortSha(mergeBase)} — the failure is new on this branch` };
					} else {
						if (input.language === "go") {
							// go reports PACKAGE paths while subjects are FILES — run the
							// comparison in package space (subject file → module/<dir>).
							const module = readGoModuleNameLocal(runCwd);
							if (!module) {
								result = { status: "unknown", evidence: `${plan.label}: baseline go.mod module unreadable` };
							} else {
								const expectedPkgs = [
									...new Set(
										subjects
											.filter((s) => s.endsWith(".go"))
											.map((s) => {
												const d = dirname(s);
												return d === "." ? module : `${module}/${d}`;
											}),
									),
								].sort();
								if (expectedPkgs.length === 0) {
									result = { status: "unknown", evidence: `${plan.label}: cannot map go file subjects to packages` };
								} else {
									result = classifyFileSubjects(expectedPkgs, parseGoFailingPackages(out), `${plan.label} at baseline ${shortSha(mergeBase)} (exit ${res.status})`);
								}
							}
						} else {
							const failing =
								input.language === "python"
									? parsePytestFailingFiles(out)
									: parseFailingNpmTestFiles(out);
							result = classifyFileSubjects(subjects, failing, `${plan.label} at baseline ${shortSha(mergeBase)} (exit ${res.status})`, plan.label.includes("whole suite")); // sweep-3 G40
						}
					}
				}
			}
		} finally {
			try {
				gitOk(input.cwd, ["worktree", "remove", "--force", tmp], 60_000);
			} catch {
				/* best effort */
			}
			try {
				rmSync(tmp, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		baselineCache.set(cacheKey, result);
		return result;
	} catch (err) {
		return unknown(`baseline verification errored: ${err instanceof Error ? err.message : String(err)}`);
	}
}
