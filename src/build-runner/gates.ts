/**
 * Deterministic gates: runBuildGate/runRedCheck/runDeliverableCheck/computeChangeGate + types (split from build-runner.ts).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { dedupePreservingOrder, detectProjectCommands, readMaybe, resolveCargoPackageNames, validatePackageNames, resolveIntegrationStems, classificationScope, type ProjectCommands } from "./detect.ts";
import { parseTestPackages, detectTouchedCargoPackages, touchedFilePaths, scopedCargoBuildArgs, scopedCargoTestArgs, scopedCargoClippyArgs, classifyOutOfScopeErrors, classifyOutOfScopeNpmErrors, parseFailingNpmTestFiles } from "./scope.ts";
import { verifyUntouchedFailuresAgainstBaseline, type BaselineCheckResult, type BaselineVerifyInput } from "./baseline.ts";

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

interface BuildCommandPlan {
	cwd: string;
	argv: string[];
	key: CmdKey;
	label: string;
}

interface RedExecutionPlan extends RedCheckPlan {
	language: string;
}

interface TestListPlan {
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
const PROJECT_MANIFEST_NAMES = ["package.json", "go.mod", "pyproject.toml", "setup.py", "requirements.txt", "pytest.ini", "tox.ini", "Cargo.toml"];
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

function isInsideOrSame(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
}

/** Resolve a deliverable path against cwd, returning the absolute path ONLY if it
 *  stays inside the worktree; otherwise null. The single safe resolver every
 *  deliverable filesystem access goes through so a model-authored `../escape`
 *  path can never read/exist-check outside cwd. Never throws. */
