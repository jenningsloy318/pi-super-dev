/**
 * 058 Wave 3 D-B (Layer 2) — execution-time protection intervals.
 * docs/requirements/058-cross-phase-contract-architecture.md §3 Layer 2 + §4 D-B.
 *
 * Phases carry a mechanically-derived protected set: the immutability-class
 * claims of the entry-time contract surface. Detection is a SYNCHRONOUS
 * ENGINE CHOKE POINT in implementation.ts (NEW-1) evaluated strictly after
 * child-agent return and RED-review join, immediately before build-gate
 * dispatch — never a filesystem watcher or concurrent hook (a watcher would
 * re-introduce the S-C read-skew race inside the protection mechanism itself).
 *
 * Source (grill R8 refinement): Layer 2 protects ONLY immutability-class
 * claims — `scanImmutabilityIdioms` porcelain/wording hits +
 * `repo-invariants.json` declared `protected` paths — MINUS paths in the
 * approved `amendmentFamily` (ingested from `.knowledge.json` via the
 * 059-R1A seam). Membership-count pins ("exactly-14") are AMENDABLE with a
 * license and are NOT write-forbidden (P4: protections are mechanically
 * extracted, never LLM-declared; P6: the porcelain scanner is COMPOSED via
 * the landed extractContractInventory/scanImmutabilityIdioms chain, never
 * re-implemented here; P8: the two-strike bound lives in the stage wiring).
 *
 * State key (058 §4 D-B): `phaseProtectionStrikes: Record<phaseId, number>`
 * rides the implementation control — strictly disjoint from 059's
 * `writerMetadataRetryUsed:<stage>` (different prefix, different lifetime:
 * per phase vs per stage).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractContractInventory } from "../review/contract-surface/index.ts";
import { amendmentExemptFiles } from "../review/claim-spine.ts";
import { claimPathUsable } from "./plan-feasibility.ts";

/** P8: exactly two strikes, then a judged route (never a third in-loop strike). */
export const PROTECTION_STRIKE_BOUND = 2;

/** One protecting clause over one protected file (the education block quotes
 *  it verbatim — P4 advisory-style education over mechanical detection). */
export interface ProtectedPathClause {
	/** The protected file (normalized repo-relative). */
	path: string;
	/** The exact clause text that protects it (pin statement / declaration). */
	clause: string;
	/** Locus of the clause, repo-relative `file:line` (or the declaring file). */
	locus: string;
	/** Deterministic pin id (inventory pins) or `repo-invariants:<path>`. */
	pinId: string;
	/** The artifact carrying the clause (owning spec / test file). */
	source: string;
}

export interface ProtectionInterval {
	/** protectedFile → its protecting clauses (immutability class only). */
	protectedPaths: Map<string, ProtectedPathClause[]>;
	/** P10 scan visibility: one line per derivation input (mirrors the Layer-1
	 *  protectionScan lines — a silent miss must be visible, never silent). */
	scanLines: string[];
}

/** Serializable form persisted on the implementation control across §D
 *  convergence iterations (the phaseStartDirt precedent). */
export type ProtectionIntervalData = Array<[string, ProtectedPathClause[]]>;

export function serializeProtectionInterval(interval: ProtectionInterval): ProtectionIntervalData {
	return [...interval.protectedPaths.entries()].map(([path, clauses]) => [path, clauses.map((c) => ({ ...c }))] as [string, ProtectedPathClause[]]);
}

/** Revive a persisted interval; null on any malformed shape (the caller
 *  re-derives — fail-safe, never fail-stuck). */
export function reviveProtectionInterval(data: unknown): ProtectionInterval | null {
	if (!Array.isArray(data)) return null;
	const map = new Map<string, ProtectedPathClause[]>();
	for (const entry of data) {
		if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== "string" || !entry[0] || !Array.isArray(entry[1])) return null;
		const clauses: ProtectedPathClause[] = [];
		for (const c of entry[1]) {
			const clause = c as Partial<ProtectedPathClause> | null;
			if (!clause || typeof clause.path !== "string" || typeof clause.clause !== "string" || typeof clause.locus !== "string" || typeof clause.pinId !== "string" || typeof clause.source !== "string") return null;
			clauses.push({ path: clause.path, clause: clause.clause, locus: clause.locus, pinId: clause.pinId, source: clause.source });
		}
		if (clauses.length === 0) return null;
		map.set(entry[0], clauses);
	}
	return { protectedPaths: map, scanLines: [] };
}

