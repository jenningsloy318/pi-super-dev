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
import { dirname, join, resolve } from "node:path";

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
 * The first `crates/<seg>/` segment matcher — identical to the one used by
 * {@link detectTouchedCargoPackages}. Non-global: each call starts at index 0
 * so `lastIndex` never needs resetting.
 */
const CRATE_SEGMENT_RE = /(?:^|\/)crates\/([^/]+)\//;

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
 * List the RAW touched file paths on the current branch vs a base ref.
 *
 * Gap 4 foundation / AC-04 — the single git extraction shared by BOTH the cargo
 * in/out-of-scope classifier ({@link detectTouchedCargoPackages}) AND the npm
 * (vitest/jest) classifier (Phase 5). Spawns `git -C <cwd> diff --merge-base
 * <baseRef> --name-only` ONCE (committed changes) and `git -C <cwd> ls-files
 * --others --exclude-standard` ONCE (the untracked-but-not-ignored union),
 * concatenates both stdouts, and de-duplicates via
 * {@link dedupePreservingOrder} preserving first-seen order (committed-diff
 * lines first, then untracked-only lines).
 *
 * Unlike {@link detectTouchedCargoPackages} this returns RAW file paths — NO
 * crate-segment filtering. A line like `crates/data/src/lib.rs` is returned
 * verbatim; non-crate paths (`Cargo.toml`, `README.md`, `docs/spec.md`,
 * `src/*.test.ts`) are ALSO returned so the npm classifier has the full touched
 * set to compare failing-test files against. The crate-segment collapse is a
 * SEPARATE, downstream step performed by {@link detectTouchedCargoPackages}.
 *
 * Base-ref precedence (highest → lowest): an explicit {@link baseRef} arg > the
 * `SUPER_DEV_GATE_BASE_REF` env var > `"main"`. The base ref applies ONLY to
 * the committed diff; the untracked-union spawn is against the working tree
 * (never takes `--merge-base`).
 *
 * Safe degradation (NEVER throws — the entire body is try/caught): returns `[]`
 * on a non-zero git exit (missing base ref / non-git dir), an `r.error` (git
 * not installed / ENOENT), empty or whitespace-only output, a non-string
 * stdout, or any thrown exception. An empty `[]` return is the conservative
 * in-scope fallback Phase 5 relies on (grants no false green). See
 * SCENARIO-001/002/003/020/021/022/023/037/038.
 *
 * Side-effecting (spawns git + reads env) like the rest of the module, but pure
 * wrt argv construction: it spawns `git` as discrete-argv calls with no
 * `shell:true`, so path data never reaches a shell. Performs exactly TWO
 * bounded git spawns per call (no baseline-on-main run, no diagnostic
 * follow-up spawns — SCENARIO-023).
 *
 * @param cwd Absolute worktree path to run git in (`-C <cwd>`).
 * @param baseRef Optional base ref override (`--merge-base <baseRef>`).
 * @returns De-duplicated RAW touched file paths (first-seen order), or `[]`.
 */
export function touchedFilePaths(cwd: string, baseRef?: string): string[] {
	try {
		const ref = baseRef ?? process.env.SUPER_DEV_GATE_BASE_REF ?? "main";
		// Layer B (untracked-file union — the motivating stockfan e2e fix, AC-01):
		// UNION the committed diff against the base ref WITH
		// `git ls-files --others --exclude-standard` (the untracked-but-not-ignored
		// file list) so a brand-new file such as `crates/workflows/tests/e2e_*.rs`
		// also contributes its path. `git diff --merge-base` lists ONLY committed
		// changes; without the union an untracked file was silently dropped.
		// Either command failing contributes nothing to the union; the helper
		// still NEVER throws. The untracked spawn is against the working tree
		// (base ref does not apply to it).
		const diffR = spawnSync("git", ["-C", cwd, "diff", "--merge-base", ref, "--name-only"], {
			encoding: "utf8",
		});
		const untrackedR = spawnSync(
			"git",
			["-C", cwd, "ls-files", "--others", "--exclude-standard"],
			{ encoding: "utf8" },
		);
		// Concatenate both stdouts; each command failing independently contributes
		// nothing (non-zero exit / spawn error / non-string stdout skipped). Paths
		// are returned RAW (verbatim) — NO crate-segment filtering here.
		const paths: string[] = [];
		const collect = (r: { error?: unknown; status?: number | null; stdout?: unknown } | null) => {
			if (!r || r.error || r.status !== 0) return;
			const out = r.stdout;
			if (typeof out !== "string" || out.trim() === "") return;
			for (const line of out.split("\n")) {
				// Trim each line so trailing newlines, stray whitespace, and CRLF
				// line endings (Windows git) collapse to clean RAW paths. Empty /
				// whitespace-only lines (e.g. the trailing newline of --name-only
				// output) contribute nothing — they are NOT emitted as paths.
				const path = line.trim();
				if (path !== "") paths.push(path);
			}
		};
		collect(diffR);
		collect(untrackedR);
		// First-seen dedup: a path present in BOTH the diff and the untracked set
		// collapses to ONE entry at its committed-diff position. This is the exact
		// input the cargo segment-mapper ({@link detectTouchedCargoPackages}) and
		// the Phase 5 npm classifier consume.
		return dedupePreservingOrder(paths);
	} catch {
		return [];
	}
}

