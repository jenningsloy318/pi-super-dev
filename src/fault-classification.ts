/**
 * Shared fault-classification helpers (Track 30 — fault-classified actuation,
 * signature normalization & reused-worktree isolation; ships as v0.2.3).
 *
 * ONE dependency-light, synchronous, NEVER-THROW module consumed by BOTH dirt
 * call sites — Stage 9's attempt loop (src/stages/implementation.ts) and
 * runSetup (src/setup.ts) — so the exclusion/quarantine semantics cannot drift
 * between them (D-7: this module is the canonical exclusion source).
 *
 *   PRA — deterministic fault-classification floor over `BuildGateResult` plus
 *         the own-scope evidence booleans; pure TypeScript, no LLM (NFR-1).
 *         scenarioRefs: [SCENARIO-001, SCENARIO-002, SCENARIO-003] ·
 *         acceptanceCriteriaRefs: [AC-01]
 *   PRB — volatile-noise stripper consumed by the stage's
 *         `normalizeSignatureText` BEFORE its whitespace-collapse/trim/800-cap.
 *         scenarioRefs: [SCENARIO-018, SCENARIO-019] ·
 *         acceptanceCriteriaRefs: [AC-06, AC-08]
 *   PRC — canonical dirt inventory (OQ-2 exclusion predicate) plus the
 *         stash-based, kill-switched quarantine primitive. The ONLY worktree
 *         mutation this module can ever issue is `git stash push` (D-9/D-10);
 *         recovery is reversible by construction (never drop/clear).
 *         scenarioRefs: [SCENARIO-008, SCENARIO-009] ·
 *         acceptanceCriteriaRefs: [AC-03, AC-13]
 *   PRD — per-track environment-fault JSONL ledger primitives.
 *         scenarioRefs: [SCENARIO-025] · acceptanceCriteriaRefs: [AC-12]
 *
 * Imports: node builtins + `isHarnessBookkeepingPath` (src/helpers.ts —
 * imported, never modified) + `BASELINE_VERIFY_ERROR_PREFIX`
 * (src/build-runner/gates.ts). No stage imports — no cycles (06-code-
 * assessment proposed module surface). Everything here is unit-testable with
 * no LLM and no stage context.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isHarnessBookkeepingPath } from "./helpers.ts";
import { BASELINE_VERIFY_ERROR_PREFIX } from "./build-runner/gates.ts";

// ── PRA: deterministic classification floor (no LLM) ────────────────────────

export type FaultClass = "environmental-blocker" | "product-defect" | "unclassified";

export type FaultActuator = "quarantine+re-gate" | "judge" | "implementer-retry";

export interface FaultClassificationInput {
	/** `gate.errors` — the raw failure blocks, including the synthetic strip. */
	errors: readonly string[];
	/** Pre-existing failure blocks referencing ONLY out-of-scope subjects. */
	outOfScopeErrors: readonly string[];
	/** Present ONLY when a baseline verification actually ran. */
	baselineCheck?: { status: "preexisting" | "regression" | "unknown"; evidence: string };
	/** Own-scope evidence booleans computed by the attempt loop's green branch. */
	ownScope: { deliverablePass: boolean; changePass: boolean; symbolPass: boolean; tddClean: boolean };
	/** v0.2.6 G1 — dirt PROVENANCE: count of inventory paths that were already
	 * dirty at PHASE START (prior-run / foreign state). Row (2) requires > 0 to
	 * claim `environmental-blocker`: on a tree clean at phase start, an
	 * out-of-scope-only regression is by construction caused by THIS phase's own
	 * edits (in-scope edits breaking a pre-existing test, or undeclared
	 * out-of-scope edits) — a product defect, never an environment fault
	 * (runs 2026-08-19T01-47-29-690Z and 2026-08-19T05-09-21-800Z). `undefined`
	 * means "no provenance signal available" and is treated as 0 (unknown
	 * provenance can never support a mutation — safe direction is product). */
	foreignDirtCount?: number;
}

export interface FaultClassification {
	faultClass: FaultClass;
	actuators: readonly FaultActuator[];
}

