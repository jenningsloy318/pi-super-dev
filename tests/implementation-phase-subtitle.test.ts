/**
 * Phase-subtitle tests — the Implementation stage announces WHICH phase is
 * being implemented via the pi-native `ctx.phase()` seam (routes to the
 * progress sink → dashboard header/working-message + a `▶`-prefixed live-log
 * line). Verifies the "Implementation — Phase N/M: <name>" format, that a
 * phase is announced BEFORE its implementer spawns, and that an unnamed phase
 * falls back to its phase id.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { StageContext, RunOptions, PipelineState, AgentResult, HelperResult, Budget } from "../src/types.ts";

// The build-gate/red/deliverable oracles are pure fs/git probes; stub them so
// this unit test drives ONLY the stage's control flow (no real repo needed).
const gate = { pass: true, inScopePass: true, errors: [] as string[], ran: [] as string[], outOfScopeErrors: [] as string[] };
vi.mock("../src/build-runner.ts", () => ({
	runBuildGate: () => gate,
	buildGateCorrelationLine: () => null,
	runRedCheck: () => "red",
	runDeliverableCheck: () => ({ pass: true, missing: [], ran: [] }),
	deliverablesAlreadyMet: () => false,
	resetDeliverableCheckCache: () => {},
	computeChangeGate: () => ({ pass: true, claimedNotChanged: [] }),
	computeSymbolGate: () => ({ pass: true, hollowFiles: [] }),
}));

const { implementationStage } = await import("../src/stages/implementation.ts");

const mkState = (phases: Array<{ name?: string }>): PipelineState =>
	({
		setup: { worktreePath: "/tmp/wt", specDirectory: "/tmp/wt/spec/", defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "x", worktreeCreated: false, initializedRepo: false },
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases },
	} as unknown as PipelineState);

/** Capture ctx.phase() announcements, emitted dashboard phase rows, AND the order of implementer spawns. */
function mkCtx() {
	const phaseCalls: string[] = [];
	const emittedStages: Array<{ id: string; label: string; status: string; kind?: string; parentId?: string }> = [];
	const events: string[] = [];
	const ctx: StageContext = {
		task: "t", options: {} as RunOptions, state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call): Promise<AgentResult> {
			if (call.agent === "implementer") events.push(`impl:${call.id}`);
			return { text: "ok", control: {} };
		},
		parallel: async (cs: Array<() => Promise<AgentResult>>) => Promise.all(cs.map((c) => c())),
		budget: { check: () => true, spent() { this.count++; return true; }, count: 0 } satisfies Budget,
		log: () => {},
		phase: (label: string) => { phaseCalls.push(label); events.push(`phase:${label}`); },
		events: { on: () => () => {}, emit: (_name: string, payload: { id: string; label: string; status: string; kind?: string; parentId?: string }) => { emittedStages.push(payload); return true; } } as never,
		results: [],
	};
	return { ctx, phaseCalls, emittedStages, events };
}

