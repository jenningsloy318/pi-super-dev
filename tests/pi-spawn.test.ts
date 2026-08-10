/**
 * Tests for the spawn-output parsing in pi-spawn.ts. No subprocess, no LLM —
 * these feed captured NDJSON event streams directly to the parser to assert
 * the resilient text-capture behavior that recovers control JSON even when an
 * agent ends on a trailing tool-call turn or is killed mid-stream.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFinalAssistant, buildSpawnArgs, buildSubprocessTaskPrompt, summarizeToolCall, renderEvent, isCodeWritingAgent, defaultAgentTimeoutMs, needsWebResearch, resolveExtensionEntry, resolveExtensionEntries, resolveThinking, type ThinkingLevel } from "../src/pi-spawn.ts";

const line = (obj: unknown) => JSON.stringify(obj);
/** Minimal inherited-model object for tests (only provider+id are read by buildSpawnArgs). */
const inheritedModel = (provider: string, id: string) => ({ provider, id } as unknown as import("../src/session-agent.ts").SessionModelOption);

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
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-context-files");
		expect(args).toContain("--no-prompt-templates");
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

	it("non-browser agents disable ambient resources and exclude only super_dev", () => {
		const args = buildSpawnArgs({ agent: "requirements-clarifier", prompt: "x", cwd: "/tmp" }, "/tmp/a.md");
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-context-files");
		expect(args).not.toContain("--tools");
		expect(args[args.indexOf("--exclude-tools") + 1]).toBe("super_dev");
	});

	it("source-read-only subprocess agents exclude edit and write tools", () => {
		const args = buildSpawnArgs({ agent: "debug-analyzer", prompt: "x", cwd: "/tmp", accessMode: "source-read-only" }, "/tmp/a.md");
		expect(args[args.indexOf("--exclude-tools") + 1]).toBe("super_dev,edit,write");
	});

	it("browser agents keep ambient discovery disabled and load browser_execute only through explicit -e paths", () => {
		const ext = "/agent/npm/node_modules/pi-browser-cdp-extension/extensions/browser-execute.ts";
		for (const agent of ["qa-agent", "ui-tester"]) {
			const args = buildSpawnArgs({ agent, prompt: "x", cwd: "/tmp" }, "/tmp/a.md", [ext]);
			expect(args, agent).toContain("--no-extensions");
			expect(args, agent).toContain("--no-context-files");
			expect(args, agent).not.toContain("--tools");
			expect(args[args.indexOf(ext) - 1], agent).toBe("-e");
			expect(args[args.indexOf("--exclude-tools") + 1], agent).toBe("super_dev");
		}
	});

	it("research-agent keeps ambient discovery disabled and loads only its explicit role extensions", () => {
		const exts = ["/agent/npm/node_modules/pi-web-access/index.ts", "/agent/npm/node_modules/pi-mcp-adapter/index.ts"];
		const args = buildSpawnArgs({ agent: "research-agent", prompt: "x", cwd: "/tmp" }, "/tmp/a.md", exts);
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-context-files");
		expect(args).not.toContain("--tools");
		expect(args[args.indexOf("--exclude-tools") + 1]).toBe("super_dev");
		for (const e of exts) {
			const i = args.indexOf(e);
			expect(i).toBeGreaterThan(0);
			expect(args[i - 1]).toBe("-e");
		}
	});

	it("appends the required <control> contract when controlKeys are provided", () => {
		const args = buildSpawnArgs({ ...base, controlKeys: ["docPath", "summary"] }, "/tmp/agent.md");
		const task = args[args.length - 1];
		expect(task).toContain("Task: do X");
		expect(task).toContain("Required Final Control Output");
		expect(task).toContain("docPath, summary");
		expect(task).toContain('<control>{"docPath":"FILL_ME","summary":"FILL_ME"}</control>');
	});
});

