/**
 * Deterministic gates: runBuildGate/runRedCheck/runDeliverableCheck/computeChangeGate + types (split from build-runner.ts).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dedupePreservingOrder, detectProjectCommands, readMaybe, resolveCargoPackageNames, validatePackageNames, resolveIntegrationStems, classificationScope, type ProjectCommands } from "./detect.ts";
import { parseTestPackages, detectTouchedCargoPackages, scopedCargoBuildArgs, scopedCargoTestArgs, scopedCargoClippyArgs, classifyOutOfScopeErrors, classifyOutOfScopeNpmErrors } from "./scope.ts";

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

const STDERR_TAIL_LINES = 12;

export type CmdKey = "build" | "test" | "typecheck";

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

/**
 * Spec-declared cargo build-gate contract (Layer D, AC-04..08). Optional. On
 * a rust repo, when present this is the HIGHEST-precedence scope source:
 *   - `workspace: true` short-circuits to workspace-wide (no `-p` flags);
 *   - otherwise `packages` (validated against known workspace members — unknowns
 *     dropped) drives the scoped `-p` set;
 *   - `integration` targets (also validated) are APPENDED to whichever set
 *     resolves, so mandated integration coverage (e.g. an e2e crate) runs.
 * Unknown declared names degrade safely (dropped → widen to workspace-wide).
 * Non-rust repos ignore the contract entirely. Reused as the {@link
 * RunOptions}.gate shape so the spec → runBuildGate path is type-checked.
 */
export interface GateOptions {
	packages?: string[];
	workspace?: boolean;
	integration?: string[];
}

/**
 * Run the detected build/test/typecheck commands in `cwd`, each with a bounded
 * timeout, and collect real pass/fail + stderr tails. Non-fatal when nothing is
 * detected (`pass` true, `ran` empty). Respects an AbortSignal: a signal that is
 * already aborted skips remaining commands; one that fires mid-run is honored.
 */
