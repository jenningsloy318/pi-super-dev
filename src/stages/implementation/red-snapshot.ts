import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInternalRuntimeClaim } from "../../tracking.ts";
import { isSubstrateArtifact } from "../../test-artifacts.ts";
import { isHarnessBookkeepingPath } from "../../tracking.ts";

/** Wave 5 increment 1: the RED TEST-FILE SNAPSHOT MACHINERY — moved verbatim
 *  from red-evidence.ts: snapshotFiles, the hollow-assertion guard
 *  (ASSERTION_RE + TEST_FILE_NAME_RE + PYTEST_SUPPORT_BASENAME_RE conftest
 *  exemption, v0.3.17), the v0.3.85 F5 assertion-surface ratchet (enumerated
 *  P2 grammar, before/after rows, weakenedAssertionSurfaces, headFileContent
 *  git-show pre-edit reads, preexistingTestSurfaceRows filter),
 *  changedSinceSnapshot, restoreRedTestFiles, and RED_WEAKENING_SOURCE.
 *  One reason to change: RED test-file content snapshot/ratchet/restore. */

export function normalizeSlash(path: string): string {
	return String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function snapshotFiles(cwd: string, paths: string[]): Map<string, string | null> {
	const out = new Map<string, string | null>();
	for (const path of paths) {
		try { out.set(path, readFileSync(join(cwd, path), "utf8")); }
		catch { out.set(path, null); }
	}
	return out;
}

/** Recognizable assertion calls across the pipeline's supported stacks. A RED
 *  test file that contains ZERO of these is HOLLOW — it may fail/pass for reasons
 *  unrelated to the behavior under test (e.g. only a bare `it("...", () => {})`),
 *  so a later minimal implementation can make it "green" without proving anything.
 *  This is the cheap, deterministic Tier-1 guard (weak-but-present assertions are
 *  Tier 2's job). Comment-stripping is intentionally skipped — a false NEGATIVE
 *  (assertion in a comment) is safe here because it only avoids a reject. */
const ASSERTION_RE = /\b(?:expect|assert|assert_eq|assert_ne|assertEquals|assertTrue|assertFalse|should|require\.|assert\.|t\.Error|t\.Fatal|t\.Errorf|t\.Fatalf|XCTAssert)\b|\bassert!|\bassert_eq!|\bassert_ne!/;

/** A RED artifact that is an actual TEST file (by name) — vs a test-only SUPPORT
 *  artifact (a fixture/helper imported by a test). The hollow-assertion guard
 *  applies ONLY to test files: a support fixture legitimately has no assertion,
 *  so flagging it would falsely reject a valid RED set. */
const TEST_FILE_NAME_RE = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|__tests__\/)/i;

/** v0.3.17 (run 2026-08-26T02-36-42-419Z phase-02): pytest's RESERVED support
 *  filename. conftest.py is auto-loaded by pytest itself (fixtures, plugins,
 *  sys.path bootstrap) and legitimately contains no assertions — it is the
 *  canonical "fixture/helper imported by a test" the guard's doc comment
 *  already exempts in spirit. Matched on BASENAME at any depth because pytest
 *  collects it from every directory on the rootdir→test path (a package-root
 *  conftest is as legal as a tests/ one). Exempting it twice killed REAL RED
 *  sets in the incident (tries 3 and 5) whose only clean import fix lived in
 *  conftest.py. */
const PYTEST_SUPPORT_BASENAME_RE = /(^|\/)conftest\.py$/i;

/** Return the RED TEST files (from a content snapshot) that contain no
 *  recognizable assertion call. Non-test-named support artifacts are skipped
 *  (they may legitimately have no assertion). Files that couldn't be read (null)
 *  are skipped — absence of content is not evidence of a hollow test and must not
 *  block. Pure; never throws. */