describe("buildSubprocessTaskPrompt", () => {
	it("leaves prompts without control keys byte-identical", () => {
		expect(buildSubprocessTaskPrompt("hello", [])).toBe("hello");
	});

	it("deduplicates invalid/duplicate control keys before rendering the contract", () => {
		const prompt = buildSubprocessTaskPrompt("do work", ["docPath", "3bad", "docPath", "summary"]);
		expect(prompt).toContain("docPath, summary");
		expect(prompt).not.toContain("3bad");
	});
});

describe("web-research agent classification", () => {
	it("needsWebResearch is true only for research-agent", () => {
		expect(needsWebResearch("research-agent")).toBe(true);
		expect(needsWebResearch("code-assessor")).toBe(false);
		expect(needsWebResearch("implementer")).toBe(false);
		expect(needsWebResearch("qa-agent")).toBe(false);
	});


	it("resolveExtensionEntry returns the manifest extension entry when installed, null otherwise", () => {
		const tmp = mkdtempSync(join(tmpdir(), "sd-ext-"));
		const pkgDir = join(tmp, "npm", "node_modules", "pi-web-access");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
		writeFileSync(join(pkgDir, "index.ts"), "// stub");
		expect(resolveExtensionEntry("pi-web-access", tmp)).toBe(join(pkgDir, "index.ts"));
		expect(resolveExtensionEntry("pi-mcp-adapter", tmp)).toBeNull();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("resolveExtensionEntries expands manifest directory entries into loadable files", () => {
		const tmp = mkdtempSync(join(tmpdir(), "sd-ext-dir-"));
		const pkgDir = join(tmp, "npm", "node_modules", "pi-browser-cdp-extension");
		const extDir = join(pkgDir, "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(join(extDir, "browser-execute.ts"), "// browser tool");
		writeFileSync(join(extDir, "README.md"), "ignored");
		expect(resolveExtensionEntries("pi-browser-cdp-extension", tmp)).toEqual([join(extDir, "browser-execute.ts")]);
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

// ─── Phase 1 (Feature 1): widened thinking + model precedence [RED] ───────
//
// These pin the contract for main-session model/thinking inheritance BEFORE the
// Phase 1 implementation lands. They typecheck (the additive types + the widened
// resolveThinking signature exist as a scaffold) but FAIL because the bodies do
// not yet consult the INHERITED tier / the SUPER_DEV_MODEL env / inheritedModelObject.

const saveEnv = (...keys: string[]) => {
	const snapshot: Record<string, string | undefined> = {};
	for (const k of keys) snapshot[k] = process.env[k];
	return {
		clear: () => { for (const k of keys) delete process.env[k]; },
		restore: () => {
			for (const k of keys) {
				if (snapshot[k] === undefined) delete process.env[k];
				else process.env[k] = snapshot[k] as string;
			}
		},
	};
};

describe("resolveThinking — widened precedence (INHERITED tier) [AC-03 / SCENARIO-005, SCENARIO-006]", () => {
	const env = saveEnv("SUPER_DEV_THINKING");
	beforeEach(env.clear);
	afterEach(env.restore);

	it("per-call override wins over SUPER_DEV_THINKING env, the INHERITED level, and the role default", () => {
		process.env.SUPER_DEV_THINKING = "low";
		// "design" role default is "high"; inherited "xhigh" must NOT win over per-call.
		expect(resolveThinking("design", "minimal", "xhigh")).toBe("minimal");
	});

	it("SUPER_DEV_THINKING env wins over the INHERITED level when no per-call override", () => {
		process.env.SUPER_DEV_THINKING = "low";
		// The INHERITED tier sits BELOW the env tier in the widened chain.
		expect(resolveThinking("design", undefined, "xhigh")).toBe("low");
	});

	it("INHERITED main-session level wins over the role default when no per-call/env override (SCENARIO-006)", () => {
		// "design" role default is "high"; the INHERITED tier sits ABOVE the default.
		expect(resolveThinking("design", undefined, "xhigh")).toBe("xhigh");
		// "slug" role default is "minimal"; an inherited "high" lifts the specialist.
		expect(resolveThinking("slug", undefined, "high")).toBe("high");
	});

	it("falls back to the role default when nothing (per-call/env/inherited) is supplied", () => {
		expect(resolveThinking("design")).toBe("high");
		expect(resolveThinking("implementer")).toBe("medium");
	});

	it("the widened signature stays backward-compatible with the legacy 2-arg call shape", () => {
		// Existing call sites (buildSpawnArgs, runAgentViaSession) still pass only
		// (agent, perCall) and must keep resolving identically to before.
		expect(resolveThinking("code-reviewer")).toBe("high");
		expect(resolveThinking("code-reviewer", "off")).toBe("off");
	});
});

describe("buildSpawnArgs — model resolution chain [AC-02 / SCENARIO-003, SCENARIO-004]", () => {
	const env = saveEnv("SUPER_DEV_MODEL", "SUPER_DEV_THINKING");
	beforeEach(env.clear);
	afterEach(env.restore);
	const base = { agent: "requirements-clarifier", prompt: "do X", cwd: "/tmp" };

	it("emits --model from an explicit opts.model (highest precedence tier)", () => {
		const args = buildSpawnArgs({ ...base, model: "openai/gpt-4o" }, "/tmp/agent.md");
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-4o");
	});

	it("SUPER_DEV_MODEL env wins over the inherited model object when no explicit model (NEW env tier)", () => {
		process.env.SUPER_DEV_MODEL = "anthropic/claude-opus-4-5";
		const args = buildSpawnArgs({ ...base, inheritedModelObject: inheritedModel("glm", "glm-5.2") }, "/tmp/agent.md");
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-opus-4-5");
	});

	it("the inherited model object is derived into a qualified provider/id --model when no explicit model and no SUPER_DEV_MODEL env", () => {
		const args = buildSpawnArgs({ ...base, inheritedModelObject: inheritedModel("openai", "gpt-4o") }, "/tmp/agent.md");
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-4o");
	});

	it("explicit opts.model wins over SUPER_DEV_MODEL env (precedence: explicit > env)", () => {
		process.env.SUPER_DEV_MODEL = "anthropic/claude-opus-4-5";
		const args = buildSpawnArgs({ ...base, model: "openai/gpt-4o" }, "/tmp/agent.md");
		expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-4o");
	});

	it("emits --model from SUPER_DEV_MODEL env alone when no explicit model and no inherited model object", () => {
		process.env.SUPER_DEV_MODEL = "openai/gpt-4o";
		const args = buildSpawnArgs(base, "/tmp/agent.md");
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-4o");
	});

	it("emits NO --model when no model resolves from any tier (SCENARIO-004 baseline)", () => {
		const args = buildSpawnArgs(base, "/tmp/agent.md");
		expect(args).not.toContain("--model");
	});
});

describe("buildSpawnArgs — ambient resources are disabled for every subprocess specialist", () => {
	it("non-browser agents carry --no-extensions and --no-context-files", () => {
		const args = buildSpawnArgs({ agent: "requirements-clarifier", prompt: "x", cwd: "/tmp" }, "/tmp/a.md");
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-context-files");
	});
	it("research-agent carries --no-extensions while explicit -e role extensions still load", () => {
		const exts = ["/agent/npm/node_modules/pi-web-access/index.ts"];
		const args = buildSpawnArgs({ agent: "research-agent", prompt: "x", cwd: "/tmp" }, "/tmp/a.md", exts);
		expect(args).toContain("--no-extensions");
		for (const e of exts) expect(args[args.indexOf(e) - 1]).toBe("-e");
	});
	it("browser agents also carry --no-extensions", () => {
		const args = buildSpawnArgs({ agent: "qa-agent", prompt: "x", cwd: "/tmp" }, "/tmp/a.md");
		expect(args).toContain("--no-extensions");
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
