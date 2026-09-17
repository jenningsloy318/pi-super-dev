import {TestListPlan, isInsideOrSame, projectCommandsForDir, projectDirsFromEvidence, relDir, resolveInsideCwd, resolveTimeoutMs} from "./build-gate.ts";
import {RedCheckOptions, RedStatus, classifyFromEvidence, cleanupConventionPlans, collectStructuredEvidence, combineRedStatuses, emitRedDiagnostic, emitRedPlans, packageScripts, readPackageJson, tailText} from "./red-check.ts";
/**
 * Deterministic gates: runBuildGate/runRedCheck/runDeliverableCheck/computeChangeGate + types (split from build-runner.ts).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { dedupePreservingOrder, detectProjectCommands, resolveCargoPackageNames, validatePackageNames, resolveIntegrationStems, classificationScope, type ProjectCommands } from "../detect.ts";
import { parseTestPackages, detectTouchedCargoPackages, touchedFilePaths, scopedCargoBuildArgs, scopedCargoTestArgs, scopedCargoClippyArgs, classifyOutOfScopeErrors, classifyOutOfScopeNpmErrors, parseFailingNpmTestFiles, parseFailingPythonTestFiles, detectFailureBlockLanguage, parseFailingGoPackages, resolveGoModuleForPackages } from "../scope.ts";
import { verifyUntouchedFailuresAgainstBaseline, type BaselineCheckResult, type BaselineVerifyInput } from "../baseline.ts";
// v0.3.30 Layer A/C: universal structured classification + agent-proposed runners.
import { classifyFromStructuredCounts, harvestJUnitXml, parseTapCounts, sumHarvestedXml, parseGoTestJson, parseCountsPattern, type TestResultCounts } from "../result-parse.ts";
// v0.3.31: the single per-ecosystem seam — convention DATA, no engine knowledge.
import { conventionPlansFor, detectPmForDir, hasPackageTool, pmExec, type ConventionPlan, type ResultChannel } from "../conventions.ts";
import { dynamicRedCheckPlans, type TestRunnerSpec } from "../runner-discovery.ts";
export function runRedCheck(cwd: string, testTargets: string[], opts?: RedCheckOptions): RedStatus {
	const plans: ConventionPlan[] = [];
	try {
		// No targets → nothing to verify RED against (no spawn).
		if (!Array.isArray(testTargets) || testTargets.length === 0) return "unknown";
		if (opts?.signal?.aborted) return "unknown";
		const timeoutMs = resolveTimeoutMs(opts?.timeoutMs);
		const targets = testTargets.filter((t) => typeof t === "string" && t.trim().length > 0);
		if (targets.length === 0) return "unknown";

		// Level 0 (v0.3.56 F1): a VALIDATED agent-proposed runner takes precedence
		// over conventions — the original contract ("a validated runner BYPASSES
		// conventions entirely") was inverted: conventions plans were pushed
		// unconditionally FIRST, so on npm-PM vitest projects the conventions row
		// (whose --reporter=tap npm consumed as config) shadowed the guarded
		// cached runner and every RED honestly degraded to unknown. Conventions
		// remain the fallback when no validated runner exists (fresh projects,
		// discovery declined, unparseable proposal).
		if (opts?.runner) {
			plans.push(...dynamicRedCheckPlans(cwd, targets, opts.runner).map((p) => ({ ...p, conventionId: "dynamic", channel: { format: "auto" } as ResultChannel })));
		}
		if (plans.length === 0) {
			plans.push(...conventionPlansFor(cwd, targets));
		}
		if (plans.length === 0) return "unknown";
		emitRedPlans(opts, plans);

		const statuses: RedStatus[] = [];
		for (const plan of plans) {
			if (opts?.signal?.aborted) return "unknown";
			const { argv } = plan;
			try {
				const startedMs = Date.now();
				const r = spawnSync(argv[0], argv.slice(1), { cwd: plan.cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
				const combined = "\n" + (r.stdout ?? "") + "\n" + (r.stderr ?? "");
				// review-2 F4: row-declared exit codes that mean "tests could not
				// even run" (pytest 2/4) classify broken BEFORE counts — a
				// collection error must never be confirmed as a valid RED.
				const brokenByExit = typeof r.status === "number" && r.status !== 0 && (plan.brokenExitCodes ?? []).includes(r.status);
				const status = r.error ? "unknown" : brokenByExit ? "broken" : classifyFromEvidence(r.status === 0, collectStructuredEvidence(plan, startedMs, combined));
				emitRedDiagnostic(opts, {
					plan: { cwd: plan.cwd, argv: [...argv] },
					language: plan.conventionId,
					status,
					exitCode: typeof r.status === "number" ? r.status : null,
					signal: typeof r.signal === "string" ? r.signal : null,
					...(r.error ? { error: r.error.message } : {}),
					outputTail: tailText(combined),
				});
				// NEVER throw on a spawn error / ENOENT — degrade to unknown, but do
				// NOT abort the remaining plans (v0.3.56 review P2: a first-plan
				// ENOENT previously returned before the later plans could classify;
				// combineRedStatuses keeps red-over-unknown precedence honest).
				if (r.error) { statuses.push("unknown"); continue; } // bound: plan loop is finite per runRedCheck call
				statuses.push(status);
			} catch (err) {
				emitRedDiagnostic(opts, {
					plan: { cwd: plan.cwd, argv: [...argv] },
					language: plan.conventionId,
					status: "unknown",
					exitCode: null,
					signal: null,
					error: err instanceof Error ? err.message : String(err),
					outputTail: "",
				});
				statuses.push("unknown");
				continue; // bound: plan loop is finite per runRedCheck call
			}
		}
		return combineRedStatuses(statuses);
	} catch {
		return "unknown";
	} finally {
		cleanupConventionPlans(plans);
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
	 * Skip the {@link requireTests
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
	/** Sweep-3 G6: the run's real base ref for touched-file evidence (default 'main'). */
	defaultBranch?: string;
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

