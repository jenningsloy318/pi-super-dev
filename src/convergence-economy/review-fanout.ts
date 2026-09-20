/**
 * WS7 (066 §2) — the review fan-out core: closure-component sharding +
 * minority-veto merge + the fact-sheet row shape.
 *
 * Research grounding (066 §1.2/§2): shard on the DEPENDENCY CLOSURE, never
 * round-robin (map-reduce's documented failure classes are inter-chunk
 * dependencies and conflicts — ACL 2025); K=3 sits at the literature
 * optimum (3–4 debaters; same-model diversity beyond 2–3 yields nothing);
 * MAJORITY VOTING IS THE MEASURED WORST OPTION for catching bad artifacts
 * (κ 0.07–0.16 inter-judge; 33–67% intransitivity) — minority veto (any
 * dissent escalates; 2.8% vs 14.8% max error at TPR 95.5%) is the rule.
 * Fact-sheet rows carry PROVENANCE stamps (the "lost provisos" mechanism —
 * a compression without provisos is where hallucination breeds; the stamp
 * convention is design-novel, disclosed).
 *
 * Pure: no I/O; deterministic (same input ⇒ same shards).
 */

import type { EnumeratedClaim } from "./verdict-cache.ts";

// ── Sharding: connected components over shared cited entities ───────────────

/** Union-find over cited entities; claims sharing an entity land in ONE
 * component (the closure — splitting it would hide exactly the interaction
 * defects the adjacency rule exists to catch). */
export function claimComponents(claims: readonly EnumeratedClaim[]): string[][] {
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let root = parent.get(x) ?? x;
		if (root === x) { parent.set(x, x); return x; }
		root = find(root);
		parent.set(x, root);
		return root;
	};
	const union = (a: string, b: string) => {
		const ra = find(a), rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	for (const c of claims) {
		find(c.id);
		const [first, ...rest] = c.citedEntities.length > 0 ? c.citedEntities : [c.id];
		find(first);
		for (const e of rest) union(first, e);
		union(c.id, first);
	}
	const groups = new Map<string, string[]>();
	for (const c of claims) {
		const root = find(c.id);
		const list = groups.get(root) ?? [];
		list.push(c.id);
		groups.set(root, list);
	}
	// Deterministic: sort members, then components by (size desc, min-id).
	return [...groups.values()]
		.map((ids) => ids.sort())
		.sort((a, b) => (b.length - a.length) || (a[0]! < b[0]! ? -1 : 1));
}

/** Pack components into K bins (largest-first greedy). Below the size floor
 * (or K ≤ 1) everything lands in ONE shard — parallelism overhead loses at
 * tiny loads (no published break-even; the floor is set per-deployment). */
export function assignShards(claims: readonly EnumeratedClaim[], k: number, minShardLoad = 3): string[][] {
	const components = claimComponents(claims);
	if (k <= 1 || claims.length < k * minShardLoad) return [components.flat()];
	const bins: string[][] = Array.from({ length: k }, () => []);
	const load = Array.from({ length: k }, () => 0);
	for (const comp of components) {
		let target = 0;
		for (let i = 1; i < k; i++) if (load[i]! < load[target]!) target = i;
		bins[target]!.push(...comp);
		load[target]! += comp.length;
	}
	return bins.filter((b) => b.length > 0);
}

// ── The merge rule: minority veto ────────────────────────────────────────────

export interface ShardVerdict<TClaim extends string = string> {
	shard: number;
	/** The claims this shard judged. */
	claims: TClaim[];
	/** Per-claim verdicts ("pass" | "fail" | custom strings — the veto rule
	 * only needs agreement). */
	verdicts: Record<string, string>;
}

export interface MergeResult<TClaim extends string = string> {
	/** Claims every judging shard agreed on. */
	consensus: Record<TClaim, string>;
	/** Claims with ANY dissent — escalated to ONE tie-break pass (never
	 * averaged; P8: ≤1 tie-break per round, ≤2 per stage at the caller). */
	contested: TClaim[];
	/** Claims no shard reported (the orchestrator's coverage gap — INV-V1:
	 * no verdict ⇒ not green). */
	uncovered: TClaim[];
}

export function mergeShardVerdicts<TClaim extends string>(shards: readonly ShardVerdict<TClaim>[], allClaims: readonly TClaim[]): MergeResult<TClaim> {
	const byClaim = new Map<TClaim, Map<string, number>>();
	for (const shard of shards) {
		for (const claim of shard.claims) {
			const v = shard.verdicts[claim];
			if (v === undefined) continue;
			const counts = byClaim.get(claim) ?? new Map<string, number>();
			counts.set(v, (counts.get(v) ?? 0) + 1);
			byClaim.set(claim, counts);
		}
	}
	const consensus = {} as Record<TClaim, string>;
	const contested: TClaim[] = [];
	for (const claim of allClaims) {
		const counts = byClaim.get(claim);
		if (!counts || counts.size === 0) continue; // uncovered below
		if (counts.size === 1) consensus[claim] = [...counts.keys()][0]!;
		else contested.push(claim);
	}
	const uncovered = allClaims.filter((c) => !byClaim.has(c));
	return { consensus, contested, uncovered };
}

// ── The fact-sheet row (provenance-stamped — WS7b) ──────────────────────────

export interface FactSheetRow {
	/** The asserted fact (deterministic output, never narrative). */
	fact: string;
	/** The command/probe that produced it (reproducibility). */
	command: string;
	/** Digest of the output at collection time (staleness detection). */
	outputDigest: string;
	/** Provenance: the provisos a bare fact would lose (066 §2 WS7b). */
	provenance: { specRev: string; toolVersion: string; collectedAt: string };
}

export function factSheetRow(fact: string, command: string, outputDigest: string, provenance: FactSheetRow["provenance"]): FactSheetRow {
	return { fact, command, outputDigest, provenance };
}

/** The prompt block: rows as JSON lines (structured context — smallest
 * high-signal token set; minimal per context-rot). */
export function factSheetBlock(rows: readonly FactSheetRow[]): string {
	if (rows.length === 0) return "";
	return [
		"## Grounding fact-sheet (deterministic, provenance-stamped — re-derive anything that looks wrong)",
		...rows.map((r) => JSON.stringify(r)),
	].join("\n");
}
