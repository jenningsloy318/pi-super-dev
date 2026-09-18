import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/render/knowledge.ts", () => ({ knowledgeForAgent: vi.fn() }));
vi.mock("../src/render/user-notes.ts", () => ({ appendUserNotes: vi.fn(), userNotesForAgent: vi.fn() }));
vi.mock("../src/team/messages.ts", () => ({ recordInstruction: vi.fn() }));
vi.mock("../src/control.ts", () => ({ drainControlDrift: vi.fn(() => []), extractControlKeys: vi.fn(() => ["verdict"]) }));
vi.mock("../src/retry-feedback.ts", () => ({
	getRetryFeedback: vi.fn(() => []),
	renderRetryFeedbackBlock: vi.fn((items) => `FEEDBACK(${items.length})`),
}));
vi.mock("../src/convergence-ledger.ts", () => ({
	convergenceRetryFeedback: vi.fn(() => []),
	normalizeConvergenceStage: vi.fn((s) => s),
}));
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return { ...actual, languageDirective: vi.fn(() => "LANGUAGE: deutsch") };
});

const { assembleAgentCall, DELEGATION_AUTONOMY_CLAUSE } = await import("../src/workflow/agent-call-assembly.ts");
const { knowledgeForAgent } = await import("../src/render/knowledge.ts");
const { appendUserNotes, userNotesForAgent } = await import("../src/render/user-notes.ts");
const { recordInstruction } = await import("../src/team/messages.ts");
const { getRetryFeedback, renderRetryFeedbackBlock } = await import("../src/retry-feedback.ts");
const { convergenceRetryFeedback } = await import("../src/convergence-ledger.ts");

function call4(call: Record<string, unknown>, state: Record<string, unknown> = {}, options: Record<string, unknown> = {}, log: ReturnType<typeof vi.fn> = vi.fn()) {
	return assembleAgentCall(call as never, state as never, options as never, log);
}

describe("workflow/agent-call-assembly — wave 2 increment 6 (prompt assembly + per-call policy)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(knowledgeForAgent).mockReturnValue(null as unknown as string);
		vi.mocked(userNotesForAgent).mockReturnValue(null as unknown as string);
		vi.mocked(getRetryFeedback).mockReturnValue([]);
		vi.mocked(convergenceRetryFeedback).mockReturnValue([]);
	});

	it("plain call: autonomy clause rides every prompt, language directive LAST, no feedback/knowledge/notes sections", () => {
		const a = call4({ agent: "sd-impl", prompt: "DO THE WORK" }, {}, {} as never);
		expect(a.promptWithLanguage).toBe(`DO THE WORK\n\n${DELEGATION_AUTONOMY_CLAUSE}\n\nLANGUAGE: deutsch`);
		expect(a.promptWithAccess).toBe(`DO THE WORK\n\n${DELEGATION_AUTONOMY_CLAUSE}`); // pre-language
		expect(a.accessMode).toBe("write"); // default
		expect(a.controlKeys).toEqual(["verdict"]); // extracted from the prompt
		expect(a.timeoutLabel).toBe("role-default");
	});

	it("feedback present: autonomy + rendered feedback block + the re-produce directive", () => {
		vi.mocked(getRetryFeedback).mockReturnValue([{ message: "gate failed: tsc" } as never]);
		const a = call4({ agent: "sd-impl", prompt: "P" }, {}, {} as never);
		expect(a.promptWithLanguage).toContain(`\n\n${DELEGATION_AUTONOMY_CLAUSE}\n\nFEEDBACK(1)\nRe-produce the complete artifact, then call structured_output.`);
		expect(renderRetryFeedbackBlock).toHaveBeenCalled();
	});

	it("the ledger-feedback dedupe: a pre-existing convergence-ledger item suppresses the ledger query", () => {
		vi.mocked(getRetryFeedback).mockReturnValue([{ location: "convergence-ledger/01-requirements" } as never]);
		call4({ agent: "sd-impl", prompt: "P" }, {}, {} as never);
		expect(convergenceRetryFeedback).not.toHaveBeenCalled();
	});

	it("user-steer drain: notes persist (appendUserNotes + one recordInstruction per note) and inject into THIS prompt", () => {
		vi.mocked(userNotesForAgent).mockReturnValue("note from the human");
		const options = { userSteerProvider: () => ["fix the colors"] } as never;
		call4({ agent: "sd-impl", prompt: "P" }, { setup: { specDirectory: "/spec" } }, options);
		expect(appendUserNotes).toHaveBeenCalledWith("/spec", ["fix the colors"]);
		expect(recordInstruction).toHaveBeenCalledWith("/spec", "fix the colors", "unknown"); // ledgerRunId of a bare state
	});

	it("knowledge injection rides between the prompt and the user-notes section", () => {
		vi.mocked(knowledgeForAgent).mockReturnValue("K: prior verdict=Approved");
		vi.mocked(userNotesForAgent).mockReturnValue("N: user note");
		const a = call4({ agent: "sd-impl", prompt: "P" }, { setup: { specDirectory: "/spec" } }, {} as never);
		const s = a.promptWithLanguage;
		expect(s.indexOf("## Prior-stage data (auto-injected)")).toBeGreaterThan(s.indexOf(DELEGATION_AUTONOMY_CLAUSE));
		expect(s.indexOf("## User context (added during the run)")).toBeGreaterThan(s.indexOf("Prior-stage data"));
		expect(s.lastIndexOf("LANGUAGE: deutsch")).toBeGreaterThan(s.indexOf("User context"));
	});

	it("source-read-only: the mutation-boundary section applies BEFORE the language directive", () => {
		const a = call4({ agent: "sd-review", prompt: "P", accessMode: "source-read-only" }, {}, {} as never);
		expect(a.accessMode).toBe("source-read-only");
		expect(a.promptWithAccess).toContain("## Source mutation boundary");
		expect(a.promptWithLanguage.endsWith("\n\nLANGUAGE: deutsch")).toBe(true);
	});

	it("per-call policy: explicit controlKeys/timeout/thinking win; the :level suffix fills thinking when absent", () => {
		const a = call4({ agent: "sd-impl", prompt: "P", controlKeys: ["pass"], timeoutMs: 45_000, thinking: "high" }, {}, {} as never);
		expect(a.controlKeys).toEqual(["pass"]);
		expect(a.timeoutMs).toBe(45_000);
		expect(a.timeoutLabel).toBe("45000ms");
		expect(a.perCallThinking).toBe("high");
		const b = call4({ agent: "sd-impl", prompt: "P", model: "glm-5.3:low" }, {}, {} as never);
		expect(b.perCallThinking).toBe("low"); // splitModelThinking fills from the suffix
	});
});
