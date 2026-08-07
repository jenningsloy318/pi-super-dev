import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";

const msg = (text: string) => `${JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }] },
})}\n`;

const harness = vi.hoisted(() => {
	const state = {
		outputs: [] as string[],
		calls: [] as Array<{ command: string; args: string[]; cwd?: string }>,
	};
	return {
		state,
		reset(outputs: string[]) {
			state.outputs = [...outputs];
			state.calls = [];
		},
	};
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn((command: string, args: string[], opts: { cwd?: string } = {}) => {
		harness.state.calls.push({ command, args, cwd: opts.cwd });
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: ReturnType<typeof vi.fn>;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from(harness.state.outputs.shift() ?? ""));
			child.emit("close", 0);
		});
		return child;
	}),
}));

vi.mock("../src/agents.ts", () => ({ loadAgentPrompt: vi.fn(() => "LOCAL AGENT PROMPT") }));
vi.mock("../src/safety.ts", () => ({ safetyPreamble: vi.fn(() => "SAFETY") }));

import { spawnAgent } from "../src/pi-spawn.ts";

describe("spawnAgent subprocess control repair", () => {
	beforeEach(() => {
		harness.reset([]);
	});

	it("does one corrective subprocess retry when the first response has no control object", async () => {
		const events: string[] = [];
		harness.reset([
			msg("I wrote the document but forgot the control block."),
			msg('Done.\n<control>{"docPath":"docs/01-requirements.md","summary":"ok"}</control>'),
		]);

		const result = await spawnAgent({
			agent: "requirements-clarifier",
			id: "pipeline.requirements",
			prompt: "write requirements",
			cwd: "/tmp/project",
			controlKeys: ["docPath", "summary"],
			onProgress: { event: (m) => { events.push(m); }, text: () => {} },
		});

		expect(harness.state.calls).toHaveLength(2);
		expect(harness.state.calls[0].args.join(" ")).toContain("--no-extensions");
		expect(harness.state.calls[0].args.join(" ")).toContain("--no-context-files");
		expect(harness.state.calls[0].args.at(-1)).toContain("Required Final Control Output");
		expect(harness.state.calls[1].args.at(-1)).toContain("Corrective Retry");
		expect(harness.state.calls[1].args.at(-1)).toContain("gate=required-control-output");
		expect(events.some((e) => e.includes("corrective subprocess retry"))).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.control).toEqual({ docPath: "docs/01-requirements.md", summary: "ok" });
	});
});