// ─── derivation (once per run at first stage entry — do NOT re-scan) ────────

/** The 059-R1A seam, D7-unified (065 DEC-7): an owner-approved amendment
 *  family (design ?? spec, persisted by knowledge.ts) exempts its declared
 *  sharedFile paths from the protection interval. The READ is the ONE
 *  exported helper `amendmentExemptFiles` (claim-spine.ts) — the previously
 *  duplicated fail-closed reader here and in plan-feasibility are retired to
 *  delegations. FAIL-CLOSED (grill R8, preserved): unparseable JSON, wrong
 *  envelope, or ANY malformed family entry ⇒ an EMPTY exemption set. */
function approvedAmendmentSharedFiles(specDirectory: string | undefined, scanLines?: string[]): Set<string> {
	return amendmentExemptFiles(specDirectory, scanLines);
}

/** The repo-invariants.json `protected` arm (the Layer-1 explicit-declaration
 *  source; the pins[] arm is already indexed by the inventory). Mirrors the
 *  landed Check-3 reader's envelope validation (058 P1). */
function declaredInvariantPaths(worktreePath: string): { paths: string[]; malformed: boolean } {
	const abs = join(worktreePath, "repo-invariants.json");
	if (!existsSync(abs)) return { paths: [], malformed: false };
	try {
		const parsed = JSON.parse(readFileSync(abs, "utf8")) as { protected?: unknown } | null;
		const declared = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.protected)
			? parsed.protected.filter((p): p is string => typeof p === "string" && !!p).map(claimPathUsable).filter((p): p is string => p !== null)
			: null;
		if (!declared) return { paths: [], malformed: true };
		return { paths: declared, malformed: false };
	} catch {
		return { paths: [], malformed: true };
	}
}

/**
 * Derive the run's protection interval. ONE walk per run at the first
 * implementation entry (the Layer-1 sources are entry-time; the stage wiring
 * persists the serialized form across §D convergence iterations — the entry
 * scan is never repeated per attempt or per re-entry). Absent tree ⇒ empty
 * interval (DEC-4 fail-open); an extraction error on an existing tree rides
 * the scan lines (P10).
 */
export function deriveProtectionInterval(worktreePath: string, specDirectory: string | undefined): ProtectionInterval {
	const interval: ProtectionInterval = { protectedPaths: new Map(), scanLines: [] };
	const exempt = approvedAmendmentSharedFiles(specDirectory, interval.scanLines);
	const declared = declaredInvariantPaths(worktreePath);
	if (declared.malformed) interval.scanLines.push("repo-invariants.json: present but malformed (expected {protected: string[]}) — declared paths unavailable");
	// P6: the porcelain/wording scanner is COMPOSED via the landed inventory
	// (extractContractInventory → scanImmutabilityIdioms for the TS form).
	// DEC-4 absent-tree fail-open: an absent worktree yields an empty inventory.
	const inventory = extractContractInventory(worktreePath);
	for (const err of inventory.errors.slice(0, 4)) interval.scanLines.push(`inventory: ${err}`);
	for (const [file, pins] of inventory.protectedFiles) {
		// grill R8 source refinement: ONLY the immutability class protects.
		// Membership-count / no-Xth / ownership pins are amendable, not forbidden.
		const immutable = pins.filter((p) => p.idiomFamily === "porcelain-emptiness");
		if (immutable.length === 0) continue;
		if (exempt.has(file)) {
			interval.scanLines.push(`exemption: ${file} — owner-approved amendmentFamily (see stages.design/stages.spec .knowledge.json)`);
			continue;
		}
		interval.protectedPaths.set(file, immutable.map((p) => ({ path: file, clause: p.statement, locus: p.locus, pinId: p.pinId, source: p.owningSpec })));
	}
	for (const p of declared.paths) {
		if (exempt.has(p) || interval.protectedPaths.has(p)) continue;
		interval.protectedPaths.set(p, [{ path: p, clause: "declared protected path (repo-invariants.json)", locus: "repo-invariants.json", pinId: `repo-invariants:${p}`, source: "repo-invariants.json" }]);
	}
	return interval;
}

