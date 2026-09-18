import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/runlog.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/runlog.ts")>();
	return { ...actual, appendRunEvent: vi.fn() };
});
vi.mock("../src/wall-fuse.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/wall-fuse.ts")>();
	return { ...actual, runWallFusePreCallError: vi.fn() };
});
vi.mock("../src/workflow/usage-accounting.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/workflow/usage-accounting.ts")>();
	return { ...actual, usageFuseError: vi.fn() };
});

const { preCallFuseError } = await import("../src/workflow/pre-call-fuses.ts");
const { appendRunEvent } = await import("../src/runlog.ts");
const { runWallFusePreCallError } = await import("../src/wall-fuse.ts");
const { usageFuseError } = await import("../src/workflow/usage-accounting.ts");

function baseInput(over: Partial<Parameters<typeof preCallFuseError>[0]> = {}) {
	return {
		state: { setup: { specDirectory: "/spec" }, __runId: "run-1" },
		call: { agent: "sd-impl", id: "pipeline.implementation.phase-01" },
		budget: { count: 0, check: () => true, spent: vi.fn(() => true) },
		wallFuse: { tripped: false },
		usage: { totals: { calls: 0 } },
		log: vi.fn(),
		...over,
	} as unknown as Parameters<typeof preCallFuseError>[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(runWallFusePreCallError).mockReturnValue(null);
	vi.mocked(usageFuseError).mockReturnValue(null);
});

describe("workflow/pre-call-fuses — wave 2 increment 5 (budget → wall fuse → cost/token fuse)", () => {
	it("budget exhausted: the honest error + ONE agent.called row (backend n/a), no log, no further fuse consulted", () => {
		const input = baseInput({ budget: { count: 9, check: () => false, spent: vi.fn(() => false) } as never });
		const out = preCallFuseError(input);
		expect(out).toBe("budget exhausted (maxAgents reached)");
		expect(appendRunEvent).toHaveBeenCalledTimes(1);
		expect(appendRunEvent).toHaveBeenCalledWith("/spec", expect.objectContaining({
			runId: "run-1",
			agent: "sd-impl",
			stage: "implementation.phase-01", // the pipeline. prefix stripped
			type: "agent.called",
			data: { agent: "sd-impl", backend: "n/a", durationMs: 0, error: "budget exhausted (maxAgents reached)" },
		}));
		expect(input.log).not.toHaveBeenCalled();
		expect(runWallFusePreCallError).not.toHaveBeenCalled();
	});

	it("wall fuse tripped: logged under the call id, one row, the fuse error returned — usage fuse NOT consulted", () => {
		vi.mocked(runWallFusePreCallError).mockReturnValue("wall fuse tripped: spent 61m >= 60m cap");
		const input = baseInput();
		const out = preCallFuseError(input);
		expect(out).toBe("wall fuse tripped: spent 61m >= 60m cap");
		expect(input.log).toHaveBeenCalledWith("agent pipeline.implementation.phase-01: wall fuse tripped: spent 61m >= 60m cap");
		expect(appendRunEvent).toHaveBeenCalledWith("/spec", expect.objectContaining({
			data: expect.objectContaining({ error: "wall fuse tripped: spent 61m >= 60m cap" }),
		}));
		expect(usageFuseError).not.toHaveBeenCalled();
	});

	it("cost/token fuse tripped: same shape (log + row + error)", () => {
		vi.mocked(runWallFusePreCallError).mockReturnValue(null);
		vi.mocked(usageFuseError).mockReturnValue("usage fuse tripped: SUPER_DEV_MAX_RUN_COST spent $51.0000 >= limit $50");
		const input = baseInput();
		const out = preCallFuseError(input);
		expect(out).toContain("usage fuse tripped");
		expect(input.log).toHaveBeenCalled();
		expect(appendRunEvent).toHaveBeenCalledTimes(1);
	});

	it("all clear: null, zero events, zero logs — the call may proceed", () => {
		vi.mocked(runWallFusePreCallError).mockReturnValue(null);
		vi.mocked(usageFuseError).mockReturnValue(null);
		const input = baseInput();
		expect(preCallFuseError(input)).toBeNull();
		expect(appendRunEvent).not.toHaveBeenCalled();
		expect(input.log).not.toHaveBeenCalled();
	});
});
