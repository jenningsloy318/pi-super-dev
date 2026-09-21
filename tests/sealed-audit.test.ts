/**
 * The sealed audit subset (066 WS1 layer b, 067 R6-Q1/R7) — L0 pins.
 */

import { describe, it, expect } from "vitest";
import { protectedAuditIds, mkSealToken, sealedAuditLogLine, sealedAuditPromptBlock, selectSealedAuditSubset } from "../src/convergence-economy/sealed-audit.ts";
import type { FindingResolution } from "../src/convergence-economy/finding-resolution-gate.ts";

const row = (id: string): FindingResolution => ({ id, loci: [`${id}.md:1`], note: "remedy quote" });
const rows = Array.from({ length: 10 }, (_, i) => row(`CF-${i}`));

describe("selectSealedAuditSubset", () => {
	it("deterministic + reconstructable: same seal ⇒ same selection; the ranking digest is exposed per row", () => {
		const a = selectSealedAuditSubset({ rows, seal: "tok", protectedIds: new Set() });
		const b = selectSealedAuditSubset({ rows, seal: "tok", protectedIds: new Set() });
		expect(a.audited.map((r) => r.id)).toEqual(b.audited.map((r) => r.id));
		expect(Object.keys(a.digests)).toHaveLength(10);
	});
	it("a different seal ⇒ a different subset (unpredictable to the writer)", () => {
		const a = selectSealedAuditSubset({ rows, seal: "tok1", protectedIds: new Set() });
		const c = selectSealedAuditSubset({ rows, seal: "tok2", protectedIds: new Set() });
		expect(a.audited.map((r) => r.id).join(",")).not.toBe(c.audited.map((r) => r.id).join(","));
	});
	it("protected ids are unconditional (even past the target)", () => {
		const sel = selectSealedAuditSubset({ rows, seal: "tok", protectedIds: new Set(["CF-9"]), fraction: 0.3, minRows: 3 });
		expect(sel.audited.some((r) => r.id === "CF-9")).toBe(true);
	});
	it("census below minRows", () => {
		const sel = selectSealedAuditSubset({ rows: [row("A"), row("B")], seal: "tok", protectedIds: new Set(), fraction: 0.4, minRows: 3 });
		expect(sel.audited.length).toBe(2);
		expect(sel.skipped.length).toBe(0);
	});
	it("the fraction bounds the sampled size", () => {
		const sel = selectSealedAuditSubset({ rows, seal: "tok", protectedIds: new Set(), fraction: 0.4, minRows: 1 });
		expect(sel.audited.length).toBe(Math.ceil(10 * 0.4));
	});
});

describe("protectedAuditIds (never balloons — resolved rows leave)", () => {
	const f = (over: Partial<Parameters<typeof protectedAuditIds>[0][number]> = {}) => ({ id: "X", blocking: true, severity: "high", status: "open", ...over });
	it("unresolved blocking high/P0/P1/critical enter", () => {
		expect(protectedAuditIds([f({ id: "a" }), f({ id: "b", severity: "P0" }), f({ id: "c", severity: "P1" }), f({ id: "d", severity: "critical" })]).size).toBe(4);
	});
	it("resolved rows LEAVE; non-blocking and low severity never enter", () => {
		const out = protectedAuditIds([f({ id: "a", status: "verified" }), f({ id: "b", status: "addressed" }), f({ id: "c", status: "superseded" }), f({ id: "d", blocking: false }), f({ id: "e", severity: "P2" })]);
		expect(out.size).toBe(0);
	});
});

describe("the commitment + prompt block", () => {
	it("the log line names the seal, the count, the ids, and the reconstruction recipe (append-only ordering = the proof)", () => {
		const sel = selectSealedAuditSubset({ rows, seal: "sd-audit-test", protectedIds: new Set() });
		const line = sealedAuditLogLine(sel);
		expect(line).toContain("seal=sd-audit-test");
		expect(line).toContain("sha256(seal,id)");
		expect(line).toContain(sel.audited[0]!.id);
	});
	it("the prompt block demands a VERBATIM quote per row (a bare pass is not an audit) and rides priorFindingResolutions", () => {
		const sel = selectSealedAuditSubset({ rows: [row("CF-1")], seal: "t", protectedIds: new Set() });
		const block = sealedAuditPromptBlock(sel);
		expect(block).toContain("priorFindingResolutions");
		expect(block).toContain("VERBATIM quote");
		expect(block.split("\n").slice(2).every((l) => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
		expect(sealedAuditPromptBlock({ audited: [], skipped: [], sealToken: "t", digests: {} })).toBe("");
	});
	it("sealToken is fresh per call (unpredictable shape)", () => {
		expect(mkSealToken()).not.toBe(mkSealToken());
	});
});
