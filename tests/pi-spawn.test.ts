/**
 * Tests for the spawn-output parsing in pi-spawn.ts. No subprocess, no LLM —
 * these feed captured NDJSON event streams directly to the parser to assert
 * the resilient text-capture behavior that recovers control JSON even when an
 * agent ends on a trailing tool-call turn or is killed mid-stream.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFinalAssistant, buildSpawnArgs, summarizeToolCall, renderEvent, isCodeWritingAgent, defaultAgentTimeoutMs, needsWebResearch, toolsForAgent, resolveExtensionEntry } from "../src/pi-spawn.ts";

const line = (obj: unknown) => JSON.stringify(obj);

describe("isCodeWritingAgent / defaultAgentTimeoutMs", () => {
	it("classifies the code-writing agents", () => {
		expect(isCodeWritingAgent("implementer")).toBe(true);
		expect(isCodeWritingAgent("tdd-guide")).toBe(true);
		expect(isCodeWritingAgent("research-agent")).toBe(false);
		expect(isCodeWritingAgent("spec-writer")).toBe(false);
		expect(isCodeWritingAgent("orchestrator")).toBe(false);
	});
	it("gives code-writing agents a strictly larger default timeout than doc writers", () => {
		// Root-cause fix: the implementer must read a large file AND land+verify
		// edits within one turn; the 480s doc-writer cap aborted it mid-exploration.
		expect(defaultAgentTimeoutMs("implementer")).toBeGreaterThan(defaultAgentTimeoutMs("research-agent"));
		expect(defaultAgentTimeoutMs("tdd-guide")).toBeGreaterThan(defaultAgentTimeoutMs("spec-writer"));
		expect(defaultAgentTimeoutMs("research-agent")).toBe(480_000);
		expect(defaultAgentTimeoutMs("implementer")).toBe(1_200_000);
	});
});

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

	it("non-browser agents keep --no-extensions and the base tool set", () => {
		const args = buildSpawnArgs({ agent: "requirements-clarifier", prompt: "x", cwd: "/tmp" }, "/tmp/a.md");
		expect(args).toContain("--no-extensions");
		const tools = args[args.indexOf("--tools") + 1];
		expect(tools).toBe("read,bash,edit,write,ffgrep,fffind");
		expect(tools).not.toContain("browser_execute");
	});

	it("browser agents (qa-agent, ui-tester) drop --no-extensions and gain browser_execute", () => {
		for (const agent of ["qa-agent", "ui-tester"]) {
			const args = buildSpawnArgs({ agent, prompt: "x", cwd: "/tmp" }, "/tmp/a.md");
			expect(args, agent).not.toContain("--no-extensions");
			const tools = args[args.indexOf("--tools") + 1];
			expect(tools, agent).toContain("browser_execute");
			expect(tools, agent).toContain("read,bash,edit,write,ffgrep,fffind");
		}
	});

	it("research-agent KEEPS --no-extensions and loads ONLY pi-web-access + pi-mcp-adapter via -e, gaining web+mcp tools", () => {
		const exts = ["/agent/npm/node_modules/pi-web-access/index.ts", "/agent/npm/node_modules/pi-mcp-adapter/index.ts"];
		const args = buildSpawnArgs({ agent: "research-agent", prompt: "x", cwd: "/tmp" }, "/tmp/a.md", exts);
		// isolation preserved: --no-extensions STAYS (unlike the rushed drop-everything approach)
		expect(args).toContain("--no-extensions");
		// only the two named extensions are loaded explicitly
		for (const e of exts) {
			const i = args.indexOf(e);
			expect(i).toBeGreaterThan(0);
			expect(args[i - 1]).toBe("-e");
		}
		const tools = args[args.indexOf("--tools") + 1];
		expect(tools).toContain("read,bash,edit,write,ffgrep,fffind");
		expect(tools).toContain("web_search");
		expect(tools).toContain("fetch_content");
		expect(tools).toContain("get_search_content");
		expect(tools).toContain("mcp");
		expect(tools).not.toContain("browser_execute");
	});
});

describe("web-research agent classification", () => {
	it("needsWebResearch is true only for research-agent", () => {
		expect(needsWebResearch("research-agent")).toBe(true);
		expect(needsWebResearch("code-assessor")).toBe(false);
		expect(needsWebResearch("implementer")).toBe(false);
		expect(needsWebResearch("qa-agent")).toBe(false);
	});

	it("toolsForAgent gives web+mcp to research, browser tool to browser, base to the rest", () => {
		expect(toolsForAgent("research-agent")).toBe("read,bash,edit,write,ffgrep,fffind,web_search,fetch_content,get_search_content,mcp");
		expect(toolsForAgent("qa-agent")).toBe("read,bash,edit,write,ffgrep,fffind,browser_execute");
		expect(toolsForAgent("spec-writer")).toBe("read,bash,edit,write,ffgrep,fffind");
	});

	it("resolveExtensionEntry returns the entry path when installed, null otherwise", () => {
		const tmp = mkdtempSync(join(tmpdir(), "sd-ext-"));
		const pkgDir = join(tmp, "npm", "node_modules", "pi-web-access");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "index.ts"), "// stub");
		expect(resolveExtensionEntry("pi-web-access", tmp)).toBe(join(pkgDir, "index.ts"));
		expect(resolveExtensionEntry("pi-mcp-adapter", tmp)).toBeNull();
		rmSync(tmp, { recursive: true, force: true });
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
	it("shows the FULL multi-line bash/python command (not just the first line)", () => {
		const cmd = "python3 -c \"\nimport sys\nprint(sys.version)\n\"";
		expect(summarizeToolCall("bash", { command: cmd })).toBe(`$ ${cmd}`);
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
