/**
 * Phase 2 — Per-run singleton threading + structured-change parsing + prompt
 * contract (spec-11 AC-05, AC-06 → SCENARIO-010, SCENARIO-011, SCENARIO-012).
 *
 * RED-phase tests written BEFORE the Phase 2 implementation exists. Today:
 *   - `src/tracking.ts` already SHIPS the singleton primitives
 *     (`setActiveTracker` / `getActiveTracker` / the module-level
 *     `activeTracker`) — these lifecycle tests therefore LOCK the contract and
 *     guard against regressions (they should be GREEN now).
 *   - `src/stages/implementation.ts` does NOT yet export
 *     `parseStructuredChanges` — the structured-parse + legacy-tolerance +
 *     never-throws tests below reference a function that does NOT exist yet,
 *     so they FAIL today (RED).
 *   - `src/prompts.ts` `buildImplementPrompt` / `buildFixPrompt` still end
 *     their `<control>` contract with the legacy flat `filesModified (array)`
 *     line — the structured-contract + cross-check-warning assertions FAIL
 *     today (RED).
 *   - `src/stages/implementation.ts` per-attempt accumulation still reads only
 *     the flat `impl.control.filesModified`; it does NOT yet derive the summary
 *     `filesModified[]` from `filesCreated ∪ filesModified` (deleted excluded)
 *     — the derivation integration test FAILS today (RED).
 *
 * Independently testable: pure module + unit + a lightweight stage-integration
 * test (mocked agents/oracles, disk-free).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

import { ChangeTracker, setActiveTracker, getActiveTracker } from "../src/tracking.ts";
import type { StructuredChanges } from "../src/tracking.ts";
import { buildImplementPrompt, buildFixPrompt } from "../src/prompts.ts";
import type { SetupControl, ControlObj } from "../src/types.ts";
// RED target — does NOT exist yet in Phase 1. Phase 2 adds it. Importing a
// non-existent named export resolves to `undefined` under vitest/esbuild, so
// `parseStructuredChanges(...)` throws at call time → these tests fail (RED).
import { parseStructuredChanges } from "../src/stages/implementation.ts";

// ─── Mocks (hoisted before the module under test loads) ─────────────────────
const mock = vi.hoisted(() => ({ implControl: null as Record<string, unknown> | null }));

// Greenfield-safe oracle stack: RED oracle "unknown" (no re-prompts), build
// gate clean PASS, deliverable check clean PASS. The ONLY variable is the
// implementer's structured change control (scripted per-test via mock.implControl).
vi.mock("../src/build-runner.ts", () => ({
	runRedCheck: (): string => "unknown",
	runBuildGate: () => ({
		pass: true,
		buildSuccess: true,
		allTestsPass: true,
		typecheckSuccess: true,
		ran: ["vitest"],
		errors: [] as string[],
		outOfScopeErrors: [] as string[],
		inScopePass: true,
	}),
	runDeliverableCheck: () => ({ pass: true, missing: [] as string[], ran: [] as string[] }),
	resetDeliverableCheckCache: () => {},
}));

// Mock the only other filesystem-writing side effect (the summary render) so
// the suite is fully disk-free and deterministic.
vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";
import type { Stage, StageContext, AgentCall, AgentResult, HelperResult, Budget, RunOptions, PipelineState } from "../src/types.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function mkSetup(): SetupControl {
	return {
		worktreePath: "/tmp/sd-structured/wt",
		specDirectory: "/tmp/sd-structured",
		defaultBranch: "main",
		language: "frontend",
		isWebUi: false,
		specIdentifier: "11",
		worktreeCreated: false,
		initializedRepo: false,
	} as unknown as SetupControl;
}

function mkState(phases: Array<{ name: string; description?: string }> = [{ name: "Phase A" }]): PipelineState {
	return {
		setup: mkSetup(),
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases },
	} as unknown as PipelineState;
}

interface FakeCtx {
	implByAttempt: Map<number, string>;
}

/** Fully-scripted StageContext. The implementer() returns the per-test
 *  `mock.implControl` structured set; everything else is a clean no-op. */
function mkCtx(): { ctx: StageContext; fake: FakeCtx } {
	const fake: FakeCtx = { implByAttempt: new Map() };
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				return { text: "", control: { testFiles: ["tests/red.test.ts"] } };
			}
			if (call.agent === "implementer") {
				const m = /\.impl\.a(\d+)$/.exec(call.id);
				if (m) fake.implByAttempt.set(Number(m[1]), call.prompt ?? "");
				return { text: "", control: { ...(mock.implControl ?? {}) } };
			}
			if (call.id.includes("summary")) return { text: "", control: null };
			return { text: "", control: {} as ControlObj };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: {
			count: 0,
			check: () => true,
			spent() {
				this.count++;
			},
		} satisfies Budget,
		log() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, fake };
}

beforeEach(() => {
	mock.implControl = null;
	// Reset the singleton between tests — Phase 2's execute()-finally must clear
	// it, but the unit tests set it directly, so reset defensively.
	setActiveTracker(null);
});

