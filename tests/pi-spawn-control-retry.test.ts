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
		// Phase 6 / AC-12: runPi now calls setEncoding("utf8") on both child
		// streams — the fake child carries real PassThrough streams (same shape
		// as a spawned pipe) instead of bare EventEmitters.
		const { PassThrough } = require("node:stream") as typeof import("node:stream");
		const child = new EventEmitter() as EventEmitter & {
			stdout: import("node:stream").PassThrough;
			stderr: import("node:stream").PassThrough;
			kill: ReturnType<typeof vi.fn>;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = vi.fn();
		queueMicrotask(() => {
			child.stdout.write(Buffer.from(harness.state.outputs.shift() ?? ""));
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

describe("spawnAgent optionality: optional-by-contract empty arrays (Fix 1d)", () => {
	const implKeys = ["filesCreated", "filesModified", "filesDeleted", "testsPassCount", "summary", "testDefects"];

	it("testDefects: [] on a green run does NOT trigger a corrective retry", async () => {
		harness.reset([
			msg('Done.\n<control>{"filesCreated":[],"filesModified":["src/a.ts"],"filesDeleted":[],"testsPassCount":"45","summary":"ok","testDefects":[]}</control>'),
		]);
		const result = await spawnAgent({
			agent: "implementer",
			prompt: "implement",
			controlKeys: implKeys,
			allowEmptyArraysFor: ["testDefects"],
		} as Parameters<typeof spawnAgent>[0]);
		expect(result.error).toBeUndefined();
		expect(result.control).toMatchObject({ testsPassCount: "45", testDefects: [] });
		// Exactly ONE spawn: no corrective retry.
		expect(harness.state.calls.length).toBe(1);
	});

	it("testDefects ABSENT still triggers exactly one corrective retry", async () => {
		harness.reset([
			msg('Done.\n<control>{"filesCreated":[],"filesModified":["src/a.ts"],"filesDeleted":[],"testsPassCount":"45","summary":"ok"}</control>'),
			msg('Done.\n<control>{"filesCreated":[],"filesModified":["src/a.ts"],"filesDeleted":[],"testsPassCount":"45","summary":"ok","testDefects":[]}</control>'),
		]);
		const result = await spawnAgent({
			agent: "implementer",
			prompt: "implement",
			controlKeys: implKeys,
			allowEmptyArraysFor: ["testDefects"],
		} as Parameters<typeof spawnAgent>[0]);
		expect(result.error).toBeUndefined();
		expect(result.control).toMatchObject({ testDefects: [] });
		expect(harness.state.calls.length).toBe(2);
	});

	it("default behavior unchanged: empty non-allow-listed array is still an error without the option", async () => {
		harness.reset([
			msg('Done.\n<control>{"filesCreated":[],"filesModified":["src/a.ts"],"filesDeleted":[],"testsPassCount":"45","summary":"ok","testDefects":[]}</control>'),
			msg('Done.\n<control>{"filesCreated":[],"filesModified":["src/a.ts"],"filesDeleted":[],"testsPassCount":"45","summary":"ok","testDefects":[{"testFile":"a.test.ts","lines":"5","reason":"r"}]}</control>'),
		]);
		const result = await spawnAgent({
			agent: "implementer",
			prompt: "implement",
			controlKeys: implKeys,
		} as Parameters<typeof spawnAgent>[0]);
		expect(result.error).toBeUndefined();
		expect(result.control).toMatchObject({ testDefects: [{ testFile: "a.test.ts", lines: "5", reason: "r" }] });
		expect(harness.state.calls.length).toBe(2);
	});
});