/**
 * Detect the cargo crates touched on the current branch vs a base ref.
 *
 * AC-01 — delegates the raw git extraction to {@link touchedFilePaths} (the Gap
 * 4 shared helper) and maps each raw `crates/<pkg>/…` path to `<pkg>` (first
 * `crates/` segment wins) via the module-level {@link CRATE_SEGMENT_RE}, then
 * de-duplicates the crate segments via {@link dedupePreservingOrder} preserving
 * first-seen order. Non-crate paths (root `Cargo.toml`, `README`, `docs/…`) are
 * ignored. This is a zero-behavior-change refactor of the pre-Phase-1 body:
 * `touchedFilePaths` performs the identical two bounded git spawns and the
 * segment-mapper + dedup collapse crate paths exactly as before.
 *
 * Base-ref precedence (highest → lowest): an explicit {@link baseRef} arg > the
 * `SUPER_DEV_GATE_BASE_REF` env var > `"main"` (delegated to
 * {@link touchedFilePaths}).
 *
 * Safe degradation (NEVER throws — the body is try/caught and
 * {@link touchedFilePaths} itself degrades to `[]`): returns `[]` on a non-zero
 * git exit (missing base ref / non-git dir), an `r.error` (git not installed),
 * empty or whitespace-only diff output, a diff with no crate paths, a
 * non-string stdout, or any thrown exception. An empty `[]` return is exactly
 * the value `runBuildGate` relies on to fall back to workspace-wide scoping (no
 * `-p` flags anywhere). See SCENARIO-001/002/003/020/022/023.
 *
 * Side-effecting (spawns git via {@link touchedFilePaths} + reads env) but pure
 * wrt argv construction: no `shell:true`, so path data never reaches a shell.
 *
 * @param cwd Absolute worktree path to run git in (`-C <cwd>`).
 * @param baseRef Optional base ref override (`--merge-base <baseRef>`).
 * @returns De-duplicated touched crate names (first-seen order), or `[]`.
 */
export function detectTouchedCargoPackages(cwd: string, baseRef?: string): string[] {
	try {
		// Reuse the shared raw-file-path helper (Gap 4 foundation, AC-04) so the
		// cargo and npm in/out-of-scope classifiers share ONE git extraction. The
		// raw paths are mapped through the SAME {@link CRATE_SEGMENT_RE}
		// segment-mapper as before (first `crates/<pkg>/` segment wins) and
		// {@link dedupePreservingOrder} is still applied to the crate segments —
		// observable crate-segment output is byte-for-byte unchanged (the
		// touched-crates / autoscope / nonregression suites stay green).
		const pkgs: string[] = [];
		for (const line of touchedFilePaths(cwd, baseRef)) {
			const m = CRATE_SEGMENT_RE.exec(line);
			if (m) pkgs.push(m[1]);
		}
		// Returns raw DIRECTORY segments (spec-08 Layer C separation). Resolution
		// to REAL cargo package names is a SEPARATE step ({@link
		// resolveCargoPackageNames}) invoked by {@link runBuildGate}, NOT here, so
		// this helper NEVER spawns `cargo metadata` (SCENARIO-020: bounded git
		// spawns; SCENARIO-001..003 assert segment output). This also keeps the
		// never-throw degrade-to-[] invariant local to git: an unknown dir stays
		// a segment here and is DROPPED later by the resolver (SCENARIO-005),
		// never emitted as a raw `-p` name.
		return dedupePreservingOrder(pkgs);
	} catch {
		return [];
	}
}

/**
 * The three cargo subcommands the build gate scopes. Constrained to a literal
 * union so a typo at a call site is a compile error, not a silent wrong argv.
 */
type CargoSubcommand = "build" | "test" | "clippy";