/** Regex-INTENT marker: syntax that can ONLY mean a regular expression — a
 *  backslash escape (`\.`, `\d`), alternation `|`, start/end anchors, the
 *  quantifier symbols `*`/`+`/`?`, `{…}` braces, or a CLASS-LIKE bracket group
 *  (content containing `-`, `^`, or `\`; bare single-token brackets like the
 *  literal indexing `arr[0]`/`list[i]` are NOT treated as classes). Bare
 *  grouping parens and bare dots are deliberately ABSENT: they are ubiquitous
 *  in literal code text (`foo(bar)`, `obj.prop`) and are the false-positive
 *  source (F-14). */
const REGEX_INTENT_RE = /\\[^\\]|\||^\^|\$$|[*+?]|\{|\[[^\]]*[-^\\][^\]]*\]/;

/**
 * Tolerant pattern match (SCENARIO-006). Used for requireContains,
 * requireNotContains, and requireTests. Matching order is an ENUMERATED
 * grammar (F-14, v0.3.86 — literal-first; the old regex-first order compiled
 * literal code text like `foo(bar)` into a regex that false-matched `foobar`):
 *
 *   | stage | pattern form                        | semantics                     |
 *   |---|---|---|
 *   | 1 | ANY                                 | exact substring containment of the RAW pattern (metacharacters inert) |
 *   | 2 | `(?i)`-prefixed only               | case-insensitive substring containment of the stripped source      |
 *   | 3 | stripped source matches REGEX_INTENT_RE | compile + `test` (with `i` for `(?i)`); only when stages 1–2 failed |
 *
 * Consequences: a pattern that IS a literal substring can never false-positive
 * via regex semantics (stage 1 wins); `foo(bar)` matches only literally (no
 * regex-intent marker); `connect.*db` / `toBe\(13\)` keep regex semantics;
 * `(?i)…` keeps its meaning in both the containment and regex stages. Never
 * throws (an invalid stage-3 regex simply does not match).
 */
