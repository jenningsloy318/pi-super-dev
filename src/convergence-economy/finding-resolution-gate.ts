/**
 * WS1 (066 §2) — the finding-resolution gate, pure decision core.
 * (Named finding-RESOLUTION to avoid colliding with build-runner's test-coverage
 * gate — same-name different-semantics predicates are a review finding.)
 *
 * The receipt class (E1, run 2026-09-20T07-37-57-688Z): 36 prior blocking
 * findings injected at write time; nothing verified per-finding coverage, so
 * an unaddressed one resurfaced at BDD review ~80 min and 3 agent calls
 * later. This module computes the deterministic half of the gate: which
 * injected blocking finding ids the writer's control block FAILED to map.
 * The bounce itself (one bounded writer re-dispatch) is wired at the
 * artifact-convergence seam; this core never dispatches, never throws on the
 * decision path (P5), and is fail-open behind SUPER_DEV_NO_COVERAGE_BOUNCE.
 *
 * Control contract (066 WS1): `findingResolutions: [{id, loci, note}]` — per
 * Degani & Wiener checklist design, per-id rows, never prose. The map is WEAK
 * evidence by itself (FBI/EMNLP 2024: evaluators name defects yet pass them;
 * CHERRL: a compliance declaration fools judges) — the reviewer's sealed
 * deep-verification subset is the strong layer; this gate only catches the
 * OMISSION class at zero reviewer cost.
 */

import { superDevEnv } from "../render/super-dev-dir.ts";

/** One writer-emitted coverage row (structurally validated, lenient parse). */
export interface FindingResolution {
	id: string;
	loci: string[];
	note: string;
}

export interface FindingResolutionGateInput {
	/** The blocking finding ids THIS round actually injected (post-downgrade,
	 * stamped at injection — grill-5 Q2: no blocking↔advisory ping-pong). */
	injectedIds: readonly string[];
	/** The writer control's `findingResolutions` value (unknown shape — parsed). */
	resolutions: unknown;
	/** Findings whose addressing loci are unchanged since a verified map
	 * (grill-2 Q4 WS1×WS6 composition) — exempt from re-mapping. */
	inheritedGreen?: ReadonlySet<string>;
}

export interface FindingResolutionGateDecision {
	/** Kill-switch state (gate disabled ⇒ never bounce). */
	enabled: boolean;
	/** Injected ids with no resolution row and no inherited-green exemption. */
	missing: string[];
	/** Rows dropped by structural validation (count only — P10 honesty). */
	malformedRows: number;
	/** True iff a bounce should fire (enabled && missing.length > 0). */
	bounce: boolean;
	/** The bounce feedback line (empty when not bouncing). */
	feedback: string;
}

/** Kill-switch — lazy env read (defensive rule 1), default ENABLED. */
export function findingResolutionGateEnabled(): boolean {
	const v = superDevEnv("SUPER_DEV_NO_COVERAGE_BOUNCE");
	return !(v === "1" || v === "true" || v === "yes");
}

/** WS2 kill-switch — same lazy-read pattern, default ENABLED. */
export function validatorBounceEnabled(): boolean {
	const v = superDevEnv("SUPER_DEV_NO_VALIDATOR_BOUNCE");
	return !(v === "1" || v === "true" || v === "yes");
}

/** Lenient structural parse of the control field. A row counts ONLY when it
 * carries a non-empty string id; loci/note survive as strings when present.
 * Malformed rows are DROPPED and counted (fail-closed: an unparseable row
 * must not mint coverage), never throw (P5). */
export function parseFindingResolutions(value: unknown): { rows: FindingResolution[]; malformedRows: number } {
	const rows: FindingResolution[] = [];
	let malformedRows = 0;
	if (!Array.isArray(value)) return { rows, malformedRows: 0 };
	for (const raw of value) {
		if (raw == null || typeof raw !== "object") { malformedRows++; continue; }
		const r = raw as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id.trim() : "";
		if (!id) { malformedRows++; continue; }
		rows.push({
			id,
			loci: Array.isArray(r.loci) ? r.loci.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [],
			note: typeof r.note === "string" ? r.note : "",
		});
	}
	return { rows, malformedRows };
}

/** The decision core. Pure; never throws; `inheritedGreen` defaults empty. */
export function adjudicateFindingResolutionGate(input: FindingResolutionGateInput, enabled: boolean = findingResolutionGateEnabled()): FindingResolutionGateDecision {
	const inherited = input.inheritedGreen ?? new Set<string>();
	const { rows, malformedRows } = parseFindingResolutions(input.resolutions);
	const mapped = new Set(rows.map((r) => r.id));
	const missing = input.injectedIds.filter((id) => !mapped.has(id) && !inherited.has(id));
	const bounce = enabled && missing.length > 0;
	const feedback = bounce
		? `coverage bounce: ${missing.length} injected blocking finding(s) have no resolution row — add findingResolutions entries (id + loci + a note quoting the finding's remedy language) for ONLY these ids, changing nothing else in the artifact: ${missing.join(", ")}; unchanged-content findings may cite their existing verified loci (repair-beats-rejection: scoped rows-only repair, never a full re-emission)`
		: "";
	return { enabled, missing, malformedRows, bounce, feedback };
}

// ── WS3 (066 §2): premise-anchor resolution — the MECHANICAL layer ──────────
// Research (grill-2 Q5): path-exists/line-in-range checks give ~100% recall
// on "anchor nonexistent" and ~zero discrimination on "anchor SUPPORTS the
// claim" — the NLI/LLM support-derivation layer is the reviewer's job. This
// layer only asserts the anchor RESOLVES (the file exists in the worktree;
// the path:line form parses) — converting "dangling citation" from a
// reviewer-time discovery into a pre-review bounce.

export interface AnchorResolution {
	/** Loci that failed to resolve (file absent / unparseable form). */
	unresolved: string[];
	/** Loci checked (resolved + unresolved) — honesty on empty inputs. */
	checked: number;
}

/** Extract the path part of a locus (`path.md:18`, `path.md#anchor`, bare
 * path) and test existence via the injected predicate (pure for tests). */
export function resolveAnchors(loci: readonly string[], exists: (path: string) => boolean): AnchorResolution {
	const unresolved: string[] = [];
	let checked = 0;
	for (const raw of loci) {
		const locus = typeof raw === "string" ? raw.trim() : "";
		if (!locus) continue;
		checked++;
		// Strip a trailing :line(-col) or #fragment; spec-relative paths win.
		const pathPart = locus.replace(/:[0-9]+(-[0-9]+)?$/, "").replace(/#.*$/, "");
		if (!pathPart || pathPart.includes(" ")) { unresolved.push(locus); continue; }
		if (!exists(pathPart)) unresolved.push(locus);
	}
	return { unresolved, checked };
}

/** 067 grill-2 Q1: row-seam strict, array-seam LENIENT. Strip malformed
 * findingResolutions rows BEFORE schema validation (one bad row degrades to
 * "unmapped id" — the bounce's own semantics — instead of rejecting the
 * whole control into a full corrective re-emission; ExtractBench:
 * whole-payload strict rejection is catastrophic, row strictness is cheap).
 * Pure; returns the original object reference when nothing changes. */
export function stripMalformedResolutionRows<T extends Record<string, unknown>>(control: T): T {
	const v = control.findingResolutions;
	if (!Array.isArray(v)) return control;
	const clean = v.filter((r): r is Record<string, unknown> => r != null && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" && ((r as { id?: unknown }).id as string).trim() !== "");
	if (clean.length === v.length) return control;
	return { ...control, findingResolutions: clean };
}