/**
 * Build a scoped cargo argv for a subcommand + package list + trailing extras.
 *
 * Shared core of the AC-02 argv family. Emits
 * `["cargo", subcommand, ...packages.flatMap(p => ["-p", p]), ...(extraArgs ?? [])]`
 * — one `-p` flag per package, in first-seen input order, followed verbatim by
 * the trailing extra args. An empty package set yields a byte-identical
 * workspace-wide argv (no `-p` flags at all) because `flatMap` over `[]` is a
 * no-op — the SCENARIO-005 invariant. `extraArgs` defaults to `undefined`
 * (omitted entirely), and an explicit `[]` is treated identically to
 * `undefined` (both append nothing). Package names are emitted as discrete
 * argv elements so they never pass through a shell (no `shell:true` is ever
 * used) — see SCENARIO-014. Each call returns a freshly-allocated array.
 *
 * Pure & side-effect-free: no git, no spawn, no filesystem, no env — fully
 * unit-testable. See SCENARIO-004 (non-empty) / SCENARIO-005 (empty).
 *
 * @param subcommand One of `build` | `test` | `clippy`.
 * @param packages Resolved (de-duplicated) package names, in run order.
 * @param extraArgs Optional trailing argv to append verbatim (e.g. `--quiet`).
 * @returns The scoped cargo argv (fresh array each call).
 */
export function scopedCargoArgs(
	subcommand: CargoSubcommand,
	packages: string[],
	extraArgs?: string[],
): string[] {
	return [
		"cargo",
		subcommand,
		...packages.flatMap((p) => ["-p", p]),
		...(extraArgs ?? []),
	];
}

/**
 * Build the scoped `cargo build` argv for a list of packages — AC-02.
 *
 * Thin wrapper over {@link scopedCargoArgs}: delegates to
 * `scopedCargoArgs("build", packages, ["--quiet"])`. Non-empty →
 * `["cargo","build", ...packages.flatMap(p => ["-p", p]), "--quiet"]`; empty →
 * `["cargo","build","--quiet"]` (byte-identical to the unscoped workspace
 * argv). See SCENARIO-004/005.
 *
 * @param packages Resolved (de-duplicated) package names.
 * @returns The cargo build argv, scoped or unscoped.
 */
export function scopedCargoBuildArgs(packages: string[]): string[] {
	return scopedCargoArgs("build", packages, ["--quiet"]);
}

/**
 * Build the scoped `cargo test` argv for a list of packages — AC-02.
 *
 * Thin wrapper over {@link scopedCargoArgs}: delegates to
 * `scopedCargoArgs("test", packages, ["--quiet"])` (byte-identical to the
 * pre-refactor hand-rolled implementation, so `verify.ts` /
 * `implementation.ts` callers and existing tests are unchanged). Non-empty →
 * `["cargo","test", ...packages.flatMap(p => ["-p", p]), "--quiet"]` (one `-p`
 * flag per package, `--quiet` retained). Empty → `["cargo","test","--quiet"]`
 * (byte-identical to the unscoped workspace argv). Package names are emitted as
 * discrete argv elements so they never pass through a shell (no `shell:true` is
 * ever used) — see SCENARIO-014.
 *
 * @param packages Resolved (de-duplicated) package names.
 * @returns The cargo test argv, scoped or unscoped.
 */
export function scopedCargoTestArgs(packages: string[]): string[] {
	return scopedCargoArgs("test", packages, ["--quiet"]);
}

/**
 * Build the scoped `cargo clippy` argv for a list of packages — AC-02.
 *
 * Thin wrapper over {@link scopedCargoArgs}: delegates to
 * `scopedCargoArgs("clippy", packages, ["--all-targets", "--quiet"])`. Non-empty
 * → `["cargo","clippy", ...packages.flatMap(p => ["-p", p]), "--all-targets",
 * "--quiet"]`; empty → `["cargo","clippy","--all-targets","--quiet"]`
 * (byte-identical to the unscoped workspace argv, with `--all-targets` retained
 * before `--quiet`). See SCENARIO-004/005.
 *
 * @param packages Resolved (de-duplicated) package names.
 * @returns The cargo clippy argv, scoped or unscoped.
 */
export function scopedCargoClippyArgs(packages: string[]): string[] {
	return scopedCargoArgs("clippy", packages, ["--all-targets", "--quiet"]);
}

