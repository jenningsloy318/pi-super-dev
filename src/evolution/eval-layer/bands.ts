import type { GoldenCase } from "./cases.ts";
/**
 * eval-layer — the σ-band baseline key (M2 fold). Layer doc: ./closure.ts.
 */
import { join } from "node:path";

// ─── Band key (M2 / §8.3 fold — P1 ships the KEY SHAPE only) ────────────────

export const BAND_KEY_SEP = "::";

/**
 * The σ-band baseline key triple (M2 fold): (caseSet, caseVersion,
 * rubricVersion). Case revision and rubric re-wording each re-key the band —
 * old and new rows never silently mix. The proposalVersion axis (§8.3 —
 * proposal/model-pin changes re-key too) lands with the D4 flywheel (P3) as a
 * NAMED amendment to this shape; P1 pins the triple. Pure string concat;
 * throws on malformed input (programmer-facing — a silently malformed band
 * key corrupts drift history).
 */
export function bandKey(caseSet: string, caseVersion: number, rubricVersion: string): string {
	if (typeof caseSet !== "string" || caseSet.trim() === "" || caseSet.includes(BAND_KEY_SEP)) {
		throw new Error(`bandKey: caseSet must be a non-empty string without "${BAND_KEY_SEP}", got: ${JSON.stringify(caseSet)}`);
	}
	if (typeof caseVersion !== "number" || !Number.isInteger(caseVersion) || caseVersion < 1) {
		throw new Error(`bandKey: caseVersion must be an integer ≥ 1, got: ${JSON.stringify(caseVersion)}`);
	}
	if (typeof rubricVersion !== "string" || rubricVersion.trim() === "" || rubricVersion.includes(BAND_KEY_SEP)) {
		throw new Error(`bandKey: rubricVersion must be a non-empty string without "${BAND_KEY_SEP}", got: ${JSON.stringify(rubricVersion)}`);
	}
	return [caseSet, `case-v${caseVersion}`, `rubric-v${rubricVersion}`].join(BAND_KEY_SEP);
}

/**
 * The case's suite identity (F10): the explicit caseSet stamp when present,
 * else DERIVED from the target's layer identity — the stage arm when present,
 * else the agent arm (DEC-6 按层过滤: suites filter by layer). `fallback`
 * covers degenerate hand-built targets with no arms at all. bandKey itself
 * stays a pure 3-arg function; this is the seam that feeds it.
 */
export function caseSetOf(c: GoldenCase, fallback = "default"): string {
	if (c.caseSet !== undefined && c.caseSet !== "") return c.caseSet;
	if (c.target.stage !== undefined) return c.target.stage;
	if (c.target.agent !== undefined) return c.target.agent;
	return fallback;
}
