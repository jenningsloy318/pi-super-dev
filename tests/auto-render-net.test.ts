/**
 * v0.3.74 P1-b — task() auto-render net (M2 class).
 *
 * Run 2026-09-05T23-09-55-596Z root: renderAndWrite is a MANUAL convention at
 * ~10 call sites — the tests-review stage simply forgot the call, five review
 * completions wrote no artifact, and the reviewer's own finding "no
 * tests-review artifact exists" was literally true. The net: renderAndWrite
 * records the stage id on SetupControl.renderedStageDocs at entry, and task()
 * renders a stage's returned control itself when a STAGE_MODELS entry exists,
 * setup is present, the doc was never rendered this run, and the result is a
 * non-empty object. Manual per-round renders stay authoritative; the net only
 * fills the forgotten-call gap.
 *
 * renderAndWrite is mocked here with a contract-mirroring fake (records the
 * call AND marks renderedStageDocs, exactly like the real entry-marks); the
 * REAL marking behavior is pinned behaviorally in run-audit-fixes.test.ts.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { task } from "../src/nodes.ts";
import { STAGE_MODELS } from "../src/render/schemas.ts";
import { renderAndWrite } from "../src/render/render.ts";
import type { PipelineState, RunOptions, Stage, StageContext } from "../src/types.ts";

const renderMock = renderAndWrite as unknown as ReturnType<typeof vi.fn>;

function mkSetup(): NonNullable<PipelineState["setup"]> {
	return {
		worktreePath: "/tmp/sd-net",
		specDirectory: "/tmp/sd-net/docs/specifications/net",
		defaultBranch: "main",
		language: "frontend",
		isWebUi: false,
		specIdentifier: "net",
		worktreeCreated: false,
		initializedRepo: false,
		renderedStageDocs: new Set<string>(),
	};
}

function mkCtx(logs: string[]): StageContext {
	return {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper() {
			return { value: {}, digest: "" };
		},
		async agent() {
			return { text: "", control: {} };
		},
		async parallel(cbs: Array<() => Promise<unknown>>) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: { count: 0, check: () => true, spent() { this.count++; return true; } },
		log(m: string) {
			logs.push(m);
		},
		phase() {},
		events: new EventEmitter(),
		results: [],
	} as unknown as StageContext;
}

/** Contract-mirroring fake: records the call and marks the stage id at entry,
 *  exactly like the real renderAndWrite's entry-marks. */
function armRenderMock() {
	renderMock.mockReset();
	renderMock.mockImplementation(((setup: { renderedStageDocs?: Set<string> }, _log: unknown, stageId: string) => {
		(setup.renderedStageDocs ??= new Set<string>()).add(stageId);
		return "/tmp/doc.md";
	}) as typeof renderAndWrite);
}

beforeEach(() => {
	armRenderMock();
});

describe("v0.3.74 P1-b — task() auto-render net", () => {
	it("renders a forgotten artifact when the stage has a model but never rendered (M2 incident shape)", async () => {
		const logs: string[] = [];
		const state = { setup: mkSetup() } as PipelineState;
		const control = { verdict: "approved", findings: [] };
		const stage: Stage = { id: "designReview", label: "Design Review", run: async () => control } as unknown as Stage;

		const result = await task(stage).run(state, mkCtx(logs));

		// The stage itself never rendered; the net must have.
		expect(renderMock).toHaveBeenCalledTimes(1);
		expect(renderMock.mock.calls[0][2]).toBe("designReview");
		expect(renderMock.mock.calls[0][3]).toBe(control);
		expect(logs.some((l) => /auto-render net/i.test(l))).toBe(true);
		expect(result).toMatchObject({ status: "ok" });
	});

	it("does NOT double-render when the stage already rendered its control (manual stays authoritative)", async () => {
		const logs: string[] = [];
		const setup = mkSetup();
		const state = { setup } as PipelineState;
		const stage: Stage = {
			id: "codeReview",
			label: "Code Review",
			run: async (_s: PipelineState, ctx: StageContext) => {
				// manual render INSIDE stage.run (the verify.ts convention)
				(setup.renderedStageDocs ??= new Set()).add("codeReview");
				ctx.log("codeReview: doc → 14-code-review.md");
				return { verdict: "approved", findings: [] };
			},
		} as unknown as Stage;

		await task(stage).run(state, mkCtx(logs));

		expect(renderMock).not.toHaveBeenCalled();
		expect(logs.some((l) => /auto-render net/i.test(l))).toBe(false);
	});

	it("skips stages with no STAGE_MODELS entry (classifiers, setup, …)", async () => {
		const logs: string[] = [];
		const state = { setup: mkSetup() } as PipelineState;
		const stage: Stage = { id: "classify", label: "Classify", run: async () => ({ taskType: "bug" }) } as unknown as Stage;
		expect(STAGE_MODELS["classify"]).toBeUndefined();

		await task(stage).run(state, mkCtx(logs));

		expect(renderMock).not.toHaveBeenCalled();
	});

	it("skips empty-object results (agent-error empty controls) and null results", async () => {
		for (const empty of [{}, null, undefined]) {
			const logs: string[] = [];
			const state = { setup: mkSetup() } as PipelineState;
			const stage: Stage = { id: "designReview", label: "Design Review", run: async () => empty } as unknown as Stage;
			await task(stage).run(state, mkCtx(logs));
			expect(renderMock).not.toHaveBeenCalled();
		}
	});

	it("skips when state.setup is absent (pre-setup stages)", async () => {
		const logs: string[] = [];
		const state = {} as PipelineState;
		const stage: Stage = { id: "designReview", label: "Design Review", run: async () => ({ verdict: "approved" }) } as unknown as Stage;

		await task(stage).run(state, mkCtx(logs));

		expect(renderMock).not.toHaveBeenCalled();
	});

	it("fires only ONCE per stage per run even across repeated rounds (net marks, manual rounds keep rendering)", async () => {
		const logs: string[] = [];
		const setup = mkSetup();
		const state = { setup } as PipelineState;
		const control = { verdict: "changes-requested", findings: [{}] };
		const stage: Stage = { id: "requirementsReview", label: "Requirements Review", run: async () => control } as unknown as Stage;

		// Round 1: net renders (nothing rendered yet).
		await task(stage).run(state, mkCtx(logs));
		expect(renderMock).toHaveBeenCalledTimes(1);

		// Round 2 (convergence retry): the net must NOT render again — the mark
		// is run-scoped; the convergence loop's own manual render owns updates.
		await task(stage).run(state, mkCtx(logs));
		expect(renderMock).toHaveBeenCalledTimes(1);
	});
});
