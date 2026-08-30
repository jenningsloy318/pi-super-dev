/**
 * v0.3.2 Contract-Claims Layer (WS-1 rung-2 sensors):
 *  - C1 designContractsErrors (pattern compiles; closure consistency reports
 *    ALL violations at once; sourceAnchor exists + #export present;
 *    uniqueness) + the designComplete wiring (rendered-doc parity).
 *  - C2 deliverablesPreflightErrors (regex compiles; scenario ids exist in
 *    BDD; repo-relative paths; non-empty test names).
 *  - C3 bddBoundaryLintErrors (pinned numeric bounds must be named by some
 *    scenario; digit-normalized; ≤4 reported).
 *  - C4 AcceptanceCriterion.verifiedBy schema + template render.
 *
 * Root cause: run 2026-08-20T06-19-50-494Z — the filename-allowlist defect
 * class was machine-checkable from round 1, but no checker ran it and three
 * review rounds discovered it one site at a time.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bddBoundaryLintErrors,
	designContractsErrors,
	deliverablesPreflightErrors,
	type NormalizedPhase,
} from "../src/doc-validators.ts";
import { designComplete } from "../src/stages/artifact-convergence.ts";
import { buildDesignPrompt, buildRequirementsPrompt, buildUpstreamReviewPrompt } from "../src/prompts.ts";
import type { ControlObj, PipelineState, SetupControl, StageContext } from "../src/types.ts";
import { EventEmitter } from "node:events";

function ctl(contracts: unknown): ControlObj {
	return { title: "d", date: "2026", contracts } as ControlObj;
}

describe("C1: designContractsErrors", () => {
	it("passes when no claims are declared (backward-compatible)", () => {
		expect(designContractsErrors(undefined, "/tmp")).toEqual([]);
		expect(designContractsErrors({} as ControlObj, "/tmp")).toEqual([]);
		expect(designContractsErrors(ctl([]), "/tmp")).toEqual([]);
	});

	it("reports EVERY closure violation at once — the run-06-19 kill", () => {
		const errors = designContractsErrors(ctl([
			{ name: "artifact-name-allowlist", pattern: "^[a-z0-9-]+$", enumerates: ["market", "earnings_surprise", "deep_research", "stage-01.report.md"] },
		]), "/tmp");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("3/4 enumerated value(s) violate");
		expect(errors[0]).toContain('"earnings_surprise"');
		expect(errors[0]).toContain('"deep_research"');
		expect(errors[0]).toContain('"stage-01.report.md"');
		expect(errors[0]).not.toContain('"market"'); // market PASSES its own pattern
		expect(errors[0]).toContain("derivation rule is wrong"); // names the fix direction
	});

	it("flags a non-compiling pattern with the regex error", () => {
		const errors = designContractsErrors(ctl([{ name: "bad", pattern: "([unclosed", enumerates: ["x"] }]), "/tmp");
		expect(errors.join("\n")).toContain("pattern does not compile");
	});

	it("verifies the sourceAnchor path exists and #export is present in the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-c1-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src/registry.ts"), "export const METHODOLOGIES = { earnings_surprise: 1 };\nexport const OTHER = 2;\n");
			const ok = designContractsErrors(ctl([{ name: "keys", pattern: "^[a-z_]+$", enumerates: ["earnings_surprise"], sourceAnchor: "src/registry.ts#METHODOLOGIES" }]), dir);
			expect(ok).toEqual([]);
			const missingExport = designContractsErrors(ctl([{ name: "keys", pattern: "^[a-z_]+$", enumerates: ["x"], sourceAnchor: "src/registry.ts#NOT_THERE" }]), dir);
			expect(missingExport.join("\n")).toContain('export "NOT_THERE" not found');
			const missingPath = designContractsErrors(ctl([{ name: "keys", pattern: "^[a-z_]+$", enumerates: ["x"], sourceAnchor: "src/nope.ts" }]), dir);
			expect(missingPath.join("\n")).toContain('does not exist in the worktree');
			const escaping = designContractsErrors(ctl([{ name: "keys", pattern: "^[a-z_]+$", enumerates: ["x"], sourceAnchor: "../outside.ts" }]), dir);
			expect(escaping.join("\n")).toContain("repo-relative");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("enforces a claimed uniqueness contract", () => {
		const errors = designContractsErrors(ctl([{ name: "ids", pattern: "^[a-z]+$", enumerates: ["a", "b", "a"], uniqueness: true }]), "/tmp");
		expect(errors.join("\n")).toContain("duplicate");
	});
});

describe("C1 wiring: designComplete", () => {
	function state(dir: string, contracts: unknown, renderDoc: boolean | "no-section"): PipelineState {
		const s = setupCtl(dir);
		if (renderDoc) {
			mkdirSync(s.specDirectory, { recursive: true });
			writeFileSync(join(s.specDirectory, "03-design.md"), renderDoc === true ? "# Design\n## Contract Claims\n..." : "# Design\nno section");
		}
		return { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false }, design: ctl(contracts) } as unknown as PipelineState;
	}
	function setupCtl(dir: string): SetupControl {
		return { worktreePath: dir, specDirectory: `${dir}/docs/specifications/001/`, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "001", worktreeCreated: true, initializedRepo: false };
	}
	const ctx = { log() {}, phase() {}, events: new EventEmitter(), results: [], task: "t", options: {}, budget: { count: 0, check: () => true, spent() { return true; } } } as unknown as StageContext;

	it("fails a design whose enumerated closure violates its own pattern", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-c1w-"));
		try {
			const r = await designComplete(state(dir, [{ name: "names", pattern: "^[a-z0-9-]+$", enumerates: ["bad_value"] }], false), ctx);
			expect(r.pass).toBe(false);
			expect(r.errors.join("\n")).toContain("1/1 enumerated value");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("fails when the control declares contracts but the rendered doc dropped the section (render parity)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-c1w-"));
		try {
			const r = await designComplete(state(dir, [{ name: "names", pattern: "^[a-z]+$", enumerates: ["ok"] }], "no-section"), ctx);
			expect(r.pass).toBe(false);
			expect(r.errors.join("\n")).toContain("## Contract Claims");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("passes a consistent claim with the rendered section present", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-c1w-"));
		try {
			const r = await designComplete(state(dir, [{ name: "names", pattern: "^[a-z0-9-]+$", enumerates: ["stage-01"] }], true), ctx);
			expect(r.pass).toBe(true);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("C2: deliverablesPreflightErrors", () => {
	const phase = (d: unknown): NormalizedPhase[] => [{ name: "P1", description: "d", deliverables: d as NormalizedPhase["deliverables"] }];

	it("catches non-compiling requireContains/requireNotContains patterns at spec time", () => {
		const errors = deliverablesPreflightErrors(phase({ requireContains: [{ file: "src/a.ts", pattern: "([bad" }, { file: "src/a.ts", pattern: "ok" }], requireNotContains: [{ pattern: "[also-bad" }] }), "# BDD");
		expect(errors.filter((e) => e.includes("requireContains pattern does not compile"))).toHaveLength(1);
		expect(errors.filter((e) => e.includes("requireNotContains pattern does not compile"))).toHaveLength(1);
	});

	it("catches requireScenarios ids absent from the BDD doc (perma-fail deliverable)", () => {
		const bdd = "### SCENARIO-001: primary\n### SCENARIO-002: edge";
		const errors = deliverablesPreflightErrors(phase({ requireScenarios: ["SCENARIO-001", "SCENARIO-009", "NOT-A-ID"] }), bdd);
		expect(errors.join("\n")).toContain("SCENARIO-009, which does not exist in the BDD doc");
		expect(errors.join("\n")).toContain("not a SCENARIO-NNN id");
	});

	it("catches escaping/absolute paths and empty test names; passes a well-formed set", () => {
		const bad = deliverablesPreflightErrors(phase({ requireFiles: ["../escape.ts", "/abs.ts"], requireTests: [""] }), "# BDD");
		expect(bad.filter((e) => e.includes("repo-relative"))).toHaveLength(2);
		expect(bad.some((e) => e.includes("non-empty test-name"))).toBe(true);
		expect(deliverablesPreflightErrors(phase({ requireFiles: ["src/new.ts"], requireScenarios: ["SCENARIO-001"], requireTests: ["renders the list"], requireContains: [{ file: "src/new.ts", pattern: "export function" }] }), "### SCENARIO-001: x")).toEqual([]);
	});
});

describe("C3: bddBoundaryLintErrors", () => {
	const req = (ac: string) => `## Acceptance Criteria\n- **AC-01**: ${ac}\n`;

	it("fires when a pinned bound is named by no scenario", () => {
		const errors = bddBoundaryLintErrors(req("list at most 10000 rows"), "### SCENARIO-001: basic list");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("at most 10000");
		expect(errors[0]).toContain("10000");
	});

	it("passes when the boundary value is named (digit-normalized 1,000 ≡ 1000)", () => {
		expect(bddBoundaryLintErrors(req("list at most 1000 rows"), "### SCENARIO-001: shows the first 1,000 rows")).toEqual([]);
	});

	it("covers the bound-phrase family but not ordinary numbers", () => {
		const phrases = ["at least 5 entries", "no more than 3 retries", "up to 20 items", "exactly 12 columns", "top 10 results", "first 50 rows", "within 60 seconds", "capped at 8 phases", "max 2 connections", "min 1 source"];
		for (const p of phrases) {
			expect(bddBoundaryLintErrors(req(p), "no numbers here"), `"${p}" should fire`).toHaveLength(1);
		}
		// ordinary numbers without a bound phrase never fire
		expect(bddBoundaryLintErrors(req("uses the v2 API and 3 tables"), "### SCENARIO-001: v2")).toEqual([]);
	});

	it("caps at 4 reported bounds", () => {
		const reqMany = `## Acceptance Criteria\n- **AC-01**: at most 10 a\n- **AC-02**: at most 20 b\n- **AC-03**: at most 30 c\n- **AC-04**: at most 40 d\n- **AC-05**: at most 50 e\n`;
		expect(bddBoundaryLintErrors(reqMany, "nothing")).toHaveLength(4);
	});
});

describe("C4 + prompts + template", () => {
	it("buildDesignPrompt documents the contracts block, closure enumeration, and alternatives", () => {
		const p = buildDesignPrompt({ language: "backend" } as SetupControl, null, "t", null, null, null, "architect");
		expect(p).toContain("contracts block");
		expect(p).toContain("enumerated closure");
		expect(p).toContain("sourceAnchor");
		expect(p).toContain("alternativesConsidered");
		expect(p).toContain("deterministic checker verifies");
	});

	it("buildRequirementsPrompt instructs the verifiedBy classification", () => {
		const p = buildRequirementsPrompt({ language: "backend" } as SetupControl, null, "t");
		expect(p).toContain("verifiedBy");
		expect(p).toContain("deterministic (a build/gate can check it");
	});

	it("the upstream reviewer prompt carries the division-of-labor line", () => {
		const p = buildUpstreamReviewPrompt({ language: "backend" } as SetupControl, null, { stage: "design", upstream: [] });
		expect(p).toContain("Contract Claims");
		expect(p).toContain("ENUMERATION MATCHES REALITY");
	});

	it("the design template renders contracts + alternatives sections", async () => {
		const { render } = await import("../src/render/template-engine.ts");
		const { readFileSync } = await import("node:fs");
		const template = readFileSync("src/render/templates/design.md.njk", "utf8");
		const html = render(template, {
			title: "T", date: "d", generatedAt: "g", designer: "x", summary: "s",
			modules: [], hasNumericConstants: "no",
			contracts: [{ name: "allowlist", pattern: "^[a-z]+$", enumerates: ["market", "ticker"], sourceAnchor: "src/registry.ts#METHODOLOGIES", derivationRule: "one file per key", uniqueness: true }],
			alternativesConsidered: [{ decision: "storage", chosen: "sqlite", rationale: "r", alternatives: ["json"] }],
		});
		expect(html).toContain("## Contract Claims");
		expect(html).toContain("allowlist");
		expect(html).toContain("market");
		expect(html).toContain("src/registry.ts#METHODOLOGIES");
		expect(html).toContain("## Alternatives Considered");
		expect(html).toContain("sqlite");
	});
});

// ── sd32 dual-review remediation pins ─────────────────────────────────────────
import { designConvergenceNode } from "../src/stages/artifact-convergence.ts";
import type { AgentCall, AgentResult, HelperCall } from "../src/types.ts";
import { runHelper } from "../src/helpers.ts";
import type { RetryFeedbackInput } from "../src/retry-feedback.ts";

function setupCtl32(dir: string): SetupControl {
	// v0.3.32: the spec dir must EXIST — a render-valid design control now
	// actually writes its doc here (previously every fixture control failed
	// validation, so the missing dir was never noticed).
	mkdirSync(`${dir}/docs/specifications/001/`, { recursive: true });
	return { worktreePath: dir, specDirectory: `${dir}/docs/specifications/001/`, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "001", worktreeCreated: true, initializedRepo: false };
}

describe("sd32 remediation: vacuous enums, dialect, (?i) parity, normalization, node wiring", () => {
	it("F2/C1-EMPTY: a declared contract with enumerates [] or all-blank entries FAILS (no vacuous pass)", () => {
		const empty = designContractsErrors(ctl([{ name: "names", pattern: "^[a-z]+$", enumerates: [] }]), "/tmp");
		expect(empty.join("\n")).toContain("enumerates no values");
		const blank = designContractsErrors(ctl([{ name: "names", pattern: "^[a-z]+$", enumerates: [null, 42, "  "] as unknown as string[] }]), "/tmp");
		expect(blank.join("\n")).toContain("all non-string/blank");
	});

	it("adv-F3: a JS-literal-style pattern ('/^x$/i') gets the dialect error, not a false derivation complaint", () => {
		const errors = designContractsErrors(ctl([{ name: "names", pattern: "/^[a-z]+$/i", enumerates: ["abc"] }]), "/tmp");
		expect(errors.join("\n")).toContain("looks like a JS regex literal");
		expect(errors.join("\n")).not.toContain("derivation rule is wrong");
	});

	it("code-C1-EXPORT: '#METHODOLOGIES' is NOT satisfied by METHODOLOGIES_EXTRA (identifier boundary)", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-c1x-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src/registry.ts"), "export const METHODOLOGIES_EXTRA = 1;\n");
			const errors = designContractsErrors(ctl([{ name: "k", pattern: "^[a-z_]+$", enumerates: ["x"], sourceAnchor: "src/registry.ts#METHODOLOGIES" }]), dir);
			expect(errors.join("\n")).toContain('export "METHODOLOGIES" not found');
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("code-C1-WIRING (adv-F6 parity-skip folded in): the design NODE fails a round on an inconsistent contract before review, and passes with no doc on disk when claims are consistent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-c1n-"));
		try {
			const s = setupCtl32(dir);
			const designCtl = { title: "d", date: "2026", summary: "s", designer: "architecture-designer", modules: [{ name: "M", description: "d" }], hasNumericConstants: "no", contracts: [{ name: "names", pattern: "^[a-z0-9-]+$", enumerates: ["stage-01", "BAD_VALUE"] }] };
			const state = { setup: s, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false }, design: designCtl } as unknown as PipelineState;
			const seen: RetryFeedbackInput[][] = [];
			let writerCalls = 0;
			let reviewCalls = 0;
			const stageCtx = {
				task: "t", options: {}, state,
				budget: { count: 0, check: () => true, spent() { return true; } },
				log() {}, phase() {}, events: new EventEmitter(), results: [],
				async agent(call: AgentCall): Promise<AgentResult> {
					const key = (call.id ?? "").replace(/^pipeline\./, "");
					const fb = ((state as Record<string, unknown>).__feedback as Record<string, RetryFeedbackInput[]> | undefined)?.[key] ?? [];
					seen.push([...fb]);
					if (key === "designReview") { reviewCalls++; return { text: "", control: { verdict: "Approved", summary: "ok", findings: [] } as ControlObj }; }
					writerCalls++;
					return { text: "", control: designCtl as ControlObj };
				},
				async helper(call: HelperCall) { return runHelper(call); },
				async parallel(calls: unknown[]) { return Promise.all((calls as Array<() => unknown>).map((c) => c())); },
			} as unknown as StageContext;
			// never converged — the liveness cap FatalAborts; what we assert is that
			// every round's feedback carried the closure table (sensor wired).
			let fatal: unknown = null;
			try { await designConvergenceNode.run(state, stageCtx); } catch (error) { fatal = error; }
			expect(String(fatal)).toContain("did not converge");
			expect(writerCalls).toBeGreaterThan(1);
			const round2 = (await import("../src/retry-feedback.ts")).renderRetryFeedbackBlock(seen[1]);
			expect(round2).toContain("1/2 enumerated value");
			expect(round2).toContain("BAD_VALUE");
			// parity-skip control (adv-F6): consistent claims + NO doc on disk → the
			// validator passes (parity only applies when a doc exists to check).
			const dir2 = mkdtempSync(join(tmpdir(), "sd-c1n2-"));
			try {
				const s2 = setupCtl32(dir2);
				const okState = { setup: s2, classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false }, design: { title: "d", date: "2026", summary: "s", designer: "architecture-designer", modules: [{ name: "M", description: "d" }], hasNumericConstants: "no", contracts: [{ name: "names", pattern: "^[a-z0-9-]+$", enumerates: ["stage-01"] }] } } as unknown as PipelineState;
				const okSeen: RetryFeedbackInput[][] = [];
				const okCtx = { ...stageCtx, state: okState, async agent(call: AgentCall): Promise<AgentResult> {
					const key = (call.id ?? "").replace(/^pipeline\./, "");
					const fb = ((okState as Record<string, unknown>).__feedback as Record<string, RetryFeedbackInput[]> | undefined)?.[key] ?? [];
					okSeen.push([...fb]);
					if (key === "designReview") return { text: "", control: { verdict: "Approved", summary: "ok", findings: [] } as ControlObj };
					return { text: "", control: okState.design as ControlObj };
				} } as unknown as StageContext;
				const r2 = await designConvergenceNode.run(okState, okCtx);
				expect(r2.status).toBe("ok");
				expect(r2.attempts).toBe(1);
			} finally { rmSync(dir2, { recursive: true, force: true }); }
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("code-C2-REGEX-DIALECT: '(?i)pattern' is ACCEPTED (parity with the phase-GREEN tolerantMatch consumer)", () => {
		expect(deliverablesPreflightErrors([{ name: "P", deliverables: { requireContains: [{ file: "src/a.ts", pattern: "(?i)Export Function" }] } } as NormalizedPhase], "# BDD")).toEqual([]);
		expect(deliverablesPreflightErrors([{ name: "P", deliverables: { requireContains: [{ file: "src/a.ts", pattern: "(?i)[bad" }] } } as NormalizedPhase], "# BDD").join("\n")).toContain("does not compile");
	});

	it("code-C2-SCENARIO: a 4-digit requireScenarios pin matches its normalized BDD id", () => {
		const bdd = "### SCENARIO-1000: fourth-digit scenario";
		expect(deliverablesPreflightErrors([{ name: "P", deliverables: { requireScenarios: ["SCENARIO-1000"] } } as NormalizedPhase], bdd)).toEqual([]);
		expect(deliverablesPreflightErrors([{ name: "P", deliverables: { requireScenarios: ["SCENARIO-1001"] } } as NormalizedPhase], bdd).join("\n")).toContain("SCENARIO-1001, which does not exist");
	});

	it("adv-F1/code-C3: comma-grouped bounds are checked whole, and small bounds are not substring-satisfied", () => {
		const req = (ac: string) => `## Acceptance Criteria\n- **AC-01**: ${ac}\n`;
		// '10' from '10,000' must NOT be satisfied by 'SCENARIO-100'
		expect(bddBoundaryLintErrors(req("list at most 10,000 rows"), "### SCENARIO-100: small").join("\n")).toContain("10000");
		// grouped bound satisfied by the grouped BDD spelling
		expect(bddBoundaryLintErrors(req("list at most 10,000 rows"), "### SCENARIO-001: caps at 10,000 rows")).toEqual([]);
		// unit suffix '60s' is a bound, not a miss
		expect(bddBoundaryLintErrors(req("responds within 60s"), "### SCENARIO-001: basic").join("\n")).toContain("60");
	});

	it("adv-F4: deliverables preflight announces truncation past 12 errors", () => {
		const contains = Array.from({ length: 15 }, (_, i) => ({ file: "src/a.ts", pattern: `(${"bad"[0]}unclosed-${i}` }));
		const errors = deliverablesPreflightErrors([{ name: "P", deliverables: { requireContains: contains } } as NormalizedPhase], "# BDD");
		expect(errors.some((e) => e.includes("more deliverable error(s) omitted"))).toBe(true);
	});

	it("code-C2-NOTCONTAINS-NO-FILE: an entry without a file is flagged (asserts nothing at green)", () => {
		expect(deliverablesPreflightErrors([{ name: "P", deliverables: { requireNotContains: [{ pattern: "TODO" }] } } as NormalizedPhase], "# BDD").join("\n")).toContain("no file");
	});
});
