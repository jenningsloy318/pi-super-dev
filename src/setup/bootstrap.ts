import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { superDevEnv } from "../render/super-dev-dir.ts";

/** Wave 4 increment 4: DEPENDENCY PRE-WARM (RC12a) — moved verbatim from
 *  setup.ts: the node arm (pm detection, Yarn Berry/classic flags, arm-scoped
 *  try/catch so a node failure never suppresses the python arm) and the python
 *  arm (uv-locked detection, .venv exclude-before-sync, partial-venv removal
 *  on SIGTERM-class failure). Best-effort, never fatal, every skip LOUD.
 *  One reason to change: how fresh worktrees get their dependencies. */

/** RC12a: best-effort dependency bootstrap for a FRESH worktree of a JS/TS
 *  monorepo. Runs the package manager's frozen install when a lockfile exists
 *  and the worktree root has no node_modules. Kill-switch SUPER_DEV_NO_BOOTSTRAP=1;
 *  timeout SUPER_DEV_BOOTSTRAP_TIMEOUT_MS (default 10min). Non-JS projects and
 *  pre-installed worktrees no-op. Failures log a warning and never throw —
 *  the pipeline keeps going exactly as before (observable, not blocking). */
/** v0.4.9 test seam (the arm is otherwise module-private). */
export function bootstrapDependenciesForTests(
	cwd: string, worktreePath: string, worktreeCreated: boolean, log?: (m: string) => void,
): void {
	bootstrapDependencies(cwd, worktreePath, worktreeCreated, log);
}