export function runBuildGate(
	cwd: string,
	opts: { timeoutMs?: number; testPackages?: string[]; gate?: GateOptions; signal?: AbortSignal } = {},
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
	// Layer D (spec-declared gate contract, AC-04/05/06/08): the NEW top
	// precedence tier. When `opts.gate` is provided on a rust repo it
	// SHORT-CIRCUITS the env/auto-detect tiers: `gate.workspace===true` forces
	// workspace-wide (no -p), else `gate.packages` (validated against known
	// members) drives scope. `gate.integration` targets are appended after the
	// validator pass. Unknown declared names DROP via validatePackageNames with
	// the widen-to-workspace-wide safe behavior; non-rust repos ignore gate.
	const gate = opts.gate;
	// CR-004: integration targets are test-binary STEMS (from file paths), NOT
	// package names. Resolved via stat-check; emitted as `cargo test --test <stem>`
	// after the main exec loop (never appended to the -p list).
	let gateIntegrationStems: string[] = [];
	let testPackages: string[];
	if (cmds0.language === "rust" && gate) {
		if (gate.integration && gate.integration.length > 0) {
			gateIntegrationStems = resolveIntegrationStems(cwd, gate.integration);
		}
		if (gate.workspace === true) {
			// Explicit workspace-wide short-circuit (no -p).
			testPackages = [];
		} else if (Array.isArray(gate.packages)) {
			testPackages = validatePackageNames(cwd, gate.packages);
		} else {
			testPackages = [];
		}
	} else if (opts.testPackages !== undefined) {
		testPackages = dedupePreservingOrder(opts.testPackages);
	} else if (process.env.SUPER_DEV_BUILD_TEST_PACKAGES !== undefined) {
		testPackages = parseTestPackages(process.env.SUPER_DEV_BUILD_TEST_PACKAGES);
	} else if (cmds0.language === "rust") {
		// AC-01/AC-02 (spec-08 Layer C separation): detect the raw touched
		// DIRECTORY segments via git, THEN resolve them to REAL cargo package
		// names via cached `cargo metadata` as a distinct step. Detection is a
		// pure git extraction ({@link detectTouchedCargoPackages} returns segments
		// and never spawns cargo); {@link resolveCargoPackageNames} maps segments
		// → names, DROPPING unknown dirs and returning [] on metadata failure (no
		// identity fallback — SCENARIO-005/006). The validator below re-checks the
		// result, so every candidate set (opt/env/auto-detect) is validated before
		// any `-p` flag is built.
		testPackages = resolveCargoPackageNames(cwd, detectTouchedCargoPackages(cwd));
	} else {
		testPackages = [];
	}
	// NOTE: opt (tier i) + env (tier ii) sources are EXPLICIT user overrides and
	// are TRUSTED as-is — they are NOT re-validated against workspace members.
	// Re-validating them dropped every explicitly-provided package name whenever
	// `cargo metadata` was unavailable (e.g. cargo not installed, or a hermetic
	// test harness), silently widening a deliberate `-p <pkg>` scope to
	// workspace-wide (review finding: "Explicit opt/env overrides silently
	// discarded"). The auto-detect tier (iii) is ALREADY validated: it resolves
	// raw touched DIRECTORY segments to REAL package names via
	// {@link resolveCargoPackageNames}, which DROPS unknown dirs and returns []
	// on metadata failure (no identity fallback — SCENARIO-005/006). So no
	// additional re-check is needed here; the spec-declared `gate` contract above
	// is the ONLY opt-in path that runs {@link validatePackageNames} (because its
	// names come from the LLM, not a trusted operator). This also removes the
	// redundant re-validation of already-validated gate output.
	// CR-004/CR-008: integration STEMS are NOT appended to the -p package list.
	// They run as independent `cargo test --test <stem>` commands (below) so a
	// `gate.workspace===true` decision is never resurrected into a scoped -p gate
	// by a surviving integration target. The stems are independent of testPackages.
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
		try {
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
		} catch (err) {
			// NEVER let a throwing spawn (e.g. a mocked handler that throws, or an
			// ENOENT thrown synchronously) escape the gate — SCENARIO-034 / AC-02.
			flag[key] = false;
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${label} FAILED (${msg.split("\n")[0]})`);
		}
	};

	if (cmds.build) exec(cmds.build, "build");
	if (cmds.test) exec(cmds.test, "test");
	if (cmds.typecheck) exec(cmds.typecheck, "typecheck");

	// CR-004: run spec-declared integration/e2e targets as additional
	// `cargo test --test <stem>` invocations (NOT -p flags — these are explicit
	// test binaries whose file paths were stat-validated). Uses key "test" so a
	// failure in any integration target correctly marks allTestsPass=false.
	for (const stem of gateIntegrationStems) {
		exec(["cargo", "test", "--test", stem, "--quiet"], "test");
	}

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
	// Build the CLASSIFICATION scope (review finding: HIGH-severity false-green
	// regression). `testPackages` now carries REAL cargo names, but cargo
	// BUILD/CLIPPY error blocks reference crates via `crates/<dir>/` SOURCE PATH
	// markers (directory segments) — and cargo does NOT always print a rerun
	// `-p <realname>` flag. Without also including the directory segments, every
	// in-scope failure's path marker would mismatch the real-name scope and be
	// misclassified out-of-scope → inScopePass=true → FALSE GREEN. So augment the
	// scope with each in-scope crate's directory segment (from cached metadata).
	// Only for rust + a non-empty scope (the metadata tier's existing
	// precondition), so non-rust repos and workspace-wide gates stay byte-identical.
	const classScope =
		cmds0.language === "rust" && testPackages.length > 0
			? classificationScope(cwd, testPackages)
			: testPackages;
	// AC-04: the cargo branch (rust) classifies via {@link
	// classifyOutOfScopeErrors} (crates/<pkg>/ + -p <pkg> markers) — byte-for-byte
	// UNCHANGED (same call + args). Phase 5 / Gap 4 generalizes in/out-of-scope
	// classification to the npm family (vitest/jest) via {@link
	// classifyOutOfScopeNpmErrors}, which partitions failing-test-FILE markers
	// against the touched-file set ({@link touchedFilePaths}). Both paths degrade
	// conservatively to in-scope on any ambiguity / empty touched set /
	// unparseable output (grants NO false green). The `inScopePass = pass ||
	// (all-failures-out-of-scope)` formula is shared verbatim across both branches.
	const outOfScopeErrors =
		cmds0.language === "rust"
			? classifyOutOfScopeErrors(errors, classScope).outOfScopeErrors
			: classifyOutOfScopeNpmErrors(errors, cwd);
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

/**
 * RED-phase oracle status (Gap 1a, AC-01). Exactly one discrete outcome of
 * running the tdd-guide-authored test targets:
 *   - `red`:     the tests COMPILED/COLLECTED and FAILED — a genuine RED phase.
 *   - `green`:   the tests passed already (zero failures) — RED not established.
 *   - `broken`:  the tests did not compile/collect (compile error, collection
 *                error, or `no tests to run`) — RED cannot be established.
 *   - `unknown`: no runner, empty targets, spawn error, or ambiguous output.
 *
 * `unknown` NEVER stalls the pipeline (Phase 3 proceeds immediately on it).
 */
export type RedStatus = "red" | "green" | "broken" | "unknown";

/**
 * Options for {@link runRedCheck}. Shares the { timeoutMs?, signal? } shape of
 * {@link GateOptions} / `runBuildGate`'s options so the Stage 9 wiring is
 * type-checked and the {@link resolveTimeoutMs} envelope is reused.
 */
export interface RedCheckOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Classify a runner's COMBINED stdout+stderr into a RED-phase status using
 * per-language heuristics (spec §A.2, AC-01). Pure + NEVER throws. Precedence
 * is always: BROKEN markers (compile/collection failure) → GREEN (exit 0) →
 * RED (exit≠0 + a failure marker) → UNKNOWN (ambiguous). This order guarantees
 * a compile error that also emits a `FAILED` marker is `broken` (the test
 * never ran), not `red` (review finding: precedence over red).
 */
function classifyRedStatus(language: string, combined: string, ok: boolean): RedStatus {
	const out = combined ?? "";
	if (language === "rust") {
		// BROKEN — compile failed (no test executed).
		if (/error\[E[0-9]/i.test(out) || /could not compile/i.test(out)) return "broken";
		// BROKEN — matched no test binary (the RED phase produced no executable).
		if (/no tests to run/i.test(out)) return "broken";
		if (ok) return "green";
		if (/test result: FAILED/i.test(out) || /FAILED/i.test(out) || /panicked/i.test(out)) {
			return "red";
		}
		return "unknown";
	}
	if (language === "python") {
		// BROKEN — pytest could not even collect.
		if (/ERROR collecting/i.test(out)) return "broken";
		if (ok) return "green";
		if (/\bfailed\b/i.test(out) || /\berror\b/i.test(out)) return "red";
		return "unknown";
	}
	// npm family: vitest / jest / npm run test (frontend + backend).
	// BROKEN — collection/parse failure before any test ran.
	if (/SyntaxError/i.test(out) || /failed to load/i.test(out) || /No test files found/i.test(out)) {
		return "broken";
	}
	if (ok) return "green";
	// RED — a failing-test marker appeared after a successful collection.
	if (
		/❯/.test(out) ||
		/^FAIL\s+/m.test(out) ||
		/Tests:?\s+\d+\s*failed/i.test(out)
	) {
		return "red";
	}
	return "unknown";
}

/**
 * Deterministic "red" oracle for the Stage 9 TDD cycle (Gap 1a, AC-01).
 *
 * Modeled on the {@link runBuildGate} skeleton and reuses its primitives —
 * {@link detectProjectCommands}, {@link resolveTimeoutMs}, and
 * {@link resolveIntegrationStems} — introducing NO new spawn/git machinery. It
 * runs the tdd-guide-authored {@link testTargets} and classifies the outcome
 * into exactly one {@link RedStatus} so `implementation.ts` can enforce a
 * genuine RED phase (Gap 1b/Phase 3 re-prompt loop).
 *
 * Per-language scoped invocation:
 *   - `rust`   → resolve integration STEMS via {@link resolveIntegrationStems}
 *               (file paths → basenames, stat-validated; NO `--lib`); run each
 *               stem as `cargo test --test <stem>`. When no stems resolve,
 *               fall back to a scoped `cargo test -p <pkg>` for the touched
 *               packages ({@link detectTouchedCargoPackages}); empty scope → a
 *               single workspace-wide `cargo test`.
 *   - npm/vitest/jest (frontend+backend) → `<pm> run test -- <targets>` (or a
 *               direct `vitest run <targets>` when vitest owns the test
 *               script), reusing the detected {@link ProjectCommands.pm}.
 *   - `python` → `pytest <targets> -q`.
 *   - `go`     → `go test <targets>`.
 *
 * No-spawn short-circuit → `unknown`: a greenfield dir (no manifest), an npm
 * project WITHOUT a test script, or `testTargets.length === 0`. A greenfield
 * repo CANNOT stall the pipeline — it has nothing to verify RED against.
 *
 * NEVER throws (the load-bearing invariant mirrored from every existing gate):
 * the ENTIRE body is try/caught; any spawn error (`r.error` / ENOENT), a
 * throwing spawnSync, a timeout, or a parse ambiguity returns `unknown`.
 *
 * @param cwd Absolute worktree path to run the targets in.
 * @param testTargets The tdd-guide-authored test file paths to run.
 * @param opts Optional timeout/signal envelope (shares the GateOptions shape).
 * @returns One of `red` | `green` | `broken` | `unknown`. Never throws.
 */
export function runRedCheck(cwd: string, testTargets: string[], opts?: RedCheckOptions): RedStatus {
	try {
		// No targets → nothing to verify RED against (no spawn).
		if (!Array.isArray(testTargets) || testTargets.length === 0) return "unknown";
		const cmds = detectProjectCommands(cwd);
		// No test runner configured (greenfield, or npm without a test script).
		if (!cmds.test || cmds.test.length === 0) return "unknown";
		if (opts?.signal?.aborted) return "unknown";

		const timeoutMs = resolveTimeoutMs(opts?.timeoutMs);
		const language = cmds.language;
		const targets = testTargets.filter((t) => typeof t === "string" && t.trim().length > 0);
		if (targets.length === 0) return "unknown";

		// Build the scoped argv(s) per language, mirroring runBuildGate's branch.
		const argvs: string[][] = [];
		if (language === "rust") {
			const stems = resolveIntegrationStems(cwd, targets);
			if (stems.length > 0) {
				// Per-stem integration binaries — NEVER `--lib` (no-`--lib` discipline).
				for (const stem of stems) argvs.push(["cargo", "test", "--test", stem, "--quiet"]);
			} else {
				// No resolvable stems → scope to the touched packages; empty → workspace.
				const pkgs = detectTouchedCargoPackages(cwd);
				if (pkgs.length > 0) {
					for (const pkg of pkgs) argvs.push(["cargo", "test", "-p", pkg, "--quiet"]);
				} else {
					argvs.push(["cargo", "test", "--quiet"]);
				}
			}
		} else if (language === "python") {
			argvs.push(["pytest", ...targets, "-q"]);
		} else if (language === "go") {
			argvs.push(["go", "test", ...targets]);
		} else {
			// npm family (frontend + backend). Prefer a direct `vitest run` when the
			// project's test script is vitest-owned; otherwise reuse the detected pm
			// (`<pm> run test -- <targets>`). Either routes the targets to vitest/jest.
			const usesVitest = cmds.ran.some((label) => /vitest/i.test(label)) || hasVitestScript(cwd);
			if (usesVitest) {
				argvs.push(["vitest", "run", ...targets]);
			} else {
				argvs.push([...cmds.test, "--", ...targets]);
			}
		}

		if (argvs.length === 0) return "unknown";

		// Run each argv under the shared timeout envelope and aggregate. The
		// phase is GREEN only when EVERY invocation exits 0; the combined stdout
	 // + stderr feeds the per-language classifier.
		let combined = "";
		let allOk = true;
		for (const argv of argvs) {
			if (opts?.signal?.aborted) return "unknown";
			const r = spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: "utf8" });
			// NEVER throw on a spawn error / ENOENT — degrade to unknown.
			if (r.error) return "unknown";
			combined += "\n" + (r.stdout ?? "") + "\n" + (r.stderr ?? "");
			if (r.status !== 0) allOk = false;
		}
		return classifyRedStatus(language, combined, allOk);
	} catch {
		// The load-bearing NEVER-THROW invariant: any spawn error, thrown
		// exception, or parse ambiguity degrades to `unknown` (proceed, do not
		// stall). SCENARIO-001/002/003 (degrade instead of throwing).
		return "unknown";
	}
}

/**
 * Whether the project's `package.json` `test` script invokes vitest. Used by
 * {@link runRedCheck} to prefer a direct `vitest run <targets>` invocation over
 * a generic `<pm> run test --`. Pure read, never throws.
 */
function hasVitestScript(cwd: string): boolean {
	try {
		if (!existsSync(join(cwd, "package.json"))) return false;
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
		const scripts = (pkg.scripts ?? {}) as Record<string, string>;
		return typeof scripts.test === "string" && /vitest/i.test(scripts.test);
	} catch {
		return false;
	}
}

// ============================================================================
// Deliverable Checker Primitive (Layer 1, AC-01/02 → SCENARIO-001..010, 014)
// A sibling of runRedCheck / runBuildGate that enforces a spec-declared
// DELIVERABLE CONTRACT, AND-ed with build-green so a phase that compiles green
// while delivering NOTHING (a never-created test file, an unwired call site, a
// dead `_ => {}` router arm) is correctly reported as FAIL.
// ============================================================================

/**
 * A per-phase DELIVERABLE CONTRACT declared by the spec author and AND-ed with
 * build-green (AC-01). Every field is optional; a phase/spec with NO
 * deliverables validates & behaves identically to today (backward compat — the
 * checker returns { pass:true } for an empty/undefined contract).
 *
 *   - requireFiles       — paths that MUST exist (a created/wired deliverable).
 *   - requireContains    — {file,pattern} regex (substring fallback on an invalid
 *                          regex) that MUST appear in a file (e.g. a wired
 *                          call site X→Y).
 *   - requireNotContains — {file,pattern} regex that MUST NOT appear (e.g. a
 *                          dead `_ => {}` match arm / leftover stub).
 *   - requireTests       — test names that MUST appear in the project test list
 *                          (tolerant substring-OR-regex match).
 */
export interface DeliverableContract {
	requireFiles?: string[];
	requireContains?: Array<{ file: string; pattern: string }>;
	requireNotContains?: Array<{ file: string; pattern: string }>;
	requireTests?: string[];
}

/**
 * Outcome of {@link runDeliverableCheck}. `missing` is EXHAUSTIVE (every
 * element of every sub-check is evaluated, no short-circuit) so a
 * build-green-but-empty phase surfaces ALL unmet deliverables at once. `ran`
 * is a human-readable audit trail — one token per check (e.g.
 * `file:src/x.rs`, `contains:a.rs:foo`, `not-contains:b.rs:bar`,
 * `tests:list` / `tests:unavailable`).
 */
export interface DeliverableCheckResult {
	pass: boolean;
	missing: string[];
	ran: string[];
}

/** Options for {@link runDeliverableCheck} (shares the gate-primitive shape). */
export interface DeliverableCheckOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/**
	 * Skip the {@link requireTests} sub-check entirely (no test-lister spawn).
	 *
	 * Review finding: `runDeliverableCheck` spawned the test-lister even when the
	 * build gate had ALREADY failed — a wasted compile on a broken build that also
	 * seeded a poisoned cache (an incomplete/unrepresentative list). The
	 * implementation stage sets this to `true` whenever the build gate is NOT
	 * green, so the cheap file/contains/not-contains checks still run and report
	 * missing deliverables, but the test-lister is NOT spawned against a broken
	 * build. When the build is green (or this is unset) the full check runs.
	 */
	skipTests?: boolean;
}

