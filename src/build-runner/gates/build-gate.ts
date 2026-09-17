import {RedStatus, packageDeps, packageScripts, readPackageJson} from "./red-check.ts";
/**
 * Deterministic gates: runBuildGate/runRedCheck/runDeliverableCheck/computeChangeGate + types (split from build-runner.ts).
 */

import { spawnSync } from "node:child_process";
import { superDevEnv } from "../../render/super-dev-dir.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {detectProjectCommands, type ProjectCommands } from "../detect.ts";
import { parseTestPackages, detectTouchedCargoPackages, touchedFilePaths, scopedCargoBuildArgs, scopedCargoTestArgs, scopedCargoClippyArgs, parseFailingNpmTestFiles, parseFailingPythonTestFiles, detectFailureBlockLanguage, parseFailingGoPackages, resolveGoModuleForPackages } from "../scope.ts";
import { verifyUntouchedFailuresAgainstBaseline, type BaselineCheckResult, type BaselineVerifyInput } from "../baseline.ts";
// v0.3.30 Layer A/C: universal structured classification + agent-proposed runners.
import { classifyFromStructuredCounts, harvestJUnitXml, parseTapCounts, sumHarvestedXml, parseGoTestJson, parseCountsPattern, type TestResultCounts } from "../result-parse.ts";
// v0.3.31: the single per-ecosystem seam — convention DATA, no engine knowledge.
import { conventionPlansFor, detectPmForDir, hasPackageTool, pmExec, type ConventionPlan, type ResultChannel } from "../conventions.ts";
import { dynamicRedCheckPlans, type TestRunnerSpec } from "../runner-discovery.ts";

export interface RedCheckPlan {
	cwd: string;
	argv: string[];
}

export interface RedCheckDiagnostic {
	plan: RedCheckPlan;
	language: string;
	status: RedStatus;
	exitCode: number | null;
	signal: string | null;
	error?: string;
	outputTail: string;
}

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
 *   2. `superDevEnv("SUPER_DEV_BUILD_TIMEOUT_MS")` parsed base-10 — NaN, <=0,
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
	const raw = superDevEnv("SUPER_DEV_BUILD_TIMEOUT_MS");
	if (raw !== undefined && raw !== "") {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return DEFAULT_TIMEOUT_MS;
}

export const STDERR_TAIL_LINES = 12;

export type CmdKey = "build" | "test" | "typecheck";

export interface BuildCommandPlan {
	cwd: string;
	argv: string[];
	key: CmdKey;
	label: string;
}

export interface TestListPlan {
	cwd: string;
	argv: string[];
	label: string;
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
	/**
	 * B-6: outcome of the merge-base baseline verification performed when the
	 * lenient out-of-scope pass was about to be granted. "regression" strips
	 * `inScopePass` (the failing untouched subjects PASS at baseline — the
	 * failure is new on this branch); "preexisting" evidence-backs the lenient
	 * pass; "unknown" degrades to the historical lenient behavior. Present
	 * ONLY when a baseline verification actually ran.
	 */
	baselineCheck?: BaselineCheckResult;
	/**
	 * pi session/model correlation tag (AC-10 / SCENARIO-016,017). Present ONLY
	 * when at least one of `process.env.PI_SESSION_ID` / `process.env.PI_MODEL`
	 * is set (defensive read; never throws). Plain ASCII, no control codes.
	 * When both are absent this field is OMITTED entirely so the captured build
	 * run is byte-identical to today. Observability-only: never influences
	 * pass/fail, command construction, or timeout behavior.
	 */
	correlation?: { sessionId?: string; model?: string };
}

/** Format the build-gate correlation tag as a plain-ASCII `# pi-session=<id>
 *  model=<model>` log line, or null when the result carries no correlation
 *  (both env vars were absent). Consumers log this so the tag is OBSERVABLE in
 *  the run trace — without an emission path the captured correlation field is
 *  write-only (AR-02). Plain ASCII, no control codes; observability-only. */
