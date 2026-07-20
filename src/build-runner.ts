/**
 * Deterministic build/test/typecheck gate — the HARD test oracle.
 *
 * Replaces trusting the QA agent's self-reported `buildSuccess`/`allTestsPass`
 * (a vacuous-pass risk: an agent can report green without running anything).
 * This module actually spawns the project's build/test/typecheck commands and
 * reports real pass/fail + stderr tails.
 *
 * Side-effecting (like `lifecycle.ts`), NOT a pure helper — it is called
 * directly from stage code, not via the pure `runHelper` dispatch. Helpers stay
 * pure; this is the deterministic counterpart that touches the filesystem.
 *
 * Non-fatal when no commands are detectable (greenfield repo with no manifest):
 * `ran` is empty and `pass` is true, so a phase can still commit on green when
 * there is genuinely nothing to build or test.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Default per-command timeout for the build gate, in milliseconds (10 min).
 *
 * The previous 120_000ms hardcode caused false FAILs on slow first-time
 * compiles (e.g. clean Rust workspaces) before the build finished, aborting
 * Stage 9 (verify). 10 minutes comfortably covers a cold cargo build/test/
 * clippy on a moderately-sized workspace without masking a genuine hang.
 *
 * Exported so the value is unit-testable and forward-compatible.
 *
 * # Configuration via environment variables
 *
 * The deterministic build gate (`runBuildGate`, consumed by Stage 9 verify,
 * Stage 9.2 implementation, and Stage 11 merge) reads TWO optional env vars
 * to tune timeout and test scope WITHOUT editing any stage call site (all
 * three callers still pass only `{ signal }`):
 *
 *   1. `SUPER_DEV_BUILD_TIMEOUT_MS` — per-command timeout override in
 *      milliseconds, parsed base-10. Falls back to {@link DEFAULT_TIMEOUT_MS}
 *      (600_000 / 10 min) when unset, empty, NaN, or `<= 0`. Resolved by
 *      {@link resolveTimeoutMs}, which threads into every `spawnSync({ timeout })`
 *      in the `exec` closure (build / test / typecheck / clippy).
 *      Precedence: explicit `opts.timeoutMs` (positive finite) > env var >
 *      default. Example: `SUPER_DEV_BUILD_TIMEOUT_MS=900000` gives 15 min.
 *
 *   2. `SUPER_DEV_BUILD_TEST_PACKAGES` — comma-separated cargo crate list to
 *      scope the cargo gate (`cargo build`/`cargo test`/`cargo clippy`, all
 *      three carrying `-p <pkg>` per entry) instead of running workspace-wide.
 *      Empty/missing → workspace-wide (unchanged). Parsed by
 *      {@link parseTestPackages} and applied by {@link scopedCargoBuildArgs}/
 *      {@link scopedCargoTestArgs}/{@link scopedCargoClippyArgs} ONLY when
 *      `detectProjectCommands` reports `language === "rust"` AND the resolved
 *      set is non-empty, on a shallow copy of the detected commands so the
 *      pure detector is byte-identical. FOUR-tier precedence (highest →
 *      lowest): `opts.testPackages` (provided, incl. explicit `[]` to force
 *      workspace-wide) > `SUPER_DEV_BUILD_TEST_PACKAGES` > auto-detected
 *      touched crates ({@link detectTouchedCargoPackages}) > workspace-wide.
 *      The git-diff spawn runs ONLY in the auto-detection tier.
 *      Example: `SUPER_DEV_BUILD_TEST_PACKAGES="crates/api,crates/store"`.
 *
 * Non-rust stacks (go/python/node/mixed) ignore the scoping var entirely,
 * and greenfield repos (no manifest) still return `pass:true, ran:[]`. The
 * target repository is never mutated — only the harness argv + timeout change.
 */