/**
 * Resolved project test list: either the collected list text OR an
 * `{ available:false }` sentinel (no-runner / spawn error / timeout / empty
 * stdout). Cached per absolute cwd so the lister spawns at most once per run.
 */
type TestListResult = { available: true; list: string } | { available: false };

/**
 * Process-local cache of the project test LIST, keyed by ABSOLUTE `cwd` (via
 * `resolve()` so a relative/symlinked `cwd` keys the cache identically to the
 * spawn `cwd` — mirrors {@link cargoMetadataCache}, review finding: cache-key/
 * argv skew risk). Stores either the collected list text OR an
 * `{ available:false }` sentinel so the lister spawns AT MOST ONCE per cwd per
 * run (SCENARIO-009 — two requireTests-bearing phases sharing a cwd share one
 * spawn). Lives only in memory.
 *
 * RUN-BOUNDARY RESET (review finding, HIGH): a module-level cache is STALE the
 * instant the implementer ADDS a test on a retry — the cached list still omits
 * the new name, so `requireTests` false-negatives forever across retry
 * attempts AND across phases (defeating the core retry mechanism). The cache is
 * therefore NEVER the source of truth across attempts: the implementation
 * stage calls {@link resetDeliverableCheckCache()} before each attempt's
 * `runDeliverableCheck`, so every attempt re-spawns a FRESH list. The cache
 * still dedupes a single runDeliverableCheck call's sub-checks (and within-run
 * calls that did not change the test set); it just cannot survive a retry
 * boundary. {@link resetDeliverableCheckCache} also bounds the map so it never
 * grows unbounded across phases.
 */