/**
 * Partition gate failure blocks into in-scope vs out-of-scope relative to the
 * resolved scoped crate set — AC-04.
 *
 * Contract: for each error block, extract the referenced crate names via:
 *   (a) `--> crates/<pkg>/…` (and any `crates/<pkg>/`) path markers, using
 *       regex `/crates\/([^/]+)\//`; and
 *   (b) cargo test-failure `-p <pkg>` listing markers, using regex
 *       `/(?:^|\s)-p\s+(\S+)/`.
 *
 * An error is OUT-OF-SCOPE iff it references ≥1 crate AND EVERY referenced
 * crate is NOT in `scopedSet`. Otherwise it is IN-SCOPE: no parseable crate
 * marker found (conservative — could be the genuine failure), ≥1 referenced
 * crate IS in scope (mixed), or `scopedSet` is empty (no scoping active).
 * Ambiguity NEVER grants a false green. See SCENARIO-009/010/011/021/024/028.
 *
 * Pure & side-effect-free (no spawn, no fs, no env). NEVER throws — the entire
 * body is try/caught and, on ANY error (bad input, regex explosion), treats
 * ALL blocks as in-scope (returns `outOfScopeErrors: []`).
 *
 * @param errors The raw error blocks collected by the gate exec loop (cargo
 *   stderr tails, failure listings, or the harness label-prefixed strings).
 * @param scopedSet The resolved (de-duplicated) in-scope crate set.
 * @returns The partition into `inScopeErrors` and `outOfScopeErrors`.
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
function classificationScope(cwd: string, realNames: string[]): string[] {
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

export function classifyOutOfScopeErrors(
	errors: string[],
	scopedSet: string[],
): { inScopeErrors: string[]; outOfScopeErrors: string[] } {
	try {
		const scope = new Set<string>(scopedSet);
		// Empty scoped set ⇒ no scoping active ⇒ treat EVERY error as in-scope
		// (SCENARIO-011 / SCENARIO-016 parity: never grants a false green).
		if (scope.size === 0) {
			const safe = Array.isArray(errors) ? errors : [];
			return {
				inScopeErrors: safe.map((e) =>
					typeof e === "string" ? e : String(e ?? ""),
				),
				outOfScopeErrors: [],
			};
		}
		const inScopeErrors: string[] = [];
		const outOfScopeErrors: string[] = [];
		// Both regexes consume ≥1 captured char per match, so `exec` always
		// advances `lastIndex` — no zero-length-match infinite loop possible.
		// `pathRe` extracts `crates/<pkg>/` source-path markers from the WHOLE
		// block (command labels never contain `crates/` paths).
		const pathRe = /crates\/([^/]+)\//g;
		// `flagRe` extracts `-p <pkg>` rerun markers. The negative lookbehind
		// `(?<!\w)` lets `-p` follow a quote (cargo's `rerun pass '-p pkg …'`),
		// a space, or string start, while rejecting `-p` glued to a word char
		// (`some-pkg`). It is run ONLY on the post-label region (see below) so
		// the command label's own `-p <scoped-pkg>` is never miscounted as a
		// crate reference (SCENARIO-028 label-exclusion contract).
		const flagRe = /(?<!\w)-p\s+(\S+)/g;
		for (const err of errors) {
			const block = typeof err === "string" ? err : String(err ?? "");
			// The gate assembles errors as `<label> FAILED (<reason>):\n<tail>`.
			// The label carries our OWN scoped `-p <pkg>` (always in scope by
			// construction); scanning it would falsely mark every failure
			// in-scope. Scan `-p` ONLY in the post-` FAILED (` tail. Path
			// markers are scanned on the whole block (labels lack `crates/`).
			const failedIdx = block.indexOf(" FAILED (");
			const flagRegion = failedIdx === -1 ? block : block.slice(failedIdx);
			const referenced = new Set<string>();
			let m: RegExpExecArray | null;
			pathRe.lastIndex = 0;
			while ((m = pathRe.exec(block)) !== null) referenced.add(m[1]);
			flagRe.lastIndex = 0;
			while ((m = flagRe.exec(flagRegion)) !== null) referenced.add(m[1]);
			if (referenced.size === 0) {
				// No parseable crate marker → conservative IN-SCOPE.
				inScopeErrors.push(block);
				continue;
			}
			// OUT-OF-SCOPE iff ≥1 crate referenced AND ALL referenced are NOT in
			// scope (anyInScope ⇒ conservative IN-SCOPE).
			let anyInScope = false;
			for (const pkg of referenced) {
				if (scope.has(pkg)) {
					anyInScope = true;
					break;
				}
			}
			if (anyInScope) {
				inScopeErrors.push(block);
			} else {
				outOfScopeErrors.push(block);
			}
		}
		return { inScopeErrors, outOfScopeErrors };
	} catch {
		// NEVER throw — treat ALL blocks as in-scope on any failure.
		const safe = Array.isArray(errors) ? errors : [];
		return {
			inScopeErrors: safe.map((e) => (typeof e === "string" ? e : String(e ?? ""))),
			outOfScopeErrors: [],
		};
	}
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
	const { outOfScopeErrors } = classifyOutOfScopeErrors(errors, classScope);
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