export function assertionPresenceGaps(snapshot: Map<string, string | null>): string[] {
	const gaps: string[] = [];
	for (const [path, content] of snapshot) {
		if (content == null) continue;
		if (!TEST_FILE_NAME_RE.test(path)) continue; // support artifact, not a test
		if (PYTEST_SUPPORT_BASENAME_RE.test(path)) continue; // conftest.py — pytest support artifact (v0.3.17)
		if (!ASSERTION_RE.test(content)) gaps.push(path);
	}
	return gaps;
}

// ── v0.3.85 F5 (C3 fix; §9 F5, §14 ADR 10) — the RED-phase assertion ratchet ──

/** §13/§14 ADR 8: the F5 declared-handoff row tag — distinct from
 *  INHERITED_RED_SOURCE (the F2/F4 tag) and never overloading
 *  `classificationSource` (that is R2 routing provenance, a different concept). */
export const RED_WEAKENING_SOURCE = "red-weakening";

/** v0.3.85 F5 — the assertion-surface GRAMMAR (P2: enumerated, not
 *  one-form-at-a-time). A file's assertion surface is the number of matches of
 *  ONE canonical regex:
 *
 *    /\b(?:test|it)\s*\(|\bassert|\bexpect|\bSCENARIO\b/g
 *
 * covering the marker families the pipeline's stacks actually use:
 *   - `test(` / `it(` — JS/TS (jest/vitest/mocha/node:test), allowing optional
 *     whitespace before the paren (`it (`). Python declarations (`def
 *     test_x():`) carry NO declaration marker — the underscored name breaks
 *     `test\s*\(` — so a python file's surface rides its `assert` markers
 *     (documented). Skip-marked forms (`test.skip(`, `xit(`) do NOT match the
 *     declaration marker: converting `test(` → `test.skip(` LOWERS the surface
 *     (detected); deleting an already-skipped test leaves it unchanged
 *     (undetected — documented fail-open blind spot).
 *   - `assert` — Python `assert`, Rust `assert!`/`assert_eq!`, JUnit
 *     `assertEquals`/`assertTrue`, Go testify — matched as a word START with NO
 *     end boundary, so `assertion`/`asserted` also count.
 *   - `expect` — jest/vitest/Playwright `expect(...)` and Rust `.expect(...)` —
 *     word START only, so `expected`/`expects` also count.
 *   - `SCENARIO` — the harness's BDD scenario ids (`SCENARIO-001`) and Gherkin
 *     `Scenario:` headers — CASE-SENSITIVE (the id grammar is uppercase;
 *     lowercase `scenario` does not count).
 *
 * COUNTING RULE: raw occurrence count per file, with BOTH sides of the
 * comparison read under this SAME grammar. Comments are deliberately NOT
 * stripped — mirroring ASSERTION_RE's documented choice but for the OPPOSITE
 * safety reason: a marker inside a comment (or a prose word like `expected`)
 * only INFLATES a surface, and inflation can only MASK a decrease (fail-open),
 * never fabricate one; a comment-stripper bug that ate real code would do the
 * fail-closed harm instead. `describe(`/`context(` grouping forms are out of
 * grammar: they group tests without asserting, so removing one without
 * removing its inner markers does not lower the surface (documented). */
