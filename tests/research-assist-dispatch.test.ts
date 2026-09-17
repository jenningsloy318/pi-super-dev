import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchResearchAssist } from "../src/stages/implementation/research-assist-dispatch.ts";
import { runResearchAssist } from "../src/stages/research-assist.ts";
import type { StageContext } from "../src/types.ts";

// The dispatch is a pure resolver over the two trigger sources + the cap/budget
// guards; runResearchAssist is mocked so the tests exercise the ROUTING, not the
// agent call. The mock's call args are captured, because the two assertions that
// matter most — the failingTargets wiring and the RED-over-GREEN precedence —
// are only observable there (both gates' F2/F3: asserting on the returned block
// alone cannot fail on a routing break).

vi.mock("../src/stages/research-assist.ts", () => ({
	runResearchAssist: vi.fn(async () => ({
		block: "## Research findings\nawait the initializer",
		row: { outcome: "answered", enrichedByNeedsResearch: true, noUsefulSignal: false, durationMs: 1200 },
		toolBudgetSent: true,
	})),
}));

const ctx = () =>
	({
		log: vi.fn(),
		budget: { check: () => true },
	} as unknown as StageContext);

const baseInput = (overrides: Record<string, unknown> = {}) => ({
	ctx: ctx(),
	specDirectory: "/spec",
	phaseId: "phase-02",
	phaseName: "the phase",
	attempt: 3,
	redAssistArmed: {},
	researchAssistPending: null,
	phaseResearchAssistUsed: {},
	needsResearchArchive: [],
	testFiles: ["src/a.test.ts"],
	...overrides,
});

const lastCall = () => vi.mocked(runResearchAssist).mock.calls.at(-1)?.[0];

beforeEach(() => {
	// The spy accumulates calls across the suite — clear it so a decline-path
	// assertion sees "no call this test" rather than the previous test's call.
	vi.mocked(runResearchAssist).mockClear();
});

describe("research-assist dispatch (v0.4.34 increment-6 extraction)", () => {
	it("declines with no block when NEITHER trigger source is set (the caller's pending-slot clear runs regardless — it is caller-owned, not this module's)", async () => {
		const redAssistArmed: Record<string, unknown> = {};
		const out = await dispatchResearchAssist(baseInput({ redAssistArmed }) as never);
		expect(out.block).toBeNull();
		expect(lastCall()).toBeUndefined(); // never dispatched
	});

	it("dispatches on a RED arm, deletes the arm, sets the phase cap, returns the block", async () => {
		const redAssistArmed: Record<string, { tries: number; detail: string; testFiles: string[] }> = {
			"phase-02": { tries: 2, detail: "no runnable test command", testFiles: ["src/a.test.ts"] },
		};
		const used: Record<string, boolean> = {};
		const out = await dispatchResearchAssist(baseInput({ redAssistArmed, phaseResearchAssistUsed: used }) as never);
		expect(out.block).toContain("Research findings");
		expect(redAssistArmed["phase-02"]).toBeUndefined(); // consumed either way
		expect(used["phase-02"]).toBe(true); // P8 cap consumed
	});

	it("dispatches on a GREEN pending trigger with the confirmed test files as failingTargets", async () => {
		const used: Record<string, boolean> = {};
		const out = await dispatchResearchAssist(
			baseInput({
				researchAssistPending: { triggerDetail: "fault-class BuildFailure × 2", contextLines: ["compile error in a.ts"] },
				phaseResearchAssistUsed: used,
			}) as never,
		);
		expect(out.block).toContain("Research findings");
		expect(used["phase-02"]).toBe(true);
		const call = lastCall();
		expect(call?.trigger).toBe("GREEN");
		expect(call?.failingTargets).toEqual(["src/a.test.ts"]); // a copy of the confirmed RED files
		expect(call?.contextLines).toEqual(["compile error in a.ts"]);
	});

	it("a RED arm takes precedence over a GREEN pending trigger (both sources set)", async () => {
		const redAssistArmed: Record<string, unknown> = { "phase-02": { tries: 3, detail: "d", testFiles: ["x.test.ts"] } };
		const out = await dispatchResearchAssist(baseInput({ redAssistArmed, researchAssistPending: { triggerDetail: "green-side detail", contextLines: ["green ctx"] } }) as never);
		expect(out.block).not.toBeNull();
		expect(redAssistArmed["phase-02"]).toBeUndefined();
		// The block alone cannot distinguish this from a GREEN-preferring implementation —
		// the captured call args are the only pin on the precedence (both gates' F3).
		const call = lastCall();
		expect(call?.trigger).toBe("RED");
		expect(call?.failingTargets).toEqual(["x.test.ts"]); // the ARM's files, not testFiles
		expect(call?.contextLines).not.toContain("green ctx");
	});

	it("declines (P8) when the per-phase cap is already spent, and still deletes the arm", async () => {
		const redAssistArmed: Record<string, unknown> = { "phase-02": { tries: 2, detail: "d", testFiles: [] } };
		const out = await dispatchResearchAssist(baseInput({ redAssistArmed, phaseResearchAssistUsed: { "phase-02": true } }) as never);
		expect(out.block).toBeNull();
		expect(redAssistArmed["phase-02"]).toBeUndefined(); // consumed either way — never leaks to a later attempt
		expect(lastCall()).toBeUndefined(); // declined: no dispatch
	});

	it("declines when the budget is exhausted, and still deletes the arm", async () => {
		const redAssistArmed: Record<string, unknown> = { "phase-02": { tries: 2, detail: "d", testFiles: [] } };
		const broke = { ...ctx(), budget: { check: () => false } } as unknown as StageContext;
		const out = await dispatchResearchAssist(baseInput({ ctx: broke, redAssistArmed }) as never);
		expect(out.block).toBeNull();
		expect(redAssistArmed["phase-02"]).toBeUndefined();
		expect(lastCall()).toBeUndefined();
	});

	it("the block-null return is the caller's archive-clear gate: declines leave the archive untouched, dispatch forwards it (needsResearch)", async () => {
		// The caller clears needsResearchArchive only under `if (assist.block)`, so
		// block-non-null ⟺ dispatch ran ⟺ archive consumed is the extraction's
		// load-bearing invariant (adversarial F2). The module forwards the array by
		// ref on dispatch and never touches it on decline.
		const archive = [{ kind: "gap", text: "how does the registry dedupe?" }];

		const declined = await dispatchResearchAssist(baseInput({ needsResearchArchive: archive, phaseResearchAssistUsed: { "phase-02": true } }) as never);
		expect(declined.block).toBeNull();
		expect(archive).toHaveLength(1); // untouched on decline

		const dispatched = await dispatchResearchAssist(baseInput({ needsResearchArchive: archive, redAssistArmed: { "phase-02": { tries: 1, detail: "d", testFiles: [] } } }) as never);
		expect(dispatched.block).not.toBeNull();
		expect(lastCall()?.needsResearch).toBe(archive); // forwarded by ref — the ledger row's enrichment source
	});
});