describe("Implementation stage — per-phase pi-native subtitle", () => {
	beforeEach(() => { gate.pass = true; gate.inScopePass = true; gate.errors = []; });

	const basePhaseCalls = (calls: string[]) =>
		calls.filter((label) => /^Implementation — Phase \d+\/\d+: [^—]+$/.test(label));

	it("announces each phase as 'Implementation — Phase N/M: <name>'", async () => {
		const { ctx, phaseCalls } = mkCtx();
		await implementationStage.run(mkState([{ name: "Scaffold" }, { name: "Wire API" }]), ctx);
		expect(basePhaseCalls(phaseCalls)).toEqual([
			"Implementation — Phase 1/2: Scaffold",
			"Implementation — Phase 2/2: Wire API",
		]);
	});

	it("announces the current Stage 9 activity under the phase banner", async () => {
		const { ctx, phaseCalls } = mkCtx();
		await implementationStage.run(mkState([{ name: "Core" }]), ctx);
		expect(phaseCalls).toEqual(expect.arrayContaining([
			"Implementation — Phase 1/1: Core",
			"Implementation — Phase 1/1: Core — Route specialist (attempt 1/5)",
			"Implementation — Phase 1/1: Core — TDD RED (attempt 1/5, try 1/5)",
			"Implementation — Phase 1/1: Core — RED oracle (attempt 1/5, try 1/5)",
			"Implementation — Phase 1/1: Core — RED boundary (attempt 1/5, try 1/5)",
			"Implementation — Phase 1/1: Core — Implementation (attempt 1/5)",
			"Implementation — Phase 1/1: Core — Build gate (attempt 1/5)",
			"Implementation — Phase 1/1: Core — Deliverable check (attempt 1/5)",
			"Implementation — Phase 1/1: Core — Change check (attempt 1/5)",
			"Implementation — Phase 1/1: Core — Symbol check (attempt 1/5)",
			"Implementation — Phase 1/1: Core — Commit",
			"Implementation — Summary",
		]));
		const tddIdx = phaseCalls.indexOf("Implementation — Phase 1/1: Core — TDD RED (attempt 1/5, try 1/5)");
		const implIdx = phaseCalls.indexOf("Implementation — Phase 1/1: Core — Implementation (attempt 1/5)");
		expect(implIdx).toBeGreaterThan(tddIdx);
	});

	it("emits implementation phases as dashboard sub-stage lifecycle rows", async () => {
		const { ctx, emittedStages } = mkCtx();
		await implementationStage.run(mkState([{ name: "Scaffold" }, { name: "Wire API" }]), ctx);
		expect(emittedStages).toEqual([
			{ id: "implementation.phase-01", label: "↳ Phase 1/2: Scaffold", status: "running", kind: "phase", parentId: "implementation" },
			{ id: "implementation.phase-01", label: "↳ Phase 1/2: Scaffold", status: "ok", kind: "phase", parentId: "implementation" },
			{ id: "implementation.phase-02", label: "↳ Phase 2/2: Wire API", status: "running", kind: "phase", parentId: "implementation" },
			{ id: "implementation.phase-02", label: "↳ Phase 2/2: Wire API", status: "ok", kind: "phase", parentId: "implementation" },
		]);
	});

	it("announces the phase BEFORE its implementer is spawned", async () => {
		const { ctx, events } = mkCtx();
		await implementationStage.run(mkState([{ name: "Only" }]), ctx);
		const phaseIdx = events.indexOf("phase:Implementation — Phase 1/1: Only");
		const implIdx = events.findIndex((e) => e.startsWith("impl:"));
		expect(phaseIdx).toBeGreaterThanOrEqual(0);
		expect(implIdx).toBeGreaterThan(phaseIdx); // subtitle precedes the spawn
	});

	it("skips phases dropped by normalization (no usable name) — only named phases are announced", async () => {
		// normalizePhases() filters out phases without a non-empty name, so a bare
		// {} phase never reaches the loop; only the named phase is announced (and
		// it is renumbered against the normalized total).
		const { ctx, phaseCalls } = mkCtx();
		await implementationStage.run(mkState([{}, { name: "Kept" }]), ctx);
		expect(basePhaseCalls(phaseCalls)).toEqual(["Implementation — Phase 1/1: Kept"]);
	});

	it("does NOT announce a phase carried green from a prior convergence iteration", async () => {
		// A convergence re-run seeds phaseStatus; an already-green phase is skipped
		// BEFORE the subtitle fires, so it never flickers a subtitle for work it is
		// not doing. Only the still-pending phase is announced.
		const { ctx, phaseCalls } = mkCtx();
		const state = mkState([{ name: "Done" }, { name: "Pending" }]);
		(state as unknown as Record<string, unknown>).implementation = { phaseStatus: [{ id: "phase-01", status: "green" }] };
		await implementationStage.run(state, ctx);
		expect(basePhaseCalls(phaseCalls)).toEqual(["Implementation — Phase 2/2: Pending"]);
	});
});
