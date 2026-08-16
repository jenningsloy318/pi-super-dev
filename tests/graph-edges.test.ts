/**
 * R1 (dsh-09 v3): the dependency-edges table contract.
 *
 * (a) Coverage — every non-setup stage has ≥1 inbound edge (no orphan stage
 *     invisible to invalidation/docs).
 * (b) Acyclicity — topological sort succeeds (replan invalidation must
 *     terminate).
 * (c) Signature tripwires — the artifact-read parameters each edge encodes are
 *     grepped from src/prompts.ts: adding a prompt dependency without
 *     updating src/graph/edges.ts fails CI (the exact drift class the table
 *     exists to prevent).
 * (d) downstreamOf reachability — the D3 full-invalidation set.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EDGES, STAGE_IDS, downstreamOf, inboundEdges } from "../src/graph/edges.ts";

describe("graph edges (R1)", () => {
	it("every non-setup stage has at least one inbound edge", () => {
		for (const id of STAGE_IDS) {
			if (id === "setup") continue;
			expect(inboundEdges(id).length, `stage "${id}" has no inbound edge`).toBeGreaterThan(0);
		}
	});

	it("every edge endpoint is a known skeleton stage", () => {
		const known = new Set<string>(STAGE_IDS);
		for (const e of EDGES) {
			expect(known.has(e.from), `unknown "from" ${e.from}`).toBe(true);
			expect(known.has(e.to), `unknown "to" ${e.to}`).toBe(true);
			expect(e.rationale.trim().length).toBeGreaterThan(10);
		}
	});

	it("the graph is acyclic (topological sort succeeds)", () => {
		const indeg = new Map<string, number>();
		for (const id of STAGE_IDS) indeg.set(id, 0);
		for (const e of EDGES) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
		const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
		const order: string[] = [];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			order.push(cur);
			for (const e of EDGES.filter((x) => x.from === cur)) {
				const d = (indeg.get(e.to) ?? 0) - 1;
				indeg.set(e.to, d);
				if (d === 0) queue.push(e.to);
			}
		}
		expect(order.length, "a cycle exists in EDGES").toBe(STAGE_IDS.length);
	});

	// (c) Signature tripwires — the verified prompt reads. If a prompt signature
	// drops or renames one of these artifact parameters, the corresponding edge
	// (and possibly the whole table) must be revisited: the test FAILS LOUD.
	const promptsSource = readFileSync(new URL("../src/prompts.ts", import.meta.url), "utf8");

	const tripwire = (fnName: string, mustContain: string, edge: string) => {
		it(`tripwire: ${fnName} still reads ${mustContain} (edge ${edge})`, () => {
			const sig = promptsSource.match(new RegExp(`export function ${fnName}\\([^)]*\\)`));
			expect(sig, `${fnName} signature not found`).toBeTruthy();
			expect(String(sig?.[0]), `${fnName} no longer reads ${mustContain}`).toContain(mustContain);
		});
	};

	tripwire("buildBddPrompt", "requirements", "requirements→bdd");
	tripwire("buildResearchPrompt", "requirements", "requirements→research");
	tripwire("buildResearchPrompt", "bdd", "bdd→research");
	tripwire("buildDebugPrompt", "research", "research→debug");
	tripwire("buildAssessmentPrompt", "debug", "debug→assessment");
	tripwire("buildDesignPrompt", "assessment", "assessment→design");
	tripwire("buildPrototypePrompt", "design", "design→prototype");
	tripwire("buildSpecPrompt", "prototype", "prototype→spec");
	tripwire("buildTddPrompt", "bddControl", "bdd→implementation");
	tripwire("buildCodeReviewPrompt", "specControl", "spec→verify");
	tripwire("buildDocsPrompt", "specControl", "spec→docs");

	it("downstreamOf(requirements) is the full downstream chain (D3 full invalidation)", () => {
		expect(downstreamOf("requirements")).toEqual([
			"assessment", "bdd", "cleanup", "debug", "design", "docs", "implementation", "merge",
			"merge-verify", "preMergeBuild", "prototype", "research", "spec", "verify",
		].sort());
	});

	it("downstreamOf(spec) invalidates implementation through the close-out chain but NOT the upstream artifact stages", () => {
		const d = downstreamOf("spec");
		expect(d).toContain("implementation");
		expect(d).toContain("verify");
		expect(d).toContain("docs");
		expect(d).toContain("merge-verify");
		expect(d).not.toContain("requirements");
		expect(d).not.toContain("bdd");
		expect(d).not.toContain("design");
		expect(d).not.toContain("research");
	});

	it("downstreamOf(merge) is empty (terminal); downstreamOf(setup) is everything else", () => {
		expect(downstreamOf("merge-verify")).toEqual([]);
		expect(downstreamOf("merge")).toEqual(["merge-verify"]);
		expect(downstreamOf("setup").length).toBe(STAGE_IDS.length - 1);
	});
});