const testListCache = new Map<string, TestListResult>();

/**
 * Clear the deliverable-checker's process-local caches (the test-list cache).
 *
 * Run-boundary hook (review finding, HIGH): the implementation stage MUST call
 * this before each retry attempt's {@link runDeliverableCheck} so a freshly
 * added test is observed instead of being masked by the stale cached list. It
 * also bounds {@link testListCache} (no unbounded growth across phases). Pure
 * (clears an in-memory map); never throws.
 */
export function resetDeliverableCheckCache(): void {
	try {
		testListCache.clear();
	} catch {
		// NEVER throw — a reset failure must not stall the pipeline.
	}
}

/**
 * Read a file for deliverable checking, DISTINGUISHING "missing" from
 * "unreadable" (the generic {@link readMaybe} collapses both to ""). Returns:
 *   - { ok:true,  text }        — file exists & is readable (text may be "");
 *   - { ok:false, exists:false } — file does NOT exist (→ "missing pattern");
 *   - { ok:false, exists:true  } — file EXISTS but is unreadable (→ "unreadable").
 * Never throws (SCENARIO-008/010).
 */
function readForDeliverable(
	cwd: string,
	file: string,
): { ok: true; text: string } | { ok: false; exists: boolean } {
	const abs = join(cwd, file);
	try {
		if (!existsSync(abs)) return { ok: false, exists: false };
		return { ok: true, text: readFileSync(abs, "utf8") };
	} catch {
		// existsSync was true but readFileSync threw (EACCES / chmod 000) → unreadable.
		return { ok: false, exists: true };
	}
}

