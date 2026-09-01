/**
 * v0.3.31 — TEST-RUNNER CONVENTIONS (the single per-ecosystem seam).
 *
 * Design contract (2026-08-29 deep research: Bazel test encyclopedia,
 * SWE-Factory/SWE-Builder FSE'26, gotestsum, cargo-nextest/pytest/vitest docs):
 *
 *   1. The ORACLE ENGINE (gates.ts runRedCheck + result-parse.ts) contains
 *      ZERO per-language/toolchain knowledge. It executes plans and classifies
 *      from STRUCTURED evidence only; console prose never classifies
 *      (Bazel: "writing any of the strings PASS or FAIL to stdout has no
 *      significance to the test runner").
 *   2. Every ecosystem fact lives HERE — as declarative row data (anchors,
 *      target transforms, result channels, count-line patterns) plus small
 *      row-owned builders for the gnarly npm cases. Adding/fixing a stack =
 *      editing this module, never the engine.
 *   3. A validated agent-proposed runner (runner-discovery.ts, Layer C)
 *      BYPASSES conventions entirely — "LLM proposes, machine verifies,
 *      cache reuses" (RepoLaunch/SWE-Factory memory pool).
 *
 * Structured channels used by rows (all parsed by result-parse.ts):
 *   - junit-xml  : harvested from conventional build output dirs, or written
 *                  to an explicit harness-owned temp path (--junitxml=,
 *                  --outputFile=) that never pollutes the worktree.
 *   - tap        : runner-emitted TAP on stdout (node --test --test-reporter=tap,
 *                  vitest --reporter=tap).
 *   - gojson     : `go test -json` TestEvents (test2json).
 *   - counts     : a DECLARED count-line pattern with named groups — the
 *                  per-framework parser-as-data approach (rust libtest,
 *                  vitest/jest summaries). The engine's parser is generic;
 *                  the pattern is row data.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveIntegrationStems } from "./detect.ts";
import { insertNpmExecGuard, type TestRunnerSpec } from "./runner-discovery.ts";

// ---------------------------------------------------------------------------
// Channel + plan types
// ---------------------------------------------------------------------------

export type ResultChannel =
	| { format: "junit-xml"; explicitFiles?: string[] }
	| { format: "tap" }
	| { format: "gojson" }
	| { format: "counts"; pattern: RegExp }
	/** Dynamic (agent-validated) runners: try XML harvest + every stdout parser. */
	| { format: "auto" };

export interface ConventionPlan {
	cwd: string;
	argv: string[];
	/** Convention id (or "dynamic" for a validated cached spec) — diagnostics label. */
	conventionId: string;
	channel: ResultChannel;
	/** Harness-owned temp dirs to remove after classification (tmp junit). */
	cleanupDirs?: string[];
	/** Exit codes that mean "tests could not even run" (pytest 2=collection
	 *  interrupted, 4=usage error) — classified broken BEFORE counts. Exit
	 *  codes are the authoritative gate (review-2 F4; data-owned semantics). */
	brokenExitCodes?: number[];
}

export interface RunnerConvention {
	id: string;
	/** Manifest anchors — a directory matches when ANY anchor exists in it. */
	anchors: string[];
	/** Row result-channel template (counts patterns live here as data). */
	results: ResultChannel;
	/** Claimable target extensions — a row only claims targets whose path
	 *  matches (ecosystem-first ordering; the npm-family catch-all comes LAST).
	 *  JVM rows use it to claim FQN-derivable or jvm-extension targets. */
	claimExtensions?: RegExp;
	/** Row-level brokenExitCodes stamped onto every plan this row builds. */
	brokenExitCodes?: number[];
	/** Build scoped plans for the targets this row claims; return [] to decline. */
	build: (root: string, targets: string[]) => ConventionPlan[];
}

// ---------------------------------------------------------------------------
// Generic primitives (no ecosystem knowledge — anchor walking, JSON reads)
// ---------------------------------------------------------------------------