export function tolerantMatch(pattern: string, text: string): boolean {
	const tryPattern = (p: string): boolean => {
		// Support common PCRE/Go-style inline case-insensitive prefix generated by
		// agents/specs (`(?i)permission`) by translating it to JS RegExp flags.
		let source = p;
		let flags = "";
		if (source.startsWith("(?i)")) {
			source = source.slice(4);
			flags = "i";
		}
		// Stage 1 — EXACT literal containment of the RAW pattern.
		if (text.includes(p)) return true;
		// Stage 2 — case-insensitive containment of the (?i)-stripped source.
		if (flags === "i" && text.toLowerCase().includes(source.toLowerCase())) return true;
		// Stage 3 — regex ONLY for regex-INTENT patterns (see REGEX_INTENT_RE);
		// literal-looking text (bare parens/dots/brackets) never reaches a regex.
		if (!REGEX_INTENT_RE.test(source)) return false;
		let re: RegExp | null = null;
		try { re = new RegExp(source, flags); } catch { re = null; }
		return re !== null && re.test(text);
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
		// Sweep-3 G12: ANCHORED to a standalone one-letter alias `h` (plain or
		// regex-escaped) — pre-fix ANY pattern containing the substring 'h.'
		// (auth\.x, path\.compile) was silently widened.
		const relaxed = p
			.replace(/(?<![A-Za-z0-9_$\\])h(?=\\?\.)/g, String.raw`[A-Za-z_$][\w$]*`)
			.replace(/(?<![A-Za-z0-9_$])h\./g, String.raw`[A-Za-z_$][\w$]*\.`);
		if (relaxed !== p) variants.push(relaxed);
	}
	return variants.some((p) => tryPattern(p));
}

/** For code deliverables, match against comment-stripped text so a placeholder
 * comment that merely mentions `createRootHandlers(...)` cannot satisfy a real
 * wiring assertion. Docs and other non-code files keep their original text. */
