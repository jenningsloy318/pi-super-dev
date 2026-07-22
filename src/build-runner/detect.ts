/**
 * Project + cargo-metadata detection + shared utils (split from build-runner.ts).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Per-call timeout for the cached `cargo metadata` lookup (review finding).
 *
 * A metadata fetch is a cheap read of the manifest graph, NOT a full build, so
 * it must NOT inherit the 10-minute {@link resolveTimeoutMs} build envelope — a
 * hung or missing `cargo` would otherwise block up to 10 minutes before the
 * resolver's identity fallback fires. 30s comfortably covers the largest real
 * workspace graph reads while failing fast. Overridable via env for CI.
 */
const DEFAULT_CARGO_METADATA_TIMEOUT_MS = 30_000;

export function cargoMetadataTimeoutMs(): number {
	const raw = process.env.SUPER_DEV_CARGO_METADATA_TIMEOUT_MS;
	if (raw !== undefined && raw !== "") {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return DEFAULT_CARGO_METADATA_TIMEOUT_MS;
}

/**
 * Dedupe a list of strings, preserving first-seen order.
 *
 * Exported so {@link ChangeTracker} (src/tracking.ts) reuses the SAME
 * first-seen dedup when UNIONing committed-diff paths with porcelain
 * untracked paths (spec-11 AC-01 single source of truth — no duplication).
 */
export function dedupePreservingOrder(items: string[]): string[] {
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
 * The first `crates/<seg>/` segment matcher — identical to the one used by
 * {@link detectTouchedCargoPackages}. Non-global: each call starts at index 0
 * so `lastIndex` never needs resetting.
 */
export const CRATE_SEGMENT_RE = /(?:^|\/)crates\/([^/]+)\//;

/**
 * Result of a cached `cargo metadata` lookup. `ok:true` carries the workspace
 * member packages mapped to `{ name, manifestDir }`; `ok:false` is the failure
 * sentinel cached so a missing/failing `cargo` is not re-spawned within one run
 * (AC-02, SCENARIO-018). NEVER persisted (process-local — SCENARIO-006).
 */
type CargoMetadataResult =
	| { ok: true; packages: Array<{ name: string; manifestDir: string }> }
	| { ok: false };

/**
 * Process-local cache of `cargo metadata` results, keyed by ABSOLUTE `cwd`.
 *
 * Stores either the parsed package list OR a `{ ok:false }` failure sentinel so
 * a failing/missing `cargo` is not re-spawned within one run (SCENARIO-018).
 * Lives only in memory — `vi.resetModules()` (or process exit) clears it, so no
 * stale result ever leaks across runs (SCENARIO-006). Module-level (NOT
 * exported) because the resolver is the sole reader.
 */
const cargoMetadataCache = new Map<string, CargoMetadataResult>();

/**
 * Extract the FIRST `crates/<seg>/` segment from a directory path.
 *
 * Cargo `manifest_path` is a FILE (`…/crates/<seg>/Cargo.toml`); its parent
 * `manifestDir` is a DIRECTORY and so lacks a trailing slash, which would
 * defeat the `crates/<seg>/` regex on a flat crate (`crates/data`). Appending
 * `/` normalizes both flat and nested manifest dirs to a path the SAME regex
 * matches, yielding the first `crates/<seg>/` segment (SCENARIO-002: a manifest
 * at `crates/data/inner/Cargo.toml` has manifestDir `crates/data/inner` whose
 * first segment is `data`, not `inner`). Returns `null` when no
 * `crates/<seg>/` segment exists (root package / non-crates layout).
 */
function firstCratesSegment(manifestDir: string): string | null {
	const m = CRATE_SEGMENT_RE.exec(`${manifestDir}/`);
	return m ? m[1] : null;
}

/**
 * Load and cache `cargo metadata` for a workspace root (AC-10, SCENARIO-005).
 *
 * Spawns `cargo metadata --format-version 1 --no-deps --manifest-path
 * <cwd>/Cargo.toml` via DISCRETE argv (no `shell:true` — package/path data never
 * reaches a shell) under the existing {@link resolveTimeoutMs} envelope with
 * `encoding:"utf8"`. The `--manifest-path` targets the WORKSPACE-ROOT
 * `Cargo.toml`; cargo returns ALL workspace members in `packages[]`, each
 * carrying its individual `manifest_path`. Each member is mapped to
 * `{ name, manifestDir: dirname(manifest_path) }` and the result cached under
 * the absolute `cwd` (or a `{ ok:false }` sentinel on failure).
 *
 * NEVER throws (AC-02): the whole body is try/caught. Spawn error (`r.error`),
 * non-zero exit (bad package spec / missing manifest), timeout kill (signal),
 * missing `cargo` (ENOENT), JSON parse failure, non-string stdout, a missing /
 * non-array `packages[]`, an empty valid set, or any thrown exception → cache
 * and return `{ ok:false }`. A failure is STILL cached so the spawn is not
 * repeated within one run (SCENARIO-018).
 *
 * Side-effecting (spawns `cargo`) but pure wrt argv construction. Memoized per
 * absolute `cwd` via {@link cargoMetadataCache}.
 *
 * @param cwd Absolute worktree path whose `Cargo.toml` is the workspace root.
 * @returns `{ ok:true, packages }` on success, else `{ ok:false }`.
 */
function loadCargoMetadata(cwd: string): CargoMetadataResult {
	// Resolve ONCE so the cache KEY and the --manifest-path argv use the SAME
	// absolute path — otherwise a relative/symlinked `cwd` could key the cache
	// under `resolve(cwd)` while cargo opens `join(cwd,"Cargo.toml")`, yielding a
	// duplicate spawn (review finding: cache-key/argv skew).
	const absCwd = resolve(cwd);
	const key = absCwd;
	const cached = cargoMetadataCache.get(key);
	if (cached) return cached;
	let result: CargoMetadataResult;
	try {
		const r = spawnSync(
			"cargo",
			[
				"metadata",
				"--format-version",
				"1",
				"--no-deps",
				"--manifest-path",
				join(absCwd, "Cargo.toml"),
			],
			// Dedicated SHORT timeout (review finding): a metadata lookup is a cheap
			// read of the manifest graph, NOT a full build. Inheriting the 10-min
			// build timeout meant a hung/missing cargo blocked up to 10 minutes
			// before the identity fallback kicked in. Overridable via env.
			{ encoding: "utf8", timeout: cargoMetadataTimeoutMs() },
		);
		if (r.error || r.status !== 0) {
			result = { ok: false };
		} else {
			const out = r.stdout;
			if (typeof out !== "string" || out === "") {
				result = { ok: false };
			} else {
				const parsed = JSON.parse(out) as {
					packages?: Array<{ name?: unknown; manifest_path?: unknown }>;
				};
				const pkgs = Array.isArray(parsed?.packages) ? parsed.packages : null;
				if (!pkgs) {
					result = { ok: false };
				} else {
					const mapped: Array<{ name: string; manifestDir: string }> = [];
					for (const p of pkgs) {
						if (
							p &&
							typeof p.name === "string" &&
							typeof p.manifest_path === "string"
						) {
							mapped.push({
								name: p.name,
								manifestDir: dirname(p.manifest_path),
							});
						}
					}
					result = mapped.length > 0 ? { ok: true, packages: mapped } : { ok: false };
				}
			}
		}
	} catch {
		result = { ok: false };
	}
	cargoMetadataCache.set(key, result);
	return result;
}

/**
 * Resolve touched DIRECTORY segments to REAL cargo package names (AC-01).
 *
 * Given touched DIRECTORY segments (e.g. `["data","tools","workflows"]`),
 * returns the REAL cargo package names (e.g.
 * `["stockfan-data","stockfan-tools","stockfan-workflows"]`) so the gate emits
 * `cargo build -p stockfan-data` instead of the rejected `-p data`. Pure-mapping
 * over the cached side-effect {@link loadCargoMetadata}; deduped, first-seen
 * order preserved.
 *
 * MATCHING (SCENARIO-002): for each touched segment `d`, select the package
 * whose `manifestDir` first `crates/<seg>/` segment (via
 * {@link firstCratesSegment}) EQUALS `d`. This is manifest-in-subdir safe: a
 * package at `crates/data/inner/Cargo.toml` has manifestDir `crates/data/inner`
 * whose first segment is `data`.
 *
 * HARDENED FALLBACK CHAIN (Layer C defense-in-depth — NEVER throws, AC-02,
 * SCENARIO-003..008/018/019/034). The per-element AND whole-list identity
 * fallbacks are REMOVED so an unknown dir never emits as a raw name and a
 * metadata failure never emits guessed names:
 *   - empty touched-dir input → returns `[]` WITHOUT spawning `cargo metadata`
 *     (no packages to resolve → workspace-wide gate → metadata unneeded);
 *   - `loadCargoMetadata` returns `{ ok:false }` (cargo missing / non-zero /
 *     timeout / bad JSON / wrong shape) → DROP everything, return `[]` (NO
 *     whole-list identity fallback — SCENARIO-006) so the gate widens safely
 *     to workspace-wide;
 *   - a touched segment with NO matching package → DROPPED (NO per-element
 *     identity fallback — SCENARIO-005); an unresolved dir never emits as its
 *     raw name;
 *   - any thrown exception → return `[]` (SCENARIO-034).
 * An empty touched-dir input short-circuits before the spawn (AC-10: the only
 * new spawn is the cached `cargo metadata --no-deps` and ONLY when there is
 * something to resolve).
 *
 * Backward compatible (AC-08): a dir==name workspace is a no-op when metadata
 * is available (the real name equals the dir name via {@link matchPackageBySegment});
 * a non-rust repo never reaches this resolver because `runBuildGate` only
 * enters the scoping tier when `language === "rust"` and a non-empty scope
 * resolves.
 *
 * @param cwd Absolute worktree path whose `Cargo.toml` is the workspace root.
 * @param touchedDirs Touched `crates/<dir>/` DIRECTORY segments.
 * @returns Resolved REAL package names, deduped first-seen order; unknown dirs
 *   are DROPPED and any metadata failure yields `[]` (never throws).
 */
export function resolveCargoPackageNames(
	cwd: string,
	touchedDirs: string[],
): string[] {
	// Normalize ONCE: filter to string segments + dedupe into a single `strDirs`
	// so there is one source of truth for the touched dir names.
	const strDirs = Array.isArray(touchedDirs)
		? touchedDirs.filter((d): d is string => typeof d === "string")
		: [];
	if (strDirs.length === 0) return [];
	try {
		const meta = loadCargoMetadata(cwd);
		// No usable metadata → DROP everything (NO whole-list identity fallback,
		// AC-02 / SCENARIO-006). Widens safely to workspace-wide; never throws.
		if (!meta.ok) {
			return [];
		}
		const out: string[] = [];
		for (const d of strDirs) {
			const matched = matchPackageBySegment(meta.packages, d);
			// Unresolved dir → DROPPED (NO per-element identity fallback, AC-02 /
			// SCENARIO-005). An unresolved dir never emits as its raw name.
			if (matched) out.push(matched.name);
		}
		return dedupePreservingOrder(out);
	} catch {
		// NEVER throws — safe [] (AC-02 / SCENARIO-034).
		return [];
	}
}

/**
 * Validate a list of candidate cargo package names against the workspace's
 * KNOWN members (Layer C defense-in-depth, AC-03 / SCENARIO-007/008).
 *
 * Reuses the per-cwd cached `cargo metadata` ({@link loadCargoMetadata}) so a
 * prior {@link resolveCargoPackageNames} (or repeated validator) call does NOT
 * trigger a second `cargo metadata` spawn (SCENARIO-007b). Returns ONLY
 * candidates that are known workspace members — every name is re-checked
 * against the member set so an invalid name is DROPPED before any `-p` flag is
 * built. De-duped, first-seen order preserved. With no usable metadata NOTHING
 * is a known member → returns `[]` (cannot confirm anything → widen safely).
 * NEVER throws — the whole body is try/caught and returns `[]` on any failure
 * (SCENARIO-034).
 *
 * @param cwd Absolute worktree path whose `Cargo.toml` is the workspace root.
 * @param names Candidate cargo package names to validate.
 * @returns Only candidates that are known members, deduped first-seen order;
 *   `[]` when metadata is unavailable or on any failure (never throws).
 */
export function validatePackageNames(cwd: string, names: string[]): string[] {
	const strNames = Array.isArray(names)
		? names.filter((n): n is string => typeof n === "string")
		: [];
	if (strNames.length === 0) return [];
	try {
		const meta = loadCargoMetadata(cwd);
		// No usable metadata → cannot confirm ANY name → drop all (AC-03 /
		// SCENARIO-007). Widens safely to workspace-wide; never throws.
		if (!meta.ok) return [];
		const known = new Set(meta.packages.map((p) => p.name));
		return dedupePreservingOrder(strNames.filter((n) => known.has(n)));
	} catch {
		// NEVER throws — safe [] (SCENARIO-034).
		return [];
	}
}

/**
 * Resolve spec-declared `gate.integration` targets (file paths like
 * `crates/workflows/tests/e2e_x.rs`) to `cargo test --test <stem>` stems.
 *
 * CR-004 fix: integration targets are FILE PATHS, not package names. Each is:
 *   1. Trimmed + basename taken (`e2e_x.rs` -> stem `e2e_x` after `.rs` strip);
 *   2. STAT-checked via `existsSync(join(cwd, path))` -- a missing file is DROPPED
 *      (never emits a cargo error for a non-existent test binary);
 *   3. Emitted as a separate `cargo test --test <stem>` invocation (NOT appended
 *      to the `-p` package list -- these are explicit test binaries, not packages).
 *
 * Never throws. Returns `[]` on any error or when no targets resolve.
 */
export function resolveIntegrationStems(cwd: string, integration: string[]): string[] {
	const paths = Array.isArray(integration)
		? integration.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
		: [];
	if (paths.length === 0) return [];
	const stems: string[] = [];
	for (const raw of paths) {
		try {
			const trimmed = raw.trim();
			const base = trimmed.split("/").pop() ?? trimmed;
			const stem = base.endsWith(".rs") ? base.slice(0, -3) : base;
			if (!stem) continue;
			if (!existsSync(join(cwd, trimmed))) continue;
			stems.push(stem);
		} catch {
			// never throw -- skip unresolvable targets
		}
	}
	return dedupePreservingOrder(stems);
}

/**
 * Pick the package whose first `crates/<seg>/` segment equals `seg`,
 * DETERMINISTICALLY preferring an exact crate root (`crates/<seg>`) over a
 * nested one (`crates/<seg>/inner`) when several workspace members share a top
 * segment (review finding: multi-crate-per-top-segment matching was ambiguous /
 * order-dependent on `cargo metadata`'s package order). Never throws.
 */
function matchPackageBySegment(
	packages: Array<{ name: string; manifestDir: string }>,
	seg: string,
): { name: string; manifestDir: string } | undefined {
	let nested: { name: string; manifestDir: string } | undefined;
	for (const p of packages) {
		if (firstCratesSegment(p.manifestDir) !== seg) continue;
		// Exact crate root wins unambiguously (flat crate `crates/<seg>`).
		if (p.manifestDir === `crates/${seg}` || p.manifestDir.endsWith(`/crates/${seg}`)) {
			return p;
		}
		if (!nested) nested = p; // keep the FIRST nested match for determinism
	}
	return nested;
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

/**
 * Augment the resolved REAL package-name scope with each in-scope crate's
 * `crates/<dir>/` DIRECTORY segment (review finding — HIGH false-green fix).
 *
 * `classifyOutOfScopeErrors` matches cargo BUILD/CLIPPY error blocks two ways:
 *   - `crates/<seg>/` SOURCE PATH markers → the DIRECTORY segment, and
 *   - `-p <name>` rerun flags → the REAL name.
 * Cargo does NOT always emit the rerun `-p` flag (build/clippy rarely do), so
 * the directory segment is the reliable signal — but `testPackages` carries
 * REAL names post-resolution. This maps each in-scope real name back to its
 * directory segment via the cached metadata and unions the two, so BOTH marker
 * forms match an in-scope crate (and, critically, NEITHER matches an
 * out-of-scope one). Pure over cached metadata; never spawns; never throws.
 */
export function classificationScope(cwd: string, realNames: string[]): string[] {
	const out = new Set<string>(realNames);
	const meta = loadCargoMetadata(cwd);
	if (meta.ok) {
		for (const p of meta.packages) {
			if (out.has(p.name)) {
				const seg = firstCratesSegment(p.manifestDir);
				if (seg) out.add(seg);
			}
		}
	}
	return [...out];
}

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

/** Best-effort read of a file's text ("" if missing/unreadable). */
export function readMaybe(cwd: string, file: string): string {
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