/**
 * Tolerant pattern match (SCENARIO-006): try `pattern` as a RegExp first, fall
 * back to a plain substring `includes` on an INVALID regex OR when the regex
 * does not match. Match by EITHER satisfies. Never throws (an invalid regex →
 * substring). Used for requireContains, requireNotContains, and requireTests.
 */
function tolerantMatch(pattern: string, text: string): boolean {
	let re: RegExp | null = null;
	try {
		re = new RegExp(pattern);
	} catch {
		re = null; // invalid regex → fall back to substring
	}
	if (re && re.test(text)) return true;
	return text.includes(pattern);
}

/**
 * Resolve the project test-LISTER argv for `cmds`, mirroring runRedCheck's
 * runner selection so the lister is chosen EXACTLY as the RED oracle chooses
 * its runner. Returns `null` when no recognized runner exists (greenfield /
 * mixed / go) → requireTests degrades to "test-list unavailable" WITHOUT
 * spawning (SCENARIO-007). Pure: only READS package.json (no spawn/git).
 */
function resolveTestListerArgv(cwd: string, cmds: ProjectCommands): string[] | null {
	if (cmds.language === "rust") {
		return ["cargo", "test", "--", "--list"];
	}
	if (cmds.language === "python") {
		return ["pytest", "--collect-only", "-q"];
	}
	if (cmds.language === "frontend" || cmds.language === "backend") {
		// node family: prefer `vitest list --json`, else `jest --listTests`. Decide
		// from the package.json `test` script content (runRedCheck's same heuristic).
		if (hasVitestScript(cwd)) return ["vitest", "list", "--json"];
		const pkgText = readMaybe(cwd, "package.json");
		if (/"test"\s*:\s*"[^"]*jest/i.test(pkgText)) return ["jest", "--listTests"];
		return null; // no recognized node lister → unavailable
	}
	return null;
}