function deliverableMatchText(file: string, text: string): string {
	return CODE_EXT.test(file) ? stripCommentsAndBlanks(text, file) : text;
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
function collectTestFileContents(cwd: string, deliverables: DeliverableContract, stopWhen?: (text: string) => boolean, baseRef?: string): { text: string; files: string[] } {
	const root = resolve(cwd);
	const evidence = [...deliverableEvidencePaths(deliverables), ...touchedFilePaths(cwd, baseRef)]; // sweep-3 G6
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

function testListPlansForDeliverables(cwd: string, deliverables: DeliverableContract, baseRef?: string): TestListPlan[] {
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
	const evidence = [...deliverableEvidencePaths(deliverables), ...touchedFilePaths(cwd, baseRef)]; // sweep-3 G6
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
		const r = spawnSync(plan.argv[0], plan.argv.slice(1), { cwd: plan.cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); // sweep-3 G5
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
function hashCommentLanguage(file: string): boolean {
	const lower = file.toLowerCase();
	if (/(^|\/)(makefile|dockerfile)(\.\w+)?$/.test(lower)) return true;
	// Accept a full path OR a bare extension ("py") — tests and callers pass both.
	const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
	return HASH_COMMENT_EXTS.has(ext);
}
/** Sweep-3 G13: `#`-lines are stripped ONLY for #comment languages. Pre-fix
 *  the blanket strip made Rust `#[derive]`, C `#include`, and JS `#private`
 *  invisible to deliverable matching. */
const HASH_COMMENT_EXTS = new Set(["py", "pyw", "rb", "sh", "bash", "zsh", "yaml", "yml", "toml", "env", "conf", "ini", "cfg", "r", "pl", "tf", "tfvars"]);

/** v0.3.62 string-aware comment stripper (single pass, no whole-source regex).
 *  The previous 4-regex chain ran the block-comment regex FIRST and was not
 *  string-literal aware, so a slash-star sequence inside a `//` line comment —
 *  e.g. the vitest include glob tests/＊＊/＊.test.ts (fullwidth stars here — the
 *  real glob contains a star-slash sequence that would end this comment) — opened a fake block comment that
 *  swallowed REAL code (run 2026-09-02T10-18-31-007Z: the string literals at
 *  prosperity-contract.test.ts:593-594 vanished, the deliverable gate reported
 *  "matched only inside comments", and two attempts burned re-fixing an
 *  already-correct file). The scanner recognizes string literals (single,
 *  double, backtick with dollar-brace interpolation scanned as code) so
 *  comment markers inside strings are inert. Behavior notes vs the old chain:
 *  - FULL-line and INLINE `//`/`#` comments are both removed (the old chain
 *    kept inline comment text, so a tag placed only in an inline comment
 *    falsely matched — the RC9 message already told agents to use string
 *    literals/constants/test titles; behavior now matches that contract).
 *  - Known limitations (fail direction = over-strip ⇒ honest actionable
 *    error, never a false green): regex literals containing a slash-star or
 *    double-slash sequence (e.g. a character class with a slash-star), and
 *    unquoted shell brace-hash expansions under # languages.
 *  Template literals are scanned as strings; their dollar-brace interpolations
 *  are scanned as code (nested braces + nested templates via a mode stack).
 */
function stripCodeComments(src: string, stripHash: boolean): string {
	type Frame = { kind: "code"; braceDepth: number } | { kind: "tpl" };
	const out: string[] = [];
	const stack: Frame[] = [{ kind: "code", braceDepth: 0 }];
	let i = 0;
	const n = src.length;
	while (i < n) {
		const top = stack[stack.length - 1]!;
		if (top.kind === "tpl") {
			const ch = src[i]!;
			const next = i + 1 < n ? src[i + 1]! : "";
			if (ch === "\\") { out.push(ch, next); i += 2; continue; }
			if (ch === "`") { out.push(ch); stack.pop(); i += 1; continue; }
			if (ch === "$" && next === "{") { out.push("${"); stack.push({ kind: "code", braceDepth: 0 }); i += 2; continue; }
			out.push(ch); i += 1; continue;
		}
		const ch = src[i]!;
		const next = i + 1 < n ? src[i + 1]! : "";
		if (ch === "/" && next === "/") { i += 2; while (i < n && src[i] !== "\n") i += 1; continue; }
		if (ch === "/" && next === "*") { const end = src.indexOf("*/", i + 2); i = end === -1 ? n : end + 2; continue; }
		if (stripHash && ch === "#") { i += 1; while (i < n && src[i] !== "\n") i += 1; continue; }
		if (ch === "'" || ch === '"') {
			const quote = ch;
			out.push(ch); i += 1;
			while (i < n) {
				const c = src[i]!;
				if (c === "\\") { out.push(c, src[i + 1] ?? ""); i += 2; continue; }
				out.push(c); i += 1;
				if (c === quote) break;
			}
			continue;
		}
		if (ch === "`") { out.push(ch); stack.push({ kind: "tpl" }); i += 1; continue; }
		if (ch === "{") { out.push(ch); top.braceDepth += 1; i += 1; continue; }
		if (ch === "}" && top.braceDepth === 0 && stack.length > 1) { stack.pop(); out.push(ch); i += 1; continue; }
		if (ch === "}" && top.braceDepth > 0) { out.push(ch); top.braceDepth -= 1; i += 1; continue; }
		out.push(ch); i += 1;
	}
	return out.join("");
}

export function stripCommentsAndBlanks(src: string, file = ""): string {
	const stripHash = file === "" ? true : hashCommentLanguage(file);
	return stripCodeComments(src, stripHash).replace(/^[ \t]*$/gm, ""); // blank lines
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
				if (!pattern.test(stripCommentsAndBlanks(src, rel))) hollow.push(rel);
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
					// RC9 (run 15-07): when the RAW text matches but the comment-stripped
					// text does not, the honest, actionable error names the cause — Go test
					// names cannot contain '-', so SCENARIO tags are often comments.
					if (CODE_EXT.test(file) && tolerantMatch(pattern, rd.text)) {
						missing.push(`missing pattern ${pattern} in ${file} (matched only inside comments — comments are stripped before matching; put the tag in a string literal, constant, or test title)`);
					} else {
						missing.push(`missing pattern ${pattern} in ${file}`);
					}
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
			const plans = testListPlansForDeliverables(cwd, deliverables, opts?.defaultBranch);
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
			const haystack = collectTestFileContents(cwd, deliverables, (text) => tagRes.every((re) => re.test(text)), opts?.defaultBranch);
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
 * safe to run UNCONDITIONALLY (not just on resume). requireTests clauses are
 * verified at EXISTENCE grade — the declared name must appear in a candidate
 * test FILE's content (per-line tolerantMatch, the same line-entry discipline
 * as runDeliverableCheck's list matching); the full test-list spawn and test
 * EXECUTION authority stays with runDeliverableCheck (F-04, v0.3.86) — a name
 * satisfiable only by a runner-generated list (test.each) fails here, so the
 * caller keeps working (fail-closed). Returns false when no clause kind is
 * declared at all (can't determine no-op without targets). NEVER throws.
 */
export function deliverablesAlreadyMet(cwd: string, deliverables: DeliverableContract, baseRef?: string): boolean {
	try {
		// F8 (v0.3.66, incident 2026-09-04T14-45-04-784Z phase 5): the
		// already-satisfied decision must evaluate EVERY clause kind the contract
		// grammar declares — requireFiles, requireContains, requireNotContains,
		// requireScenarios — not only requireFiles. The old
		// `requireFiles.length === 0 → false` guard predated the contains/scenarios
		// clauses, so contains-only contracts were permanently un-satisfiable HERE
		// while sibling runDeliverableCheck passed them — two grammars for one
		// contract (class D). Fail-closed is preserved for the one shape that
		// genuinely cannot be judged: a contract with NO checkable clause at all
		// (empty contracts must never count as "already satisfied").
		const files = deliverables.requireFiles;
		const contains = deliverables.requireContains ?? [];
		const notContains = deliverables.requireNotContains ?? [];
		const scenarios = normalizeScenarioTags(deliverables.requireScenarios);
		// F-04 (v0.3.86): requireTests joins the checkable-clause set — pre-fix a
		// contract carrying only requireTests had NO checkable clause here and was
		// permanently un-satisfiable (two grammars for one contract, the F8 class).
		const tests = (Array.isArray(deliverables.requireTests) ? deliverables.requireTests : []).filter((t): t is string => typeof t === "string" && t.length > 0);
		const hasCheckableClause = (Array.isArray(files) && files.length > 0)
			|| contains.length > 0
			|| notContains.length > 0
			|| scenarios.length > 0
			|| tests.length > 0;
		if (!hasCheckableClause) return false;
		if (Array.isArray(files)) {
			for (const p of files) {
				const abs = resolveInsideCwd(cwd, p);
				if (abs === null || !existsSync(abs)) return false;
			}
		}
		for (const entry of contains) {
			const rd = readForDeliverable(cwd, entry.file);
			if (!rd.ok || !tolerantMatch(entry.pattern, deliverableMatchText(entry.file, rd.text))) return false;
		}
		for (const entry of notContains) {
			const rd = readForDeliverable(cwd, entry.file);
			if (rd.ok && tolerantMatch(entry.pattern, deliverableMatchText(entry.file, rd.text))) return false;
		}
		// requireScenarios: every declared SCENARIO-NNN tag must appear in a
		// candidate test file (same stable-tag match as runDeliverableCheck).
		if (scenarios.length > 0) {
			const tagRes = scenarios.map((tag) => new RegExp(`\\b${tag.replace(/[-]/g, "\\-")}\\b`, "i"));
			const { text } = collectTestFileContents(cwd, deliverables, (t) => tagRes.every((re) => re.test(t)), baseRef); // sweep-3 CR-R2-7
			if (!tagRes.every((re) => re.test(text))) return false;
		}
		// requireTests (F-04, v0.3.86): every declared test NAME must appear on a
		// LINE of the concatenated candidate test-file contents (tolerantMatch per
		// line — the same line-entry discipline runDeliverableCheck applies to the
		// runner's list output, so a hit inside a path/comment line can't satisfy
		// a name). Existence grade only — see the function docstring.
		if (tests.length > 0) {
			const { text } = collectTestFileContents(cwd, deliverables, undefined, baseRef);
			const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
			if (!tests.every((name) => lines.some((line) => tolerantMatch(name, line)))) return false;
		}
		return true;
	} catch {
		return false;
	}
}