export function buildGateCorrelationLine(r: BuildGateResult): string | null {
	if (!r.correlation) return null;
	const parts: string[] = [];
	if (r.correlation.sessionId) parts.push(`pi-session=${r.correlation.sessionId}`);
	if (r.correlation.model) parts.push(`model=${r.correlation.model}`);
	return parts.length ? `# ${parts.join(" ")}` : null;
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

const DEP_PRUNE_DIRS = new Set([".git", ".worktree", "node_modules", "target", "dist", "build", ".next", ".nuxt", "vendor", ".venv", "venv", "__pycache__", "coverage"]);
// v0.3.30 F1: JVM manifests (run 2026-08-28T16-09-12-785Z — a Gradle/Android
// project had ZERO oracle plans because no manifest was recognized).
const PROJECT_MANIFEST_NAMES = ["package.json", "go.mod", "pyproject.toml", "setup.py", "requirements.txt", "pytest.ini", "tox.ini", "Cargo.toml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "pom.xml"];
const depBootstrapCache = new Map<string, string>();

function readJson(path: string): Record<string, unknown> | null {
	try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function findUp(start: string, file: string, stop: string): string | null {
	let cur = start;
	const root = resolve(stop);
	while (cur.startsWith(root)) {
		if (existsSync(join(cur, file))) return cur;
		const next = dirname(cur);
		if (next === cur) break;
		cur = next;
	}
	return null;
}

function findManifestDirs(cwd: string, names: string[]): string[] {
	const out = new Set<string>();
	const visit = (dir: string) => {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!DEP_PRUNE_DIRS.has(entry.name)) visit(p);
				continue;
			}
			if (entry.isFile() && names.includes(entry.name)) out.add(dir);
		}
	};
	visit(cwd);
	return [...out].sort();
}

export function isInsideOrSame(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
}

/** Resolve a deliverable path against cwd, returning the absolute path ONLY if it
 *  stays inside the worktree; otherwise null. The single safe resolver every
 *  deliverable filesystem access goes through so a model-authored `../escape`
 *  path can never read/exist-check outside cwd. Never throws. */
export function resolveInsideCwd(cwd: string, file: string): string | null {
	if (typeof file !== "string" || file.length === 0) return null;
	const abs = resolve(cwd, file);
	return isInsideOrSame(resolve(cwd), abs) ? abs : null;
}

function hasAnyManifest(dir: string, names = PROJECT_MANIFEST_NAMES): boolean {
	return names.some((name) => existsSync(join(dir, name)));
}

function nearestProjectDir(cwd: string, target: string): string | null {
	const root = resolve(cwd);
	const absTarget = resolve(cwd, target);
	if (!isInsideOrSame(root, absTarget)) return null;
	let cur = dirname(absTarget);
	while (isInsideOrSame(root, cur)) {
		if (hasAnyManifest(cur)) return cur;
		const next = dirname(cur);
		if (next === cur) break;
		cur = next;
	}
	return hasAnyManifest(root) ? root : null;
}

export function projectDirsFromEvidence(cwd: string, paths: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (typeof path !== "string" || path.trim() === "") continue;
		const dir = nearestProjectDir(cwd, path);
		if (!dir) continue;
		const abs = resolve(dir);
		if (seen.has(abs)) continue;
		seen.add(abs);
		out.push(abs);
	}
	return out;
}

function hasNestedProjectManifest(cwd: string): boolean {
	const root = resolve(cwd);
	return findManifestDirs(cwd, PROJECT_MANIFEST_NAMES).some((dir) => resolve(dir) !== root);
}

function nodeInstallArgv(dir: string, root: string): { cwd: string; argv: string[] } | null {
	const pkg = readJson(join(dir, "package.json")) ?? {};
	const pmRaw = String(pkg.packageManager ?? "").split("@")[0];
	const hasOwnLock = existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "pnpm-lock.yaml")) || existsSync(join(dir, "yarn.lock")) || existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"));
	const workspaceRoot = findUp(dir, "pnpm-workspace.yaml", root);
	// Only redirect to a pnpm workspace root when the nested package does NOT
	// declare its own package manager/lockfile. Independent nested modules must be
	// installed in their own directory; otherwise an npm package under a pnpm
	// workspace can become `npm ci` at the root and block the gate incorrectly.
	const runDir = dir !== root && workspaceRoot && !pmRaw && !hasOwnLock ? workspaceRoot : dir;
	const pm = pmRaw && /^(npm|pnpm|yarn|bun)$/.test(pmRaw)
		? pmRaw
		: existsSync(join(runDir, "pnpm-lock.yaml")) || existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm"
			: existsSync(join(dir, "yarn.lock")) ? "yarn"
				: existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? "bun"
					: "npm";
	if (pm === "pnpm") return { cwd: runDir, argv: existsSync(join(runDir, "pnpm-lock.yaml")) || existsSync(join(dir, "pnpm-lock.yaml")) ? ["pnpm", "install", "--frozen-lockfile"] : ["pnpm", "install"] };
	if (pm === "yarn") return { cwd: runDir, argv: existsSync(join(dir, "yarn.lock")) ? ["yarn", "install", "--frozen-lockfile"] : ["yarn", "install"] };
	if (pm === "bun") return { cwd: runDir, argv: existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? ["bun", "install", "--frozen-lockfile"] : ["bun", "install"] };
	return { cwd: runDir, argv: existsSync(join(dir, "package-lock.json")) ? ["npm", "ci"] : ["npm", "install"] };
}

