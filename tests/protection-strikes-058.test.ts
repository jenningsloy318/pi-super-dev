/**
 * 058 Wave 3 D-B (Layer 2) acceptance — execution-time protection intervals,
 * the two-strike bounded defense, and the strike-2 judge consumer.
 * docs/requirements/058-cross-phase-contract-architecture.md §3 Layer 2 + §4 D-B.
 *
 * Deterministic only (058 §5 D-B acceptance): real-git fixtures for the
 * strike-1 revert, pure-module coverage for derivation/detection/education,
 * fake-ctx agent interception for the judge consumer (scope + routes + the
 * escalate-now REFUSAL), and source pins for the stage wiring (zero attempt
 * cost, education re-prompt, state-key disjointness). Mirrors
 * tests/contract-writers-059.test.ts style.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import {
	buildProtectionEducationBlock,
	bumpProtectionStrike,
	detectProtectionViolations,
	deriveProtectionInterval,
	PROTECTION_STRIKE_BOUND,
	resetProtectionStrike,
	reviveProtectionInterval,
	serializeProtectionInterval,
	type ProtectionInterval,
} from "../src/stages/protection-interval.ts";
import {
	consumeProtectionBreachEscalation,
	PROTECTION_BREACH_ALLOWED_ROUTES,
	PROTECTION_BREACH_SCOPE,
} from "../src/review/protection-breach-consumer.ts";
import { restorePaths } from "../src/stages/implementation.ts";
import type { AgentCall, AgentResult, PipelineState, StageContext } from "../src/types.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The RAW run-2026-09-13 SCENARIO-014 shape (porcelain pathspec +
 *  byte-untouched message) — the 058 §0 S-A golden idiom. */
const SCENARIO_14_TEST = [
	'import { execSync } from "node:child_process";',
	'import { expect, it } from "vitest";',
	"",
	'it("SCENARIO-014 the frozen contract holds", () => {',
	'\tconst dirty = execSync("git status --porcelain -- src/schemas.ts").toString();',
	'\texpect(dirty, "src/schemas.ts must stay byte-untouched").toBe("");',
	"});",
].join("\n");

const FROZEN_CONTENT = "export const FROZEN = 1;\n";

