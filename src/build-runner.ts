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

const DEFAULT_TIMEOUT_MS = 120_000;
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
export function runBuildGate(cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): BuildGateResult {
	const cmds = detectProjectCommands(cwd);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