/**
 * True for the synthetic `[baseline-verify] regression — …` block the gate
 * appends on a regression verdict — a verdict ANNOTATION, not a product
 * failure (AC-01). Exact prefix match (`startsWith` on the exported gate
 * constant); an in-scope error that merely QUOTES the prefix words mid-string
 * is NOT absorbed (no fuzzy matching — 06-code-assessment Seam 3 risk).
 */
export function isBaselineVerifySyntheticError(error: string): boolean {
	return error.startsWith(BASELINE_VERIFY_ERROR_PREFIX);
}

/**
 * Deterministic classification floor — pure, no LLM (NFR-1). Truth table
 * (Track 30 T1.1, pinned row-by-row in tests/fault-classification.test.ts):
 *
 *  (1) any `errors[i]` that is neither an `outOfScopeErrors` member
 *      (exact-string) nor `isBaselineVerifySyntheticError` ⇒ `product-defect`,
 *      actuators `["implementer-retry"]` — today's retry semantics.
 *  (2) else, all errors out-of-scope-or-synthetic with
 *      `outOfScopeErrors.length > 0`: `baselineCheck.status === "regression"`
 *      AND all four own-scope booleans true AND `foreignDirtCount > 0`
 *      (v0.2.6 G1 — dirt that predates the phase; without foreign dirt the
 *      failure is this phase's own product regression) ⇒ `environmental-blocker`,
 *      actuators `["quarantine+re-gate", "judge"]` (D-3); otherwise (absent
 *      `baselineCheck`, `preexisting`/`unknown`, own-scope red, or zero foreign
 *      dirt) ⇒ `unclassified` when no out-of-scope premise supports a product
 *      reading… and `product-defect` when the out-of-scope-only + regression
 *      shape held but provenance was missing — actuators `["implementer-retry"]`
 *      — never `environmental-blocker`.
 *  (3) empty `errors` ⇒ `unclassified`.
 *
 * scenarioRefs: [SCENARIO-001, SCENARIO-002, SCENARIO-003] ·
 * acceptanceCriteriaRefs: [AC-01]
 */
export function classifyGateFault(input: FaultClassificationInput): FaultClassification {
	// Row (3) first: empty errors must never reach the (vacuously-true) row-2
	// premise and classify environmental-blocker.
	if (input.errors.length === 0) {
		return { faultClass: "unclassified", actuators: ["implementer-retry"] };
	}
	// Row (1): genuine in-scope or mixed failure — exact-string membership plus
	// prefix match, nothing fuzzier.
	const outOfScope = new Set(input.outOfScopeErrors);
	const hasProductFailure = input.errors.some((e) => !outOfScope.has(e) && !isBaselineVerifySyntheticError(e));
	if (hasProductFailure) {
		return { faultClass: "product-defect", actuators: ["implementer-retry"] };
	}
	// Row (2): out-of-scope-only failures — environmental ONLY on an evidence-
	// backed regression with fully green own-scope evidence AND foreign (pre-
	// phase) dirt on the tree (v0.2.6 G1). Without foreign dirt this shape is a
	// product regression CAUSED by this phase's own edits (an out-of-scope
	// subject that passes at baseline cannot break on a clean-at-start tree
	// any other way) — route it to the implementer with named out-of-scope
	// edits rather than mutating the worktree.
	const o = input.ownScope;
	const shapeHeld =
		input.outOfScopeErrors.length > 0 &&
		input.baselineCheck?.status === "regression" &&
		o.deliverablePass && o.changePass && o.symbolPass && o.tddClean;
	if (shapeHeld && (input.foreignDirtCount ?? 0) > 0) {
		return { faultClass: "environmental-blocker", actuators: ["quarantine+re-gate", "judge"] };
	}
	if (shapeHeld) {
		return { faultClass: "product-defect", actuators: ["implementer-retry"] };
	}
	return { faultClass: "unclassified", actuators: ["implementer-retry"] };
}

// ── PRB: signature noise normalization (consumed by normalizeSignatureText) ──

/** ISO-8601 timestamps: `2026-08-18T10:11:42.496069+08:00`, `…Z`, and the
 *  space-separated `2026-08-18 10:11:42` form — with/without fractional
 *  seconds and timezone (SCENARIO-014 inventory). */