// ===========================================================================
// AC-05 / SCENARIO-010 — Per-run singleton lifecycle (no leak)
// ===========================================================================
describe("Phase 2 — per-run tracker singleton (AC-05 / SCENARIO-010)", () => {
	it("setActiveTracker(t) is observable via getActiveTracker()", () => {
		expect(getActiveTracker()).toBeNull();
		const t = new ChangeTracker("/tmp/sd-singleton", "/tmp/sd-singleton/wt");
		setActiveTracker(t);
		expect(getActiveTracker()).toBe(t);
	});

	it("setActiveTracker(null) clears the singleton — no leak into a subsequent read (the finally path)", () => {
		const t = new ChangeTracker("/tmp/sd-singleton", "/tmp/sd-singleton/wt");
		setActiveTracker(t);
		expect(getActiveTracker()).toBe(t);
		// execute()'s finally clears it — must not leak across runs.
		setActiveTracker(null);
		expect(getActiveTracker()).toBeNull();
		expect(getActiveTracker()).toBeNull();
	});

	it("a fresh setActiveTracker(new) discards a stale singleton from an overlapping run", () => {
		const stale = new ChangeTracker("/tmp/sd-stale", "/tmp/sd-stale/wt");
		const fresh = new ChangeTracker("/tmp/sd-fresh", "/tmp/sd-fresh/wt");
		setActiveTracker(stale);
		// Stale-singleton discard guard: the pipeline must overwrite, not append.
		setActiveTracker(fresh);
		expect(getActiveTracker()).toBe(fresh);
		expect(getActiveTracker()).not.toBe(stale);
	});

	it("repeated clear cycles leave no residual tracker state", () => {
		for (let i = 0; i < 3; i++) {
			const t = new ChangeTracker(`/tmp/sd-c${i}`, `/tmp/sd-c${i}/wt`);
			setActiveTracker(t);
			expect(getActiveTracker()).toBe(t);
			setActiveTracker(null);
			expect(getActiveTracker()).toBeNull();
		}
	});
});

// ===========================================================================
// AC-06 / SCENARIO-012 — parseStructuredChanges: structured + legacy tolerance
// ===========================================================================
describe("Phase 2 — parseStructuredChanges (AC-06 / SCENARIO-011, SCENARIO-012)", () => {
	it("reads a structured {filesCreated, filesModified, filesDeleted} set verbatim", () => {
		const control = {
			filesCreated: ["src/new.ts"],
			filesModified: ["src/existing.ts"],
			filesDeleted: ["src/old.ts"],
		};
		const parsed = parseStructuredChanges(control);
		expect(parsed.filesCreated).toEqual(["src/new.ts"]);
		expect(parsed.filesModified).toEqual(["src/existing.ts"]);
		expect(parsed.filesDeleted).toEqual(["src/old.ts"]);
	});

	it("SCENARIO-012: tolerates a legacy flat filesModified array — normalized into filesModified (created/deleted empty), no error", () => {
		// Legacy agents that have NOT adopted the structured contract still return
		// a flat `filesModified` array. parseStructuredChanges must accept it.
		const legacy = { filesModified: ["src/a.ts", "src/b.ts"] };
		const parsed = parseStructuredChanges(legacy);
		expect(parsed.filesModified).toEqual(["src/a.ts", "src/b.ts"]);
		expect(parsed.filesCreated).toEqual([]);
		expect(parsed.filesDeleted).toEqual([]);
	});

	it("returns an empty StructuredChanges for null/undefined control (never throws)", () => {
		const empty: StructuredChanges = { filesCreated: [], filesModified: [], filesDeleted: [] };
		expect(parseStructuredChanges(null)).toEqual(empty);
		expect(parseStructuredChanges(undefined)).toEqual(empty);
	});

	it("returns an empty StructuredChanges for a malformed/non-object control (never throws)", () => {
		const empty: StructuredChanges = { filesCreated: [], filesModified: [], filesDeleted: [] };
		expect(parseStructuredChanges({})).toEqual(empty);
		expect(parseStructuredChanges("not-an-object")).toEqual(empty);
		expect(parseStructuredChanges({ filesCreated: "oops-not-an-array" })).toEqual(empty);
	});

	it("ignores non-array bucket values (defensive normalization, never throws)", () => {
		const parsed = parseStructuredChanges({
			filesCreated: ["ok.ts", 123 as unknown as string],
			filesModified: null,
			filesDeleted: undefined,
		});
		// Only string entries survive; bad buckets collapse to empty.
		expect(Array.isArray(parsed.filesCreated)).toBe(true);
		expect(parsed.filesCreated.filter((x) => typeof x === "string")).toEqual(parsed.filesCreated);
		expect(parsed.filesModified).toEqual([]);
		expect(parsed.filesDeleted).toEqual([]);
	});

	it("accepts a mixed control (structured buckets + a stray legacy filesModified) without losing the structured set", () => {
		// An agent mid-migration may emit both. The structured buckets win;
		// the legacy flat field is folded into filesModified when structured is
		// absent, and does not DOUBLE-COUNT when structured is present.
		const parsed = parseStructuredChanges({
			filesCreated: ["src/new.ts"],
			filesModified: ["src/mod.ts"],
			filesDeleted: ["src/del.ts"],
		});
		expect(parsed.filesCreated).toEqual(["src/new.ts"]);
		expect(parsed.filesModified).toEqual(["src/mod.ts"]);
		expect(parsed.filesDeleted).toEqual(["src/del.ts"]);
	});
});