export const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Resolve the per-command build-gate timeout in milliseconds.
 *
 * Precedence (highest wins):
 *   1. an explicit finite positive `opt` (preserves the opts.timeoutMs unit-test
 *      override; 0/NaN/-x/Infinity are NOT honored and fall through);
 *   2. `process.env.SUPER_DEV_BUILD_TIMEOUT_MS` parsed base-10 — NaN, <=0,
 *      empty, or missing falls through;
 *   3. {@link DEFAULT_TIMEOUT_MS} (600_000 / 10 min).
 *
 * Pure & side-effect-free (only READS process.env) so it is fully unit-
 * testable without spawning any command.
 *
 * @param explicit An optional finite positive millisecond override.
 * @returns The resolved timeout in milliseconds.
 */
export function resolveTimeoutMs(explicit?: number): number {
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
		return explicit;
	}
	const raw = process.env.SUPER_DEV_BUILD_TIMEOUT_MS;
	if (raw !== undefined && raw !== "") {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return DEFAULT_TIMEOUT_MS;
}

/** Dedupe a list of package names, preserving first-seen order. */
function dedupePreservingOrder(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const it of items) {
		if (seen.has(it)) continue;
		seen.add(it);
		out.push(it);
	}
	return out;
}

/**
 * Parse a comma-separated list of cargo package names into a clean array.
 *
 * Used to read `process.env.SUPER_DEV_BUILD_TEST_PACKAGES`. Splits on commas,
 * trims each entry (spaces/tabs/newlines), drops empties, and dedupes while
 * preserving first-seen order. Returns `[]` for undefined/empty/whitespace-only
 * input. Pure & side-effect-free so it is fully unit-testable.
 *
 * @param raw The raw comma-list (typically an env-var value).
 * @returns A de-duplicated, trimmed list of package names.
 */
