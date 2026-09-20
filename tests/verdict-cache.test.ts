/**
 * WS5 (066 §2) — the verdict-cache pure core: INV-V1..V7 pins.
 */

import { describe, it, expect } from "vitest";
import { computeGreenManifest, cspTransition, probeSampleSize, verdictCacheEnabled, verdictCacheKey, type EnumeratedClaim, type VerdictRow } from "../src/convergence-economy/verdict-cache.ts";

const claim = (id: string, text: string, cited: string[] = ["01-requirements.md"]): EnumeratedClaim => ({ id, text, citedEntities: cited });
const row = (claimId: string, verdict: "pass" | "fail", tier: VerdictRow["tier"] = "full"): VerdictRow => ({ claimId, verdict, tier, evidenceDigest: "digest-A", verifier: "glm-5.3-flash:high@rubric-v1" });

const baseInput = (over: Partial<Parameters<typeof computeGreenManifest>[0]> = {}) => ({
	claims: [claim("C1", "PYTHON_SCRIPTS has 14 members"), claim("C2", "the dispatch fails loud", ["src/runtime-dispatch.ts"])],
	stored: new Map<string, VerdictRow>([
		[verdictCacheKey({ claimText: "PYTHON_SCRIPTS has 14 members", evidenceDigest: "digest-A", verifier: "glm-5.3-flash:high@rubric-v1" }), row("C1", "pass")],
		[verdictCacheKey({ claimText: "the dispatch fails loud", evidenceDigest: "digest-B", verifier: "glm-5.3-flash:high@rubric-v1" }), row("C2", "pass")],
	]),
	candidates: [] as VerdictRow[],
	currentEvidenceDigest: (c: EnumeratedClaim) => (c.id === "C1" ? "digest-A" : "digest-B"),
	verifier: "glm-5.3-flash:high@rubric-v1",
	changedEntities: new Set<string>(),
	...over,
});

describe("computeGreenManifest (INV-V1..V7)", () => {
	it("V1: unchanged evidence + stored pass ⇒ green; no row ⇒ toVerify (not green)", () => {
		const out = computeGreenManifest(baseInput({ claims: [claim("C1", "PYTHON_SCRIPTS has 14 members"), claim("C3", "new claim", ["x.ts"])] }));
		expect(out.green).toEqual(["C1"]);
		expect(out.toVerify).toContain("C3");
	});
	it("V2: a cited entity in the changed set re-verifies (adjacency closure)", () => {
		const out = computeGreenManifest(baseInput({ changedEntities: new Set(["src/runtime-dispatch.ts"]) }));
		expect(out.green).toEqual(["C1"]);
		expect(out.toVerify).toContain("C2");
	});
	it("V2: an evidence-digest change misses the key ⇒ re-verify (content addressing)", () => {
		const out = computeGreenManifest(baseInput({ currentEvidenceDigest: () => "digest-CHANGED" }));
		expect(out.green).toEqual([]);
		expect(out.toVerify.length).toBe(2);
	});
	it("V2: globalInvalidation (spec control/rubric change) re-verifies everything", () => {
		const out = computeGreenManifest(baseInput({ globalInvalidation: true }));
		expect(out.green).toEqual([]);
	});
	it("V3: stored-vs-candidate disagreement ⇒ divergence + re-verify (never averaged)", () => {
		const out = computeGreenManifest(baseInput({ candidates: [row("C1", "fail")] }));
		expect(out.divergences).toContain("C1");
		expect(out.toVerify).toContain("C1");
		expect(out.green).not.toContain("C1");
	});
	it("V4: a stored FAIL never replays as green", () => {
		const out = computeGreenManifest(baseInput({
			stored: new Map([[verdictCacheKey({ claimText: "PYTHON_SCRIPTS has 14 members", evidenceDigest: "digest-A", verifier: "glm-5.3-flash:high@rubric-v1" }), row("C1", "fail")]]),
		}));
		expect(out.green).not.toContain("C1");
	});
	it("verifier identity is part of the key (a model/thinking change misses)", () => {
		const out = computeGreenManifest(baseInput({ verifier: "glm-5.3-flash:low@rubric-v1" }));
		expect(out.green).toEqual([]);
	});
});

describe("cspTransition (grill-3 Q4: CSP-1 across rounds)", () => {
	it("100% until i clean rounds, then fraction; any miss reverts to 100%", () => {
		let s: { mode: string; cleanStreak: number } = { mode: "full", cleanStreak: 0 };
		s = cspTransition(s as never, true, { i: 3, f: 0.2 });
		expect(s.mode).toBe("full");
		s = cspTransition(s as never, true, { i: 3, f: 0.2 });
		expect(s.mode).toBe("full");
		s = cspTransition(s as never, true, { i: 3, f: 0.2 });
		expect(s.mode).toBe("fraction");
		s = cspTransition(s as never, false, { i: 3, f: 0.2 });
		expect(s.mode).toBe("full");
		expect(s.cleanStreak).toBe(0);
	});
});

describe("probeSampleSize (grill-2 Q2: zero-acceptance, census below n)", () => {
	it("n ≥ ln(β)/ln(1−p) independent of lot size; N < n ⇒ census", () => {
		expect(probeSampleSize(1000)).toBe(45); // β=0.10, p=5%
		expect(probeSampleSize(10)).toBe(10); // census
		expect(probeSampleSize(1000, 0.05, 0.02)).toBe(149);
	});
});

describe("verdictCacheEnabled (activation gate — OFF by default)", () => {
	it("defaults OFF; the three truthy spellings enable (lazy env)", () => {
		const env = (v?: string) => (k: string) => (k === "SUPER_DEV_VERDICT_CACHE" ? v : undefined);
		expect(verdictCacheEnabled(env(undefined))).toBe(false);
		expect(verdictCacheEnabled(env("1"))).toBe(true);
		expect(verdictCacheEnabled(env("true"))).toBe(true);
		expect(verdictCacheEnabled(env("0"))).toBe(false);
	});
});