const ISO8601_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
/** Canonical 8-4-4-4-12 hex UUIDs. */
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
/** Durations (`14.439s`, `3.695s`, `0.000s`, `423ms`). The `\b` anchors keep
 *  semver-ish tokens intact — `3s` followed by `rc` (as in `0.2.3src`) has no
 *  word boundary, so it survives (AC-08 no-over-normalization). */
const DURATION_RE = /\b\d+(?:\.\d+)?(?:ms|s)\b/g;
/** `(cached)` and `[cached]` markers — the latter also neutralizes baseline.ts's
 *  memo-hit `" [cached]"` evidence suffix (fresh vs memoized verdicts compare
 *  equal once collapsed). */
const CACHED_PAREN_RE = /\(cached\)/g;
const CACHED_BRACKET_RE = /\[cached\]/g;

/**
 * Strip volatile noise from failure text — the PRB primitive
 * `normalizeSignatureText` runs BEFORE its whitespace-collapse/trim/800-cap
 * (strip → collapse → trim → cap), so noise never displaces discriminating
 * content past the cap (SCENARIO-015) and identical failures hash to ONE
 * signature (SCENARIO-016). Classes, in order (T1.3): ISO-8601 timestamps,
 * UUIDs, durations, `(cached)`/`[cached]` markers.
 * scenarioRefs: [SCENARIO-018, SCENARIO-019] · acceptanceCriteriaRefs: [AC-06, AC-08]
 */
export function stripVolatileNoise(text: string): string {
	return text
		.replace(ISO8601_RE, "")
		.replace(UUID_RE, "")
		.replace(DURATION_RE, "")
		.replace(CACHED_PAREN_RE, "")
		.replace(CACHED_BRACKET_RE, "");
}

// ── PRC: canonical dirt inventory (OQ-2 exclusion predicate + porcelain reader) ──

export interface DirtInventoryOptions {
	/** The git worktree whose porcelain state is inventoried. */
	worktreePath: string;
	/** Absolute (setup/stage form, usually trailing-slash) or relative spec dir.
	 *  Files under its worktree-relative `docs/specifications/<id>/` prefix are
	 *  harness-owned state, never foreign dirt (OQ-2 rule 1). */
	specDirectory?: string;
	/** `runSetup`'s copied env files (repo-relative) — exclusions (rule 4). */
	copiedEnvFiles?: readonly string[];
	/** In-loop ONLY (D-7 rule 5): implementer-claimed `filesCreated ∪
	 *  filesModified ∪ filesDeleted` ∪ phase `declaredScope` ∪ `testFiles` —
	 *  unknown at setup time, which passes none. */
	extraExcluded?: readonly string[];
}