function depFingerprint(cwd: string): string {
	const manifestNames = ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "requirements.txt", "pyproject.toml", "poetry.lock", "Pipfile", "Pipfile.lock"];
	const parts: string[] = [];
	for (const dir of findManifestDirs(cwd, manifestNames)) {
		for (const name of manifestNames) {
			const p = join(dir, name);
			try { const st = statSync(p); parts.push(`${p}:${st.mtimeMs}:${st.size}`); } catch { /* absent */ }
		}
	}
	return parts.join("|");
}

function buildDependencyBootstraps(cwd: string, cmds: ProjectCommands, requiredDirs: string[] = []): Array<{ cwd: string; argv: string[]; required: boolean }> {
	const hasRootCommands = Boolean(cmds.build || cmds.test || cmds.typecheck);
	const requiredSet = new Set(requiredDirs.map((dir) => resolve(dir)));
	if (!hasRootCommands && requiredSet.size === 0) return [];
	const tasks: Array<{ cwd: string; argv: string[]; required: boolean }> = [];
	const seen = new Set<string>();
	const root = resolve(cwd);
	const add = (dir: string, argv: string[], required = false) => { const key = `${dir}\0${argv.join(" ")}`; if (!seen.has(key)) { seen.add(key); tasks.push({ cwd: dir, argv, required }); } else if (required) { const t = tasks.find((x) => `${x.cwd}\0${x.argv.join(" ")}` === key); if (t) t.required = true; } };
	const shouldConsider = (dir: string) => hasRootCommands || requiredSet.has(resolve(dir));
	const isRequired = (dir: string) => resolve(dir) === root || requiredSet.has(resolve(dir));

	for (const dir of findManifestDirs(cwd, ["package.json"])) {
		if (!shouldConsider(dir)) continue;
		if (existsSync(join(dir, "node_modules"))) continue;
		const install = nodeInstallArgv(dir, cwd);
		if (install) add(install.cwd, install.argv, isRequired(dir));
	}
	for (const dir of findManifestDirs(cwd, ["go.mod"])) if (shouldConsider(dir)) add(dir, ["go", "mod", "download"], isRequired(dir));
	// Rust's cargo build/test already fetches dependencies as part of the normal
	// command, so no separate cargo fetch is needed (and it would add noise to
	// existing gate command accounting).
	for (const dir of findManifestDirs(cwd, ["poetry.lock"])) if (shouldConsider(dir)) add(dir, ["poetry", "install", "--no-interaction"], isRequired(dir));
	// GAP-F fix: uv is the preferred python package manager (agents/lang/python.md)
	// but was missing from the bootstrap list — a uv.lock project with no
	// .venv ended up running a global/absent interpreter. `uv sync` creates the
	// project venv and installs locked deps (updates the lock only if needed).
	for (const dir of findManifestDirs(cwd, ["uv.lock"])) {
		if (!shouldConsider(dir)) continue;
		if (existsSync(join(dir, ".venv"))) continue; // already synced — skip the spawn
		add(dir, ["uv", "sync"], isRequired(dir));
	}
	for (const dir of findManifestDirs(cwd, ["Pipfile"])) if (shouldConsider(dir)) add(dir, ["pipenv", "install", "--deploy"], isRequired(dir));
	for (const dir of findManifestDirs(cwd, ["requirements.txt"])) {
		if (!shouldConsider(dir)) continue;
		if (existsSync(join(dir, ".venv", "bin", "pip"))) add(dir, [join(dir, ".venv", "bin", "pip"), "install", "-r", "requirements.txt"], isRequired(dir));
	}
	return tasks;
}