/**
 * Load (and cache) the project test list for `cwd` via ONE spawn per cwd per
 * run (SCENARIO-009). On no-runner / spawn error / timeout / empty stdout →
 * returns `{ available:false }` and does NOT block (existence/grep still
 * enforced — SCENARIO-007). Never throws.
 */
function loadTestList(
	cwd: string,
	cmds: ProjectCommands,
	timeoutMs: number,
	signal?: AbortSignal,
): TestListResult {
	// Resolve ONCE so the cache KEY and the spawn `cwd` use the SAME absolute
	// path (review finding: cache-key/argv skew — mirrors {@link cargoMetadataCache}).
	const key = resolve(cwd);
	const cached = testListCache.get(key);
	if (cached) return cached;
	const argv = resolveTestListerArgv(cwd, cmds);
	if (!argv || argv.length === 0) {
		const res: TestListResult = { available: false };
		testListCache.set(key, res);
		return res;
	}
	if (signal?.aborted) {
		const res: TestListResult = { available: false };
		testListCache.set(key, res);
		return res;
	}
	let list = "";
	let available = false;
	try {
		const r = spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: "utf8" });
		if (!r.error && r.status === 0) {
			const out = (r.stdout ?? "").trim();
			if (out.length > 0) {
				list = out;
				available = true;
			}
		}
	} catch {
		available = false; // spawn threw → unavailable, do not block
	}
	const res: TestListResult = available
		? { available: true, list }
		: { available: false };
	testListCache.set(key, res);
	return res;
}