function resolveInsideCwd(cwd: string, file: string): string | null {
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

function projectDirsFromEvidence(cwd: string, paths: string[]): string[] {
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

function bootstrapDependencies(cwd: string, timeoutMs: number, signal: AbortSignal | undefined, ran: string[], errors: string[], requiredDirs: string[] = []): void {
	if (process.env.SUPER_DEV_SKIP_DEP_BOOTSTRAP === "1") return;
	const fp = depFingerprint(cwd);
	const cacheKey = `${resolve(cwd)}\0${requiredDirs.map((dir) => resolve(dir)).sort().join("|")}`;
	if (depBootstrapCache.get(cacheKey) === fp) return;
	for (const task of buildDependencyBootstraps(cwd, detectProjectCommands(cwd), requiredDirs)) {
		if (signal?.aborted) { errors.push(`${task.argv.join(" ")}: aborted before dependency bootstrap`); return; }
		const label = `bootstrap:${task.argv.join(" ")}`;
		ran.push(label);
		try {
			const r = spawnSync(task.argv[0], task.argv.slice(1), { cwd: task.cwd, timeout: timeoutMs, encoding: "utf8" });
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

function relDir(root: string, dir: string): string {
	const absRoot = resolve(root);
	const absDir = resolve(dir);
	if (absRoot === absDir) return ".";
	const rel = relative(absRoot, absDir);
	return rel && !rel.startsWith("..") ? rel : dir;
}

function buildPlan(root: string, planCwd: string, key: CmdKey, argv: string[]): BuildCommandPlan {
	const rel = relDir(root, planCwd);
	const command = argv.join(" ");
	return {
		cwd: planCwd,
		argv,
		key,
		label: rel === "." ? command : `${rel}: ${command}`,
	};
}

function commandPlansFromProject(root: string, planCwd: string, cmds: ProjectCommands): BuildCommandPlan[] {
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

function projectCommandsForDir(root: string, dir: string, rootCmds: ProjectCommands): ProjectCommands {
	if (existsSync(join(dir, "package.json"))) {
		const rootPkg = readPackageJson(root);
		const fallbackPm = rootCmds.pm ?? detectPmForPackageDir(root, rootPkg);
		return detectNodePackageCommands(dir, fallbackPm);
	}
	return detectProjectCommands(dir);
}

function moduleBuildPlans(cwd: string, rootCmds: ProjectCommands): BuildCommandPlan[] {
	const root = resolve(cwd);
	if (rootCmds.language === "rust") return [];
	if (!hasNestedProjectManifest(cwd)) return [];
	if (!rootCmds.build && !rootCmds.test && !rootCmds.typecheck && hasAnyManifest(root)) return [];
	const dirs = projectDirsFromEvidence(cwd, touchedFilePaths(cwd)).filter((dir) => resolve(dir) !== root);
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
		const subjects =
			args.language === "rust"
				? parseOutOfScopeCrateSubjects(args.outOfScopeErrors)
				: [...new Set(args.outOfScopeErrors.flatMap((b) => parseFailingNpmTestFiles(typeof b === "string" ? b : String(b ?? ""))))];
		if (subjects.length === 0) return { inScopePass: historical, errors: args.errors };
		const verify = args.baselineVerify ?? verifyUntouchedFailuresAgainstBaseline;
		const outcome = verify({
			cwd: args.cwd,
			defaultBranch: args.defaultBranch,
			language: args.language,
			pm: args.pm,
			subjects,
			signal: args.signal,
		});
		if (outcome.status === "regression") {
			return {
				inScopePass: false,
			errors: [...args.errors, `[baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch: ${outcome.evidence}`],
				baselineCheck: outcome,
			};
		}
		return { inScopePass: historical, errors: args.errors, baselineCheck: outcome };
	} catch {
		return { inScopePass: historical, errors: args.errors };
	}
}

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
	const rootPlans = commandPlansFromProject(cwd, cwd, cmds);
	const nestedPlans = moduleBuildPlans(cwd, cmds0);
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
			const r = spawnSync(argv[0], argv.slice(1), { cwd: plan.cwd, timeout: timeoutMs, encoding: "utf8" });
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
			: classifyOutOfScopeNpmErrors(errors, cwd);
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
}

function tailText(text: string, maxLines = STDERR_TAIL_LINES): string {
	const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
	return lines.slice(-maxLines).join("\n");
}

function emitRedDiagnostic(opts: RedCheckOptions | undefined, diagnostic: RedCheckDiagnostic): void {
	try { opts?.onResult?.(diagnostic); } catch { /* diagnostics must never affect the oracle */ }
}

function emitRedPlans(opts: RedCheckOptions | undefined, plans: RedExecutionPlan[]): void {
	try { opts?.onPlan?.(plans.map((plan) => ({ cwd: plan.cwd, argv: [...plan.argv] }))); } catch { /* diagnostics must never affect the oracle */ }
}

// Source extensions tried when resolving a relative module specifier to a file
// on disk (greenfield RED detection). Mirrors Node/TS resolver basics.
const RED_SOURCE_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** Extract candidate RELATIVE module specifiers (`./…` or `../…`) mentioned in
 *  runner output. Bare specifiers (`express`, `node:fs`) and absolute paths are
 *  ignored — they are external/package resolution concerns, not the module
 *  under test. Pure + never throws. */
function extractRelativeSpecifiers(out: string): string[] {
	const re = /(?:^|[^\w./])(\.{1,2}\/[^\s'")\]]+)/g;
	const specs = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(out))) {
		const clean = m[1].replace(/[:;,.)+]+$/, "");
		if (clean) specs.add(clean);
	}
	return [...specs];
}

/** Does a relative specifier resolve to an EXISTING source file under `cwd` or
 *  the directory of any RED target? (A test in `src/persistence.test.ts` that
 *  imports `./persistence` resolves the module under `src/`.) Pure + never
 *  throws (existsSync is wrapped). */
function relativeModuleExists(cwd: string, spec: string, targets: string[]): boolean {
	try {
		const dirs = [cwd, ...targets.map((t) => join(cwd, dirname(t)))];
		for (const dir of dirs) {
			const base = resolve(dir, spec);
			for (const ext of RED_SOURCE_EXTS) {
				if (existsSync(base + ext)) return true;
				if (existsSync(join(base, "index" + (ext || ".ts")))) return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

/** GREENFIELD RED: a test failing ONLY because it imports a not-yet-created
 *  RELATIVE project module is failing because the implementation is missing —
 *  the textbook greenfield RED (the contract `buildTddPrompt` states is valid).
 *  Detected so `classifyRedStatus` returns "red" instead of "broken".
 *
 *  Conservative by design:
 *  - SyntaxError / `No test files found` / `Cannot find package` → NOT
 *    greenfield (those are genuinely broken).
 *  - No RELATIVE specifier present → NOT greenfield (a bare package miss stays
 *    broken).
 *  - With `cwd`: greenfield only when EVERY extracted relative specifier
 *    resolves to an ABSENT file. An existing module that fails to load is a
 *    real load failure → broken (never mis-read as greenfield). Pure + never
 *    throws. */
function isGreenfieldModuleMissing(out: string, cwd?: string, targets: string[] = []): boolean {
	if (/SyntaxError|No test files found|Cannot find package/i.test(out)) return false;
	if (!/Failed to load url|ERR_MODULE_NOT_FOUND|Cannot find module|Could not resolve|does not exist|not found/i.test(out)) return false;
	const specs = extractRelativeSpecifiers(out);
	if (specs.length === 0) return false;
	if (!cwd) return true;
	return specs.every((spec) => !relativeModuleExists(cwd, spec, targets));
}

/** Python module existence check for the greenfield detector: a dotted
 *  module name resolves to <root>/<dotted-as-path>.py or
 *  <root>/<dotted-as-path>/__init__.py under any of the conventional roots
 *  (repo root, src/, tests/). Pure + never throws. */
function pythonModuleExists(cwd: string, dotted: string): boolean {
	const rel = dotted.replace(/\./g, "/");
	for (const root of [cwd, join(cwd, "src"), join(cwd, "tests")]) {
		try {
			if (existsSync(join(root, rel + ".py"))) return true;
			if (existsSync(join(root, rel, "__init__.py"))) return true;
		} catch {
			/* best-effort */
		}
	}
	return false;
}

/** GREENFIELD RED (python): pytest collection failed with ModuleNotFoundError
 *  for module(s) that do NOT exist under any conventional root — the
 *  implementation is simply not written yet (the contract buildTddPrompt
 *  states is valid RED). An EXISTING module that fails to import (RuntimeError
 *  at import time, circular import, …) produces ERROR collecting WITHOUT a
 *  ModuleNotFoundError and stays broken.
 *  Probed byte-for-byte against pytest 8.3.5 (exit 2):
 *      "ERROR collecting tests/test_thing.py"
 *      "E   ModuleNotFoundError: No module named 'mypkg'"          */
function isPythonGreenfieldCollectionFailure(out: string, cwd?: string): boolean {
	if (!/ERROR collecting/i.test(out)) return false;
	if (/SyntaxError/i.test(out)) return false;
	const names = [...out.matchAll(/ModuleNotFoundError: No module named '([^']+)'/g)].map((m) => m[1]);
	if (names.length === 0) return false;
	if (!cwd) return true;
	return names.every((name) => !pythonModuleExists(cwd, name));
}

/** Go: does the directory (relative to the module root) contain ONLY *_test.go
 *  files (zero production .go)? An absent dir counts (nothing production
 *  there yet). Pure + never throws. */
function goDirHasOnlyTestFiles(cwd: string, relDir: string): boolean {
	try {
		const dir = resolve(cwd, relDir);
		if (!existsSync(dir)) return true;
		const entries = readdirSync(dir).filter((e) => e.endsWith(".go"));
		return entries.length > 0 && entries.every((e) => e.endsWith("_test.go"));
	} catch {
		return false;
	}
}

/** Read the `module <path>` directive from go.mod (null when unreadable). */
function readGoModuleName(cwd: string): string | null {
	try {
		const text = readFileSync(join(cwd, "go.mod"), "utf8");
		const m = /(?:^|\n)module\s+(\S+)/.exec(text);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

/** GREENFIELD RED (go): the build failed ONLY because the code under test
 *  does not exist yet, in one of two probed shapes (go 1.26.3):
 *   1. `path/file_test.go:L:C: undefined: Ident` + `FAIL\t<pkg> [build failed]`
 *      where the referenced directory contains ONLY *_test.go files.
 *   2. `no required module provides package <module>/<dir>; to add it:`
 *      (a same-module package whose directory is absent) + `[setup failed]`.
 *  Any diagnostic on a PRODUCTION .go file, or any non-`undefined` diagnostic,
 *  means the suite is genuinely broken → not greenfield. Pure + never throws. */
function isGoGreenfieldBuildFailure(out: string, cwd?: string): boolean {
	const errorLines = [...out.matchAll(/([^\s:]+\.go):\d+:\d+: ([^\n]+)/g)];
	const undefinedLines = errorLines.filter((m) => /^undefined: /.test(m[2]));
	if (undefinedLines.length > 0) {
		if (errorLines.length !== undefinedLines.length) return false;
		const files = undefinedLines.map((m) => m[1]);
		if (!files.every((f) => /_test\.go$/.test(f))) return false;
		if (!cwd) return true;
		return files.every((f) => goDirHasOnlyTestFiles(cwd, dirname(f)));
	}
	const missingPkg = [...out.matchAll(/no required module provides package (\S+?)[;\s]/g)].map((m) => m[1]);
	if (missingPkg.length > 0) {
		if (!cwd) return true;
		const modulePath = readGoModuleName(cwd);
		if (!modulePath) return false;
		return missingPkg.every((pkg) => pkg.startsWith(modulePath + "/") && !existsSync(join(cwd, pkg.slice(modulePath.length + 1))));
	}
	return false;
}

/** Read the [package].name from Cargo.toml, normalized to the lib name
 *  (hyphens → underscores). Null when unreadable. */
function readCargoPackageName(cwd: string): string | null {
	try {
		const text = readFileSync(join(cwd, "Cargo.toml"), "utf8");
		const pkg = /\[package\]([^\[]*)/.exec(text);
		const m = pkg ? /name\s*=\s*"([^"]+)"/.exec(pkg[1]) : null;
		return m ? m[1].replace(/-/g, "_") : null;
	} catch {
		return null;
	}
}

/** GREENFIELD RED (rust): the crate failed to compile ONLY because the code
 *  under test does not exist yet, in one of three shapes (cargo 1.95.0):
 *   1. greenfield crate (no src/lib.rs): `error[E0433]: cannot find module or
 *      crate `<this-crate>` ` naming THIS crate.
 *   2. undeclared module: `error[E0432]: unresolved import `<crate>::<mod>`
 *      where the leading segment is this crate (`crate::`/`self::`/`super::`
 *      also count as internal).
 *   3. declared-but-absent module: `error[E0583]: file not found for module
 *      `<mod>` `.
 *  An EXTERNAL unresolved crate (serde_json, …) is broken — the test author
 *  referenced a dependency missing from Cargo.toml. Any unresolved-EXTERNAL
 *  diagnostic anywhere disqualifies greenfield. Pure + never throws. */
function isRustGreenfieldCompileFailure(out: string, cwd?: string): boolean {
	if (!/error\[E04(32|33)\]|error\[E0583\]/.test(out)) return false;
	const crateName = cwd ? readCargoPackageName(cwd) : null;
	const isInternalPath = (path: string): boolean => {
		const first = path.split("::")[0];
		if (first === "crate" || first === "self" || first === "super") return true;
		return crateName !== null && first === crateName;
	};
	let sawInternal = false;
	for (const m of out.matchAll(/error\[E0432\]: unresolved import `([^`]+)`/g)) {
		if (!isInternalPath(m[1])) return false;
		sawInternal = true;
	}
	for (const m of out.matchAll(/error\[E0433\]: cannot find module or crate `([^`]+)`/g)) {
		// E0433 naming THIS crate ⇒ the lib target does not exist (greenfield
		// crate). Naming anything else ⇒ external dependency missing → broken.
		if (crateName === null || m[1] !== crateName) return false;
		sawInternal = true;
	}
	for (const m of out.matchAll(/error\[E0583\]: file not found for module `([^`]+)`/g)) {
		sawInternal = true; // by definition a module of THIS crate whose file is absent
	}
	return sawInternal;
}

/**
 * Classify a runner's COMBINED stdout+stderr into a RED-phase status using
 * per-language heuristics (spec §A.2, AC-01). Pure + NEVER throws. Precedence
 * is always: BROKEN markers (compile/collection failure) → GREEN (exit 0) →
 * RED (exit≠0 + a failure marker) → UNKNOWN (ambiguous). This order guarantees
 * a compile error that also emits a `FAILED` marker is `broken` (the test
 * never ran), not `red` (review finding: precedence over red).
 *
 * `ctx` carries `cwd` + `targets` so the npm-family greenfield check can verify
 * whether an imported relative module actually exists on disk.
 */
function classifyRedStatus(language: string, combined: string, ok: boolean, ctx?: { cwd?: string; targets?: string[] }): RedStatus {
	const out = combined ?? "";
	if (language === "rust") {
		// RED (greenfield) — the crate failed to compile solely because the code
		// under test does not exist yet (missing crate/module targets). Cross-
		// language parity with the npm isGreenfieldModuleMissing check below.
		if (isRustGreenfieldCompileFailure(out, ctx?.cwd)) return "red";
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
		// RED (greenfield) — collection failed solely because the module under
		// test does not exist yet (the buildTddPrompt greenfield contract).
		if (isPythonGreenfieldCollectionFailure(out, ctx?.cwd)) return "red";
		// BROKEN — pytest could not even collect.
		if (/ERROR collecting/i.test(out)) return "broken";
		if (ok) return "green";
		if (/\bfailed\b/i.test(out) || /\berror\b/i.test(out)) return "red";
		return "unknown";
	}
	if (language === "go") {
		// RED (greenfield) — the build failed solely because the code under test
		// does not exist yet (undefined ident in a test-only package dir, or a
		// same-module package whose directory is absent).
		if (isGoGreenfieldBuildFailure(out, ctx?.cwd)) return "red";
		if (/build failed/i.test(out) || /setup failed/i.test(out) || /no required module provides package/i.test(out)) return "broken";
		if (ok) return "green";
		if (/^--- FAIL:/m.test(out) || /^FAIL\b/m.test(out) || /\bpanic:/i.test(out)) return "red";
		return "unknown";
	}
	// npm family: vitest / jest / npm run test (frontend + backend).
	// BROKEN — test/source syntax error before any test ran.
	if (/SyntaxError/i.test(out)) return "broken";
	// BROKEN — the positional filter matched no test file (no run).
	if (/No test files found/i.test(out)) return "broken";
	// BROKEN — a missing EXTERNAL dependency (bare package specifier).
	if (/Cannot find package/i.test(out)) return "broken";
	// RED (greenfield) — the test imports a not-yet-created RELATIVE project
	// module; the suite fails to load solely because the implementation is
	// missing. This is the textbook greenfield RED (matches buildTddPrompt's
	// stated contract). Distinguished from a real load failure by the relative
	// module being ABSENT on disk; an existing module that fails to load is
	// caught by the next rule and stays broken.
	if (isGreenfieldModuleMissing(out, ctx?.cwd, ctx?.targets)) return "red";
	// BROKEN — any OTHER collection/load failure (config load, an existing
	// module that throws at import, a missing bare specifier that isn't
	// "Cannot find package", …).
	if (/failed to load|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(out)) return "broken";
	if (ok) return "green";
	// RED — a failing-test marker appeared after a successful collection.
	if (
		/❯/.test(out) ||
		/^✖\s+/m.test(out) ||
		/^FAIL\s+/m.test(out) ||
		/failing tests/i.test(out) ||
		/AssertionError/i.test(out) ||
		/Tests:?\s+\d+\s*failed/i.test(out)
	) {
		return "red";
	}
	return "unknown";
}

function readPackageJson(dir: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function packageScripts(pkg: Record<string, unknown> | null): Record<string, string> {
	return (pkg?.scripts ?? {}) as Record<string, string>;
}

function packageDeps(pkg: Record<string, unknown> | null): Record<string, string> {
	return { ...(pkg?.dependencies as Record<string, string> | undefined), ...(pkg?.devDependencies as Record<string, string> | undefined) };
}

function detectPmForDir(dir: string, pkg: Record<string, unknown> | null): string {
	const pm = String(pkg?.packageManager ?? "").split("@")[0];
	if (pm && /^(npm|pnpm|yarn|bun|deno)$/.test(pm)) return pm;
	if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
	if (existsSync(join(dir, "deno.lock"))) return "deno";
	if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(dir, "yarn.lock"))) return "yarn";
	return "npm";
}

function nearestPackageDir(cwd: string, target: string): string | null {
	const root = resolve(cwd);
	let cur = dirname(resolve(cwd, target));
	while (cur.startsWith(root)) {
		if (existsSync(join(cur, "package.json"))) return cur;
		const next = dirname(cur);
		if (next === cur) break;
		cur = next;
	}
	return existsSync(join(root, "package.json")) ? root : null;
}

function relTarget(pkgDir: string, cwd: string, target: string): string {
	const rel = relative(pkgDir, resolve(cwd, target));
	return rel.startsWith("..") ? target : rel;
}

function isJsTsTarget(target: string): boolean {
	return /\.(?:[cm]?[jt]sx?)$/i.test(target);
}

function isTsTarget(target: string): boolean {
	return /\.(?:[cm]?ts|tsx)$/i.test(target);
}

function fileUsesNodeTest(cwd: string, target: string): boolean {
	try {
		const content = readFileSync(resolve(cwd, target), "utf8");
		return /(?:from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)|node:test)/.test(content);
	} catch {
		return false;
	}
}

function hasPackageTool(pkgDir: string, pkg: Record<string, unknown> | null, tool: string): boolean {
	const deps = packageDeps(pkg);
	return Boolean(deps[tool]) || existsSync(join(pkgDir, "node_modules", ".bin", tool)) || existsSync(join(pkgDir, "node_modules", tool));
}

function pmExec(pm: string, tool: string, args: string[]): string[] {
	if (pm === "yarn") return [pm, "exec", tool, ...args];
	if (pm === "bun") return [pm, "x", tool, ...args];
	if (pm === "deno") return ["deno", "task", tool, ...args];
	return [pm, "exec", tool, ...args];
}

function npmRedCheckPlans(cwd: string, targets: string[], cmds: ProjectCommands): RedCheckPlan[] {
	const plans: RedCheckPlan[] = [];
	const fallbackTargets: string[] = [];
	for (const target of targets) {
		const pkgDir = nearestPackageDir(cwd, target) ?? cwd;
		const pkg = readPackageJson(pkgDir);
		const scripts = packageScripts(pkg);
		const rel = relTarget(pkgDir, cwd, target);
		const pm = detectPmForDir(pkgDir, pkg);

		if (isJsTsTarget(target) && fileUsesNodeTest(cwd, target)) {
			if (!isTsTarget(target)) {
				plans.push({ cwd: pkgDir, argv: ["node", "--test", rel] });
				continue;
			}
			if (hasPackageTool(pkgDir, pkg, "tsx")) {
				plans.push({ cwd: pkgDir, argv: ["node", "--import", "tsx", "--test", rel] });
				continue;
			}
		}

		if (scripts.test) {
			// RC-1: a package `test` script only scopes to a single file if the runner
			// accepts the file as a positional arg. `pnpm -r run test` (recursive) does
			// NOT — it forwards the arg to EVERY workspace, which ignore it and run their
			// whole suite (→ the new test never runs in isolation → the RED oracle sees
			// the pre-existing suite pass → "red-not-confirmed" forever, the 15h livelock).
			// So: prefer a DIRECT runner invocation whenever we can detect one; only use
			// the `run test -- <file>` form when the script is NOT a recursive fan-out.
			if (/vitest/i.test(scripts.test) || hasPackageTool(pkgDir, pkg, "vitest")) { plans.push({ cwd: pkgDir, argv: pmExec(pm, "vitest", ["run", rel]) }); continue; }
			if (isJsTsTarget(target) && hasPackageTool(pkgDir, pkg, "tsx")) { plans.push({ cwd: pkgDir, argv: ["node", "--import", "tsx", "--test", rel] }); continue; }
			const recursive = /\bpnpm\b[^\n]*\s-r\b|\bpnpm\b[^\n]*--recursive|\bturbo\b|\bnx\s+run-many|--workspaces\b/.test(scripts.test);
			if (!recursive) { plans.push({ cwd: pkgDir, argv: pm === "deno" ? ["deno", "task", "test", rel] : [pm, "run", "test", "--", rel] }); continue; }
			// Recursive/monorepo test script with no directly-runnable runner for this
			// package: fall through so the caller surfaces an honest "no scoped runner"
			// blocker instead of running the whole monorepo and misreading it as green.
			fallbackTargets.push(target);
			continue;
		}

		if (hasPackageTool(pkgDir, pkg, "vitest")) {
			plans.push({ cwd: pkgDir, argv: pmExec(pm, "vitest", ["run", rel]) });
			continue;
		}
		// No package `test` script and no vitest: try a direct tsx/node runner for a
		// JS/TS file before giving up to the (non-scoping) root fallback.
		if (isJsTsTarget(target) && hasPackageTool(pkgDir, pkg, "tsx")) {
			plans.push({ cwd: pkgDir, argv: ["node", "--import", "tsx", "--test", rel] });
			continue;
		}

		fallbackTargets.push(target);
	}
	if (fallbackTargets.length > 0) {
		const usesVitest = cmds.ran.some((label) => /vitest/i.test(label)) || hasVitestScript(cwd);
		// Recursion lives in the root package.json `test` SCRIPT BODY (e.g.
		// "pnpm -r run test"), not in the resolved argv (which is just
		// ["pnpm","run","test"]). Read the script text to detect the fan-out.
		const rootTestScript = String(packageScripts(readPackageJson(cwd)).test ?? "");
		const rootRecursive = /\bpnpm\b[^\n]*\s-r\b|--recursive|\bturbo\b|nx\s+run-many|--workspaces\b|\blerna\b/.test(rootTestScript);
		if (usesVitest) plans.push({ cwd, argv: ["vitest", "run", ...fallbackTargets] });
		// Only use the root `test -- <files>` form when it is NOT a recursive
		// monorepo fan-out — that form ignores the file args and runs every package
		// (RC-1). When the only root command is recursive and no scoped runner was
		// found, emit NO plan for these targets: runRedCheck then reports a no-runner
		// state (broken) instead of a false green, and the RED loop surfaces it.
		else if (cmds.test && cmds.test.length > 0 && !rootRecursive) plans.push({ cwd, argv: [...cmds.test, "--", ...fallbackTargets] });
	}
	return plans.filter((plan) => plan.argv.length > 0);
}

function goPackageArg(moduleDir: string, cwd: string, target: string): string {
	const rel = relTarget(moduleDir, cwd, target).replace(/\\/g, "/");
	const pkgDir = /\.go$/i.test(rel) ? dirname(rel).replace(/\\/g, "/") : rel.replace(/\/$/, "");
	if (!pkgDir || pkgDir === ".") return ".";
	return pkgDir.startsWith("./") ? pkgDir : `./${pkgDir}`;
}

function ownerRedCheckPlans(cwd: string, targets: string[]): { plans: RedExecutionPlan[]; handled: Set<string> } {
	const groups = new Map<string, { dir: string; language: string; targets: string[] }>();
	const handled = new Set<string>();
	for (const target of targets) {
		const dir = nearestProjectDir(cwd, target);
		if (!dir) continue;
		const cmds = detectProjectCommands(dir);
		if (cmds.language !== "rust" && cmds.language !== "python" && cmds.language !== "go") continue;
		const key = `${resolve(dir)}\0${cmds.language}`;
		const group = groups.get(key) ?? { dir, language: cmds.language, targets: [] };
		group.targets.push(target);
		groups.set(key, group);
		handled.add(target);
	}
	const plans: RedExecutionPlan[] = [];
	for (const group of groups.values()) {
		const cmds = detectProjectCommands(group.dir);
		if (!cmds.test || cmds.test.length === 0) continue;
		if (group.language === "rust") {
			const relTargets = group.targets.map((target) => relTarget(group.dir, cwd, target));
			const stems = resolveIntegrationStems(group.dir, relTargets);
			if (stems.length > 0) {
				for (const stem of stems) plans.push({ cwd: group.dir, argv: ["cargo", "test", "--test", stem, "--quiet"], language: "rust" });
			} else {
				plans.push({ cwd: group.dir, argv: ["cargo", "test", "--quiet"], language: "rust" });
			}
		} else if (group.language === "python") {
			plans.push({ cwd: group.dir, argv: ["pytest", ...group.targets.map((target) => relTarget(group.dir, cwd, target)), "-q"], language: "python" });
		} else if (group.language === "go") {
			const pkgs = dedupePreservingOrder(group.targets.map((target) => goPackageArg(group.dir, cwd, target)));
			plans.push({ cwd: group.dir, argv: ["go", "test", ...pkgs], language: "go" });
		}
	}
	return { plans, handled };
}

function combineRedStatuses(statuses: RedStatus[]): RedStatus {
	if (statuses.length === 0) return "unknown";
	if (statuses.includes("broken")) return "broken";
	if (statuses.includes("red")) return "red";
	if (statuses.every((status) => status === "green")) return "green";
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
 *   - npm/vitest/jest/node:test (frontend+backend) → resolve each target's
 *               owning package directory first, then run that package's direct
 *               node:test/vitest/script plan. Only fall back to the root test
 *               command when no package-local runner can be identified.
 *   - `python` → `pytest <targets> -q`.
 *   - `go`     → root modules use the root command; nested modules are grouped
 *               by owning `go.mod` and run as `go test <package>` from that cwd.
 *
 * No-spawn short-circuit → `unknown`: a greenfield dir (no manifest or owning
 * package runner), unresolved/empty targets, or a target set for which no safe
 * package/root test plan can be identified. A greenfield repo CANNOT stall the
 * pipeline — it has nothing to verify RED against.
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
		if (opts?.signal?.aborted) return "unknown";

		const timeoutMs = resolveTimeoutMs(opts?.timeoutMs);
		const language = cmds.language;
		const targets = testTargets.filter((t) => typeof t === "string" && t.trim().length > 0);
		if (targets.length === 0) return "unknown";

		// Build the scoped spawn plan(s) per language, mirroring runBuildGate's branch.
		const plans: RedExecutionPlan[] = [];
		if (language === "rust") {
			if (!cmds.test || cmds.test.length === 0) return "unknown";
			const stems = resolveIntegrationStems(cwd, targets);
			if (stems.length > 0) {
				// Per-stem integration binaries — NEVER `--lib` (no-`--lib` discipline).
				for (const stem of stems) plans.push({ cwd, argv: ["cargo", "test", "--test", stem, "--quiet"], language });
			} else {
				// No resolvable stems → scope to the touched packages; empty → workspace.
				const pkgs = detectTouchedCargoPackages(cwd);
				if (pkgs.length > 0) {
					for (const pkg of pkgs) plans.push({ cwd, argv: ["cargo", "test", "-p", pkg, "--quiet"], language });
				} else {
					plans.push({ cwd, argv: ["cargo", "test", "--quiet"], language });
				}
			}
		} else if (language === "python") {
			if (!cmds.test || cmds.test.length === 0) return "unknown";
			plans.push({ cwd, argv: ["pytest", ...targets, "-q"], language });
		} else if (language === "go") {
			if (!cmds.test || cmds.test.length === 0) return "unknown";
			plans.push({ cwd, argv: ["go", "test", ...targets], language });
		} else {
			const ownerPlans = ownerRedCheckPlans(cwd, targets);
			plans.push(...ownerPlans.plans);
			const npmTargets = targets.filter((target) => !ownerPlans.handled.has(target));
			plans.push(...npmRedCheckPlans(cwd, npmTargets, cmds).map((plan) => ({ ...plan, language: "backend" })));
		}

		if (plans.length === 0) return "unknown";
		emitRedPlans(opts, plans);

		// Run each argv under the shared timeout envelope. Each plan is classified
		// with its own language because RED targets may live in nested modules whose
		// stack differs from the repository root.
		const statuses: RedStatus[] = [];
		for (const plan of plans) {
			if (opts?.signal?.aborted) return "unknown";
			const { argv } = plan;
			try {
				const r = spawnSync(argv[0], argv.slice(1), { cwd: plan.cwd, timeout: timeoutMs, encoding: "utf8" });
				const combined = "\n" + (r.stdout ?? "") + "\n" + (r.stderr ?? "");
				const status = r.error ? "unknown" : classifyRedStatus(plan.language, combined, r.status === 0, { cwd: plan.cwd, targets });
				emitRedDiagnostic(opts, {
					plan: { cwd: plan.cwd, argv: [...plan.argv] },
					language: plan.language,
					status,
					exitCode: typeof r.status === "number" ? r.status : null,
					signal: typeof r.signal === "string" ? r.signal : null,
					...(r.error ? { error: r.error.message } : {}),
					outputTail: tailText(combined),
				});
				// NEVER throw on a spawn error / ENOENT — degrade to unknown.
				if (r.error) return "unknown";
				statuses.push(status);
			} catch (err) {
				emitRedDiagnostic(opts, {
					plan: { cwd: plan.cwd, argv: [...plan.argv] },
					language: plan.language,
					status: "unknown",
					exitCode: null,
					signal: null,
					error: err instanceof Error ? err.message : String(err),
					outputTail: "",
				});
				return "unknown";
			}
		}
		return combineRedStatuses(statuses);
	} catch {
		// The load-bearing NEVER-THROW invariant: any spawn error, thrown
		// exception, or parse ambiguity degrades to `unknown` (proceed, do not
		// stall). SCENARIO-001/002/003 (degrade instead of throwing).
		return "unknown";
	}
}

/**
 * Whether the root `package.json` `test` script invokes vitest. Used by the
 * root fallback path only; package-local plans inspect the owning package.
 * Pure read, never throws.
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
 *   - requireScenarios   — BDD SCENARIO-NNN tags that MUST appear in the phase's
 *                          test FILE CONTENTS. Stable-by-construction: a reworded
 *                          `it(...)` title never breaks it (the tag is the unique
 *                          id), so it is the anti-brittle counterpart to
 *                          requireTests. Unifies with the RED scenario-coverage
 *                          classifier's model (both key off SCENARIO-NNN).
 */
export interface DeliverableContract {
	requireFiles?: string[];
	requireContains?: Array<{ file: string; pattern: string }>;
	requireNotContains?: Array<{ file: string; pattern: string }>;
	requireTests?: string[];
	requireScenarios?: string[];
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
 * stdout). Cached per absolute cwd + argv so each distinct lister plan spawns
 * at most once per run.
 */
type TestListResult = { available: true; list: string } | { available: false };

/**
 * Process-local cache of the project test LIST, keyed by ABSOLUTE `cwd` plus
 * argv (via `resolve()` so a relative/symlinked `cwd` keys the cache
 * identically to the spawn `cwd` — mirrors {@link cargoMetadataCache}, review
 * finding: cache-key/argv skew risk). Stores either the collected list text OR
 * an `{ available:false }` sentinel so the same lister plan spawns AT MOST ONCE
 * per run (SCENARIO-009 — two requireTests-bearing phases sharing a plan share
 * one spawn). Lives only in memory.
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
	const abs = resolveInsideCwd(cwd, file);
	// A deliverable path that resolves OUTSIDE the worktree (e.g. a model-authored
	// `../outside.txt`) must never be read — treat it as missing so it can't
	// satisfy a require* assertion against an external file.
	if (abs === null) return { ok: false, exists: false };
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
	const tryPattern = (p: string): boolean => {
		// Support common PCRE/Go-style inline case-insensitive prefix generated by
		// agents/specs (`(?i)permission`) by translating it to JS RegExp flags.
		let source = p;
		let flags = "";
		if (source.startsWith("(?i)")) {
			source = source.slice(4);
			flags = "i";
		}
		let re: RegExp | null = null;
		try { re = new RegExp(source, flags); } catch { re = null; }
		if (re && re.test(text)) return true;
		if (text.includes(p)) return true;
		if (flags === "i" && text.toLowerCase().includes(source.toLowerCase())) return true;
		return false;
	};
	const variants = [pattern];
	// Tolerant fallback: strip `async ` so `export async function X` matches
	// `export function X` (spec may declare async but the impl is sync).
	const stripped = pattern.replace(/\basync\s+/g, "");
	if (stripped !== pattern) variants.push(stripped);
	// Specs often encode examples with arbitrary local aliases, e.g.
	// `const h = createRootHandlers(...); export const POST = h.POST`. The alias
	// name is not semantic; `handlers.POST` is equivalent. Relax only this common
	// generated one-letter alias form, and only as a fallback after the exact
	// pattern missed.
	for (const p of [...variants]) {
		const relaxed = p.replace(/h\\\./g, String.raw`[A-Za-z_$][\w$]*\.`).replace(/h\./g, String.raw`[A-Za-z_$][\w$]*\.`);
		if (relaxed !== p) variants.push(relaxed);
	}
	return variants.some((p) => tryPattern(p));
}

/** For code deliverables, match against comment-stripped text so a placeholder
 * comment that merely mentions `createRootHandlers(...)` cannot satisfy a real
 * wiring assertion. Docs and other non-code files keep their original text. */
function deliverableMatchText(file: string, text: string): string {
	return CODE_EXT.test(file) ? stripCommentsAndBlanks(text) : text;
}

/**
 * Resolve the project test-LISTER argv for `cmds`, mirroring runRedCheck's
 * runner selection so the lister is chosen EXACTLY as the RED oracle chooses
 * its runner. Returns `null` when no recognized runner exists (greenfield /
 * mixed) → requireTests degrades to "test-list unavailable" WITHOUT
 * spawning (SCENARIO-007). Pure: only READS package.json (no spawn/git).
 */
function resolveTestListerArgv(cwd: string, cmds: ProjectCommands): string[] | null {
	if (cmds.language === "rust") {
		return ["cargo", "test", "--", "--list"];
	}
	if (cmds.language === "python") {
		return ["pytest", "--collect-only", "-q"];
	}
	if (cmds.language === "go") {
		return ["go", "test", "./...", "-list", "."];
	}
	if (cmds.language === "frontend" || cmds.language === "backend") {
		// node family: prefer `vitest list --json`, else `jest --listTests`. Decide
		// from the package.json `test` script content (runRedCheck's same heuristic).
		const pkg = readPackageJson(cwd);
		const scripts = packageScripts(pkg);
		const pm = detectPmForDir(cwd, pkg);
		if (/vitest/i.test(scripts.test ?? "") || hasPackageTool(cwd, pkg, "vitest")) return pmExec(pm, "vitest", ["list", "--json"]);
		if (/jest/i.test(scripts.test ?? "") || hasPackageTool(cwd, pkg, "jest")) return pmExec(pm, "jest", ["--listTests"]);
		return null; // no recognized node lister → unavailable
	}
	return null;
}

function testListPlan(root: string, dir: string, cmds: ProjectCommands): TestListPlan | null {
	const argv = resolveTestListerArgv(dir, cmds);
	if (!argv || argv.length === 0) return null;
	const rel = relDir(root, dir);
	return { cwd: dir, argv, label: rel === "." ? "tests:list" : `tests:list:${rel}` };
}

function deliverableEvidencePaths(deliverables: DeliverableContract): string[] {
	const paths: string[] = [];
	for (const p of deliverables.requireFiles ?? []) if (typeof p === "string") paths.push(p);
	for (const entry of deliverables.requireContains ?? []) if (entry && typeof entry.file === "string") paths.push(entry.file);
	for (const entry of deliverables.requireNotContains ?? []) if (entry && typeof entry.file === "string") paths.push(entry.file);
	return paths;
}

/** Normalize a requireScenarios list into canonical `SCENARIO-NNN` tags (deduped,
 *  drops blanks/non-strings). Accepts `SCENARIO-24`, `scenario-024`, `24`, or a
 *  free-form string containing a tag; zero-pads to 3 digits to match the spec's
 *  own `SCENARIO-NNN` rendering. Never throws. */
function normalizeScenarioTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "number" && Number.isInteger(item)) {
			out.push(`SCENARIO-${String(item).padStart(3, "0")}`);
			continue;
		}
		if (typeof item !== "string") continue;
		const matches = [...item.matchAll(/\bSCENARIO-(\d+)\b/gi)].map((m) => `SCENARIO-${String(Number(m[1] ?? "0")).padStart(3, "0")}`);
		if (matches.length) out.push(...matches);
		else if (/^\d+$/.test(item.trim())) out.push(`SCENARIO-${String(Number(item.trim())).padStart(3, "0")}`);
	}
	return [...new Set(out)];
}

/** Test-file globs recognised across the pipeline's supported stacks (ts/js,
 *  rust, python, go). Matched on the file BASENAME or path segment. */
const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|__tests__\/)/i;

/** Collect the concatenated contents of candidate test files under the
 *  deliverable + touched-file directories, for requireScenarios tag matching.
 *  Bounded (file count + per-file size) so a huge tree cannot stall the gate.
 *  Never throws — unreadable files are skipped. */
function collectTestFileContents(cwd: string, deliverables: DeliverableContract, stopWhen?: (text: string) => boolean): { text: string; files: string[] } {
	const root = resolve(cwd);
	const evidence = [...deliverableEvidencePaths(deliverables), ...touchedFilePaths(cwd)];
	const collected: string[] = [];
	const files: string[] = [];
	const seenFiles = new Set<string>();
	let done = false; // set once stopWhen is satisfied — short-circuits everything
	const MAX_FILES = 200;        // cap for the untrusted TIER-2 directory walk
	const MAX_EVIDENCE_FILES = 2000; // separate, generous cap for the EXPLICIT
	// touched/declared evidence list (tier 1) — a finite, trusted set, so it must
	// NOT be starved by the tier-2 walk cap (finding: the 201st touched test, the
	// tagged one, was never opened because files.length had already hit MAX_FILES).
	const MAX_BYTES = 256 * 1024;
	const readInto = (abs: string, cap: number): void => {
		if (done || files.length >= cap || seenFiles.has(abs)) return;
		seenFiles.add(abs);
		try {
			collected.push(readFileSync(abs, "utf8").slice(0, MAX_BYTES));
			files.push(abs);
			// Early-exit the moment the caller's target is satisfied (every required
			// scenario tag seen). Combined with tier-1's own budget, this makes the
			// MAX_FILES cap irrelevant whenever the tag is in a touched/declared file.
			if (stopWhen && stopWhen(collected.join("\n"))) done = true;
		} catch { /* unreadable — skip */ }
	};
	// Worktree-escape guard: a model-authored deliverable path like
	// `../sibling/tests/x.test.ts` must NOT let scenario matching read outside the
	// worktree (and pass against an external file). Filter every resolved evidence
	// path through isInsideOrSame BEFORE using it.
	const insideEvidence = evidence
		.map((p) => resolve(cwd, p))
		.filter((abs) => isInsideOrSame(root, abs));

	// TIER 1 — read the EXACT evidence test FILES directly, before any dir walk.
	// This is the fix for the standalone-requireScenarios case: when the touched
	// set lists unrelated sibling tests around the tagged one, a dir walk would
	// exhaust the cap on the siblings and never reach the target. Reading the
	// specific evidence files first (plus stopWhen early-exit) guarantees the
	// tagged file is seen whenever it is a touched/declared deliverable — which is
	// ALWAYS true in the real pipeline (RED tests are git-touched, so
	// touchedFilePaths surfaces them here). The tier-2 dir walk below is only a
	// best-effort fallback for tags in files that are neither touched nor declared;
	// there the MAX_FILES cap still applies (a huge unrelated dir could bound it),
	// but that path is not how the pipeline feeds RED tests.
	for (const abs of insideEvidence) {
		if (done) break;
		if (!TEST_FILE_RE.test(abs)) continue;
		try { if (!statSync(abs).isFile()) continue; } catch { continue; }
		readInto(abs, MAX_EVIDENCE_FILES);
	}

	// TIER 2+ — walk directories to catch tagged tests not in the evidence list:
	// the immediate parent dirs of evidence files, then resolved project roots,
	// then cwd last. All filtered to inside-worktree. Bounded by its OWN cap
	// (walkCount) so tier-1's larger read does not disable the fallback, and so a
	// huge unrelated tree still can't stall the gate.
	const evidenceFileDirs = insideEvidence
		.map((abs) => dirname(abs))
		.filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
	const dirs = new Set<string>(
		[...evidenceFileDirs, ...projectDirsFromEvidence(cwd, evidence), root]
			.filter((d) => isInsideOrSame(root, d)),
	);
	let walkCount = 0;
	const walk = (dir: string, depth: number): void => {
		if (done || depth > 6 || walkCount >= MAX_FILES) return;
		let entries: string[] = [];
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			if (done || walkCount >= MAX_FILES) return;
			if (name === "node_modules" || name === ".git" || name === "target" || name === "dist" || name === "build") continue;
			const abs = join(dir, name);
			let isDir = false;
			try { isDir = statSync(abs).isDirectory(); } catch { continue; }
			if (isDir) { walk(abs, depth + 1); continue; }
			if (!TEST_FILE_RE.test(abs)) continue;
			if (seenFiles.has(abs)) continue; // already read in tier 1 — don't recount
			walkCount++;
			readInto(abs, Number.POSITIVE_INFINITY); // walkCount already bounds tier 2
		}
	};
	for (const dir of dirs) { if (done) break; walk(dir, 0); }
	return { text: collected.join("\n"), files };
}

function testListPlansForDeliverables(cwd: string, deliverables: DeliverableContract): TestListPlan[] {
	const rootCmds = detectProjectCommands(cwd);
	const plans: TestListPlan[] = [];
	const seen = new Set<string>();
	const add = (plan: TestListPlan | null) => {
		if (!plan) return;
		const key = `${resolve(plan.cwd)}\0${plan.argv.join("\0")}`;
		if (seen.has(key)) return;
		seen.add(key);
		plans.push(plan);
	};
	add(testListPlan(cwd, cwd, rootCmds));
	const evidence = [...deliverableEvidencePaths(deliverables), ...touchedFilePaths(cwd)];
	for (const dir of projectDirsFromEvidence(cwd, evidence)) {
		if (resolve(dir) === resolve(cwd)) continue;
		add(testListPlan(cwd, dir, projectCommandsForDir(cwd, dir, rootCmds)));
	}
	return plans;
}

/**
 * Load (and cache) one project test-list plan via ONE spawn per cwd+argv per
 * run (SCENARIO-009). On spawn error / timeout / empty stdout →
 * returns `{ available:false }` and does NOT block (existence/grep still
 * enforced — SCENARIO-007). Never throws.
 */
function loadTestList(
	plan: TestListPlan,
	timeoutMs: number,
	signal?: AbortSignal,
): TestListResult {
	// Resolve ONCE so the cache KEY and the spawn `cwd` use the SAME absolute
	// path (review finding: cache-key/argv skew — mirrors {@link cargoMetadataCache}).
	const key = `${resolve(plan.cwd)}\0${plan.argv.join("\0")}`;
	const cached = testListCache.get(key);
	if (cached) return cached;
	if (signal?.aborted) {
		const res: TestListResult = { available: false };
		testListCache.set(key, res);
		return res;
	}
	let list = "";
	let available = false;
	try {
		const r = spawnSync(plan.argv[0], plan.argv.slice(1), { cwd: plan.cwd, timeout: timeoutMs, encoding: "utf8" });
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
 * selection, {@link resolveTimeoutMs} for the spawn envelope, and cached
 * {@link spawnSync} test-list subprocesses per derived cwd+argv plan
 * ({@link testListCache}).
 *
 * NEVER throws (the load-bearing build-runner-nonregression invariant): the
 * ENTIRE body is wrapped in try/catch; on any thrown error it returns
 * { pass:false, missing:['<reason>'], ran:[...] } rather than propagating
 * (SCENARIO-010). Every element of every sub-check is evaluated (no
 * short-circuit) so `missing` is exhaustive and `ran` is complete.
 *
 * Sub-checks:
 *   (a) requireFiles       → existsSync(join(cwd,p)); miss ⇒
 *                            `missing file: <p>`.
 *   (b) requireContains    → readForDeliverable; unreadable ⇒ `unreadable: <p>`;
 *                            missing-file OR absent-pattern ⇒
 *                            `missing pattern <pat> in <file>` (tolerant regex,
 *                            substring fallback on an invalid regex).
 *   (c) requireNotContains → a READABLE hit ⇒ `forbidden pattern <pat> still
 *                            present in <file>`; missing/unreadable ⇒ no entry.
 *                            If the file itself is required, declare it in
 *                            requireFiles or requireContains; a pure negative
 *                            assertion is satisfied when the target is absent.
 *   (d) requireTests       → cached test-list spawn(s) per derived cwd+argv
 *                            plan; tolerant
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

/** Result of the symbol / hollow-file gate. `hollowFiles` lists claimed source
 *  deliverables that EXIST but contain NO language symbols (doc-comment-only /
 *  empty shells) — the "silent-empty-success" a build+deliverable+change gate
 *  cannot otherwise catch (a never-implemented file compiles, exists, and is
 *  git-changed). */
export interface SymbolGateResult {
	pass: boolean;
	hollowFiles: string[];
}

/** Per-language "has real code" symbol probes, matched against comment-stripped
 *  source. A doc-comment-only shell strips to empty → no match → hollow. */
const SYMBOL_PATTERNS: Partial<Record<string, RegExp>> = {
	rust: /\b(?:fn|struct|enum|impl|trait|use|const|static|mod|macro_rules|type)\b/,
	go: /\b(?:func|type|struct|var|const|import|package)\b/,
	python: /\b(?:def|class|import|from)\b/,
	frontend: /\b(?:function|const|let|class|interface|type|export|import)\b|=>/,
	backend: /\b(?:function|const|let|class|interface|type|export|import)\b|=>/,
};
const CODE_EXT = /\.(?:rs|go|py|ts|tsx|js|jsx|mjs|mts|cjs|java|kt|swift|rb|cs|cpp|cc|c|h|hpp|zig|nim)$/;

/** Strip block + line comments and blank lines so a doc-comment-only shell
 *  reduces to empty (zero symbols). Pure. */
function stripCommentsAndBlanks(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")      // /* block comments */
		.replace(/^[ \t]*\/\/.*$/gm, "")         // // line comments (incl //! ///)
		.replace(/^[ \t]*#.*$/gm, "")            // # line comments (py/ruby/sh)
		.replace(/^[ \t]*$/gm, "");              // blank lines
}

/** Catches the "silent-empty-success": claimed source deliverables that EXIST
 *  (so they pass the deliverable + change gates) but contain NO real code —
 *  only comments/whitespace. AND-ed into phase-green alongside buildGate /
 *  deliverableCheck / changeGate so an implementer that ships doc-comment-only
 *  shells while claiming the phase done is REJECTED until real symbols land.
 *
 *  Best-effort + never-throws (mirrors computeChangeGate): an unreadable file
 *  is SKIPPED (not counted hollow — never block on infrastructure); an unknown
 *  language or a phase with no claimed source files → pass (don't block
 *  config/doc-only phases). */
export function computeSymbolGate(
	worktreePath: string,
	claimedFiles: string[],
	language: string | undefined,
): SymbolGateResult {
	try {
		const pattern = language ? SYMBOL_PATTERNS[language] : undefined;
		if (!pattern) return { pass: true, hollowFiles: [] }; // unknown language → don't block
		const codeFiles = (claimedFiles ?? []).filter((f): f is string => typeof f === "string" && CODE_EXT.test(f));
		if (codeFiles.length === 0) return { pass: true, hollowFiles: [] }; // no source → don't block
		const hollow: string[] = [];
		for (const rel of codeFiles) {
			try {
				const src = readFileSync(join(worktreePath, rel), "utf8");
				if (!pattern.test(stripCommentsAndBlanks(src))) hollow.push(rel);
			} catch {
				// unreadable / missing → skip (deliverable/change gates handle absence)
			}
		}
		return { pass: hollow.length === 0, hollowFiles: hollow };
	} catch {
		return { pass: true, hollowFiles: [] };
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
				const abs = resolveInsideCwd(cwd, p);
				if (abs === null || !existsSync(abs)) {
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
				if (!tolerantMatch(pattern, deliverableMatchText(file, rd.text))) {
					missing.push(`missing pattern ${pattern} in ${file}`);
				}
			}
		}

		// (c) requireNotContains — a forbidden pattern surviving in a READABLE file
		// is reported. A missing or unreadable file does NOT fail this negative-only
		// assertion: if a phase needs the file to exist, it must also declare the file
		// under requireFiles or requireContains. This distinction matters for specs
		// that say "do not touch/create proxy.ts/middleware.ts"; absence already proves
		// the forbidden pattern is not present and must not trap an implementer in an
		// unwinnable retry loop because the spec named the wrong optional path.
		const notContains = deliverables.requireNotContains;
		if (Array.isArray(notContains)) {
			for (const entry of notContains) {
				const file = entry?.file;
				const pattern = entry?.pattern;
				ran.push(`not-contains:${file}:${pattern}`);
				const rd = readForDeliverable(cwd, file);
				if (rd.ok && tolerantMatch(pattern, deliverableMatchText(file, rd.text))) {
					missing.push(`forbidden pattern ${pattern} still present in ${file}`);
				}
			}
		}

		// (d) requireTests — cached test-list spawn(s) per cwd+argv plan. Skipped
		// entirely when `opts.skipTests` is set (review finding: do NOT spawn the
		// test-lister when the build gate already failed — wasted compile on a broken
		// build, and a poisoned cache). The cheap file/contains/not-contains checks
		// above still ran regardless.
		const tests = deliverables.requireTests;
		if (Array.isArray(tests) && tests.length > 0 && !opts?.skipTests) {
			const timeoutMs = resolveTimeoutMs(opts?.timeoutMs);
			const plans = testListPlansForDeliverables(cwd, deliverables);
			const lines: string[] = [];
			for (const plan of plans) {
				const list = loadTestList(plan, timeoutMs, opts?.signal);
				if (!list.available) continue;
				ran.push(plan.label);
				lines.push(...list.list.split(/\r?\n/).filter((l) => l.trim().length > 0));
			}
			if (lines.length > 0) {
				// Review finding: matching the test name against the WHOLE raw stdout
				// (a single giant string) risks false-greens — a name substring hit in
				// a path, a directory header, or a comment line would satisfy the
				// contract even when no real test by that name exists. Match per-LINE
				// instead so a hit requires the name to appear on an actual listed
				// entry line (cargo/pytest emit one test per line; vitest --json emits
				// a single-line JSON array, which is one line and unaffected).
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

		// (e) requireScenarios — the ANTI-BRITTLE counterpart to requireTests: a
		// BDD SCENARIO-NNN tag MUST appear in the phase's test FILE CONTENTS. Test
		// files carry the tag in an `it("SCENARIO-024 ...")` title, a comment, or a
		// tag constant; unlike a full English test name, the tag is a stable unique
		// id that survives rewording (RTM best practice: unique id per test case).
		// Matched by grepping the candidate test files under the deliverable +
		// touched-file directories, so it never spawns a runner and never blocks on
		// a missing test list. Absent tag ⇒ `missing scenario: SCENARIO-NNN`.
		const scenarios = normalizeScenarioTags(deliverables.requireScenarios);
		if (scenarios.length > 0) {
			const tagRes = scenarios.map((tag) => new RegExp(`\\b${tag.replace(/[-]/g, "\\-")}\\b`, "i"));
			// Stop reading files as soon as EVERY required tag has appeared — the
			// MAX_FILES cap then can't hide a tag that exists, regardless of touched-
			// file ordering. Word-boundary, case-insensitive (`SCENARIO-024` matches,
			// `SCENARIO-0240` does not).
			const haystack = collectTestFileContents(cwd, deliverables, (text) => tagRes.every((re) => re.test(text)));
			ran.push(haystack.files.length ? `scenarios:${haystack.files.length} test file(s)` : "scenarios:no-test-files");
			for (let i = 0; i < scenarios.length; i++) {
				if (!tagRes[i].test(haystack.text)) {
					missing.push(`missing scenario: ${scenarios[i]}`);
				}
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

/**
 * Lightweight REAL-FILESYSTEM check (no spawn, no test-lister) for whether a
 * phase's declared deliverables are ALREADY satisfied. Used by the pre-implement
 * no-op detection (§F #1) to skip the implementer when files/patterns already
 * exist — kills the state-confusion churn (implementers re-touching done work).
 *
 * Unlike {@link runDeliverableCheck} this reads the REAL filesystem directly
 * (existsSync + readFileSync), so it does NOT consume test-stub queues and is
 * safe to run UNCONDITIONALLY (not just on resume). Returns false when no
 * requireFiles are declared (can't determine no-op without file targets).
 * NEVER throws.
 */
export function deliverablesAlreadyMet(cwd: string, deliverables: DeliverableContract): boolean {
	try {
		const files = deliverables.requireFiles;
		if (!Array.isArray(files) || files.length === 0) return false;
		for (const p of files) {
			const abs = resolveInsideCwd(cwd, p);
			if (abs === null || !existsSync(abs)) return false;
		}
		for (const entry of deliverables.requireContains ?? []) {
			const rd = readForDeliverable(cwd, entry.file);
			if (!rd.ok || !tolerantMatch(entry.pattern, deliverableMatchText(entry.file, rd.text))) return false;
		}
		for (const entry of deliverables.requireNotContains ?? []) {
			const rd = readForDeliverable(cwd, entry.file);
			if (rd.ok && tolerantMatch(entry.pattern, deliverableMatchText(entry.file, rd.text))) return false;
		}
			// requireScenarios: every declared SCENARIO-NNN tag must appear in a
			// candidate test file (same stable-tag match as runDeliverableCheck).
			const scenarios = normalizeScenarioTags(deliverables.requireScenarios);
			if (scenarios.length > 0) {
				const tagRes = scenarios.map((tag) => new RegExp(`\\b${tag.replace(/[-]/g, "\\-")}\\b`, "i"));
				const { text } = collectTestFileContents(cwd, deliverables, (t) => tagRes.every((re) => re.test(t)));
				if (!tagRes.every((re) => re.test(text))) return false;
			}
		return true;
	} catch {
		return false;
	}
}