export function parseTestPackages(raw?: string): string[] {
	if (raw === undefined || raw === "") return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (trimmed === "" || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Detect the cargo crates touched on the current branch vs a base ref.
 *
 * AC-01 — spawns `git -C <cwd> diff --merge-base <baseRef> --name-only` once,
 * maps each `crates/<pkg>/…` line to `<pkg>` (first `crates/` segment wins), and
 * de-duplicates the result via {@link dedupePreservingOrder} preserving
 * first-seen order. Non-crate paths (root `Cargo.toml`, `README`, `docs/…`) are
 * ignored.
 *
 * Base-ref precedence (highest → lowest): an explicit {@link baseRef} arg > the
 * `SUPER_DEV_GATE_BASE_REF` env var > `"main"`.
 *
 * Safe degradation (NEVER throws — the entire body is try/caught): returns `[]`
 * on a non-zero git exit (missing base ref / non-git dir), an `r.error` (git
 * not installed), empty or whitespace-only diff output, a diff with no crate
 * paths, a non-string stdout, or any thrown exception. An empty `[]` return is
 * exactly the value `runBuildGate` relies on to fall back to workspace-wide
 * scoping (no `-p` flags anywhere). See SCENARIO-001/002/003/020/022/023.
 *
 * Side-effecting (spawns git + reads env) like the rest of the module, but pure
 * wrt argv construction: it spawns `git` as a single discrete-argv call with no
 * `shell:true`, so package/path data never reaches a shell.
 *
 * @param cwd Absolute worktree path to run git in (`-C <cwd>`).
 * @param baseRef Optional base ref override (`--merge-base <baseRef>`).
 * @returns De-duplicated touched crate names (first-seen order), or `[]`.
 */
export function detectTouchedCargoPackages(cwd: string, baseRef?: string): string[] {
	try {
		const ref = baseRef ?? process.env.SUPER_DEV_GATE_BASE_REF ?? "main";
		const r = spawnSync("git", ["-C", cwd, "diff", "--merge-base", ref, "--name-only"], {
			encoding: "utf8",
		});
		// Non-zero exit (bad ref / non-git dir) or spawn error → safe [] return.
		if (r.error || r.status !== 0) return [];
		const out: string = r.stdout;
		if (typeof out !== "string" || out.trim() === "") return [];
		// Match the FIRST `crates/<pkg>/` segment of each line; ignore non-crate
		// paths entirely. `(?:^|\/)crates\/` tolerates nested-`crates/` prefixes.
		const re = /(?:^|\/)crates\/([^/]+)\//;
		const pkgs: string[] = [];
		for (const line of out.split("\n")) {
			const m = re.exec(line);
			if (m) pkgs.push(m[1]);
		}
		return dedupePreservingOrder(pkgs);
	} catch {
		return [];
	}
}

/**
 * The three cargo subcommands the build gate scopes. Constrained to a literal
 * union so a typo at a call site is a compile error, not a silent wrong argv.
 */
type CargoSubcommand = "build" | "test" | "clippy";

/**
 * Build a scoped cargo argv for a subcommand + package list + trailing extras.
 *
 * Shared core of the AC-02 argv family. Emits
 * `["cargo", subcommand, ...packages.flatMap(p => ["-p", p]), ...(extraArgs ?? [])]`
 * — one `-p` flag per package, in first-seen input order, followed verbatim by
 * the trailing extra args. An empty package set yields a byte-identical
 * workspace-wide argv (no `-p` flags at all) because `flatMap` over `[]` is a
 * no-op — the SCENARIO-005 invariant. `extraArgs` defaults to `undefined`
 * (omitted entirely), and an explicit `[]` is treated identically to
 * `undefined` (both append nothing). Package names are emitted as discrete
 * argv elements so they never pass through a shell (no `shell:true` is ever
 * used) — see SCENARIO-014. Each call returns a freshly-allocated array.
 *
 * Pure & side-effect-free: no git, no spawn, no filesystem, no env — fully
 * unit-testable. See SCENARIO-004 (non-empty) / SCENARIO-005 (empty).
 *
 * @param subcommand One of `build` | `test` | `clippy`.
 * @param packages Resolved (de-duplicated) package names, in run order.
 * @param extraArgs Optional trailing argv to append verbatim (e.g. `--quiet`).
 * @returns The scoped cargo argv (fresh array each call).
 */
export function scopedCargoArgs(
	subcommand: CargoSubcommand,
	packages: string[],
	extraArgs?: string[],
): string[] {
	return [
		"cargo",
		subcommand,
		...packages.flatMap((p) => ["-p", p]),
		...(extraArgs ?? []),
	];
}

/**
 * Build the scoped `cargo build` argv for a list of packages — AC-02.
 *
 * Thin wrapper over {@link scopedCargoArgs}: delegates to
 * `scopedCargoArgs("build", packages, ["--quiet"])`. Non-empty →
 * `["cargo","build", ...packages.flatMap(p => ["-p", p]), "--quiet"]`; empty →
 * `["cargo","build","--quiet"]` (byte-identical to the unscoped workspace
 * argv). See SCENARIO-004/005.
 *
 * @param packages Resolved (de-duplicated) package names.
 * @returns The cargo build argv, scoped or unscoped.
 */
export function scopedCargoBuildArgs(packages: string[]): string[] {
	return scopedCargoArgs("build", packages, ["--quiet"]);
}

/**
 * Build the scoped `cargo test` argv for a list of packages — AC-02.
 *
 * Thin wrapper over {@link scopedCargoArgs}: delegates to
 * `scopedCargoArgs("test", packages, ["--quiet"])` (byte-identical to the
 * pre-refactor hand-rolled implementation, so `verify.ts` /
 * `implementation.ts` callers and existing tests are unchanged). Non-empty →
 * `["cargo","test", ...packages.flatMap(p => ["-p", p]), "--quiet"]` (one `-p`
 * flag per package, `--quiet` retained). Empty → `["cargo","test","--quiet"]`
 * (byte-identical to the unscoped workspace argv). Package names are emitted as
 * discrete argv elements so they never pass through a shell (no `shell:true` is
 * ever used) — see SCENARIO-014.
 *
 * @param packages Resolved (de-duplicated) package names.
 * @returns The cargo test argv, scoped or unscoped.
 */
export function scopedCargoTestArgs(packages: string[]): string[] {
	return scopedCargoArgs("test", packages, ["--quiet"]);
}

/**
 * Build the scoped `cargo clippy` argv for a list of packages — AC-02.
 *
 * Thin wrapper over {@link scopedCargoArgs}: delegates to
 * `scopedCargoArgs("clippy", packages, ["--all-targets", "--quiet"])`. Non-empty
 * → `["cargo","clippy", ...packages.flatMap(p => ["-p", p]), "--all-targets",
 * "--quiet"]`; empty → `["cargo","clippy","--all-targets","--quiet"]`
 * (byte-identical to the unscoped workspace argv, with `--all-targets` retained
 * before `--quiet`). See SCENARIO-004/005.
 *
 * @param packages Resolved (de-duplicated) package names.
 * @returns The cargo clippy argv, scoped or unscoped.
 */
export function scopedCargoClippyArgs(packages: string[]): string[] {
	return scopedCargoArgs("clippy", packages, ["--all-targets", "--quiet"]);
}

/**
 * Partition gate failure blocks into in-scope vs out-of-scope relative to the
 * resolved scoped crate set — AC-04.
 *
 * Contract: for each error block, extract the referenced crate names via:
 *   (a) `--> crates/<pkg>/…` (and any `crates/<pkg>/`) path markers, using
 *       regex `/crates\/([^/]+)\//`; and
 *   (b) cargo test-failure `-p <pkg>` listing markers, using regex
 *       `/(?:^|\s)-p\s+(\S+)/`.
 *
 * An error is OUT-OF-SCOPE iff it references ≥1 crate AND EVERY referenced
 * crate is NOT in `scopedSet`. Otherwise it is IN-SCOPE: no parseable crate
 * marker found (conservative — could be the genuine failure), ≥1 referenced
 * crate IS in scope (mixed), or `scopedSet` is empty (no scoping active).
 * Ambiguity NEVER grants a false green. See SCENARIO-009/010/011/021/024/028.
 *
 * Pure & side-effect-free (no spawn, no fs, no env). NEVER throws — the entire
 * body is try/caught and, on ANY error (bad input, regex explosion), treats
 * ALL blocks as in-scope (returns `outOfScopeErrors: []`).
 *
 * @param errors The raw error blocks collected by the gate exec loop (cargo
 *   stderr tails, failure listings, or the harness label-prefixed strings).
 * @param scopedSet The resolved (de-duplicated) in-scope crate set.
 * @returns The partition into `inScopeErrors` and `outOfScopeErrors`.
 */
export function classifyOutOfScopeErrors(
	errors: string[],
	scopedSet: string[],
): { inScopeErrors: string[]; outOfScopeErrors: string[] } {
	try {
		const scope = new Set<string>(scopedSet);
		// Empty scoped set ⇒ no scoping active ⇒ treat EVERY error as in-scope
		// (SCENARIO-011 / SCENARIO-016 parity: never grants a false green).
		if (scope.size === 0) {
			const safe = Array.isArray(errors) ? errors : [];
			return {
				inScopeErrors: safe.map((e) =>
					typeof e === "string" ? e : String(e ?? ""),
				),
				outOfScopeErrors: [],
			};
		}
		const inScopeErrors: string[] = [];
		const outOfScopeErrors: string[] = [];
		// Both regexes consume ≥1 captured char per match, so `exec` always
		// advances `lastIndex` — no zero-length-match infinite loop possible.
		// `pathRe` extracts `crates/<pkg>/` source-path markers from the WHOLE
		// block (command labels never contain `crates/` paths).
		const pathRe = /crates\/([^/]+)\//g;
		// `flagRe` extracts `-p <pkg>` rerun markers. The negative lookbehind
		// `(?<!\w)` lets `-p` follow a quote (cargo's `rerun pass '-p pkg …'`),
		// a space, or string start, while rejecting `-p` glued to a word char
		// (`some-pkg`). It is run ONLY on the post-label region (see below) so
		// the command label's own `-p <scoped-pkg>` is never miscounted as a
		// crate reference (SCENARIO-028 label-exclusion contract).
		const flagRe = /(?<!\w)-p\s+(\S+)/g;
		for (const err of errors) {
			const block = typeof err === "string" ? err : String(err ?? "");
			// The gate assembles errors as `<label> FAILED (<reason>):\n<tail>`.
			// The label carries our OWN scoped `-p <pkg>` (always in scope by
			// construction); scanning it would falsely mark every failure
			// in-scope. Scan `-p` ONLY in the post-` FAILED (` tail. Path
			// markers are scanned on the whole block (labels lack `crates/`).
			const failedIdx = block.indexOf(" FAILED (");
			const flagRegion = failedIdx === -1 ? block : block.slice(failedIdx);
			const referenced = new Set<string>();
			let m: RegExpExecArray | null;
			pathRe.lastIndex = 0;
			while ((m = pathRe.exec(block)) !== null) referenced.add(m[1]);
			flagRe.lastIndex = 0;
			while ((m = flagRe.exec(flagRegion)) !== null) referenced.add(m[1]);
			if (referenced.size === 0) {
				// No parseable crate marker → conservative IN-SCOPE.
				inScopeErrors.push(block);
				continue;
			}
			// OUT-OF-SCOPE iff ≥1 crate referenced AND ALL referenced are NOT in
			// scope (anyInScope ⇒ conservative IN-SCOPE).
			let anyInScope = false;
			for (const pkg of referenced) {
				if (scope.has(pkg)) {
					anyInScope = true;
					break;
				}
			}
			if (anyInScope) {
				inScopeErrors.push(block);
			} else {
				outOfScopeErrors.push(block);
			}
		}
		return { inScopeErrors, outOfScopeErrors };
	} catch {
		// NEVER throw — treat ALL blocks as in-scope on any failure.
		const safe = Array.isArray(errors) ? errors : [];
		return {
			inScopeErrors: safe.map((e) => (typeof e === "string" ? e : String(e ?? ""))),
			outOfScopeErrors: [],
		};
	}
}

const STDERR_TAIL_LINES = 12;

export type CmdKey = "build" | "test" | "typecheck";

export interface ProjectCommands {
	/** Detected stack label (mirrors setup.ts detectLanguage, independent). */
	language: string;
	/** Package manager for node projects (npm/pnpm/yarn/bun/deno). */
	pm?: string;
	build?: string[];
	test?: string[];
	typecheck?: string[];
	/** Human-readable labels of the commands that will run, in order. */
	ran: string[];
}

export interface BuildGateResult {
	pass: boolean;
	buildSuccess: boolean;
	allTestsPass: boolean;
	typecheckSuccess: boolean;
	ran: string[];
	errors: string[];
	/**
	 * Pre-existing failure blocks referencing ONLY crates outside the resolved
	 * scope — AC-04. Empty when the gate passed or when no scoping is active.
	 * Conservative: an ambiguous/mixed/no-marker error is kept in `errors` but
	 * never appears here (never grants a false green).
	 */
	outOfScopeErrors: string[];
	/**
	 * True when the gate is GREEN for the current scope: either `pass`, OR the
	 * gate failed ONLY on pre-existing out-of-scope crates (every failure is
	 * out-of-scope). A phase may still commit in the latter case (AC-05). Stays
	 * `false` for any genuine in-scope failure and when no scoping is active,
	 * preserving the pre-change abort semantics exactly.
	 */
	inScopePass: boolean;
}

/** Best-effort read of a file's text ("" if missing/unreadable). */
function readMaybe(cwd: string, file: string): string {
	try {
		return existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : "";
	} catch {
		return "";
	}
}

/** Detect the node package manager: packageManager field → lockfile → npm. */
function detectPm(cwd: string, pkg: Record<string, unknown>): string {
	const pm = String(pkg.packageManager ?? "").split("@")[0];
	if (pm && /^(npm|pnpm|yarn|bun|deno)$/.test(pm)) return pm;
	if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
	if (existsSync(join(cwd, "deno.lock"))) return "deno";
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	return "npm";
}

/** argv to run a package.json script under the detected pm. */
function pmRun(pm: string, script: string): string[] {
	return pm === "deno" ? ["deno", "task", script] : [pm, "run", script];
}

/**
 * Detect build/test/typecheck commands from the project's manifests. Returns
 * only the commands that SHOULD run (script/tool is configured). Empty for
 * greenfield or stacks with nothing to verify.
 */
export function detectProjectCommands(cwd: string): ProjectCommands {
	const has = (f: string) => existsSync(join(cwd, f));

	if (has("Cargo.toml")) {
		return {
			language: "rust",
			build: ["cargo", "build", "--quiet"],
			test: ["cargo", "test", "--quiet"],
			typecheck: ["cargo", "clippy", "--all-targets", "--quiet"],
			ran: ["cargo build", "cargo test", "cargo clippy"],
		};
	}

	if (has("go.mod")) {
		return {
			language: "go",
			build: ["go", "build", "./..."],
			test: ["go", "test", "./..."],
			typecheck: ["go", "vet", "./..."],
			ran: ["go build ./...", "go test ./...", "go vet ./..."],
		};
	}

	if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
		const cmds: ProjectCommands = { language: "python", ran: [] };
		const pyproject = readMaybe(cwd, "pyproject.toml");
		const setupCfg = readMaybe(cwd, "setup.cfg");
		const hasPytest = has("pytest.ini") || has("tox.ini") || /\[(tool\.pytest|tool:pytest|pytest)/.test(pyproject + setupCfg);
		if (hasPytest) {
			cmds.test = ["pytest", "-q"];
			cmds.ran.push("pytest");
		}
		const hasMypy = has("mypy.ini") || has(".mypy.ini") || /\[mypy\]/.test(setupCfg) || /tool\.mypy/.test(pyproject);
		if (hasMypy) {
			cmds.typecheck = ["mypy", "."];
			cmds.ran.push("mypy .");
		}
		return cmds;
	}

	if (has("package.json")) {
		let pkg: Record<string, unknown> = {};
		try {
			pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
		} catch {
			/* malformed package.json — fall through with empty scripts */
		}
		const scripts = (pkg.scripts ?? {}) as Record<string, string>;
		const pm = detectPm(cwd, pkg);
		const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
		const language = deps && (deps.react || deps.next || deps.vue || deps.svelte) ? "frontend" : "backend";
		const cmds: ProjectCommands = { language, pm, ran: [] };
		if (scripts.build) {
			cmds.build = pmRun(pm, "build");
			cmds.ran.push(`${pm} run build`);
		}
		if (scripts.test) {
			cmds.test = pmRun(pm, "test");
			cmds.ran.push(`${pm} run test`);
		}
		if (scripts.typecheck) {
			cmds.typecheck = pmRun(pm, "typecheck");
			cmds.ran.push(`${pm} run typecheck`);
		} else if (has("tsconfig.json")) {
			// Fallback: invoke the local tsc directly (no install prompt).
			cmds.typecheck = ["npx", "--no-install", "tsc", "--noEmit"];
			cmds.ran.push("tsc --noEmit");
		}
		return cmds;
	}

	return { language: "mixed", ran: [] };
}

/**
 * Run the detected build/test/typecheck commands in `cwd`, each with a bounded
 * timeout, and collect real pass/fail + stderr tails. Non-fatal when nothing is
 * detected (`pass` true, `ran` empty). Respects an AbortSignal: a signal that is
 * already aborted skips remaining commands; one that fires mid-run is honored.
 */
export function runBuildGate(
	cwd: string,
	opts: { timeoutMs?: number; testPackages?: string[]; signal?: AbortSignal } = {},
): BuildGateResult {
	const cmds0 = detectProjectCommands(cwd);
	const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
	// AC-03: FOUR-tier package-set precedence (highest → lowest). The git-diff
	// spawn runs ONLY in tier (iii) — it is SKIPPED whenever a higher tier
	// supplies a value, so an override never wastes a process (SCENARIO-007).
	//   (i)   opts.testPackages provided (incl. explicit [] = force workspace-wide);
	//   (ii)  process.env.SUPER_DEV_BUILD_TEST_PACKAGES (set-but-empty ⇒ [] and
	//         no spawn, preserving the pre-change env-set behaviour);
	//   (iii) detectTouchedCargoPackages(cwd) — ONLY for rust repos (AC-01);
	//   (iv)  [] → workspace-wide (no scoping).
	let testPackages: string[];
	if (opts.testPackages !== undefined) {
		testPackages = dedupePreservingOrder(opts.testPackages);
	} else if (process.env.SUPER_DEV_BUILD_TEST_PACKAGES !== undefined) {
		testPackages = parseTestPackages(process.env.SUPER_DEV_BUILD_TEST_PACKAGES);
	} else if (cmds0.language === "rust") {
		testPackages = detectTouchedCargoPackages(cwd);
	} else {
		testPackages = [];
	}
	// AC-03/AC-06: scope ALL THREE cargo commands (build/test/typecheck) on a
	// SHALLOW COPY when rust + a non-empty scope resolve; an empty set leaves cmds
	// byte-identical to detectProjectCommands (the detector purity regression
	// assertion still passes). SCENARIO-006 (all three carry -p) / SCENARIO-008
	// (empty ⇒ byte-identical) / SCENARIO-007 (precedence + no-spawn).
	const cmds =
		cmds0.language === "rust" && testPackages.length > 0
			? {
					...cmds0,
					build: scopedCargoBuildArgs(testPackages),
					test: scopedCargoTestArgs(testPackages),
					typecheck: scopedCargoClippyArgs(testPackages),
				}
			: cmds0;
	const errors: string[] = [];
	const ran: string[] = [];
	const flag = { build: true, test: true, typecheck: true };

	const exec = (argv: string[], key: CmdKey) => {
		if (opts.signal?.aborted) {
			flag[key] = false;
			errors.push(`${argv.join(" ")}: aborted before run`);
			return;
		}
		const label = argv.join(" ");
		ran.push(label);
		const r = spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: "utf8" });
		if (opts.signal?.aborted) {
			flag[key] = false;
			errors.push(`${label}: aborted`);
			return;
		}
		if (r.error) {
			flag[key] = false;
			errors.push(`${label} FAILED (${r.error.message.split("\n")[0]})`);
			return;
		}
		if (r.status !== 0) {
			flag[key] = false;
			const reason = r.signal ? `killed (signal ${r.signal})` : `exit ${r.status}`;
			const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n").trim();
			errors.push(`${label} FAILED (${reason})${tail ? ":\n" + tail : ""}`);
		}
	};

	if (cmds.build) exec(cmds.build, "build");
	if (cmds.test) exec(cmds.test, "test");
	if (cmds.typecheck) exec(cmds.typecheck, "typecheck");

	const buildSuccess = flag.build;
	const allTestsPass = flag.test;
	const typecheckSuccess = flag.typecheck;
	const pass = errors.length === 0;
	// AC-04: classify collected failures into in-scope vs pre-existing
	// out-of-scope relative to the resolved scoped crate set (`testPackages`).
	// The classifier is pure + NEVER throws, so this can only ever SHRINK the
	// failure set (out-of-scope subset) — it never grants a false green. When the
	// gate passed, or no scoping is active (empty set), `outOfScopeErrors` is []
	// and `inScopePass` mirrors `pass` (true on green, false otherwise) so the
	// pre-change abort semantics are preserved exactly. SCENARIO-009/010/011/
	// 021/024/028.
	const { outOfScopeErrors } = classifyOutOfScopeErrors(errors, testPackages);
	const inScopePass =
		pass || (errors.length > 0 && outOfScopeErrors.length === errors.length);
	return {
		pass,
		buildSuccess,
		allTestsPass,
		typecheckSuccess,
		ran,
		errors,
		outOfScopeErrors,
		inScopePass,
	};
}
