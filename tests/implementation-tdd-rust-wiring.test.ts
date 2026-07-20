/**
 * Phase P4 — RED-phase wiring test for `src/stages/implementation.ts`.
 *
 * RED-phase tests written BEFORE the P4 wiring exists. The snapshot suite
 * (`tests/prompts-tdd-rust-discipline.test.ts`) proves `buildTddPrompt` renders
 * the discipline WHEN it is passed as `langInstructions` and that `rustDiscipline`
 * must be exported. THIS suite proves the STAGE actually passes it through — i.e.
 * the tdd-guide agent prompt the stage emits carries the no-`--lib` Rust
 * discipline for a `rust` setup and OMITS it for a non-rust setup (AC-03,
 * SCENARIO-010 RED).
 *
 * Current (pre-P4) behavior at implementation.ts:113/120:
 *   buildTddPrompt(setup, classify, phase, spec, lang)
 * where `lang` is the SPECIALIST's `languageInstructions` (frontend profile
 * etc.), NOT `rustDiscipline(setup)`. So today a `rust` setup's tdd-guide
 * prompt contains NEITHER `cargo test -p` NOR the `never sufficient proof`
 * marker → the rust assertion below is RED until P4 wires the discipline in.
 *
 * Hermeticity mirrors `tests/implementation-red-loop.test.ts`: the ONLY
 * side-effecting imports of the stage are mocked (`runRedCheck`/`runBuildGate`
 * and `renderAndWrite`). `ctx.agent`/`ctx.helper` are pure scripted closures.
 * No `pi` subprocess, no network, no LLM, no disk.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type {
	AgentCall,
	AgentResult,
	Budget,
	ControlObj,
	HelperResult,
	PipelineState,
	RunOptions,
	Stage,
	StageContext,
} from "../src/types.ts";

vi.mock("../src/build-runner.ts", () => ({
	runRedCheck: vi.fn((): string => "unknown"),
	runBuildGate: vi.fn(() => ({
		pass: true,
		inScopePass: false,
		ran: ["npm test"],
		errors: [] as string[],
		outOfScopeErrors: [] as string[],
	})),
	// Phase 3 (AC-03 → SCENARIO-011..015): the stage now calls this third sibling
	// primitive after the build-gate, AND-ed into the GREEN verdict. Default PASS
	// (these phases declare no deliverables) so today's behavior is preserved.
	runDeliverableCheck: vi.fn(() => ({
		pass: true,
		missing: [] as string[],
		ran: [] as string[],
	})),
	resetDeliverableCheckCache: vi.fn(() => {}),
}));

vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";
import { runRedCheck, runBuildGate, runDeliverableCheck } from "../src/build-runner.ts";

const redCheck = runRedCheck as unknown as ReturnType<typeof vi.fn>;
const buildGate = runBuildGate as unknown as ReturnType<typeof vi.fn>;
const deliverableCheck = runDeliverableCheck as unknown as ReturnType<typeof vi.fn>;

/** Unique substring of the Rust self-verify discipline (single source of truth). */
const RUST_DISCIPLINE_MARKER = "never sufficient proof";

function mkState(language: "rust" | "frontend"): PipelineState {
	return {
		setup: {
			worktreePath: "/tmp/sd-p4-wiring",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language,
			isWebUi: false,
			specIdentifier: "p4",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language, isWebUi: false },
		spec: {
			phases: [{ name: "P4", description: "Mirror no-`--lib` discipline into the TDD prompt" }],
		},
	};
}

interface CapturedCalls {
	tdd: AgentCall[];
	impl: AgentCall[];
	orch: AgentCall[];
	helper: number;
	logs: string[];
}

