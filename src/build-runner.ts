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
 * Build the scoped `cargo test` argv for a list of packages.
 *
 * Non-empty → `["cargo","test", ...packages.flatMap(p => ["-p", p]), "--quiet"]`
 * (one `-p` flag per package, `--quiet` retained). Empty → `["cargo","test",
 * "--quiet"]` (byte-identical to the unscoped workspace argv). Package names are
 * emitted as discrete argv elements so they never pass through a shell (no
 * `shell:true` is ever used) — see SCENARIO-014.
 *
 * @param packages Resolved (de-duplicated) package names.
 * @returns The cargo test argv, scoped or unscoped.
 */
export function scopedCargoTestArgs(packages: string[]): string[] {
	if (packages.length === 0) return ["cargo", "test", "--quiet"];
	return ["cargo", "test", ...packages.flatMap((p) => ["-p", p]), "--quiet"];
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
	// Resolve rust test-package scope with explicit precedence (AC-04):
	//   1. opts.testPackages provided (incl. explicit [] = force workspace-wide);
	//   2. process.env.SUPER_DEV_BUILD_TEST_PACKAGES (de-duplicated);
	//   3. workspace-wide (no scoping).
	const testPackages =
		opts.testPackages !== undefined
			? dedupePreservingOrder(opts.testPackages)
			: parseTestPackages(process.env.SUPER_DEV_BUILD_TEST_PACKAGES);
	// AC-03/AC-06: apply scoping ONLY when rust + non-empty packages exist, on a
	// SHALLOW COPY so detectProjectCommands stays pure/byte-identical (the
	// detector regression assertion still passes).
	const cmds =
		cmds0.language === "rust" && testPackages.length > 0 && cmds0.test
			? { ...cmds0, test: scopedCargoTestArgs(testPackages) }
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
	return {
		pass: errors.length === 0,
		buildSuccess,
		allTestsPass,
		typecheckSuccess,
		ran,
		errors,
	};
}