export function bootstrapDependencies(cwd: string, worktreePath: string, worktreeCreated: boolean, log?: (m: string) => void): void {
	if (superDevEnv("SUPER_DEV_NO_BOOTSTRAP") === "1") return;
	if (!worktreeCreated || worktreePath === cwd) return;
	const wt = (m: string) => { if (log) log(m); };
	try {
		// v0.4.9 (live-run prototype-timeout class, 2026-09-16): the node arm's
		// early return is now ARM-scoped — a present node_modules must not skip
		// the python arm below (both run independently).
		const timeoutMs = Number.parseInt(superDevEnv("SUPER_DEV_BOOTSTRAP_TIMEOUT_MS") ?? "", 10) || 600_000;
		if (!existsSync(join(worktreePath, "node_modules"))) {
			// Adversarial F2 fold: the node arm gets its OWN try/catch — a node
			// install failure previously jumped to the OUTER catch and silently
			// suppressed the python arm (violating the loud-every-skip contract
			// for polyglot repos). Arm-scoped skips never `return`.
			const pm = existsSync(join(worktreePath, "pnpm-lock.yaml")) ? "pnpm"
				: existsSync(join(worktreePath, "yarn.lock")) ? "yarn"
				: existsSync(join(worktreePath, "bun.lockb")) || existsSync(join(worktreePath, "bun.lock")) ? "bun"
				: existsSync(join(worktreePath, "package-lock.json")) ? "npm"
				: null;
			if (!pm) {
				wt("Setup node bootstrap skipped (no node lockfile in the worktree)");
			} else if (!existsSync(join(worktreePath, "package.json"))) {
				wt("Setup node bootstrap skipped (lockfile without package.json)");
			} else {
				try {
					// Reviewer F-5/F-6: `--immutable` is Yarn BERRY only — classic
					// yarn needs `--frozen-lockfile` (Berry marker `.yarnrc.yml`).
					const yarnBerry = existsSync(join(worktreePath, ".yarnrc.yml"));
					const argv = pm === "pnpm" ? ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]
						: pm === "yarn" ? (yarnBerry ? ["yarn", "install", "--immutable"] : ["yarn", "install", "--frozen-lockfile"])
						: pm === "bun" ? ["bun", "install", "--frozen-lockfile"]
						: ["npm", "ci", "--prefer-offline"];
					wt(`Setup bootstrapping dependencies in the fresh worktree (${argv.join(" ")}; timeout ${timeoutMs}ms)`);
					const r = execFileSync(argv[0], argv.slice(1), { cwd: worktreePath, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
					wt(`Setup dependency bootstrap finished${r ? ` (tail: ${String(r).trim().slice(-200)})` : ""}`);
				} catch (nerr) {
					const nmsg = nerr instanceof Error ? nerr.message : String(nerr);
					wt(`Setup NODE dependency bootstrap FAILED (continuing — the python arm below still runs): ${nmsg.slice(0, 400)}`);
				}
			}
		} // end node arm
		// ── v0.4.9: the PYTHON arm — dependency cold-start inside a bounded
		// agent slot is the top prototype-timeout cause (3 of the last ~10
		// runs: attempt 1 burns its whole 20-min delegation slot on
		// uv/akshare/pandas installs; attempt 2 inherits the warm wheel cache
		// and passes — one full slot wasted per affected run). Same contract
		// as the node arm: best-effort, never fatal, every skip LOUD.
		// Detection is deliberately narrow: uv-locked projects only (root or
		// the python/ subdir convention); requirements.txt-only repos see NO
		// python-arm line at all today (add detection when measured).
		// Code-gate Minor-5 fold: a separate knob — a mixed node+python fresh
		// worktree runs both arms SEQUENTIALLY, so a shared budget doubles the
		// worst-case setup wall; per-arm knobs keep that named and tunable.
		// Adversarial F6 (documented deviation): loadDotEnv runs AFTER
		// bootstrap by design (install-env changes) — a copied .env setting
		// UV_PROJECT_ENVIRONMENT redirects only the agents' `uv run`, not this
		// pre-warm; the default-location .venv is still created and is what the
		// prompts point at.
		const pyTimeout = Number.parseInt(superDevEnv("SUPER_DEV_PYTHON_BOOTSTRAP_TIMEOUT_MS") ?? "", 10) || timeoutMs;
		const pyDirs = [worktreePath, join(worktreePath, "python")].filter((d) => existsSync(join(d, "pyproject.toml")));
		if (pyDirs.length > 0) {
			const uvAvailable = (() => { try { execFileSync("uv", ["--version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 }); return true; } catch { return false; } })();
			if (!uvAvailable) {
				wt("Setup python bootstrap skipped (pyproject.toml present but uv is not on PATH — install uv to enable pre-warmed python envs; prototype/implementation agents will otherwise pay dependency cold-start inside their own bounded slots)");
			} else {
				for (const pyDir of pyDirs) {
					const rel = pyDir === worktreePath ? "." : relative(worktreePath, pyDir);
					if (!existsSync(join(pyDir, "uv.lock"))) { wt(`Setup python bootstrap skipped (${rel}: pyproject.toml without uv.lock — lock the project to enable pre-warm)`); continue; }
					if (existsSync(join(pyDir, ".venv"))) { wt(`Setup python bootstrap skipped (${rel}/.venv already exists — reused as-is)`); continue; }
					// Adversarial F3 fold: an unignored .venv would be stashed by the
					// re-entry hygiene (git stash push -u over 10k+ paths) or
					// snapshotted by `git add -A` phase commits — append the two
					// candidate venv paths to the COMMON git dir's info/exclude
					// BEFORE syncing (excludeCopiedEnvFiles precedent; idempotent).
					try {
						const commonDir = execFileSync("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 10_000 }).trim();
						const excludePath = join(resolve(worktreePath, commonDir), "info", "exclude");
						mkdirSync(dirname(excludePath), { recursive: true });
						let ex = "";
						try { ex = readFileSync(excludePath, "utf8"); } catch { /* absent — create */ }
						const add: string[] = [];
						for (const pat of [".venv/", "/.venv/"]) {
							if (!ex.split("\n").includes(pat)) add.push(pat);
						}
						if (add.length > 0) {
							const pre2 = ex.length > 0 && !ex.endsWith("\n") ? "\n" : "";
							writeFileSync(excludePath, ex + pre2 + "# pi-super-dev python pre-warm (never committed)\n" + add.join("\n") + "\n", "utf8");
						}
					} catch { /* best-effort — repo .gitignore is the backstop */ }
					try {
						wt(`Setup python bootstrap starting (uv sync --frozen) in ${rel} (timeout ${pyTimeout}ms)`);
						const pr = execFileSync("uv", ["sync", "--frozen"], { cwd: pyDir, timeout: pyTimeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
						wt(`Setup python bootstrap finished${pr ? ` (tail: ${String(pr).trim().slice(-200)})` : ""} — pre-warmed env at ${rel}/.venv`);
					} catch (perr) {
						const pmsg = perr instanceof Error ? perr.message : String(perr);
						// Adversarial F1 fold: a SIGTERM'd mid-install sync leaves a
						// PARTIAL .venv that the reuse check would misclassify as
						// complete ("already exists — reused as-is") — the incident
						// class one level deeper. Remove it; uv's warm wheel cache
						// makes the next sync cheap.
						try { rmSync(join(pyDir, ".venv"), { recursive: true, force: true }); } catch { /* best-effort */ }
						wt(`Setup python bootstrap FAILED for ${rel} (continuing without it — the partial .venv was REMOVED so a later attempt re-syncs from the warm cache; agents will otherwise install inside their own slots): ${pmsg.slice(0, 400)}`);
					}
				}
			}
		}
	} catch (err) {
		// Never block: a failed bootstrap degrades to today's behavior, but the
		// warning makes the later build-gate failure attributable.
		const msg = err instanceof Error ? err.message : String(err);
		wt(`Setup dependency bootstrap FAILED (continuing without it — later build-gate failures on missing dependencies are environmental, do NOT edit unrelated packages to work around them): ${msg.slice(0, 400)}`);
	}
}