/** Backslash→slash + leading-"./" normalization for repo-relative compares. */
function normalizeRepoRelative(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Worktree-relative spec-dir prefix (`docs/specifications/<id>`), derived
 *  from `specDirectory` — absolute (with the final-segment fallback technique
 *  of `isHarnessBookkeepingPath` for absolute-vs-relative mismatches) or
 *  already relative. Null when no spec dir is known. Never throws. */
function specDirRelPrefix(o: DirtInventoryOptions): string | null {
	const specDir = o.specDirectory?.trim();
	if (!specDir) return null;
	const cleaned = normalizeRepoRelative(specDir.replace(/\/+$/, ""));
	if (!cleaned) return null;
	if (!isAbsolute(cleaned)) return cleaned;
	const wt = resolve(o.worktreePath);
	const abs = resolve(cleaned);
	if (abs === wt) return null; // degenerate: spec dir IS the worktree — exclude nothing
	const rel = relative(wt, abs).split(sep).join("/");
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	// Final-segment fallback: match `docs/specifications/<final-segment>/…`
	// anywhere, mirroring isHarnessBookkeepingPath's absolute/relative bridge.
	const base = cleaned.split("/").pop() ?? "";
	return base ? `docs/specifications/${base}` : null;
}

/**
 * The canonical OQ-2 quarantine-exclusion predicate — ONE predicate shared by
 * BOTH call sites (Stage 9 in-loop inventory and setup re-entry hygiene) so
 * the semantics cannot drift (D-7). Deliberately DIFFERENT from
 * `trackerOutofScopeEdits`'s audit exclusion set (self-claims are exempt
 * HERE, not there — the two sets serve different purposes; drift hazard is
 * documented in the Track 30 spec D-7). Rules, in order:
 *   (1) the spec-dir prefix (`docs/specifications/<specId>/…`);
 *   (2) `isHarnessBookkeepingPath(specDirectory, path)` (same-named files
 *       OUTSIDE the spec dir are NOT exempt);
 *   (3) the `.super-dev/` state prefix;
 *   (4) `copiedEnvFiles` members (slash-normalized exact match);
 *   (5) `extraExcluded` — in-loop ONLY (claimed ∪ declaredScope ∪ testFiles).
 * Pure string logic; never throws.
 * scenarioRefs: [SCENARIO-008, SCENARIO-009] · acceptanceCriteriaRefs: [AC-03]
 */
export function isExcludedFromQuarantine(path: string, options: DirtInventoryOptions): boolean {
	const p = normalizeRepoRelative(path);
	const prefix = specDirRelPrefix(options);
	if (prefix && (p === prefix || p.startsWith(`${prefix}/`))) return true;
	if (isHarnessBookkeepingPath(options.specDirectory, p)) return true;
	if (p === ".super-dev" || p.startsWith(".super-dev/")) return true;
	for (const c of options.copiedEnvFiles ?? []) {
		if (c && normalizeRepoRelative(c) === p) return true;
	}
	for (const e of options.extraExcluded ?? []) {
		if (e && normalizeRepoRelative(e) === p) return true;
	}
	return false;
}

/** Porcelain path parsing scaffolding mirrored from `trackerOutofScopeEdits`
 *  (src/stages/implementation.ts — deliberately NOT imported, no cycles):
 *  C-quote strip + backslash unescape, backslash→slash normalize, leading
 *  "./" strip. */
function normalizePorcelainPath(raw: string): string {
	const t = raw.trim();
	if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
		return t.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\/g, "/");
	}
	return t.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Read the worktree's dirty paths via
 * `git -c core.quotepath=false -C <worktreePath> status --porcelain
 * --untracked-files=all` (15 s timeout, array argv — no shell) and return the
 * sorted UNIQUE paths for which `!isExcludedFromQuarantine` — the canonical
 * quarantine inventory. Rename entries resolve to the NEW path. NEVER throws:
 * any spawn error / non-zero exit / exception ⇒ `[]`.
 * scenarioRefs: [SCENARIO-008, SCENARIO-009] · acceptanceCriteriaRefs: [AC-03]
 */
/** v0.2.6 G1 — RAW porcelain path list (NO exclusions): every path git
 * reports dirty/untracked, with rename-new-path semantics and
 * `core.quotepath=false` identical to {@link collectDirtPaths}. Consumed by the
 * attempt loop's phase-start snapshot so dirt PROVENANCE (present at phase
 * start = foreign; absent = this phase's own edit) partitions against the
 * exact same parsing the inventory uses — the two can never drift. `[]` on any
 * git failure (never throws); an empty result on a live repo means clean tree. */