/**
 * Deterministic per-phase DELIVERABLE checker (Layer 1, AC-01/02 →
 * SCENARIO-001..010, 014). A sibling of {@link runRedCheck}/{@link runBuildGate}
 * that enforces a spec-declared DELIVERABLE CONTRACT — requireFiles /
 * requireContains / requireNotContains / requireTests — AND-ed with build-green
 * so a phase that compiles green while delivering NOTHING (a never-created test
 * file, an unwired call site, a dead `_ => {}` router arm) is correctly
 * reported as FAIL. This is the proven root cause of the 2026-07-20 stockfan
 * spec-54 false-green.
 *
 * Reuses the single sources of truth: {@link detectProjectCommands} for runner
 * selection, {@link resolveTimeoutMs} for the spawn envelope, and ONE cached
 * {@link spawnSync} test-list subprocess per cwd per run ({@link testListCache}).
 *
 * NEVER throws (the load-bearing build-runner-nonregression invariant): the
 * ENTIRE body is wrapped in try/catch; on any thrown error it returns
 * { pass:false, missing:['<reason>'], ran:[...] } rather than propagating
 * (SCENARIO-010). Every element of every sub-check is evaluated (no
 * short-circuit) so `missing` is exhaustive and `ran` is complete.
 *
 * Sub-checks:
 *   (a) requireFiles       → existsSync(resolve(cwd,p)); miss ⇒
 *                            `missing file: <p>`.
 *   (b) requireContains    → readForDeliverable; unreadable ⇒ `unreadable: <p>`;
 *                            missing-file OR absent-pattern ⇒
 *                            `missing pattern <pat> in <file>` (tolerant regex,
 *                            substring fallback on an invalid regex).
 *   (c) requireNotContains → a READABLE hit ⇒ `forbidden pattern <pat> still
 *                            present in <file>`; missing/unreadable ⇒ no entry.
 *   (d) requireTests       → ONE cached test-list spawn per cwd; tolerant
 *                            substring-OR-regex name match; miss ⇒
 *                            `missing test: <name>`. On no-runner / spawn
 *                            error / timeout / empty stdout ⇒ records
 *                            `tests:unavailable` and does NOT block
 *                            (SCENARIO-007).
 *
 * When `deliverables` is undefined/null/empty → early-returns
 * { pass:true, missing:[], ran:[] } immediately (backward compat, SCENARIO-014).
 *
 * @param cwd          Absolute worktree path to check deliverables in.
 * @param deliverables The spec-declared DELIVERABLE CONTRACT (all-optional).
 * @param opts         Optional timeout/signal envelope.
 * @returns { pass, missing, ran }. Never throws.
 */

/**
 * Outcome of {@link computeChangeGate} — the git cross-check GATE verdict.
 * `claimedNotChanged` is the EXHAUSTIVE list of created/modified claims git
 * did NOT show (fed into the next implementer retry, SCENARIO-015).
 */
export interface ChangeGateResult {
	pass: boolean;
	claimedNotChanged: string[];
}

/**
 * Compute the git cross-check GATE verdict from a tracker `ChangeRecord` (the
 * phase end-record carrying the claimed-vs-actual cross-check). Co-located with
 * the other deterministic gates. spec-11 AC-07, AC-08 → SCENARIO-013/014/016/017.
 *
 * Contract (the false-green killer, AC-08):
 *   - `pass === false` iff `rec` is a non-null record with `!gitUnavailable`
 *     AND a `crossCheck.claimedNotChanged` of length > 0 — a created/modified
 *     claim git does NOT show.
 *   - `changedNotClaimed` (under-reporting) is ADVISORY-only and NEVER affects
 *     `pass` (SCENARIO-014).
 *   - `gitUnavailable` (or no record → `rec == null`) → `pass = true` — never
 *     block on infrastructure (SCENARIO-017).
 *   - No claimed changes → empty `claimedNotChanged` → `pass = true`
 *     (SCENARIO-016, trivial pass).
 *   - NEVER throws (defensive against a malformed/untrusted record). Accepts
 *     `unknown` so the wiring layer may pass a record of any shape; a record
 *     missing the expected fields collapses to a trivial pass (no false block).
 *
 * @param rec The phase end-record (or `null` when no tracker / never ended).
 * @returns `{ pass, claimedNotChanged }`. Never throws.
 */
export function computeChangeGate(rec: unknown): ChangeGateResult {
	try {
		if (rec == null || typeof rec !== "object") {
			return { pass: true, claimedNotChanged: [] };
		}
		const r = rec as { gitUnavailable?: unknown; crossCheck?: unknown };
		// Infrastructure could not be queried → cross-check unreliable → no block.
		if (r.gitUnavailable) {
			return { pass: true, claimedNotChanged: [] };
		}
		const cc = r.crossCheck;
		if (cc == null || typeof cc !== "object") {
			return { pass: true, claimedNotChanged: [] };
		}
		const claimedRaw = (cc as { claimedNotChanged?: unknown }).claimedNotChanged;
		const claimed = Array.isArray(claimedRaw)
			? claimedRaw.filter((x): x is string => typeof x === "string")
			: [];
		return { pass: claimed.length === 0, claimedNotChanged: claimed };
	} catch {
		// Defensive — never throw on a malformed/untrusted record.
		return { pass: true, claimedNotChanged: [] };
	}
}