const ASSERTION_SURFACE_RE = /\b(?:test|it)\s*\(|\bassert|\bexpect|\bSCENARIO\b/g;

/** Count one file's assertion surface under the F5 grammar. Pure; never throws. */
export function assertionSurfaceCount(content: string): number {
	return (content.match(ASSERTION_SURFACE_RE) ?? []).length;
}

/** One comparable file for the ratchet. `before` is the pre-edit (HEAD)
 * content — `null` means the file did NOT exist pre-edit (newly authored this
 * try → exempt: it survives both the ratchet and the revert). `after` `null`
 * means the file was deleted on disk (surface 0). */
export interface AssertionSurfaceRow {
	path: string;
	before: string | null;
	after: string | null;
}

/** A weakened row: the path plus its before→after surface counts. */
export interface WeakenedAssertionSurface {
	path: string;
	before: number;
	after: number;
}

/** The ratchet predicate (pure; never throws): every row whose post-edit
 *  surface is STRICTLY lower than its pre-edit surface (a deleted pre-existing
 *  file counts as 0). Equal or HIGHER surfaces pass — ADDING assertions to a
 *  pre-existing test file is legal and stays accepted. */
export function weakenedAssertionSurfaces(rows: AssertionSurfaceRow[]): WeakenedAssertionSurface[] {
	const out: WeakenedAssertionSurface[] = [];
	for (const row of rows) {
		if (row.before === null) continue; // not pre-existing — new file, exempt
		const before = assertionSurfaceCount(row.before);
		const after = row.after === null ? 0 : assertionSurfaceCount(row.after);
		if (after < before) out.push({ path: row.path, before, after });
	}
	return out;
}

/** `git show HEAD:<path>` content — `null` when the path is not tracked at
 *  HEAD (new/untracked file), on any git failure, or on a spawn error. Never
 *  throws. For a path clean at RED entry (everything in redChangedFiles, by
 *  the setDiff construction) HEAD content IS the pre-edit disk content. */
function headFileContent(cwd: string, path: string): string | null {
	try {
		const r = spawnSync("git", ["-C", cwd, "show", `HEAD:${path}`], { encoding: "utf8", timeout: 10_000 });
		if (r.error || typeof r.status !== "number" || r.status !== 0) return null;
		return String(r.stdout ?? "");
	} catch {
		return null;
	}
}

/** The F5 comparable set (impure; never throws): RED-changed paths that are
 *  TEST files by name (TEST_FILE_NAME_RE; conftest.py stays a support
 *  artifact, mirroring assertionPresenceGaps) and PRE-EXISTING (tracked at
 *  HEAD). Harness bookkeeping/substrate paths are exempt, mirroring
 *  restoreUnacceptedRedChanges's filter. */
export function preexistingTestSurfaceRows(cwd: string, changedFiles: string[]): AssertionSurfaceRow[] {
	const rows: AssertionSurfaceRow[] = [];
	for (const path of changedFiles) {
		const rel = normalizeSlash(path);
		if (!TEST_FILE_NAME_RE.test(rel) || PYTEST_SUPPORT_BASENAME_RE.test(rel)) continue;
		if (isInternalRuntimeClaim(rel) || isSubstrateArtifact(rel) || isHarnessBookkeepingPath(rel)) continue;
		const before = headFileContent(cwd, rel);
		if (before === null) continue; // not pre-existing — new file, exempt
		let after: string | null = null;
		try { after = readFileSync(join(cwd, rel), "utf8"); } catch { after = null; }
		rows.push({ path: rel, before, after });
	}
	return rows;
}

export function changedSinceSnapshot(cwd: string, before: Map<string, string | null>): string[] {
	const changed: string[] = [];
	for (const [path, oldContent] of before) {
		let next: string | null = null;
		try { next = readFileSync(join(cwd, path), "utf8"); } catch { next = null; }
		if (next !== oldContent) changed.push(path);
	}
	return changed;
}

/** Restore confirmed RED test files that the GREEN implementer modified,
 *  writing the snapshot's original content back to disk. Returns the count
 *  actually restored (files whose snapshot content was non-null and wrote
 *  successfully). This re-establishes the honest RED oracle so the phase can
 *  retry the implementer WITHOUT re-running the RED phase — the RED tests are
 *  still valid; only the implementer overstepped by editing them. Best-effort:
 *  a write failure is skipped (the next changedSinceSnapshot re-check will
 *  still flag an unrestored file). */
export function restoreRedTestFiles(cwd: string, snapshot: Map<string, string | null>, modified: string[]): number {
	let restored = 0;
	for (const path of modified) {
		const content = snapshot.get(path);
		if (content == null) continue;
		try { writeFileSync(join(cwd, path), content); restored++; } catch { /* best-effort */ }
	}
	return restored;
}
