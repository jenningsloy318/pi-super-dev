/**
 * Git/cargo scoping + in/out-of-scope classification (split from build-runner.ts).
 */

import { spawnSync } from "node:child_process";
import { dedupePreservingOrder, CRATE_SEGMENT_RE } from "./detect.ts";

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

/**
 * Strip a trailing vitest `:line:col` (or bare `:line`) location suffix from a
 * test-file path token so it matches a RAW git diff/ls-files path. vitest's
 * `❯ <path>:<line>:<col>` pointer always carries a location; jest's
 * `FAIL <path>` summary never does. Applying this to BOTH forms is a safe no-op
 * when no `:digit` suffix is present. Pure; never throws.
 */
function stripLineCol(p: string): string {
	return p.replace(/:\d+(?::\d+)?$/, "");
}

/**
 * Module-level regexes for {@link parseFailingNpmTestFiles}. Both are GLOBAL
 * so a single `exec` loop finds every marker; {@link parseFailingNpmTestFiles}
 * resets `lastIndex = 0` before each use (the constants are reused across
 * calls). Each consumes ≥1 captured char per match, so `exec` always advances
 * `lastIndex` — no zero-length-match infinite loop.
 *
 *   - `VITEST_FAIL_PTR_RE` matches vitest's `❯ <path>:line:col` assertion
 *     pointer. The path token `[\s\s❯]+` excludes whitespace AND the `❯` marker
 *     itself, so a bare `❯`/`❯\n❯` sequence with NO path yields no capture
 *     (adversarial robustness — never invents a path out of marker noise).
 *   - `JEST_FAIL_LINE_RE` matches jest's line-start `FAIL <path>` summary
 *     (multiline + global: anchored to the start of ANY line). A mid-sentence
 *     `FAIL` is correctly ignored (the spec anchors jest at `^FAIL`).
 */
const VITEST_FAIL_PTR_RE = /❯\s*([^\s❯]+)/g;

const JEST_FAIL_LINE_RE = /^FAIL\s+(\S+)/gm;

/**
 * Parse the failing npm-family (vitest / jest) test files out of combined
 * runner output. Phase 5 / Gap 4 — the npm counterpart of the cargo
 * `crates/<pkg>/` marker scan performed by {@link classifyOutOfScopeErrors}.
 *
 * Matches:
 *   - vitest `❯\s*<path>` assertion pointers (the authoritative failing-file
 *     signal), STRIPPING a trailing `:line:col` / `:line` location via
 *     {@link stripLineCol} so the result matches a RAW git path; AND
 *   - jest `^FAIL\s+<path>` line-start summary markers.
 *
 * Returns the de-duplicated RAW file paths in first-seen order (vitest markers
 * first, then jest-only markers), or `[]` when no marker is found.
 *
 * NEVER throws — the entire body is try/caught and degrades to `[]` on any
 * input (non-string, null/undefined, adversarial content, regex explosion). An
 * empty `[]` return is the conservative in-scope fallback the npm classifier
 * ({@link classifyOutOfScopeNpmErrors}) relies on: unparseable output grants
 * NO false green.
 *
 * Pure & side-effect-free (no spawn, no fs, no env).
 *
 * @param combinedOutput The combined stdout/stderr of a failed npm-family test
 *   step (vitest/jest) — typically the assembled error block(s).
 * @returns De-duplicated RAW failing test file paths (first-seen order), or [].
 */
