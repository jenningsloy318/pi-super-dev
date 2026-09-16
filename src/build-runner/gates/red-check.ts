import {BuildCommandPlan, BuildGateResult, GateOptions, RedCheckDiagnostic, RedCheckPlan, STDERR_TAIL_LINES, bootstrapDependencies, buildPlan, commandPlansFromProject, moduleBuildPlans, resolveInScopePassWithBaseline, resolveTimeoutMs} from "./build-gate.ts";
/**
 * Deterministic gates: runBuildGate/runRedCheck/runDeliverableCheck/computeChangeGate + types (split from build-runner.ts).
 */

import { spawnSync } from "node:child_process";
import { superDevEnv } from "../../render/super-dev-dir.ts";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { dedupePreservingOrder, detectProjectCommands, resolveCargoPackageNames, validatePackageNames, resolveIntegrationStems, classificationScope, type ProjectCommands } from "../detect.ts";
import { parseTestPackages, detectTouchedCargoPackages, touchedFilePaths, scopedCargoBuildArgs, scopedCargoTestArgs, scopedCargoClippyArgs, classifyOutOfScopeErrors, classifyOutOfScopeNpmErrors, parseFailingNpmTestFiles, parseFailingPythonTestFiles, detectFailureBlockLanguage, parseFailingGoPackages, resolveGoModuleForPackages } from "../scope.ts";
import { verifyUntouchedFailuresAgainstBaseline, type BaselineCheckResult, type BaselineVerifyInput } from "../baseline.ts";
// v0.3.30 Layer A/C: universal structured classification + agent-proposed runners.
import { classifyFromStructuredCounts, harvestJUnitXml, parseTapCounts, sumHarvestedXml, parseGoTestJson, parseCountsPattern, type TestResultCounts } from "../result-parse.ts";
// v0.3.31: the single per-ecosystem seam — convention DATA, no engine knowledge.
import { conventionPlansFor, detectPmForDir, hasPackageTool, pmExec, type ConventionPlan, type ResultChannel } from "../conventions.ts";
import { dynamicRedCheckPlans, type TestRunnerSpec } from "../runner-discovery.ts";
export function runBuildGate(
	cwd: string,
	opts: { timeoutMs?: number; testPackages?: string[]; gate?: GateOptions; signal?: AbortSignal; defaultBranch?: string; baselineVerify?: (input: BaselineVerifyInput) => BaselineCheckResult } = {},
): BuildGateResult {
	const cmds0 = detectProjectCommands(cwd);
	const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
	// AC-03: FOUR-tier package-set precedence (highest → lowest). The git-diff
	// spawn runs ONLY in tier (iii) — it is SKIPPED whenever a higher tier
	// supplies a value, so an override never wastes a process (SCENARIO-007).
	//   (i)   opts.testPackages provided (incl. explicit [] = force workspace-wide);
	//   (ii)  superDevEnv("SUPER_DEV_BUILD_TEST_PACKAGES") (set-but-empty ⇒ [] and
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
	} else if (superDevEnv("SUPER_DEV_BUILD_TEST_PACKAGES") !== undefined || process.env.SUPER_DEV_BUILD_TEST_PACKAGES !== undefined) {
		// Tier (ii) keeps the pre-v0.3.15 set-but-empty escape hatch: an env var
		// explicitly set to "" means "force workspace-wide, skip auto-detect"
		// (process.env check — superDevEnv deliberately treats "" as unset).
		// A config-env value flows through superDevEnv as usual.
		testPackages = parseTestPackages(superDevEnv("SUPER_DEV_BUILD_TEST_PACKAGES"));
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
		testPackages = resolveCargoPackageNames(cwd, detectTouchedCargoPackages(cwd, opts.defaultBranch)); // sweep-3 G6 (AR1-3)
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
	const rootPlans = commandPlansFromProject(cwd, cwd, cmds);
	const nestedPlans = moduleBuildPlans(cwd, cmds0, opts.defaultBranch); // sweep-3 G6
	bootstrapDependencies(cwd, timeoutMs, opts.signal, ran, errors, nestedPlans.map((plan) => plan.cwd));
	const bootstrapFailed = errors.some((e) => e.startsWith("bootstrap:"));
	if (bootstrapFailed) {
		if (cmds.build) flag.build = false;
		if (cmds.test) flag.test = false;
		if (cmds.typecheck) flag.typecheck = false;
	}

	const exec = (plan: BuildCommandPlan) => {
		const { argv, key, label } = plan;
		if (opts.signal?.aborted) {
			flag[key] = false;
			errors.push(`${label}: aborted before run`);
			return;
		}
		ran.push(label);
		try {
			const r = spawnSync(argv[0], argv.slice(1), { cwd: plan.cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); // sweep-3 G5: 64MB (default 1MB ENOBUFS-kills large suites)
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

	if (!bootstrapFailed) {
		for (const plan of rootPlans) exec(plan);
		for (const plan of nestedPlans) exec(plan);
	}

	// CR-004: run spec-declared integration/e2e targets as additional
	// `cargo test --test <stem>` invocations (NOT -p flags — these are explicit
	// test binaries whose file paths were stat-validated). Uses key "test" so a
	// failure in any integration target correctly marks allTestsPass=false.
	if (!bootstrapFailed) {
		for (const stem of gateIntegrationStems) {
			exec(buildPlan(cwd, cwd, "test", ["cargo", "test", "--test", stem, "--quiet"]));
		}
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
			: classifyOutOfScopeNpmErrors(errors, cwd, opts.defaultBranch); // sweep-3 G6: honor the run's real base ref
	// B-6: the historical formula granted the lenient pass whenever EVERY error
	// block was out-of-scope, WITHOUT checking that the failing subjects were
	// actually failing before the branch. Now the same subjects are re-run in an
	// isolated checkout of the merge-base: "preexisting"/"unknown" keep the
	// lenient pass (unknown == the old behavior, degraded on any ambiguity);
	// "regression" (subjects pass at baseline) strips it so the phase must fix.
	const baselineDecision = resolveInScopePassWithBaseline({
		pass,
		errors,
		outOfScopeErrors,
		language: cmds0.language,
		pm: cmds0.pm,
		cwd,
		defaultBranch: opts.defaultBranch,
		signal: opts.signal,
		baselineVerify: opts.baselineVerify,
	});
	const inScopePass = baselineDecision.inScopePass;
	const errorsWithBaseline = baselineDecision.errors;
	// AC-10 / SCENARIO-016,017: pi session/model correlation tag. Defensive read
	// of the bash-session env vars pi 0.82.0 exposes to built-in bash tools. The
	// field is OMITTED entirely when BOTH are absent so the captured build run is
	// byte-identical to today (SCENARIO-017); populated additively (only the keys
	// whose env var is set) when at least one is present (SCENARIO-016). Plain
	// ASCII values copied verbatim — no control codes synthesized. Observability-
	// only: it NEVER touches pass/fail, command construction, or timeouts. The
	// read is try-guarded so a hostile `process.env` proxy cannot stall the gate.
	let correlation: { sessionId?: string; model?: string } | undefined;
	try {
		const sid = process.env.PI_SESSION_ID;
		const mdl = process.env.PI_MODEL;
		if (sid || mdl) {
			correlation = {
				...(sid ? { sessionId: sid } : {}),
				...(mdl ? { model: mdl } : {}),
			};
		}
	} catch {
		// NEVER throw — degrade to absent (byte-identical) on any read failure.
		correlation = undefined;
	}
	return {
		pass,
		buildSuccess,
		allTestsPass,
		typecheckSuccess,
		ran,
		errors: errorsWithBaseline,
		outOfScopeErrors,
		inScopePass,
		...(baselineDecision.baselineCheck ? { baselineCheck: baselineDecision.baselineCheck } : {}),
		...(correlation ? { correlation } : {}),
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
	onPlan?: (plans: RedCheckPlan[]) => void;
	onResult?: (diagnostic: RedCheckDiagnostic) => void;
	/** Sweep-3 G6 (AR1-3): the run's real base ref for touched-file scoping. */
	defaultBranch?: string;
	/** v0.3.30 Layer C: an agent-proposed, machine-validated runner spec used
	 *  when the deterministic registry matched nothing for this stack. */
	runner?: TestRunnerSpec;
}

export function tailText(text: string, maxLines = STDERR_TAIL_LINES): string {
	const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
	return lines.slice(-maxLines).join("\n");
}

export function emitRedDiagnostic(opts: RedCheckOptions | undefined, diagnostic: RedCheckDiagnostic): void {
	try { opts?.onResult?.(diagnostic); } catch { /* diagnostics must never affect the oracle */ }
}

export function emitRedPlans(opts: RedCheckOptions | undefined, plans: Array<{ cwd: string; argv: string[] }>): void {
	try { opts?.onPlan?.(plans.map((plan) => ({ cwd: plan.cwd, argv: [...plan.argv] }))); } catch { /* diagnostics must never affect the oracle */ }
}

/** Collect structured per-test evidence for one executed plan, per its
 *  DECLARED channel (conventions data or a validated dynamic spec). Pure read
 *  + parse; never throws; null = no evidence. (v0.3.31.) */
export function collectStructuredEvidence(plan: ConventionPlan, startedMs: number, combined: string): TestResultCounts | null {
	try {
		const ch = plan.channel;
		if (ch.format === "tap") return parseTapCounts(combined);
		if (ch.format === "gojson") return parseGoTestJson(combined);
		if (ch.format === "counts") return parseCountsPattern(combined, ch.pattern);
		if (ch.format === "junit-xml") {
			const files = harvestJUnitXml(plan.cwd, startedMs);
			for (const f of ch.explicitFiles ?? []) {
				try { if (statSync(f).mtimeMs + 1 >= startedMs) files.push(f); } catch { /* missing */ }
			}
			return sumHarvestedXml(files);
		}
		// auto: dynamic/validated runners and generic npm scripts — try every
		// structured shape; Layer C validation guaranteed one fires for dynamic
		// specs (junit/tap evidence was REQUIRED to cache them).
		const xml = sumHarvestedXml(harvestJUnitXml(plan.cwd, startedMs));
		if (xml) return xml;
		const tap = parseTapCounts(combined);
		if (tap) return tap;
		return parseGoTestJson(combined);
	} catch {
		return null;
	}
}

/** v0.3.31 universal classifier — the ONLY status decision in the engine.
 *  Structured counts + exit code; without counts the honest answer is
 *  `unknown` — for a failing exit (red vs broken is undecidable without
 *  per-test evidence) AND for a passing exit (scope-miss false-green guard:
 *  pytest exit 5, cargo/go filter misses exit 0). Console prose NEVER
 *  classifies (Bazel test encyclopedia: "writing any of the strings PASS or
 *  FAIL to stdout has no significance to the test runner"). */
export function classifyFromEvidence(exitOk: boolean, counts: TestResultCounts | null): RedStatus {
	if (!counts) return "unknown";
	return classifyFromStructuredCounts(counts, exitOk) ?? "unknown";
}

export function cleanupConventionPlans(plans: ConventionPlan[]): void {
	for (const dir of plans.flatMap((p) => p.cleanupDirs ?? [])) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

export function readPackageJson(dir: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function packageScripts(pkg: Record<string, unknown> | null): Record<string, string> {
	return (pkg?.scripts ?? {}) as Record<string, string>;
}

export function packageDeps(pkg: Record<string, unknown> | null): Record<string, string> {
	return { ...(pkg?.dependencies as Record<string, string> | undefined), ...(pkg?.devDependencies as Record<string, string> | undefined) };
}

export function combineRedStatuses(statuses: RedStatus[]): RedStatus {
	if (statuses.length === 0) return "unknown";
	if (statuses.includes("broken")) return "broken";
	if (statuses.includes("red")) return "red";
	if (statuses.every((status) => status === "green")) return "green";
	return "unknown";
}

/**
 * v0.3.31 — the universal RED oracle. The engine is LANGUAGE-BLIND: plans come
 * from the conventions table (src/build-runner/conventions.ts — editable rows
 * + row-owned builders; the single per-ecosystem seam) or from a
 * machine-VALIDATED agent-proposed runner (runner-discovery.ts, Layer C —
 * "LLM proposes, machine verifies, cache reuses"). Classification reads ONLY
 * structured evidence plus the exit code (see classifyFromEvidence). All
 * per-language branches, regex chains, and greenfield predicates that lived
 * here through v0.3.30 are DELETED — adding or fixing a stack means editing
 * convention DATA, never this engine.
 * NEVER-THROW: any spawn error, thrown exception, or ambiguity degrades to
 * `unknown` (proceed, do not stall). */