// ─── detection (pure — the choke point's synchronous core) ──────────────────

/** One spelling of path normalization for the protection diff (the leakNorm
 *  convention: trim, backslash→slash, strip leading ./, strip trailing /). */
export function normProtectionPath(raw: string): string {
	return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export interface ProtectionViolation {
	path: string;
	/** Every protecting clause for the path (education + judge context). */
	clauses: ProtectedPathClause[];
	/** Which input arm caught the write: worktree porcelain and/or the
	 *  attempt's declared footprint. */
	detectedBy: Array<"porcelain" | "declared-footprint">;
}

/**
 * Diff the attempt's changed files (worktree porcelain + the implementer's
 * declared footprint) against the phase's protected set. Pure, synchronous,
 * zero spawns. Empty protected set ⇒ [] (zero false positives, zero cost).
 */
export function detectProtectionViolations(
	changedPaths: readonly string[],
	declaredFootprint: readonly string[],
	interval: ProtectionInterval,
): ProtectionViolation[] {
	if (interval.protectedPaths.size === 0) return [];
	const byPath = new Map<string, Set<"porcelain" | "declared-footprint">>();
	const consider = (raw: string, via: "porcelain" | "declared-footprint"): void => {
		const p = normProtectionPath(raw);
		if (!p || !interval.protectedPaths.has(p)) return;
		const set = byPath.get(p) ?? new Set();
		set.add(via);
		byPath.set(p, set);
	};
	for (const p of changedPaths) consider(p, "porcelain");
	for (const p of declaredFootprint) consider(p, "declared-footprint");
	return [...byPath.keys()].sort().map((path) => ({ path, clauses: interval.protectedPaths.get(path)!, detectedBy: [...byPath.get(path)!] }));
}

// ─── strike state (per-phase counters on the implementation control) ───────

/** Increment the phase's strike counter; returns the NEW count (1 = strike 1,
 *  ≥2 = strike 2 — every outcome at ≥2 ends the attempt in the stage wiring,
 *  so no third in-loop strike exists; P8 bound = PROTECTION_STRIKE_BOUND). */
export function bumpProtectionStrike(strikes: Record<string, number>, phaseId: string): number {
	const next = (strikes[phaseId] ?? 0) + 1;
	strikes[phaseId] = next;
	return next;
}

/** Reset a phase's strike counter. Called ONLY after a strike-2 challenge-test
 *  verdict re-authors the RED (the contract surface changed — a fresh
 *  protection interval), keeping the whole loop bounded by
 *  MAX_CHALLENGE_REAUTHORS in the stage wiring. */
export function resetProtectionStrike(strikes: Record<string, number>, phaseId: string): void {
	delete strikes[phaseId];
}

// ─── education (P4: mechanical detection, advisory-style education) ─────────

/** The strike-1 corrective block: names the protected files and quotes the
 *  EXACT clause that protects each (locus + statement). Injected once into
 *  the re-prompted implementer's context. */
export function buildProtectionEducationBlock(args: { phaseId: string; violations: ProtectionViolation[]; strike: number }): string {
	const rows = args.violations.flatMap((v) => v.clauses.slice(0, 3).map((c) => `- \`${v.path}\` — protected by ${c.locus}: "${c.clause}"`));
	return [
		`## PROTECTED FILES — your previous edit was detected and REVERTED (protection strike ${args.strike}/${PROTECTION_STRIKE_BOUND}, phase ${args.phaseId})`,
		"The files below are protected by immutable-baseline contract clauses (deterministically extracted from the test suite and repo-invariants.json). This phase MUST NOT create, modify, or delete them:",
		...rows,
		"",
		`Your edit to these path(s) was REVERTED to the phase's entry state, and this attempt did NOT count against the phase budget. Work AROUND the protected surface (new files, wrappers, dependency injection) — never through it. If the task genuinely cannot be done without editing a protected file, state that in your final answer instead of editing: that is a plan-level contract conflict the engine routes to the judge.`,
	].join("\n");
}