function mkCtx(): { ctx: StageContext; calls: CapturedCalls } {
	const calls: CapturedCalls = { tdd: [], impl: [], orch: [], helper: 0, logs: [] };
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			calls.helper++;
			// Empty specialist instructions — the discipline must come from
			// `rustDiscipline(setup)`, NOT from the specialist profile.
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			if (call.agent === "tdd-guide") {
				calls.tdd.push(call);
				return { text: "", control: { testFiles: ["tests/red.test.ts"] } };
			}
			if (call.agent === "implementer") {
				calls.impl.push(call);
				return { text: "", control: { filesModified: ["src/x.ts"] } };
			}
			calls.orch.push(call);
			return { text: "", control: {} };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: { count: 0, check: () => true, spent() { this.count++; } } satisfies Budget,
		log(message: string) {
			calls.logs.push(message);
		},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, calls };
}

beforeEach(() => {
	redCheck.mockReset();
	buildGate.mockReset();
	deliverableCheck.mockReset();
	// Default: RED oracle unknown (greenfield-safe, immediate proceed) + gate pass
	// + deliverable check pass (phases declare no contract → backward-compat).
	redCheck.mockImplementation(() => "unknown");
	buildGate.mockImplementation(() => ({
		pass: true,
		inScopePass: false,
		ran: ["npm test"],
		errors: [],
		outOfScopeErrors: [],
	}));
	deliverableCheck.mockImplementation(() => ({
		pass: true,
		missing: [],
		ran: [],
	}));
});

describe("P4 wiring — tdd-guide prompt carries the no-`--lib` discipline for rust (AC-03, SCENARIO-010)", () => {
	it("embeds the discipline in the initial tdd-guide prompt when setup.language === 'rust'", async () => {
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState("rust"), ctx);

		expect(calls.tdd.length).toBeGreaterThanOrEqual(1);
		const initialPrompt = calls.tdd[0].prompt;
		expect(initialPrompt).toContain("cargo test -p");
		expect(initialPrompt).toContain("--lib");
		expect(initialPrompt).toContain(RUST_DISCIPLINE_MARKER);
	});

	it("OMITS the discipline from the tdd-guide prompt when setup.language === 'frontend'", async () => {
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState("frontend"), ctx);

		expect(calls.tdd.length).toBeGreaterThanOrEqual(1);
		const initialPrompt = calls.tdd[0].prompt;
		expect(initialPrompt).not.toContain("cargo test -p");
		expect(initialPrompt).not.toContain(RUST_DISCIPLINE_MARKER);
	});

	it("carries the discipline into the RED-retry tdd-guide prompt as well (rust, green→red)", async () => {
		// RED oracle reports green once (forcing one re-prompt), then red (proceed).
		let i = 0;
		redCheck.mockImplementation(() => {
			const s = i === 0 ? "green" : "red";
			i++;
			return s;
		});
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState("rust"), ctx);

		// initial tdd-guide + at least one RED-retry tdd-guide
		expect(calls.tdd.length).toBeGreaterThanOrEqual(2);
		for (const call of calls.tdd) {
			expect(call.prompt).toContain(RUST_DISCIPLINE_MARKER);
			expect(call.prompt).toContain("cargo test -p");
		}
	});

	it("preserves the original RED-phase instructions alongside the discipline (no regression)", async () => {
		const { ctx, calls } = mkCtx();
		await (implementationStage as Stage).run(mkState("rust"), ctx);
		const initialPrompt = calls.tdd[0].prompt;
		expect(initialPrompt).toContain("Write failing tests FIRST");
		expect(initialPrompt).toContain("red phase of TDD");
		expect(initialPrompt).toContain("testFiles");
	});
});

describe("P4 wiring — outer Stage 9 structure unchanged", () => {
	it("MAX_ATTEMPTS=3 / gate.pass||inScopePass commit condition unaffected: a green gate commits the phase", async () => {
		const { ctx, calls } = mkCtx();
		const res = (await (implementationStage as Stage).run(mkState("rust"), ctx)) as ControlObj;
		// one phase, gate passes → phasesCompleted === 1, allGreen true
		expect(res.phasesCompleted).toBe(1);
		expect(res.allGreen).toBe(true);
		// build-gate invoked exactly once for the single phase (attempt 1 green)
		expect(buildGate).toHaveBeenCalledTimes(1);
		// implementer invoked exactly once
		expect(calls.impl).toHaveLength(1);
	});
});
