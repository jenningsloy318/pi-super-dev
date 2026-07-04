/**
 * Tests for the spawn-output parsing in pi-spawn.ts. No subprocess, no LLM —
 * these feed captured NDJSON event streams directly to the parser to assert
 * the resilient text-capture behavior that recovers control JSON even when an
 * agent ends on a trailing tool-call turn or is killed mid-stream.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { extractFinalAssistant, buildSpawnArgs, summarizeToolCall, renderEvent } from "../src/pi-spawn.ts";

const line = (obj: unknown) => JSON.stringify(obj);

describe("extractFinalAssistant", () => {
	it("returns the assistant text from a single message_end", () => {
		const stdout = [line({ type: "message_start" }), line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })].join("\n");
		expect(extractFinalAssistant(stdout).text).toBe("hello");
	});

	it("keeps the LAST NON-EMPTY text when a later turn ends on a tool call", () => {
		// Turn N emits the control block as text; turn N+1 ends on a tool_use
		// (no text). The trailing empty message_end must NOT discard the control.
		const stdout = [
			line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: 'done\n<control>{"ok":true}</control>' }] } }),
			line({ type: "message_end", message: { role: "assistant", content: [{ type: "tool_use", name: "write" }] } }),
		].join("\n");
		expect(extractFinalAssistant(stdout).text).toContain('<control>{"ok":true}</control>');
	});

	it("returns empty when no assistant text ever appeared", () => {
		const stdout = [
			line({ type: "message_end", message: { role: "assistant", content: [{ type: "tool_use", name: "read" }] } }),
			line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "tool result" }] } }),
		].join("\n");
		expect(extractFinalAssistant(stdout).text).toBe("");
	});

	it("ignores malformed/non-JSON lines without throwing", () => {
		const stdout = ["not json at all", "", line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }), "{ broken"];
		expect(extractFinalAssistant(stdout.join("\n")).text).toBe("ok");
	});

	it("captures the model from the final assistant message", () => {
		const stdout = [line({ type: "message_end", message: { role: "assistant", model: "glm-5.2", content: [{ type: "text", text: "hi" }] } })].join("\n");
		expect(extractFinalAssistant(stdout).model).toBe("glm-5.2");
	});
});

describe("buildSpawnArgs", () => {
	const base = { agent: "requirements-clarifier", prompt: "do X", cwd: "/tmp" };

	it("element 0 is a real executable, never a flag (regression: spawn --mode ENOENT)", () => {
		const args = buildSpawnArgs(base, "/tmp/agent.md");
		// The bug dropped `command`, making args[0] === "--mode".
		expect(args[0].startsWith("-")).toBe(false);
		expect(args[0].length).toBeGreaterThan(0);
	});

	it("includes the required pi flags after the executable", () => {
		const args = buildSpawnArgs(base, "/tmp/agent.md");
		expect(args).toContain("--mode");
		expect(args[args.indexOf("--mode") + 1]).toBe("json");
		expect(args).toContain("-p");
		expect(args).toContain("--no-session");
		expect(args).toContain("--system-prompt");
		expect(args[args.indexOf("--system-prompt") + 1]).toBe("/tmp/agent.md");
	});

	it("appends the task as the final positional 'Task: ...' arg", () => {
		const args = buildSpawnArgs({ ...base, prompt: "hello world" }, "/tmp/agent.md");
		expect(args[args.length - 1]).toBe("Task: hello world");
	});

	it("adds --model when a model override is provided", () => {
		const args = buildSpawnArgs({ ...base, model: "openai/gpt-4o" }, "/tmp/agent.md");
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-4o");
	});
});

describe("summarizeToolCall", () => {
	it("summarizes a write/edit/read by path (full, no abbreviation)", () => {
		expect(summarizeToolCall("write", { path: "docs/01-requirements.md" })).toBe("write docs/01-requirements.md");
		expect(summarizeToolCall("read", { path: "src/index.ts" })).toBe("read src/index.ts");
	});
	it("shows the full bash command (no artificial truncation)", () => {
		expect(summarizeToolCall("bash", { command: "npm test && npm run build" })).toBe("$ npm test && npm run build");
		expect(summarizeToolCall("bash", { command: "x".repeat(200) })).toBe(`$ ${"x".repeat(200)}`);
	});
	it("summarizes ffgrep/fffind by pattern", () => {
		expect(summarizeToolCall("ffgrep", { pattern: "TODO" })).toBe('ffgrep "TODO"');
	});
	it("falls back to the tool name for unknown tools", () => {
		expect(summarizeToolCall("mystery", { x: 1 })).toBe("mystery");
	});
});

describe("renderEvent (live progress extraction)", () => {
	const noTurn = () => 0;
	const ev = (o: unknown) => o as Parameters<typeof renderEvent>[0];

	it("extracts accumulated live text from a message_update event", () => {
		const r = renderEvent(ev({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "I will check" }] } }), noTurn);
		expect(r).toEqual({ kind: "text", text: "I will check" });
	});
	it("surfaces tool calls", () => {
		const r = renderEvent(ev({ type: "tool_execution_start", toolName: "write", args: { path: "docs/x.md" } }), noTurn);
		expect(r).toEqual({ kind: "tool", summary: "write docs/x.md" });
	});
	it("surfaces turn counts", () => {
		let n = 0;
		expect(renderEvent(ev({ type: "turn_start" }), () => ++n)).toEqual({ kind: "turn", n: 1 });
	});
	it("returns null for irrelevant events", () => {
		expect(renderEvent(ev({ type: "message_update", message: { content: [{ type: "thinking" }] } }), noTurn)).toBeNull();
		expect(renderEvent(ev({ type: "tool_execution_end" }), noTurn)).toBeNull();
	});
});