export function bootstrapDependencies(cwd: string, timeoutMs: number, signal: AbortSignal | undefined, ran: string[], errors: string[], requiredDirs: string[] = []): void {
	if (superDevEnv("SUPER_DEV_SKIP_DEP_BOOTSTRAP") === "1") return;
	const fp = depFingerprint(cwd);
	const cacheKey = `${resolve(cwd)}\0${requiredDirs.map((dir) => resolve(dir)).sort().join("|")}`;
	if (depBootstrapCache.get(cacheKey) === fp) return;
	for (const task of buildDependencyBootstraps(cwd, detectProjectCommands(cwd), requiredDirs)) {
		if (signal?.aborted) { errors.push(`${task.argv.join(" ")}: aborted before dependency bootstrap`); return; }
		const label = `bootstrap:${task.argv.join(" ")}`;
		ran.push(label);
		try {
			const r = spawnSync(task.argv[0], task.argv.slice(1), { cwd: task.cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); // sweep-3 G5
			if (r.error || r.status !== 0) {
				const reason = r.error ? r.error.message.split("\n")[0] : `exit ${String(r.status)}`;
				const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n").trim();
				if (task.required) errors.push(`${label} FAILED (${reason})${tail ? ":\n" + tail : ""}`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (task.required) errors.push(`${label} FAILED (${msg.split("\n")[0]})`);
		}
	}
	if (!errors.some((e) => e.startsWith("bootstrap:"))) depBootstrapCache.set(cacheKey, fp);
}

export function relDir(root: string, dir: string): string {
	const absRoot = resolve(root);
	const absDir = resolve(dir);
	if (absRoot === absDir) return ".";
	const rel = relative(absRoot, absDir);
	return rel && !rel.startsWith("..") ? rel : dir;
}

export function buildPlan(root: string, planCwd: string, key: CmdKey, argv: string[]): BuildCommandPlan {
	const rel = relDir(root, planCwd);
	const command = argv.join(" ");
	return {
		cwd: planCwd,
		argv,
		key,
		label: rel === "." ? command : `${rel}: ${command}`,
	};
}

export function commandPlansFromProject(root: string, planCwd: string, cmds: ProjectCommands): BuildCommandPlan[] {
	const plans: BuildCommandPlan[] = [];
	if (cmds.build) plans.push(buildPlan(root, planCwd, "build", cmds.build));
	if (cmds.test) plans.push(buildPlan(root, planCwd, "test", cmds.test));
	if (cmds.typecheck) plans.push(buildPlan(root, planCwd, "typecheck", cmds.typecheck));
	return plans;
}

function detectPmForPackageDir(dir: string, pkg: Record<string, unknown> | null, fallbackPm?: string): string {
	const pm = String(pkg?.packageManager ?? "").split("@")[0];
	if (pm && /^(npm|pnpm|yarn|bun|deno)$/.test(pm)) return pm;
	if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
	if (existsSync(join(dir, "deno.lock"))) return "deno";
	if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(dir, "yarn.lock"))) return "yarn";
	if (fallbackPm && /^(npm|pnpm|yarn|bun|deno)$/.test(fallbackPm)) return fallbackPm;
	return "npm";
}

function nodePmRun(pm: string, script: string): string[] {
	return pm === "deno" ? ["deno", "task", script] : [pm, "run", script];
}

function detectNodePackageCommands(dir: string, fallbackPm?: string): ProjectCommands {
	const pkg = readPackageJson(dir) ?? {};
	const scripts = packageScripts(pkg);
	const deps = packageDeps(pkg);
	const pm = detectPmForPackageDir(dir, pkg, fallbackPm);
	const language = deps && (deps.react || deps.next || deps.vue || deps.svelte) ? "frontend" : "backend";
	const cmds: ProjectCommands = { language, pm, ran: [] };
	if (scripts.build) {
		cmds.build = nodePmRun(pm, "build");
		cmds.ran.push(`${pm} run build`);
	}
	if (scripts.test) {
		cmds.test = nodePmRun(pm, "test");
		cmds.ran.push(`${pm} run test`);
	}
	if (scripts.typecheck) {
		cmds.typecheck = nodePmRun(pm, "typecheck");
		cmds.ran.push(`${pm} run typecheck`);
	} else if (existsSync(join(dir, "tsconfig.json"))) {
		cmds.typecheck = ["npx", "--no-install", "tsc", "--noEmit"];
		cmds.ran.push("tsc --noEmit");
	}
	return cmds;
}

export function projectCommandsForDir(root: string, dir: string, rootCmds: ProjectCommands): ProjectCommands {
	if (existsSync(join(dir, "package.json"))) {
		const rootPkg = readPackageJson(root);
		const fallbackPm = rootCmds.pm ?? detectPmForPackageDir(root, rootPkg);
		return detectNodePackageCommands(dir, fallbackPm);
	}
	return detectProjectCommands(dir);
}

export function moduleBuildPlans(cwd: string, rootCmds: ProjectCommands, baseRef?: string): BuildCommandPlan[] {
	const root = resolve(cwd);
	if (rootCmds.language === "rust") return [];
	// Review-2 F5: gradle/maven modules have no wrapper of their own, so
	// nested detection would exec PATH `gradle` (wrapper-only machines get
	// ENOENT) or double-run full builds with version drift. The root plan
	// (`./gradlew testDebugUnitTest` etc.) already builds every included
	// module — same contract as the rust guard above.
	if (rootCmds.language === "gradle" || rootCmds.language === "maven") return [];
	if (!hasNestedProjectManifest(cwd)) return [];
	// Sweep-3 G11-B5 (audit B-5): a root manifest WITHOUT scripts no longer
	// suppresses nested plans — npm-workspaces roots routinely declare no
	// scripts while every real package does, and the old guard made their
	// build/test gates vacuously green. Nested dirs are already evidence-scoped
	// (touched files) above, so single-package repos never reach here
	// (hasNestedProjectManifest is false for them).
	const dirs = projectDirsFromEvidence(cwd, touchedFilePaths(cwd, baseRef)).filter((dir) => resolve(dir) !== root); // sweep-3 G6
	const plans: BuildCommandPlan[] = [];
	for (const dir of dirs) {
		const cmds = projectCommandsForDir(cwd, dir, rootCmds);
		plans.push(...commandPlansFromProject(cwd, dir, cmds));
	}
	return plans;
}

/**
 * Run the detected build/test/typecheck commands in `cwd`, each with a bounded
 * timeout, and collect real pass/fail + stderr tails. Non-fatal when nothing is
 * detected (`pass` true, `ran` empty). Respects an AbortSignal: a signal that is
 * already aborted skips remaining commands; one that fires mid-run is honored.
 */
/** Extract out-of-scope crate subjects from rust error blocks (crates/<pkg>/ + -p <pkg> markers). */
function parseOutOfScopeCrateSubjects(blocks: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const block of blocks) {
		const text = typeof block === "string" ? block : String(block ?? "");
		let m: RegExpExecArray | null;
		const dir = /(?:^|[\s"'`])crates\/([A-Za-z0-9_-]+)\//g;
		while ((m = dir.exec(text)) !== null) {
			if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
		}
		const flag = /-p\s+([A-Za-z0-9_-]+)/g;
		while ((m = flag.exec(text)) !== null) {
			if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
		}
	}
	return out;
}

/**
 * Prefix of the synthetic error block `resolveInScopePassWithBaseline` appends
 * to `errors` when the baseline verdict is "regression" (B-6). Hoisted into an
 * exported constant (Track 30 T1.2/AC-01) so the fault classifier
 * (src/fault-classification.ts) and the gate read ONE literal — never two.
 * The interpolation below keeps the appended block byte-identical to the
 * historical inline literal: `${BASELINE_VERIFY_ERROR_PREFIX} ${evidence}`.
 * scenarioRefs: [SCENARIO-001] · acceptanceCriteriaRefs: [AC-01]
 */
export const BASELINE_VERIFY_ERROR_PREFIX = "[baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch:";

/**
 * B-6 decision core — exported for hermetic testing. When the gate is about to
 * grant the lenient all-out-of-scope pass, the failing subjects are verified
 * against the merge-base baseline (see ./baseline.ts). "regression" strips the
 * lenient pass and appends a synthetic in-scope error block; "preexisting" /
 * "unknown" keep it (unknown == the historical behavior). The historical
 * formula (`pass || (errors.length > 0 && outOfScopeErrors.length === errors.length)`)
 * is preserved byte-for-byte whenever no baseline verification runs (gate
 * green, partial out-of-scope, no default branch, or no parseable subjects).
 * NEVER throws.
 */
export function resolveInScopePassWithBaseline(args: {
	pass: boolean;
	errors: string[];
	outOfScopeErrors: string[];
	language: string;
	pm?: string;
	cwd: string;
	defaultBranch?: string;
	signal?: AbortSignal;
	/** Injectable verifier (tests). Defaults to {@link verifyUntouchedFailuresAgainstBaseline}. */
	baselineVerify?: (input: BaselineVerifyInput) => BaselineCheckResult;
}): { inScopePass: boolean; errors: string[]; baselineCheck?: BaselineCheckResult } {
	const historical = args.pass || (args.errors.length > 0 && args.outOfScopeErrors.length === args.errors.length);
	if (args.pass || !args.defaultBranch) return { inScopePass: historical, errors: args.errors };
	if (!(args.errors.length > 0 && args.outOfScopeErrors.length === args.errors.length)) {
		return { inScopePass: historical, errors: args.errors };
	}
	try {
		// v0.2.9 G6: group the out-of-scope failure blocks BY THE SUBJECT'S OWN
		// language (detected from the block), not the run's primary language, and
		// verify each group with the matching runner + module dir. Run
		// 2026-08-19T08-32-47-962Z: a nested Go module's `snow` failure on a
		// node-primary track was verified with `pnpm run test` (passes at baseline)
		// → mis-tagged regression. A block whose language cannot be detected falls
		// back to the run's primary language (today's behavior).
		const verify = args.baselineVerify ?? verifyUntouchedFailuresAgainstBaseline;
		const byLang = new Map<string, string[]>();
		for (const block of args.outOfScopeErrors) {
			const b = typeof block === "string" ? block : String(block ?? "");
			const detected = detectFailureBlockLanguage(b);
			// Only the compiled/distinct families OVERRIDE the run's primary language;
			// a node-detected block (or an undetected one) verifies with the run's own
			// language (frontend/backend/node) so buildBaselinePlan builds the right JS
			// runner — never the bare literal "node" (which it cannot plan).
			const key = detected === "go" || detected === "rust" || detected === "python" ? detected : args.language;
			(byLang.get(key) ?? byLang.set(key, []).get(key)!).push(b);
		}
		let anyVerified = false;
		let lastOutcome: BaselineCheckResult | undefined;
		const regressionEvidence: string[] = [];
		for (const [lang, blocks] of byLang) {
			let subjects: string[];
			let moduleSubdir: string | undefined;
			if (lang === "rust") {
				subjects = parseOutOfScopeCrateSubjects(blocks);
			} else if (lang === "go") {
				const pkgs = parseFailingGoPackages(blocks);
				const mod = pkgs.length ? resolveGoModuleForPackages(args.cwd, pkgs) : null;
				if (mod) {
					moduleSubdir = mod.moduleSubdir;
					// buildBaselinePlan(go) maps `.go` file subjects → their dir; synthesize
					// a module-relative marker per package dir so it resolves to
					// `go test ./<dir>` inside the module.
					subjects = mod.packageDirs.map((d) => (d === "." ? "pkg.go" : `${d}/pkg.go`));
				} else {
					subjects = [];
				}
			} else if (lang === "python") {
				subjects = [...new Set(blocks.flatMap((b) => parseFailingPythonTestFiles(b)))];
			} else {
				subjects = [...new Set(blocks.flatMap((b) => parseFailingNpmTestFiles(b)))];
			}
			if (subjects.length === 0) continue;
			anyVerified = true;
			const outcome = verify({
				cwd: args.cwd,
				defaultBranch: args.defaultBranch,
				language: lang,
				pm: args.pm,
				subjects,
				...(moduleSubdir ? { moduleSubdir } : {}),
				signal: args.signal,
			});
			lastOutcome = outcome;
			if (outcome.status === "regression") regressionEvidence.push(outcome.evidence);
		}
		if (!anyVerified) return { inScopePass: historical, errors: args.errors };
		// A regression in ANY language group strips the lenient pass (the phase must
		// address a failure that is genuinely new on this branch).
		if (regressionEvidence.length > 0) {
			return {
				inScopePass: false,
				errors: [...args.errors, ...regressionEvidence.map((e) => `${BASELINE_VERIFY_ERROR_PREFIX} ${e}`)],
				baselineCheck: { status: "regression", evidence: regressionEvidence.join(" | ") },
			};
		}
		return { inScopePass: historical, errors: args.errors, baselineCheck: lastOutcome };
	} catch {
		return { inScopePass: historical, errors: args.errors };
	}
}
