/**
 * WS5 (066 §2) — the claim-level verdict cache: pure core.
 *
 * THE NOVEL SYNTHESIS (066 §1.2: no published system caches claim-level LLM
 * verification verdicts; the invalidation contract transfers from Bazel
 * action keys / rustc red-green / merge queues). Sound-by-construction:
 *  - V1 a claim is green ONLY via a verdict row whose key covers the current
 *    artifact+evidence state (no row ⇒ not green — a lazy reviewer cannot
 *    mint green);
 *  - V2 any change to a claim's evidence set invalidates or re-verifies it
 *    (adjacency: shared-cited-entity + suspect links + globalDeps);
 *  - V3 disagreement ⇒ entry dropped + escalated, never averaged;
 *  - V4 cached-FAIL never replays (Bazel auto precedent);
 *  - V5 verification-strength tier on every row (full / adjacent-closure /
 *    sampled / mechanical-only); probe budget weights weak tiers;
 *  - V6 audit selection unseals only after submission (sealed seeds are the
 *    node's concern; the cache never fabricates them);
 *  - V7 first-write-wins per key; divergences preserved as distrust signals.
 *
 * ACTIVATION GATE (066 §3 wave 2): land OFF (SUPER_DEV_VERDICT_CACHE) until
 * the measured re-verification share on real runs stays >30% — the WS0
 * economy line is the measurement.
 *
 * Pure: no fs, no spawns; hashing injectable for tests.
 */

import { createHash } from "node:crypto";

export type VerdictTier = "full" | "adjacent-closure" | "sampled" | "mechanical-only";

/** A claim as mechanically enumerated from the anchor grammar (INV-V1's
 * deterministic set — reviewers supply verdicts for THIS set only). */
export interface EnumeratedClaim {
	id: string;
	/** The claim's text (hashed into the key). */
	text: string;
	/** Cited evidence entities (file paths / pin ids / AC ids) — hashed via
	 * their CURRENT content digests by the caller. */
	citedEntities: string[];
}

export interface VerdictRow {
	claimId: string;
	verdict: "pass" | "fail";
	tier: VerdictTier;
	/** The evidence-state digest the verdict was rendered against. */
	evidenceDigest: string;
	/** The resolution tuple (resolved model id + thinking + rubric version). */
	verifier: string;
}

export interface CacheKeyInput {
	claimText: string;
	/** Digest of every cited file's CURRENT content (the caller hashes). */
	evidenceDigest: string;
	verifier: string;
}

export function verdictCacheKey(input: CacheKeyInput): string {
	return createHash("sha256").update(`${input.claimText}\u0000${input.evidenceDigest}\u0000${input.verifier}`).digest("hex").slice(0, 24);
}

/** The green manifest for a round: which enumerated claims HIT under
 * unchanged keys (V1: a claim with no row, a FAILED row, or a key mismatch
 * is NOT green). */
export interface GreenManifest {
	green: string[];
	/** Claims needing fresh verification (delta + adjacency-closure). */
	toVerify: string[];
	/** Distrust signals: keys where a stored row disagrees with a candidate
	 * (V3/V7 — dropped, never averaged). */
	divergences: string[];
}

export function computeGreenManifest(input: {
	claims: readonly EnumeratedClaim[];
	stored: ReadonlyMap<string, VerdictRow>;
	candidates: readonly VerdictRow[];
	currentEvidenceDigest: (claim: EnumeratedClaim) => string;
	verifier: string;
	/** Entities changed this round — the adjacency closure input (V2). */
	changedEntities: ReadonlySet<string>;
	/** globalDependencies analog: when true, EVERY claim re-verifies (spec
	 * control block / rubric changed — the untraceable-shared-state hatch). */
	globalInvalidation?: boolean;
}): GreenManifest {
	const candidateByKey = new Map<string, VerdictRow>();
	for (const c of input.candidates) candidateByKey.set(c.claimId, c);
	const green: string[] = [];
	const toVerify: string[] = [];
	const divergences: string[] = [];
	for (const claim of input.claims) {
		const key = verdictCacheKey({ claimText: claim.text, evidenceDigest: input.currentEvidenceDigest(claim), verifier: input.verifier });
		const stored = input.stored.get(key);
		const candidate = candidateByKey.get(claim.id);
		// V3/V7: disagreement between a stored row and this round's candidate
		// invalidates the entry and escalates.
		if (stored && candidate && stored.verdict !== candidate.verdict) {
			divergences.push(claim.id);
			toVerify.push(claim.id);
			continue;
		}
		// V2: adjacency — a claim citing a changed entity always re-verifies.
		const citesChanged = claim.citedEntities.some((e) => input.changedEntities.has(e));
		if (input.globalInvalidation || citesChanged || !stored || stored.verdict !== "pass") {
			toVerify.push(claim.id);
			continue;
		}
		green.push(claim.id);
	}
	return { green, toVerify, divergences };
}

/** CSP-1 (MIL-STD-1235B, grill-3 Q4): 100% audit until i consecutive clean
 * rounds, then fraction f; any audited false verdict reverts to 100%. The
 * probe-state transition, pure. */
export interface CspState { mode: "full" | "fraction"; cleanStreak: number; }

export function cspTransition(state: CspState, auditClean: boolean, opts: { i: number; f: number }): CspState {
	if (!auditClean) return { mode: "full", cleanStreak: 0 };
	const streak = state.cleanStreak + 1;
	return streak >= opts.i ? { mode: "fraction", cleanStreak: streak } : { mode: "full", cleanStreak: streak };
}

/** The zero-acceptance probe size (grill-2 Q2): n ≥ ln(β)/ln(1−p),
 * independent of lot size; N < n ⇒ census. */
export function probeSampleSize(lotSize: number, beta = 0.1, p = 0.05): number {
	const n = Math.ceil(Math.log(beta) / Math.log(1 - p));
	return Math.max(1, Math.min(lotSize, n));
}

/** The activation switch — OFF by default until the wave-2 gate measurement
 * (re-verification share > 30% on real runs). Lazy env read. */
export function verdictCacheEnabled(env: (k: string) => string | undefined = (k) => process.env[k]): boolean {
	const v = env("SUPER_DEV_VERDICT_CACHE");
	return v === "1" || v === "true" || v === "yes";
}