export function runDeliverableCheck(
	cwd: string,
	deliverables: DeliverableContract | null | undefined,
	opts?: DeliverableCheckOptions,
): DeliverableCheckResult {
	try {
		// Backward compat (SCENARIO-014): no contract ⇒ nothing to check ⇒ green.
		if (!deliverables || typeof deliverables !== "object") {
			return { pass: true, missing: [], ran: [] };
		}

		const missing: string[] = [];
		const ran: string[] = [];

		// (a) requireFiles — every path checked (no short-circuit).
		const files = deliverables.requireFiles;
		if (Array.isArray(files)) {
			for (const p of files) {
				ran.push(`file:${p}`);
				if (!existsSync(resolve(cwd, p))) {
					missing.push(`missing file: ${p}`);
				}
			}
		}

		// (b) requireContains — distinguish missing-file vs unreadable vs absent.
		const contains = deliverables.requireContains;
		if (Array.isArray(contains)) {
			for (const entry of contains) {
				const file = entry?.file;
				const pattern = entry?.pattern;
				ran.push(`contains:${file}:${pattern}`);
				const rd = readForDeliverable(cwd, file);
				if (!rd.ok) {
					if (rd.exists) {
						missing.push(`unreadable: ${file}`);
					} else {
						missing.push(`missing pattern ${pattern} in ${file}`);
					}
					continue;
				}
				if (!tolerantMatch(pattern, rd.text)) {
					missing.push(`missing pattern ${pattern} in ${file}`);
				}
			}
		}

		// (c) requireNotContains — a forbidden pattern surviving in a READABLE file
		// is reported; a MISSING or UNREADABLE file is ALSO a failure (review finding:
		// requireNotContains silently PASSED when the target file was missing or
		// unreadable — a spec that forbids a pattern in `<file>` cannot be verified
		// when `<file>` is absent, so the contract is unmet and must FAIL, not silently
		// pass). This mirrors requireFiles/requireContains: `missing file:` when the
		// file is absent, `unreadable:` when it exists but cannot be read.
		const notContains = deliverables.requireNotContains;
		if (Array.isArray(notContains)) {
			for (const entry of notContains) {
				const file = entry?.file;
				const pattern = entry?.pattern;
				ran.push(`not-contains:${file}:${pattern}`);
				const rd = readForDeliverable(cwd, file);
				if (!rd.ok) {
					missing.push(rd.exists ? `unreadable: ${file}` : `missing file: ${file}`);
				} else if (tolerantMatch(pattern, rd.text)) {
					missing.push(`forbidden pattern ${pattern} still present in ${file}`);
				}
			}
		}

		// (d) requireTests — ONE cached test-list spawn per cwd per run. Skipped
		// entirely when `opts.skipTests` is set (review finding: do NOT spawn the
		// test-lister when the build gate already failed — wasted compile on a broken
		// build, and a poisoned cache). The cheap file/contains/not-contains checks
		// above still ran regardless.
		const tests = deliverables.requireTests;
		if (Array.isArray(tests) && tests.length > 0 && !opts?.skipTests) {
			const cmds = detectProjectCommands(cwd);
			const timeoutMs = resolveTimeoutMs(opts?.timeoutMs);
			const list = loadTestList(cwd, cmds, timeoutMs, opts?.signal);
			if (list.available) {
				ran.push("tests:list");
				// Review finding: matching the test name against the WHOLE raw stdout
				// (a single giant string) risks false-greens — a name substring hit in
				// a path, a directory header, or a comment line would satisfy the
				// contract even when no real test by that name exists. Match per-LINE
				// instead so a hit requires the name to appear on an actual listed
				// entry line (cargo/pytest emit one test per line; vitest --json emits
				// a single-line JSON array, which is one line and unaffected).
				const lines = list.list.split(/\r?\n/).filter((l) => l.trim().length > 0);
				for (const name of tests) {
					const hit = lines.some((line) => tolerantMatch(name, line));
					if (!hit) {
						missing.push(`missing test: ${name}`);
					}
				}
			} else {
				// No runner / spawn error / timeout / empty stdout — do NOT block
				// (existence/grep still enforced). SCENARIO-007.
				ran.push("tests:unavailable");
			}
		}

		return { pass: missing.length === 0, missing, ran };
	} catch (err) {
		// NEVER-THROW invariant (SCENARIO-010): any thrown error (e.g. a
		// deliverables object whose field access throws) degrades to a FAIL with a
		// reason rather than propagating — the gate primitive must NEVER stall the
		// pipeline. BDD: SCENARIO-010.
		const msg = err instanceof Error ? err.message : String(err);
		return {
			pass: false,
			missing: [`deliverable-check error: ${msg.split("\n")[0]}`],
			ran: [],
		};
	}
}