/** Nearest ancestor-or-self directory of `target` containing one of `anchors`. */
function nearestAnchorDir(root: string, target: string, anchors: string[]): string | null {
	const top = resolve(root);
	let cur = resolve(root, dirname(target));
	while (cur.startsWith(top)) {
		if (anchors.some((a) => existsSync(join(cur, a)))) return cur;
		if (cur === top) break;
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return anchors.some((a) => existsSync(join(top, a))) ? top : null;
}

function readJson(dir: string, name: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function relFrom(anchorDir: string, root: string, target: string): string {
	if (isAbsolute(target)) {
		const rel = relative(anchorDir, target);
		return rel.startsWith("..") ? target : rel;
	}
	const rel = relative(anchorDir, resolve(root, target));
	return rel.startsWith("..") ? target : rel;
}

function dedupeByKey(plans: ConventionPlan[]): ConventionPlan[] {
	const seen = new Set<string>();
	const out: ConventionPlan[] = [];
	for (const p of plans) {
		const key = `${resolve(p.cwd)}\0${p.argv.join(" ")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(p);
	}
	return out;
}

function tmpJunitDir(): string {
	return mkdtempSync(join(tmpdir(), "super-dev-junit-"));
}

// ---------------------------------------------------------------------------
// npm-family helpers (row-owned; ported battle-tested from gates.ts v0.3.30)
// ---------------------------------------------------------------------------

function packageScripts(pkg: Record<string, unknown> | null): Record<string, string> {
	return (pkg?.scripts ?? {}) as Record<string, string>;
}

function packageDeps(pkg: Record<string, unknown> | null): Record<string, string> {
	return { ...(pkg?.dependencies as Record<string, string> | undefined), ...(pkg?.devDependencies as Record<string, string> | undefined) };
}

export function detectPmForDir(dir: string, pkg: Record<string, unknown> | null): string {
	const pm = String(pkg?.packageManager ?? "").split("@")[0];
	if (pm && /^(npm|pnpm|yarn|bun|deno)$/.test(pm)) return pm;
	if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
	if (existsSync(join(dir, "deno.lock"))) return "deno";
	if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(dir, "yarn.lock"))) return "yarn";
	return "npm";
}

function nearestPackageDir(root: string, target: string): string | null {
	return nearestAnchorDir(root, target, ["package.json"]);
}

export function hasPackageTool(pkgDir: string, pkg: Record<string, unknown> | null, tool: string): boolean {
	const deps = packageDeps(pkg);
	return Boolean(deps[tool]) || existsSync(join(pkgDir, "node_modules", ".bin", tool)) || existsSync(join(pkgDir, "node_modules", tool));
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

export function pmExec(pm: string, tool: string, args: string[]): string[] {
	if (pm === "deno") return ["deno", "task", tool, ...args]; // deno task forwards child args — no npm-config eating
	// v0.3.56 F1 (class B): npm exec/dlx/npx/bun x consume `--flag=value` child
	// flags as npm config, so the conventions vitest row silently lost
	// --reporter=tap and the oracle degraded to unknown. Shared guard (one
	// helper with the string-form fix) inserts ` -- ` after the tool token;
	// byte-identical no-op without child flags.
	const argv = pm === "yarn" ? [pm, "exec", tool, ...args]
		: pm === "bun" ? [pm, "x", tool, ...args]
		: [pm, "exec", tool, ...args];
	return insertNpmExecGuard(argv);
}

function hasVitestScript(root: string): boolean {
	const pkg = readJson(root, "package.json");
	return /vitest/i.test(String(packageScripts(pkg).test ?? ""));
}

// vitest uses the TAP channel (`--reporter=tap`) — per-test structured lines
// that cover ALL shapes incl. the all-failing summary and greenfield suite
// load failures (review-2 F1: the summary line `Tests  2 failed (2)` has no
// " | " separator and no passed segment, so a counts pattern missed it).
const JEST_COUNTS = /Tests:\s*(?:(?<failed>\d+) failed)?,?\s*(?:(?<passed>\d+) passed)?(?:,\s*(?<total>\d+) total)?/;

/** npm-family scoped plans. Port of npmRedCheckPlans (v0.3.30) with explicit
 *  channels: vitest/jest get declared count-line patterns, node:test emits TAP.
 *  RC-1 preserved: recursive monorepo test scripts never get positional file
 *  args forwarded (they ignore them and run every package). */
function npmPlans(root: string, targets: string[], channelFor: { jest: ResultChannel; script: ResultChannel }): ConventionPlan[] {
	const plans: ConventionPlan[] = [];
	const fallbackTargets: string[] = [];
	for (const target of targets) {
		const pkgDir = nearestPackageDir(root, target) ?? root;
		const pkg = readJson(pkgDir, "package.json");
		const scripts = packageScripts(pkg);
		const rel = relFrom(pkgDir, root, target);
		const pm = detectPmForDir(pkgDir, pkg);

		if (isJsTsTarget(target) && fileUsesNodeTest(root, target)) {
			if (!isTsTarget(target)) {
				plans.push({ cwd: pkgDir, argv: ["node", "--test", "--test-reporter=tap", rel], conventionId: "npm-node-test", channel: { format: "tap" } });
				continue;
			}
			if (hasPackageTool(pkgDir, pkg, "tsx")) {
				plans.push({ cwd: pkgDir, argv: ["node", "--import", "tsx", "--test", "--test-reporter=tap", rel], conventionId: "npm-node-test", channel: { format: "tap" } });
				continue;
			}
		}

		if (scripts.test) {
			if (/vitest/i.test(scripts.test) || hasPackageTool(pkgDir, pkg, "vitest")) {
				plans.push({ cwd: pkgDir, argv: pmExec(pm, "vitest", ["run", "--reporter=tap", rel]), conventionId: "npm-vitest", channel: { format: "tap" } });
				continue;
			}
			if (/jest/i.test(scripts.test) || hasPackageTool(pkgDir, pkg, "jest")) {
				plans.push({ cwd: pkgDir, argv: pmExec(pm, "jest", [rel]), conventionId: "npm-jest", channel: channelFor.jest });
				continue;
			}
			if (isJsTsTarget(target) && hasPackageTool(pkgDir, pkg, "tsx")) {
				plans.push({ cwd: pkgDir, argv: ["node", "--import", "tsx", "--test", "--test-reporter=tap", rel], conventionId: "npm-node-test", channel: { format: "tap" } });
				continue;
			}
			const recursive = /\bpnpm\b[^\n]*\s-r\b|\bpnpm\b[^\n]*--recursive|\bturbo\b|\bnx\s+run-many|--workspaces\b/.test(scripts.test);
			if (!recursive) {
				plans.push({ cwd: pkgDir, argv: pm === "deno" ? ["deno", "task", "test", rel] : [pm, "run", "test", "--", rel], conventionId: "npm-script", channel: channelFor.script });
				continue;
			}
			fallbackTargets.push(target);
			continue;
		}

		if (hasPackageTool(pkgDir, pkg, "vitest")) {
			plans.push({ cwd: pkgDir, argv: pmExec(pm, "vitest", ["run", "--reporter=tap", rel]), conventionId: "npm-vitest", channel: { format: "tap" } });
			continue;
		}
		if (isJsTsTarget(target) && hasPackageTool(pkgDir, pkg, "tsx")) {
			plans.push({ cwd: pkgDir, argv: ["node", "--import", "tsx", "--test", "--test-reporter=tap", rel], conventionId: "npm-node-test", channel: { format: "tap" } });
			continue;
		}
		fallbackTargets.push(target);
	}
	if (fallbackTargets.length > 0) {
		const rootPkg = readJson(root, "package.json");
		const rootScript = String(packageScripts(rootPkg).test ?? "");
		const rootRecursive = /\bpnpm\b[^\n]*\s-r\b|--recursive|\bturbo\b|nx\s+run-many|--workspaces\b|\blerna\b/.test(rootScript);
		const rootPm = detectPmForDir(root, rootPkg);
		if (hasVitestScript(root) || hasPackageTool(root, rootPkg, "vitest")) {
			plans.push({ cwd: root, argv: pmExec(rootPm, "vitest", ["run", "--reporter=tap", ...fallbackTargets]), conventionId: "npm-vitest", channel: { format: "tap" } });
		} else if (rootScript && !rootRecursive) {
			plans.push({ cwd: root, argv: [rootPm, "run", "test", "--", ...fallbackTargets], conventionId: "npm-script", channel: channelFor.script });
		}
		// Recursive-only root with no scoped runner: NO plan — the honest
		// no-runner state (never a whole-monorepo false green). RC-1.
	}
	return dedupeByKey(plans);
}

// ---------------------------------------------------------------------------
// JVM helpers (row-owned; ported from gates.ts v0.3.30)
// ---------------------------------------------------------------------------

const JVM_TEST_ROOTS = ["src/test/java", "src/test/kotlin", "src/androidTest/java", "src/androidTest/kotlin", "src/test/groovy"];

function jvmTestFqn(root: string, target: string): string | null {
	const norm = target.replace(/\\/g, "/");
	for (const testRoot of JVM_TEST_ROOTS) {
		const i = norm.indexOf(`/${testRoot}/`);
		const j = i >= 0 ? i + 1 : norm.startsWith(`${testRoot}/`) ? 0 : -1;
		if (j < 0) continue;
		const rel = norm.slice(j + testRoot.length + 1).replace(/\.(java|kt|kts|groovy)$/i, "");
		if (!rel) return null;
		return rel.split("/").filter(Boolean).join(".");
	}
	return null;
}

function gradleModuleDir(root: string, target: string): string {
	const top = resolve(root);
	let cur = resolve(root, dirname(target));
	while (cur.startsWith(top)) {
		if (["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some((f) => existsSync(join(cur, f)))) return cur;
		if (cur === top) break;
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return top;
}

function gradleWrapperArgv0(moduleDir: string): string {
	let cur = moduleDir;
	for (let i = 0; i < 16; i++) {
		if (existsSync(join(cur, "gradlew"))) return join(cur, "gradlew");
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return "gradle";
}

function isAndroidGradleModule(moduleDir: string): boolean {
	for (const f of ["build.gradle", "build.gradle.kts"]) {
		try {
			const text = readFileSync(join(moduleDir, f), "utf8");
			if (/com\.android|\bandroid\s*\{/.test(text)) return true;
		} catch {
			/* absent */
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// The conventions table
// ---------------------------------------------------------------------------

export const RUNNER_CONVENTIONS: RunnerConvention[] = [
	{
		id: "python-pytest",
		anchors: ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "requirements.txt", "Pipfile", "poetry.lock"],
		results: { format: "junit-xml" },
		claimExtensions: /\.(py|pyw)$/i,
		brokenExitCodes: [2, 4],
		build: (root, targets) => {
			const plans: ConventionPlan[] = [];
			const byDir = new Map<string, string[]>();
			for (const t of targets) {
				const dir = nearestAnchorDir(root, t, ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "requirements.txt", "Pipfile", "poetry.lock"]) ?? root;
				const group = byDir.get(dir) ?? [];
				group.push(relFrom(dir, root, t));
				byDir.set(dir, group);
			}
			for (const [dir, rel] of byDir) {
				const tmp = tmpJunitDir();
				const file = join(tmp, "junit.xml");
				plans.push({
					cwd: dir,
					argv: ["pytest", "-q", `--junitxml=${file}`, ...rel],
					conventionId: "python-pytest",
					channel: { format: "junit-xml", explicitFiles: [file] },
					cleanupDirs: [tmp],
					brokenExitCodes: [2, 4],
				});
			}
			return dedupeByKey(plans);
		},
	},
	{
		id: "go-test",
		anchors: ["go.mod"],
		results: { format: "gojson" },
		claimExtensions: /\.go$/i,
		build: (root, targets) => {
			const byDir = new Map<string, string[]>();
			for (const t of targets) {
				const dir = nearestAnchorDir(root, t, ["go.mod"]) ?? root;
				const group = byDir.get(dir) ?? [];
				group.push(relFrom(dir, root, t));
				byDir.set(dir, group);
			}
			const plans: ConventionPlan[] = [];
			for (const [dir, rel] of byDir) {
				const pkgs = [...new Set(rel.map((r) => goPackageArg(r)))].sort();
				plans.push({ cwd: dir, argv: ["go", "test", "-json", ...pkgs], conventionId: "go-test", channel: { format: "gojson" } });
			}
			return dedupeByKey(plans);
		},
	},
	{
		id: "cargo-test",
		anchors: ["Cargo.toml"],
		results: { format: "counts", pattern: /test result: \w+\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<skipped>\d+) ignored/ },
		claimExtensions: /\.rs$/i,
		build: (root, targets) => {
			const byDir = new Map<string, string[]>();
			for (const t of targets) {
				const dir = nearestAnchorDir(root, t, ["Cargo.toml"]) ?? root;
				const group = byDir.get(dir) ?? [];
				group.push(relFrom(dir, root, t));
				byDir.set(dir, group);
			}
			const plans: ConventionPlan[] = [];
			for (const [dir, rel] of byDir) {
				const stems = resolveIntegrationStems(dir, rel);
				if (stems.length > 0) {
					for (const stem of stems) plans.push({ cwd: dir, argv: ["cargo", "test", "--test", stem, "--quiet"], conventionId: "cargo-test", channel: { format: "counts", pattern: CARGO_COUNTS } });
				} else {
					plans.push({ cwd: dir, argv: ["cargo", "test", "--quiet"], conventionId: "cargo-test", channel: { format: "counts", pattern: CARGO_COUNTS } });
				}
			}
			return dedupeByKey(plans);
		},
	},
	{
		id: "gradle",
		anchors: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
		results: { format: "junit-xml" },
		claimExtensions: /\.(java|kt|kts|groovy)$/i,
		build: (root, targets) => {
			const plans: ConventionPlan[] = [];
			for (const t of targets) {
				const moduleDir = gradleModuleDir(root, t);
				const exe = gradleWrapperArgv0(moduleDir);
				const task = isAndroidGradleModule(moduleDir) ? "testDebugUnitTest" : "test";
				const fqn = jvmTestFqn(root, t);
				const argv = fqn ? [exe, task, "--tests", fqn] : [exe, task];
				plans.push({ cwd: moduleDir, argv, conventionId: "gradle", channel: { format: "junit-xml" } });
			}
			return dedupeByKey(plans);
		},
	},
	{
		id: "maven",
		anchors: ["pom.xml"],
		results: { format: "junit-xml" },
		claimExtensions: /\.(java|kt|kts|groovy)$/i,
		build: (root, targets) => {
			const plans: ConventionPlan[] = [];
			for (const t of targets) {
				const moduleDir = nearestAnchorDir(root, t, ["pom.xml"]) ?? root;
				const exe = existsSync(join(moduleDir, "mvnw")) ? join(moduleDir, "mvnw") : "mvn";
				const fqn = jvmTestFqn(root, t);
				const argv = fqn ? [exe, "test", `-Dtest=${fqn}`] : [exe, "test"];
				plans.push({ cwd: moduleDir, argv, conventionId: "maven", channel: { format: "junit-xml" } });
			}
			return dedupeByKey(plans);
		},
	},

	{
		id: "npm-family",
		anchors: ["package.json"],
		results: { format: "auto" },
		build: (root, targets) =>
			npmPlans(root, targets, {
				jest: { format: "counts", pattern: JEST_COUNTS },
				script: { format: "auto" },
			}),
	},
];

const CARGO_COUNTS = /test result: \w+\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<skipped>\d+) ignored/;

function goPackageArg(relTarget: string): string {
	const rel = relTarget.replace(/\\/g, "/");
	const pkgDir = /\.go$/i.test(rel) ? dirname(rel).replace(/\\/g, "/") : rel.replace(/\/$/, "");
	if (!pkgDir || pkgDir === ".") return ".";
	return pkgDir.startsWith("./") ? pkgDir : `./${pkgDir}`;
}

/** v0.3.56 F2: when phase RED ran via CONVENTIONS (no validated runner →
 *  discovery never wrote the cache), the coverage gate had no runner spec and
 *  silently skipped (a silent green — P10). This derives the SAME conventions
 *  runner as a TestRunnerSpec so the gate can measure it; null when no row
 *  claims the targets (the caller then emits the loud UNMEASURABLE advisory).
 *  Best-effort: never throws, tmp junit dirs are cleaned up. */
export function deriveConventionsRunnerSpec(root: string, targets: string[]): TestRunnerSpec | null {
	try {
		const plans = conventionPlansFor(root, targets);
		try {
			const first = plans[0];
			if (!first) return null;
			const format = first.channel.format === "tap" ? "tap" : first.channel.format === "junit-xml" ? "junit-xml" : "console";
			const command = first.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
			return {
				version: 1,
				command,
				cwd: first.cwd,
				resultFormat: format,
				note: `derived from conventions row ${first.conventionId} (coverage gate; RED ran via conventions)`,
				discoveredAt: new Date().toISOString(),
			};
		} finally {
			for (const p of plans) for (const d of p.cleanupDirs ?? []) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
		}
	} catch {
		return null;
	}
}

/** Resolve scoped oracle plans for `targets` under `root` by consulting the
 *  conventions table. Targets are PARTITIONED by claiming rows in DECLARED
 *  order — review-2 F2: ecosystem-specific rows come first and claim their
 *  extensions (.go/.rs/.py, JVM FQN/shapes), the npm-family catch-all comes
 *  LAST so a polyglot repo (npm monorepo with a nested go/python/cargo
 *  service) never starves the correct runner. Unclaimed targets produce no
 *  plan (the oracle reports unknown — the honest no-runner state). */
export function conventionPlansFor(root: string, targets: string[]): ConventionPlan[] {
	const out: ConventionPlan[] = [];
	const claimed = new Set<string>();
	const abs = new Set<string>();
	for (const t of targets) {
		if (!t || typeof t !== "string") continue;
		const key = t.replace(/\\/g, "/");
		if (abs.has(key)) continue;
		abs.add(key);
	}
	const list = [...abs];
	const built: ConventionPlan[] = [];
	try {
		for (const row of RUNNER_CONVENTIONS) {
		// Determine which unclaimed targets live under this row's anchors.
		const mine: string[] = [];
		for (const t of list) {
			if (claimed.has(t)) continue;
			const dir = nearestAnchorDir(root, t, row.anchors);
			if (!dir) continue;
			// JVM rows only claim derivable test sources; npm claims js/ts;
			// others claim everything under their anchor.
			if (row.claimExtensions && !jvmTestFqn(root, t) && !row.claimExtensions.test(t)) continue;
			mine.push(t);
		}
			if (mine.length === 0) continue;
			for (const t of mine) claimed.add(t);
			const plans = row.build(root, mine);
			built.push(...plans);
			out.push(...plans);
		}
		return dedupeByKey(out);
	} catch (err) {
		// review-2 F8: never orphan harness-owned tmp junit dirs built before
		// a later row threw.
		for (const dir of built.flatMap((p) => p.cleanupDirs ?? [])) {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
		}
		throw err;
	}
}