function makeRepo(prefix: string, files: Record<string, string> = {}): { repo: string; git: (...args: string[]) => ReturnType<typeof spawnSync> } {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	for (const [rel, content] of Object.entries({ "src/schemas.ts": FROZEN_CONTENT, "tests/frozen.test.ts": SCENARIO_14_TEST, ...files })) {
		const p = join(repo, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	git("add", "-A");
	git("commit", "-qm", "seed");
	return { repo, git };
}

function writeRepo(repo: string, rel: string, content: string): void {
	const p = join(repo, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
}

/** A violation over a one-path interval (the SCENARIO-014 shape). */
function scenario14Violations(repo: string, declaredFootprint: string[] = []): ReturnType<typeof detectProtectionViolations> {
	const interval = deriveProtectionInterval(repo, undefined);
	return detectProtectionViolations(
		String(spawnSync("git", ["-C", repo, "status", "--porcelain", "-z", "--untracked-files=all"], { encoding: "utf8" }).stdout ?? "")
			.split("\0")
			.map((rec) => rec.slice(3))
			.filter(Boolean),
		declaredFootprint,
		interval,
	);
}

// ─── derivation ──────────────────────────────────────────────────────────────

describe("058 D-B — protection interval derivation (mechanical, entry-time, once per run)", () => {
	it("derives the protected set from the SCENARIO-014 idiom (porcelain pathspec + byte-untouched wording)", () => {
		const { repo } = makeRepo("sd-058-db-derive-");
		try {
			const interval = deriveProtectionInterval(repo, undefined);
			expect(interval.protectedPaths.has("src/schemas.ts")).toBe(true);
			const clause = interval.protectedPaths.get("src/schemas.ts")![0]!;
			expect(clause.locus.startsWith("tests/frozen.test.ts:")).toBe(true);
			expect(clause.clause.length).toBeGreaterThan(0); // the exact matched wording
			expect(clause.source).toBe("tests/frozen.test.ts");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("membership-count pins are NOT write-forbidden (grill R8: only the immutability class protects)", () => {
		const grammarTableTest = [
			'import { expect, it } from "vitest";',
			'import { DIMENSION_REGISTRY } from "../src/registry.ts";',
			"",
			'it("registry is closed", () => {',
			'\texpect(DIMENSION_REGISTRY.length, "src/registry.ts is pinned at exactly 14 members").toBe(14);',
			"});",
		].join("\n");
		const { repo } = makeRepo("sd-058-db-membership-", { "tests/registry.test.ts": grammarTableTest, "src/registry.ts": "export const DIMENSION_REGISTRY: string[] = [];\n", "tests/frozen.test.ts": grammarTableTest });
		try {
			// overwrite the default frozen fixture so ONLY the membership pin exists
			writeRepo(repo, "tests/frozen.test.ts", grammarTableTest);
			const interval = deriveProtectionInterval(repo, undefined);
			expect(interval.protectedPaths.size).toBe(0); // exactly-N is amendable, not forbidden
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("repo-invariants.json declared protected paths join the interval (the explicit-declaration arm)", () => {
		const { repo } = makeRepo("sd-058-db-invariants-", { "repo-invariants.json": JSON.stringify({ protected: ["src/legacy.ts"] }) });
		try {
			const interval = deriveProtectionInterval(repo, undefined);
			expect(interval.protectedPaths.has("src/legacy.ts")).toBe(true);
			expect(interval.protectedPaths.get("src/legacy.ts")![0]!.source).toBe("repo-invariants.json");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("an owner-approved amendmentFamily exempts its sharedFile (the 059-R1A seam)", () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-058-db-knowledge-"));
		const { repo } = makeRepo("sd-058-db-exempt-");
		try {
			writeRepo(specDir, ".knowledge.json", JSON.stringify({ stages: { design: { timestamp: "t", agent: "a", data: { amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: ["pin-x"], exemptions: [], docUpdates: [] }] } } } }));
			const interval = deriveProtectionInterval(repo, specDir);
			expect(interval.protectedPaths.has("src/schemas.ts")).toBe(false);
			expect(interval.scanLines.some((l) => l.startsWith("exemption: src/schemas.ts"))).toBe(true); // P10: exempted, never silently dropped
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("absent idioms ⇒ empty interval: detection no-ops with zero false positives", () => {
		const { repo } = makeRepo("sd-058-db-empty-", { "tests/frozen.test.ts": 'it("plain", () => { expect(1).toBe(1); });\n' });
		try {
			const interval = deriveProtectionInterval(repo, undefined);
			expect(interval.protectedPaths.size).toBe(0);
			expect(detectProtectionViolations(["src/schemas.ts", "anything/else.ts"], ["src/schemas.ts"], interval)).toEqual([]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("the interval serializes + revives for control persistence (malformed ⇒ null ⇒ re-derive)", () => {
		const { repo } = makeRepo("sd-058-db-ser-");
		try {
			const interval = deriveProtectionInterval(repo, undefined);
			const revived = reviveProtectionInterval(serializeProtectionInterval(interval));
			expect(revived).not.toBeNull();
			expect(revived!.protectedPaths.has("src/schemas.ts")).toBe(true);
			expect(reviveProtectionInterval("nonsense")).toBeNull();
			expect(reviveProtectionInterval([["src/x.ts", []]])).toBeNull(); // empty clause list is malformed
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

// ─── strike state ────────────────────────────────────────────────────────────

describe("058 D-B — strike state: phaseProtectionStrikes (per phase, disjoint key)", () => {
	it("counters are PER PHASE — a second phase's first violation is strike 1, not strike 2 (reset per phase)", () => {
		const strikes: Record<string, number> = {};
		expect(bumpProtectionStrike(strikes, "phase-01")).toBe(1);
		expect(bumpProtectionStrike(strikes, "phase-01")).toBe(2);
		expect(bumpProtectionStrike(strikes, "phase-02")).toBe(1); // disjoint per-phase namespace
		expect(strikes).toEqual({ "phase-01": 2, "phase-02": 1 });
		resetProtectionStrike(strikes, "phase-01");
		expect(bumpProtectionStrike(strikes, "phase-01")).toBe(1); // fresh interval after reset
	});

	it("the state key is phaseProtectionStrikes on the implementation control (disjoint from 059's writerMetadataRetryUsed)", () => {
		const impl = readFileSync(new URL("../src/stages/implementation.ts", import.meta.url), "utf8");
		const validators = readFileSync(new URL("../src/review/contract-validators.ts", import.meta.url), "utf8");
		expect(impl).toContain("phaseProtectionStrikes");
		expect(impl).toContain("phaseProtectionStrikes,"); // persisted on the control across §D iterations
		// Disjointness = the KEY USAGE form (contract-validators.ts writes the
		// template literal `writerMetadataRetryUsed:${stage}`); doc-comment mentions
		// of the disjointness rule itself are fine (adversarial S8-adjacent).
		expect(impl).not.toContain("writerMetadataRetryUsed:${");
		expect(validators).not.toContain("phaseProtectionStrikes:"); // the 059 colon-form disjointness pin stays true
		expect(PROTECTION_STRIKE_BOUND).toBe(2); // P8: exactly two strikes, then a judged route
	});
});

// ─── strike 1: revert + education at zero attempt cost ───────────────────────

describe("058 D-B — strike 1: revert to the phase entry state + education block", () => {
	it("a tracked protected-path edit is detected and restored to the EXACT prior content", () => {
		const { repo, git } = makeRepo("sd-058-db-s1-");
		try {
			writeRepo(repo, "src/schemas.ts", "export const FROZEN = 2; // tampered\n");
			const violations = scenario14Violations(repo);
			expect(violations.map((v) => v.path)).toEqual(["src/schemas.ts"]);
			expect(violations[0]!.detectedBy).toContain("porcelain");
			restorePaths(repo, violations.map((v) => v.path)); // the strike-1 revert (the checkpoint chain = entry state)
			expect(readFileSync(join(repo, "src/schemas.ts"), "utf8")).toBe(FROZEN_CONTENT); // byte-exact restore
			expect(String(git("status", "--porcelain", "--", "src/schemas.ts").stdout).trim()).toBe(""); // clean
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("a CREATED protected file (untracked) is removed by the revert — restore covers the clean case", () => {
		const { repo, git } = makeRepo("sd-058-db-s1c-", { "repo-invariants.json": JSON.stringify({ protected: ["src/legacy.ts"] }) });
		try {
			writeRepo(repo, "src/legacy.ts", "created by the implementer\n");
			const violations = scenario14Violations(repo, ["src/legacy.ts"]);
			expect(violations.map((v) => v.path)).toContain("src/legacy.ts");
			expect(violations.find((v) => v.path === "src/legacy.ts")!.detectedBy).toContain("declared-footprint");
			restorePaths(repo, ["src/legacy.ts"]);
			expect(String(git("status", "--porcelain", "--untracked-files=all").stdout)).not.toContain("src/legacy.ts"); // gone
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("the education block names the protected files and quotes the EXACT clause + locus (P4 advisory-style)", () => {
		const { repo } = makeRepo("sd-058-db-edu-");
		try {
			writeRepo(repo, "src/schemas.ts", "tampered\n");
			const violations = scenario14Violations(repo);
			const block = buildProtectionEducationBlock({ phaseId: "phase-03", violations, strike: 1 });
			expect(block).toContain("PROTECTED FILES");
			expect(block).toContain("`src/schemas.ts`");
			expect(block).toContain("tests/frozen.test.ts:"); // the locus
			expect(block).toContain(violations[0]!.clauses[0]!.clause); // the exact clause text
			expect(block).toContain("phase-03");
			expect(block).toContain("did NOT count against the phase budget");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("strike-1 stage wiring: attempt NOT counted (zero attempt cost) + the education re-prompt is consumed once", () => {
		const impl = readFileSync(new URL("../src/stages/implementation.ts", import.meta.url), "utf8");
		// zero attempt cost: the loop counter is decremented so the for-loop's ++ restores the SAME number
		expect(impl).toContain("attempt--; // zero attempt cost");
		expect(impl).toMatch(/protection strike 1\/\$\{PROTECTION_STRIKE_BOUND\}/); // the strike-1 log
		// the choke point is the post-join pre-build-gate seam (NEW-1) — BEFORE the build gate, never a watcher
		const chokeIdx = impl.indexOf("the protection-interval choke point");
		const gateIdx = impl.indexOf("// HARD test oracle: actually run build/test/typecheck");
		expect(chokeIdx).toBeGreaterThan(-1);
		expect(chokeIdx).toBeLessThan(gateIdx);
		// education consumed-on-use at the next implementer prompt (the judgeGuidance pattern)
		expect(impl).toContain("implParts.push(protectionEducation);");
		expect(impl).toContain('protectionEducation = "";');
	});
});

// ─── strike 2: the judge consumer ────────────────────────────────────────────

function breachCtx(repo: string, control: Record<string, unknown> | null, out: { calls: AgentCall[]; logs: string[]; error?: string }): StageContext {
	return {
		task: "t", options: {}, state: {} as PipelineState,
		budget: { count: 0, check: () => true, spent: () => true },
		log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
		async agent(call: AgentCall): Promise<AgentResult> {
			out.calls.push(call);
			return out.error !== undefined ? { text: "", control: null, error: out.error } : { text: "", control: control as Record<string, unknown> };
		},
		helper: async () => ({ value: {}, digest: "" }),
		parallel: async (calls: unknown[]) => Promise.all((calls as Array<() => unknown>).map((c) => c())),
	} as unknown as StageContext;
}

function breachViolations(repo: string): ReturnType<typeof detectProtectionViolations> {
	const interval: ProtectionInterval = deriveProtectionInterval(repo, undefined);
	return detectProtectionViolations(["src/schemas.ts"], ["src/schemas.ts"], interval);
}

describe("058 D-B — strike 2: judge escalation via the protection-breach consumer", () => {
	it("the scope is EXACTLY stage9.protection-breach and the allowed routes are EXACTLY [replan-upstream, challenge-test]", () => {
		expect(PROTECTION_BREACH_SCOPE).toBe("stage9.protection-breach");
		expect([...PROTECTION_BREACH_ALLOWED_ROUTES]).toEqual(["replan-upstream", "challenge-test"]);
	});

	it("the judge agent call carries the protection-breach wiring-point id and the offered routes in the prompt", async () => {
		const { repo } = makeRepo("sd-058-db-j1-");
		const out = { calls: [] as AgentCall[], logs: [] as string[] };
		const ctx = breachCtx(repo, { diagnosis: "the frozen contract is stale for this phase's scope", route: "challenge-test", confidence: 0.8, evidence: [] }, out);
		try {
			const res = await consumeProtectionBreachEscalation({ ctx, state: { setup: { worktreePath: repo } } as unknown as PipelineState, phaseId: "phase-02", phaseName: "wire-screen", strike: 2, violations: breachViolations(repo), specIdentifier: "001" });
			expect(res.action).toBe("challenge-test");
			expect(out.calls.length).toBeGreaterThan(0);
			expect(out.calls[0]!.id).toContain("stage9.protection-breach"); // the scope rides the judge agent id (dot form, consistent with stage9.contract-conflict)
			expect(out.calls[0]!.prompt).toContain("replan-upstream");
			expect(out.calls[0]!.prompt).toContain("challenge-test");
			expect(out.calls[0]!.prompt).toContain("src/schemas.ts"); // the breach context names the protected paths
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("challenge-test verdict → action challenge-test with the verified diagnosis (the test is the suspect contract)", async () => {
		const { repo } = makeRepo("sd-058-db-j2-");
		const out = { calls: [] as AgentCall[], logs: [] as string[] };
		const ctx = breachCtx(repo, { diagnosis: "SCENARIO-014 pins the wrong surface for this feature", route: "challenge-test", confidence: 0.9, evidence: [] }, out);
		try {
			const res = await consumeProtectionBreachEscalation({ ctx, state: { setup: { worktreePath: repo } } as unknown as PipelineState, phaseId: "phase-02", phaseName: "p", strike: 2, violations: breachViolations(repo), specIdentifier: "001" });
			expect(res.action).toBe("challenge-test");
			if (res.action === "challenge-test") expect(res.diagnosis).toContain("SCENARIO-014");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("escalate-now verdict REFUSED — no FatalAbort on this trigger, honest degrade + ledger record only", async () => {
		const { repo } = makeRepo("sd-058-db-j3-");
		const out = { calls: [] as AgentCall[], logs: [] as string[] };
		const ctx = breachCtx(repo, { diagnosis: "stop everything", route: "escalate-now", confidence: 0.95, evidence: [] }, out);
		try {
			const res = await consumeProtectionBreachEscalation({ ctx, state: { setup: { worktreePath: repo } } as unknown as PipelineState, phaseId: "phase-04", phaseName: "p", strike: 2, violations: breachViolations(repo), specIdentifier: "001" });
			expect(res.action).toBe("degraded");
			if (res.action === "degraded") expect(res.reason).toContain("REFUSED for the protection-breach trigger");
			expect(out.logs.some((l) => l.includes("no FatalAbort on this trigger"))).toBe(true);
			// the consumer NEVER throws (the contract-conflict-consumer refusal pattern — mirrored)
			const consumerSrc = readFileSync(new URL("../src/review/protection-breach-consumer.ts", import.meta.url), "utf8");
			expect(consumerSrc).not.toMatch(/throw new FatalAbort/);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("a judge infrastructure failure degrades honestly (never a new deadlock source)", async () => {
		const { repo } = makeRepo("sd-058-db-j4-");
		const out = { calls: [] as AgentCall[], logs: [] as string[], error: "backend timeout" };
		const ctx = breachCtx(repo, null, out);
		try {
			const res = await consumeProtectionBreachEscalation({ ctx, state: { setup: { worktreePath: repo } } as unknown as PipelineState, phaseId: "phase-05", phaseName: "p", strike: 2, violations: breachViolations(repo), specIdentifier: "001" });
			expect(res.action).toBe("degraded");
			if (res.action === "degraded") expect(res.reason).toContain("judge agent failed");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("replan-upstream verdict routes the replan circuit → action replan-routed (verified evidence, real spec dir)", async () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-058-db-spec-"));
		const { repo } = makeRepo("sd-058-db-j5-");
		const out = { calls: [] as AgentCall[], logs: [] as string[] };
		const ctx = breachCtx(repo, {
			diagnosis: "the phase must write src/schemas.ts — the plan contradicts the frozen contract",
			route: "replan-upstream",
			confidence: 0.9,
			evidence: [{ file: "tests/frozen.test.ts", quote: "must stay byte-untouched" }],
		}, out);
		try {
			const res = await consumeProtectionBreachEscalation({
				ctx,
				state: { setup: { worktreePath: repo, specDirectory: specDir } } as unknown as PipelineState,
				phaseId: "phase-06", phaseName: "p", strike: 2, violations: breachViolations(repo), specIdentifier: "001",
			});
			expect(res.action).toBe("replan-routed");
			expect(out.logs.some((l) => l.includes("routed to REPLAN"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});
});