export function parseFailingNpmTestFiles(combinedOutput: string): string[] {
	try {
		if (typeof combinedOutput !== "string" || combinedOutput.length === 0) {
			return [];
		}
		const seen = new Set<string>();
		const out: string[] = [];
		const add = (raw: string) => {
			const p = stripLineCol(raw);
			if (p && !seen.has(p)) {
				seen.add(p);
				out.push(p);
			}
		};
		// vitest `❯ <path>:line:col` pointers first (authoritative signal).
		VITEST_FAIL_PTR_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = VITEST_FAIL_PTR_RE.exec(combinedOutput)) !== null) {
			if (m[1]) add(m[1]);
		}
		// jest `^FAIL <path>` line-start summaries (dedup against vitest hits).
		JEST_FAIL_LINE_RE.lastIndex = 0;
		while ((m = JEST_FAIL_LINE_RE.exec(combinedOutput)) !== null) {
			if (m[1]) add(m[1]);
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Classify npm-family (vitest/jest) error blocks into out-of-scope failures.
 *
 * Phase 5 / Gap 4 — the npm counterpart of {@link classifyOutOfScopeErrors}
 * (cargo). Whereas the cargo classifier partitions blocks by `crates/<pkg>/` +
 * `-p <pkg>` markers against a resolved CRATE scope, this classifier partitions
 * by failing-test-FILE markers (parsed via {@link parseFailingNpmTestFiles})
 * against the RAW touched-file set ({@link touchedFilePaths}): a failing test
 * file is OUT-of-scope iff it is ABSENT from the touched set.
 *
 * Mirrors the cargo contract EXACTLY (AC-04):
 *   - unparseable output (no failing-file marker) ⇒ conservative IN-SCOPE
 *     (returns `[]` — grants NO false green);
 *   - EMPTY touched set (git error / no diff) ⇒ conservative IN-SCOPE (`[]`);
 *   - a block referencing ≥1 failing file ALL absent from touched ⇒ OUT-of-scope;
 *   - any block whose failing files intersect touched ⇒ conservative IN-SCOPE
 *     (mixed failures never escape to out-of-scope).
 *
 * Side-effecting (spawns git via {@link touchedFilePaths}) like the cargo
 * path's {@link classificationScope}, but pure wrt argv construction. NEVER
 * throws — the entire body is try/caught and degrades to `[]`.
 *
 * @param errors The raw error blocks collected by the gate exec loop.
 * @param cwd Absolute worktree path (passed to {@link touchedFilePaths}).
 * @returns The out-of-scope error blocks (subset of `errors`), or [].
 */
export function classifyOutOfScopeNpmErrors(errors: string[], cwd: string): string[] {
	try {
		const safeErrors = Array.isArray(errors) ? errors : [];
		// Short-circuit: parse the COMBINED output once. If NO failing-file marker
		// is found anywhere, there is nothing to classify AND no reason to spawn
		// git — degrade conservatively to in-scope (grants no false green). This
		// also skips the git spawn when the gate PASSED (errors=[]).
		const combined = safeErrors
			.map((e) => (typeof e === "string" ? e : String(e ?? "")))
			.join("\n");
		const failingFiles = parseFailingNpmTestFiles(combined);
		if (failingFiles.length === 0) return [];
		// Empty touched set (git error / non-git dir / no diff) ⇒ cannot PROVE any
		// failure is out-of-scope ⇒ conservative IN-SCOPE.
		const touched = touchedFilePaths(cwd);
		if (touched.length === 0) return [];
		const touchedSet = new Set(touched);
		// Per-block classification mirroring {@link classifyOutOfScopeErrors}: a
		// block is OUT-of-scope iff it references ≥1 failing file AND ALL of its
		// referenced failing files are ABSENT from the touched set. Any in-scope
		// (touched) failing file ⇒ the whole block stays in-scope (no false green).
		const outOfScopeErrors: string[] = [];
		for (const err of safeErrors) {
			const block = typeof err === "string" ? err : String(err ?? "");
			const blockFiles = parseFailingNpmTestFiles(block);
			if (blockFiles.length === 0) continue; // no marker ⇒ in-scope (skip)
			let anyInScope = false;
			for (const f of blockFiles) {
				if (touchedSet.has(f)) {
					anyInScope = true;
					break;
				}
			}
			if (!anyInScope) outOfScopeErrors.push(block);
		}
		return outOfScopeErrors;
	} catch {
		// NEVER throw — degrade to in-scope on any failure.
		return [];
	}
}