export function listPorcelainPaths(worktreePath: string): string[] {
	try {
		const r = spawnSync("git", ["-c", "core.quotepath=false", "-C", worktreePath, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", timeout: 15_000 });
		if (r.error || typeof r.status !== "number" || r.status !== 0) return [];
		const out: string[] = [];
		for (const line of String(r.stdout ?? "").split("\n")) {
			if (!line.trim()) continue;
			const code = line.slice(0, 2);
			const body = line.slice(3);
			// Rename entries (R) carry "old -> new" — the NEW path is the live one.
			const raw = code.includes("R") && body.includes(" -> ") ? body.split(" -> ").pop()! : body;
			const path = normalizePorcelainPath(raw);
			if (!path) continue;
			out.push(path);
		}
		return out;
	} catch {
		return [];
	}
}

export function collectDirtPaths(options: DirtInventoryOptions): string[] {
	try {
		const raw = listPorcelainPaths(options.worktreePath);
		const out = new Set<string>();
		for (const path of raw) {
			if (isExcludedFromQuarantine(path, options)) continue;
			out.add(path);
		}
		return [...out].sort();
	} catch {
		return [];
	}
}

// ── PRC: quarantine primitive + kill-switch (never-destructive contract) ─────

/** Kill-switch (AC-11/NFR-3/D-10): `SUPER_DEV_NO_DIRTY_QUARANTINE=1` disables
 *  BOTH quarantines (setup + in-loop). Detection still observes and logs;
 *  mutation never runs. Matches the SUPER_DEV_NO_SPEC_REUSE /
 *  SUPER_DEV_NO_BOOTSTRAP convention. */
export const DIRTY_QUARANTINE_KILL_SWITCH = "SUPER_DEV_NO_DIRTY_QUARANTINE";

export function dirtyQuarantineEnabled(): boolean {
	return process.env[DIRTY_QUARANTINE_KILL_SWITCH] !== "1";
}

export interface QuarantineOutcome {
	ok: boolean;
	skipped?: "kill-switch" | "empty";
	stashRef: string | null;
	paths: string[];
	error?: string;
}

/** Tail helper for git stderr surfaces (bounded, single line preferred). */
function tailText(s: string, max = 300): string {
	const t = s.trim();
	return t.length > max ? t.slice(t.length - max) : t;
}

/** `git rev-parse refs/stash` (15 s, never throws) — null when absent or on
 *  any failure. Used by the phantom-success guard in quarantineDirt. */
function readStashRef(worktreePath: string): string | null {
	try {
		const rev = spawnSync("git", ["rev-parse", "refs/stash"], { encoding: "utf8", timeout: 15_000, cwd: worktreePath });
		if (rev.error || rev.status !== 0) return null;
		return String(rev.stdout ?? "").trim() || null;
	} catch {
		return null;
	}
}

/**
 * Recoverable, never-destructive dirt quarantine (D-9 contract):
 *   - kill-switch set ⇒ `{ok:false, skipped:"kill-switch", stashRef:null}` with
 *     NO mutation and NO git call;
 *   - empty/blank pathspec ⇒ `{ok:false, skipped:"empty", …}` — the
 *     everything-stash footgun is structurally unreachable;
 *   - otherwise the ONLY worktree mutation is
 *     `git stash push -u -m <reason> -- <paths…>` (30 s timeout,
 *     `cwd: worktreePath`, array argv — no shell), then `git rev-parse
 *     refs/stash` captured as `stashRef` (git stash push prints no SHA);
 *   - any non-zero exit ⇒ `{ok:false, stashRef:null, error: <stderr tail>}`.
 *
 * Never `checkout`/`reset`/`clean`/`drop`/`clear`; never the legacy `save`;
 * always the literal `--` separator; `-u` (never `-a` — ignored files stay).
 * `pop`-conflicts preserve the entry, so recovery is reversible by
 *  construction (R-N6). NEVER throws.
 * acceptanceCriteriaRefs: [AC-13] (end-to-end SCENARIO-028 ownership: T5.5)
 */
export function quarantineDirt(options: { worktreePath: string; paths: readonly string[]; reason: string; log?: (m: string) => void }): QuarantineOutcome {
	const paths = options.paths.filter((p) => typeof p === "string" && p.trim() !== "");
	if (!dirtyQuarantineEnabled()) {
		return { ok: false, skipped: "kill-switch", stashRef: null, paths };
	}
	if (paths.length === 0) {
		return { ok: false, skipped: "empty", stashRef: null, paths: [] };
	}
	try {
		// Review remediation (dual-review F-1, both reviewers): `git stash push`
		// exits 0 with "No local changes to save" when the pathspec matches
		// nothing (gitlink/submodule dirt, cleanup race) — a phantom success that
		// would record a false ledger line and burn the one re-run budget. Two
		// guards: (1) every pathspec is prefixed with `:(literal)` magic so glob
		// metacharacters in paths are never interpreted (and quoted paths can
		// never widen the match), and (2) success additionally requires the
		// refs/stash ref to have CHANGED (or been created) by this push — an
		// exit-0 no-op push reports ok:false with the no-changes error instead.
		const literalPaths = paths.map((p) => `:(literal)${p}`);
		const refBefore = readStashRef(options.worktreePath);
		const push = spawnSync("git", ["stash", "push", "-u", "-m", options.reason, "--", ...literalPaths], { encoding: "utf8", timeout: 30_000, cwd: options.worktreePath });
		if (push.error) {
			const error = String(push.error.message ?? push.error);
			try { options.log?.(`dirty-quarantine: git stash push failed: ${tailText(error)}`); } catch { /* never throw */ }
			return { ok: false, stashRef: null, paths, error: tailText(error) };
		}
		if (typeof push.status !== "number" || push.status !== 0) {
			const error = tailText(String(push.stderr ?? "") || String(push.stdout ?? ""));
			try { options.log?.(`dirty-quarantine: git stash push failed: ${error}`); } catch { /* never throw */ }
			return { ok: false, stashRef: null, paths, error };
		}
		const stashRef = readStashRef(options.worktreePath);
		const noChanges = /no local changes to save/i.test(String(push.stdout ?? "") + String(push.stderr ?? ""));
		if (noChanges || stashRef === null || (refBefore !== null && stashRef === refBefore)) {
			const error = `stash push exited 0 but changed nothing${noChanges ? " (no local changes to save)" : ""} — pathspec matched no dirt (refs/stash ${stashRef === null ? "absent" : "unchanged"})`;
			try { options.log?.(`dirty-quarantine: phantom-success guard: ${error}`); } catch { /* never throw */ }
			return { ok: false, stashRef: null, paths, error };
		}
		return { ok: true, stashRef, paths };
	} catch (err) {
		const error = tailText(err instanceof Error ? err.message : String(err));
		try { options.log?.(`dirty-quarantine: git stash push failed: ${error}`); } catch { /* never throw */ }
		return { ok: false, stashRef: null, paths, error };
	}
}

// ── PRD: per-track environment-fault ledger ───────────────────────────────

export type EnvironmentFaultKind = "quarantine" | "judge-environmental";

export interface EnvironmentFaultRecord {
	kind: EnvironmentFaultKind;
	paths: string[] | null;
	stashRef: string | null;
	reason: string;
}

/** `<specDir>/.environment-faults.jsonl` — mirroring the `.resume-cache.jsonl`
 *  in-spec-dir precedent (setup.ts) and `.judge.jsonl` (judge.ts). */
export function environmentFaultLedgerPath(specDir: string): string {
	return join(specDir, ".environment-faults.jsonl");
}

/**
 * Append ONE JSON line per environment-fault event. Key order is exactly
 * `{kind, paths, stashRef, reason}` (SCENARIO-025's exact key-set pin).
 * NEVER throws: any failure degrades to a warning through `log` (never
 * fatal — SCENARIO-030) and the caller's flow proceeds.
 * scenarioRefs: [SCENARIO-025] · acceptanceCriteriaRefs: [AC-12]
 */
export function appendEnvironmentFault(specDir: string | undefined, record: EnvironmentFaultRecord, log?: (m: string) => void): void {
	if (!specDir) return;
	try {
		// judge.ts's .judge.jsonl precedent: ensure the spec dir exists (it always
		// does in practice), then append one line.
		mkdirSync(specDir, { recursive: true });
		appendFileSync(environmentFaultLedgerPath(specDir), JSON.stringify({ kind: record.kind, paths: record.paths, stashRef: record.stashRef, reason: record.reason }) + "\n");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		try { log?.(`environment-fault ledger append failed (continuing; never fatal): ${msg}`); } catch { /* never throw */ }
	}
}

/**
 * Count prior environment-fault lines on this track — `null` IFF the ledger
 * file is absent (SCENARIO-027: no line at all when absent). NEVER throws.
 * scenarioRefs: [SCENARIO-027] · acceptanceCriteriaRefs: [AC-12]
 */
export function readEnvironmentFaultCount(specDir: string | undefined): number | null {
	if (!specDir) return null;
	try {
		const text = readFileSync(environmentFaultLedgerPath(specDir), "utf8");
		return text.split("\n").filter((line) => line.trim() !== "").length;
	} catch {
		return null;
	}
}