// ===========================================================================
// AC-06 / SCENARIO-011 — Prompt contract: structured set + cross-check warning
// ===========================================================================
describe("Phase 2 — prompt output contract (AC-06 / SCENARIO-011)", () => {
	const specialist = { languageInstructions: "" };
	const specControl = { specificationPath: "/tmp/sd/spec.md" };

	it("buildImplementPrompt declares the structured contract (filesCreated/filesModified/filesDeleted)", () => {
		const prompt = buildImplementPrompt(mkSetup(), null, { name: "Phase A" }, specialist, specControl);
		// Today the trailing line is the legacy flat
		// `filesModified (array), testsPassCount (number), summary.` — RED.
		expect(prompt).toContain("filesCreated (array)");
		expect(prompt).toContain("filesModified (array)");
		expect(prompt).toContain("filesDeleted (array)");
	});

	it("buildImplementPrompt carries the git-cross-check warning (claiming an unchanged file fails the phase)", () => {
		const prompt = buildImplementPrompt(mkSetup(), null, { name: "Phase A" }, specialist, specControl);
		// The one-line instruction flagging the report as git-cross-checked.
		expect(prompt.toLowerCase()).toMatch(/git[ -]?cross[ -]?check/);
		expect(prompt.toLowerCase()).toContain("did not change");
	});

	it("buildFixPrompt declares the structured contract (filesCreated/filesModified/filesDeleted)", () => {
		const prompt = buildFixPrompt(mkSetup(), null, [{ severity: "high", title: "X" }]);
		expect(prompt).toContain("filesCreated (array)");
		expect(prompt).toContain("filesModified (array)");
		expect(prompt).toContain("filesDeleted (array)");
	});

	it("buildFixPrompt carries the git-cross-check warning", () => {
		const prompt = buildFixPrompt(mkSetup(), null, [{ severity: "high", title: "X" }]);
		expect(prompt.toLowerCase()).toMatch(/git[ -]?cross[ -]?check/);
	});

	it("buildImplementationSummaryPrompt is UNCHANGED — still consumes the flat filesModified list", () => {
		// buildImplementationSummaryPrompt must NOT change its contract this phase
		// (AC-10: the summary writer consumes the DERIVED flat list). Import here
		// to assert it still references `filesModified` in its output, byte-stable
		// for unchanged agents.
		// (Re-imported lazily to keep the top-level import list focused.)
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { buildImplementationSummaryPrompt } = require("../src/prompts.ts") as {
			buildImplementationSummaryPrompt: typeof import("../src/prompts.ts").buildImplementationSummaryPrompt;
		};
		const prompt = buildImplementationSummaryPrompt(mkSetup(), null, { filesModified: ["src/a.ts"] });
		expect(prompt).toContain("filesModified");
	});
});

// ===========================================================================
// AC-06 / AC-10 — Summary filesModified derivation = filesCreated ∪ filesModified
// (deleted excluded), wired into the implementation stage accumulation
// ===========================================================================
describe("Phase 2 — summary filesModified derivation (AC-06/AC-10, integration)", () => {
	it("the summary filesModified[] unions filesCreated ∪ filesModified and EXCLUDES filesDeleted", async () => {
		// Implementer reports a created file, a modified file, AND a deleted file.
		// The flat summary `filesModified` shown in the implementation summary must
		// contain the created + modified entries and must NOT contain the deleted
		// entry (deleted is not a "modified" display).
		mock.implControl = {
			filesCreated: ["src/new.ts"],
			filesModified: ["src/existing.ts"],
			filesDeleted: ["src/old.ts"],
		};
		const { ctx } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;

		expect(res.filesModified).toContain("src/new.ts");
		expect(res.filesModified).toContain("src/existing.ts");
		// The deleted entry must NOT leak into the "modified" summary list.
		expect(res.filesModified).not.toContain("src/old.ts");
		// Exactly the two non-deleted entries — no phantom, no duplication.
		expect((res.filesModified as string[]).length).toBe(2);
	});

	it("a phase that reports ONLY a legacy flat filesModified still accumulates unchanged (no regression for agents that did not adopt the structured contract)", async () => {
		mock.implControl = { filesModified: ["src/legacy.ts"] };
		const { ctx } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;
		expect(res.filesModified).toEqual(["src/legacy.ts"]);
	});

	it("a created file is surfaced into the summary even when filesModified is empty (false-green evidence)", async () => {
		// A phase that ONLY creates a file (no modifications) must still surface
		// that file in the flat summary — otherwise the dashboard/summary under-
		// reports the phase's footprint.
		mock.implControl = { filesCreated: ["src/brand-new.ts"], filesModified: [], filesDeleted: [] };
		const { ctx } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState(), ctx)) as ControlObj;
		expect(res.filesModified).toContain("src/brand-new.ts");
	});
});
