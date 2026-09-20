/**
 * WS7 (066 §2) — the fan-out core: closure sharding, minority veto,
 * fact-sheet provenance. L0 pins.
 */

import { describe, it, expect } from "vitest";
import { assignShards, claimComponents, mergeShardVerdicts, factSheetBlock, factSheetRow, type ShardVerdict } from "../src/convergence-economy/review-fanout.ts";
import type { EnumeratedClaim } from "../src/convergence-economy/verdict-cache.ts";

const c = (id: string, ...entities: string[]): EnumeratedClaim => ({ id, text: `t-${id}`, citedEntities: entities });

describe("claimComponents (closure over shared cited entities)", () => {
	it("claims sharing an entity form ONE component (never split)", () => {
		const comps = claimComponents([c("A", "f1.md"), c("B", "f1.md"), c("C", "f2.md")]);
		expect(comps.some((x) => x.includes("A") && x.includes("B"))).toBe(true);
		expect(comps.some((x) => x.includes("C") && !x.includes("A"))).toBe(true);
	});
	it("transitive: A-f1, f1-f2 chains merge", () => {
		const comps = claimComponents([c("A", "f1", "f2"), c("B", "f2", "f3"), c("D", "f9")]);
		const big = comps.find((x) => x.includes("A"))!;
		expect(big).toContain("B");
		expect(comps.some((x) => x.includes("D") && x.length === 1)).toBe(true);
	});
	it("deterministic: same input ⇒ same output ordering", () => {
		const claims = [c("A", "f1"), c("B", "f2"), c("C", "f1"), c("D", "f3"), c("E", "f2")];
		expect(JSON.stringify(claimComponents(claims))).toBe(JSON.stringify(claimComponents(claims)));
	});
});

describe("assignShards (largest-first packing; size floor; K=1)", () => {
	it("below the floor everything is ONE shard (parallelism overhead loses)", () => {
		const shards = assignShards([c("A", "f1"), c("B", "f2")], 3);
		expect(shards.length).toBe(1);
	});
	it("large loads split into K shards without splitting components", () => {
		const claims = Array.from({ length: 12 }, (_, i) => c(`C${i}`, `f${i}.md`));
		const shards = assignShards(claims, 3);
		expect(shards.length).toBe(3);
		const flat = shards.flat().sort();
		expect(flat).toEqual(claims.map((x) => x.id).sort());
	});
	it("a shared-entity component stays whole across the split", () => {
		const claims = [c("A", "f1"), c("B", "f1"), ...Array.from({ length: 10 }, (_, i) => c(`X${i}`, `fx${i}.md`))];
		const shards = assignShards(claims, 3);
		const withA = shards.find((s) => s.includes("A"))!;
		expect(withA).toContain("B");
	});
});

describe("mergeShardVerdicts (MINORITY VETO — majority is the measured-worst option)", () => {
	const all = ["C1", "C2", "C3"] as const;
	it("unanimous claims reach consensus; ANY dissent escalates (never averaged)", () => {
		const shards: ShardVerdict<string>[] = [
			{ shard: 0, claims: ["C1", "C2", "C3"], verdicts: { C1: "pass", C2: "pass", C3: "pass" } },
			{ shard: 1, claims: ["C1", "C2", "C3"], verdicts: { C1: "pass", C2: "fail", C3: "pass" } },
		];
		const out = mergeShardVerdicts(shards, [...all]);
		expect(out.consensus.C1).toBe("pass");
		expect(out.contested).toEqual(["C2"]);
	});
	it("claims NO shard reported are uncovered (no verdict ⇒ not green — INV-V1)", () => {
		const out = mergeShardVerdicts([{ shard: 0, claims: ["C1"], verdicts: { C1: "pass" } }], [...all]);
		expect(out.uncovered).toEqual(["C2", "C3"]);
	});
});

describe("factSheet (provenance-stamped rows)", () => {
	it("rows render as JSON lines with the provisos; empty rows → empty block", () => {
		const row = factSheetRow("PYTHON_SCRIPTS has 14 members", "grep -c src/schemas.ts", "abc123", { specRev: "r7", toolVersion: "git-2.43", collectedAt: "2026-09-20T23:00:00Z" });
		const block = factSheetBlock([row]);
		expect(block).toContain("## Grounding fact-sheet");
		const parsed = JSON.parse(block.split("\n")[1]!);
		expect(parsed.provenance.specRev).toBe("r7");
		expect(factSheetBlock([])).toBe("");
	});
});
