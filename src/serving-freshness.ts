import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { superDevEnv } from "./render/super-dev-dir.ts";
import { SUPER_DEV_EXTENSION_VERSION } from "./version.ts";

const execFileAsync = promisify(execFile);

let warnedFreshnessOff = false;

/** The installed/serving extension directory (this module's parent). */
export const SERVING_EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** One-line serving-version stamp for activation logs / run-log correlation. */
export function servingVersionLine(): string {
	return `super-dev v${SUPER_DEV_EXTENSION_VERSION} serving (extension dir: ${SERVING_EXTENSION_DIR})`;
}

/**
 * v0.3.81 C1 — serving-copy freshness check (the 14-10 incident class: a fixed
 * bug kept running live because the installed copy lagged repo main).
 *
 * Best-effort, NEVER throws: `git fetch origin` (bounded), then counts
 * HEAD..origin/main. When behind, the caller's log receives a WARN naming the
 * count and the remedy (pull the installed copy + restart pi). The version
 * itself is already stamped into every run.log header via runStartedEvent.
 *
 * Returns { staleCommits } — 0 when unknown/up-to-date (fail-open: freshness
 * checking must never break activation).
 */
export async function checkServingFreshness(
	extensionDir: string,
	warn: (line: string) => void,
): Promise<{ staleCommits: number }> {
	// review adv-F1 (v0.3.81): the suite activates the extension ~41 times
	// across 9 test files — an unguarded fetch would do real network I/O and
	// mutate remote-tracking refs mid-suite. Same guard pattern as
	// SUPER_DEV_NO_GLOBAL_METRICS (v0.3.73 AR-73-04): vitest sets it
	// suite-wide; set outside tests it means what it says, loudly once.
	if (superDevEnv("SUPER_DEV_NO_FRESHNESS_CHECK") === "1") {
		if (!process.env.VITEST && !warnedFreshnessOff) {
			warnedFreshnessOff = true;
			console.warn("[super-dev] SUPER_DEV_NO_FRESHNESS_CHECK=1 is active outside tests — the serving-copy freshness check will not run (unset it to re-enable)");
		}
		return { staleCommits: 0 };
	}
	try {
		await execFileAsync("git", ["-C", extensionDir, "fetch", "origin", "--quiet"], { timeout: 20_000 });
	} catch {
		return { staleCommits: 0 }; // offline / not a clone / no permission — silent
	}
	for (const ref of ["origin/main", "origin/master"]) {
		try {
			const { stdout } = await execFileAsync("git", ["-C", extensionDir, "rev-list", "--count", `HEAD..${ref}`], { timeout: 10_000 });
			const count = Number.parseInt(String(stdout).trim(), 10);
			if (!Number.isFinite(count) || count <= 0) return { staleCommits: 0 };
			warn(`[super-dev] serving copy is ${count} commit(s) behind ${ref} — fixed bugs may still be running live (incident class 2026-09-04T14-10). Remedy: cd ${extensionDir} && git pull (or reinstall), then restart pi. Currently serving: super-dev v${SUPER_DEV_EXTENSION_VERSION}.`);
			return { staleCommits: count };
		} catch {
			// ref missing — try the next
		}
	}
	return { staleCommits: 0 };
}
