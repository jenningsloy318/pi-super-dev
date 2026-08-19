/**
 * Tests for the spawn-output parsing in pi-spawn.ts. No subprocess, no LLM —
 * these feed captured NDJSON event streams directly to the parser to assert
 * the resilient text-capture behavior that recovers control JSON even when an
 * agent ends on a trailing tool-call turn or is killed mid-stream.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { extractFinalAssistant, buildSpawnArgs, buildSubprocessTaskPrompt, summarizeToolCall, renderEvent, isCodeWritingAgent, defaultAgentTimeoutMs, needsWebResearch, resolveExtensionEntry, resolveExtensionEntries, resolveThinking, type ThinkingLevel } from "../src/pi-spawn.ts";
import * as piSpawnModule from "../src/pi-spawn.ts";

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

	it("includes the required pi flags after the executable (skills stay loadable by default — v0.2.10 W4)", () => {
		const args = buildSpawnArgs(base, "/tmp/agent.md");
		expect(args).toContain("--mode");
		expect(args[args.indexOf("--mode") + 1]).toBe("json");
		expect(args).toContain("-p");
		expect(args).toContain("--no-session");
		expect(args).not.toContain("--no-skills"); // capability parity with the session backend
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

// ─── Phase 6 / T6.1 + T6.2 (AC-12, AC-23): runPi streaming + kill ladder ────
//
// `runPi` is the raw spawn/parse/terminate primitive underneath spawnAgent. The
// harness keeps `node:child_process.spawn` REAL by default (pass-through) so the
// existing pure-function tests are untouched; the fake-child tests flip the
// harness to scripted `PassThrough` children (real stream decoders, no process).

interface ScriptedChild extends EventEmitter {
	stdout: PassThrough;
	stderr: PassThrough;
	killCalls: string[];
	kill(signal?: string | number): boolean;
}

const spawnHarness = vi.hoisted(() => {
	const state: {
		mode: "real" | "fake";
		last: unknown;
		makeChild: () => ScriptedChild;
	} = {
		// default "real" keeps every existing test (and the real-child tests
		// below) on the genuine spawn; fake mode scripts PassThrough children.
		mode: "real",
		last: null,
		makeChild: () => {
			throw new Error("spawn harness not initialized");
		},
	};
	return state;
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const makeChild = (): ScriptedChild => {
		// The concrete stream type matters: runPi must call setEncoding on the
		// child's streams (AC-12), which a bare EventEmitter cannot support.
		const child = new EventEmitter() as ScriptedChild;
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.killCalls = [];
		child.kill = (signal?: string | number) => {
			child.killCalls.push(String(signal));
			return true;
		};
		return child;
	};
	spawnHarness.makeChild = makeChild;
	return {
		...actual,
		spawn: ((command: string, args: readonly string[], options: object) => {
			if (spawnHarness.mode === "fake") {
				const child = makeChild();
				spawnHarness.last = child;
				return child as unknown as import("node:child_process").ChildProcess;
			}
			return actual.spawn(command, [...args], options as never);
		}) as unknown as typeof actual.spawn,
	};
});

const messageEndLine = (text: string): string =>
	`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "sd-runpi-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("AC-12 (SCENARIO-026): runPi reassembles a UTF-8 sequence split across data chunks byte-exactly", () => {
	beforeEach(() => { spawnHarness.mode = "fake"; });
	afterEach(() => { spawnHarness.mode = "real"; });

	it("no U+FFFD: a message_end line whose emoji is split mid-codepoint across two data chunks parses intact (scripted child)", async () => {
		await withTempCwd(async (cwd) => {
			const bytes = Buffer.from(messageEndLine("ship it 🚀 now"), "utf8");
			const emoji = Buffer.from("🚀", "utf8");
			// Split AFTER the first byte of the 4-byte sequence (F0 9F | 98 80).
			const splitAt = bytes.indexOf(emoji) + 1;
			expect(splitAt).toBeGreaterThan(0);
			const promise = piSpawnModule.runPi(["fake"], cwd, undefined, "utf8-split", 10_000);
			const child = spawnHarness.last as ScriptedChild;
			child.stdout.write(bytes.subarray(0, splitAt));
			child.stdout.write(bytes.subarray(splitAt));
			child.stdout.end();
			child.emit("close", 0);
			const result = await promise;
			expect(result.text).toBe("ship it 🚀 now");
			expect(result.text).not.toContain("\uFFFD");
		});
	});

	it("same reassembly against a REAL node child writing the split bytes through a real pipe", async () => {
		spawnHarness.mode = "real";
		await withTempCwd(async (cwd) => {
			const script = [
				`const line = Buffer.from(${JSON.stringify(messageEndLine("ship it 🚀 now"))}, "utf8");`,
				`const emoji = Buffer.from(${JSON.stringify("🚀")}, "utf8");`,
				"const splitAt = line.indexOf(emoji) + 1;",
				"process.stdout.write(line.subarray(0, splitAt));",
				"setTimeout(() => process.stdout.write(line.subarray(splitAt)), 150);",
			].join("\n");
			const result = await piSpawnModule.runPi([process.execPath, "-e", script], cwd, undefined, "utf8-real", 10_000);
			expect(result.text).toBe("ship it 🚀 now");
			expect(result.text).not.toContain("\uFFFD");
		});
	}, 15_000);
});

describe("AC-12 (SCENARIO-027): a newline-less final NDJSON line is still parsed", () => {
	beforeEach(() => { spawnHarness.mode = "fake"; });
	afterEach(() => { spawnHarness.mode = "real"; });

	it("a final message_end with no trailing newline is processed, not dropped", async () => {
		await withTempCwd(async (cwd) => {
			const line = messageEndLine("final answer without newline").trimEnd(); // no \n
			const promise = piSpawnModule.runPi(["fake"], cwd, undefined, "final-line", 10_000);
			const child = spawnHarness.last as ScriptedChild;
			child.stdout.write(Buffer.from(line, "utf8"));
			child.stdout.end();
			child.emit("close", 0);
			const result = await promise;
			expect(result.text).toBe("final answer without newline");
		});
	});

	it("the residual parse runs BEFORE the produced-no-output rejection (real node child)", async () => {
		spawnHarness.mode = "real";
		await withTempCwd(async (cwd) => {
			const script = `process.stdout.write(${JSON.stringify(messageEndLine("tail no newline").trimEnd())});`;
			const result = await piSpawnModule.runPi([process.execPath, "-e", script], cwd, undefined, "final-line-real", 10_000);
			expect(result.text).toBe("tail no newline");
		});
	}, 15_000);
});

describe("AC-23 (SCENARIO-049): SIGTERM → SIGKILL ladder + bounded settle", () => {
	beforeEach(() => { spawnHarness.mode = "fake"; });
	afterEach(() => { vi.useRealTimers(); spawnHarness.mode = "real"; });

	it("exports the watchdog constants (10s SIGTERM grace, 5s settle bound)", () => {
		expect(piSpawnModule.SIGTERM_GRACE_MS).toBe(10_000);
		expect(piSpawnModule.SETTLE_GRACE_MS).toBe(5_000);
	});

	it("timeout variant: SIGTERM → SIGTERM_GRACE_MS → SIGKILL → SETTLE_GRACE_MS → backstop reject 'killed after SIGTERM+SIGKILL'", async () => {
		vi.useFakeTimers();
		await withTempCwd(async (cwd) => {
			let caught: Error | undefined;
			const guarded = piSpawnModule.runPi(["fake"], cwd, undefined, "ladder-timeout", 1_000)
				.catch((err: Error) => { caught = err; return undefined as never; });
			const child = spawnHarness.last as ScriptedChild;
			await vi.advanceTimersByTimeAsync(1_000); // run timeout fires → SIGTERM
			expect(child.killCalls).toEqual(["SIGTERM"]);
			await vi.advanceTimersByTimeAsync(10_000); // grace elapses → escalate
			expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
			await vi.advanceTimersByTimeAsync(5_000); // settle bound → backstop
			await guarded;
			expect(caught).toBeInstanceOf(Error);
			expect(caught?.message).toContain("killed after SIGTERM+SIGKILL");
			expect(caught?.message).toContain("no exit within 5000ms");
		});
	});

	it("abort variant: the same ladder runs on the AbortSignal path and cleanup removes the abort listener", async () => {
		vi.useFakeTimers();
		await withTempCwd(async (cwd) => {
			const controller = new AbortController();
			const baseline = getEventListeners(controller.signal, "abort").length;
			let caught: Error | undefined;
			const guarded = piSpawnModule.runPi(["fake"], cwd, controller.signal, "ladder-abort", 60_000)
				.catch((err: Error) => { caught = err; return undefined as never; });
			const child = spawnHarness.last as ScriptedChild;
			controller.abort();
			expect(child.killCalls).toEqual(["SIGTERM"]);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
			await vi.advanceTimersByTimeAsync(5_000);
			await guarded;
			expect(caught?.message).toContain("killed after SIGTERM+SIGKILL");
			// cleanup ran: the abort listener was removed (no leak), the settle
			// timer is cleared, and the promise settled (no hang).
			expect(getEventListeners(controller.signal, "abort").length).toBe(baseline);
		});
	});

	it("a real SIGTERM-ignoring child is actually killed by the ladder and the promise settles within the bound (node -e fixture)", async () => {
		spawnHarness.mode = "real";
		await withTempCwd(async (cwd) => {
			// A real child that ignores SIGTERM (registered handler) and can only be
			// stopped by the ladder's SIGKILL. Its 13s self-exit is a leak guard for
			// the RED run (it leaves a marker so we can tell self-exit from SIGKILL);
			// the GREEN ladder SIGKILLs it at ~timeout + SIGTERM_GRACE_MS = 10.4s —
			// strictly before the self-exit — so the marker never appears.
			const marker = join(cwd, "selfexit.txt");
			const script = [
				`process.stdout.write(${JSON.stringify(messageEndLine("partial output before kill"))});`,
				"process.on('SIGTERM', () => {});",
				`setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "self"); process.exit(0); }, 13000);`,
				"setInterval(() => {}, 1000);",
			].join("\n");
			const started = Date.now();
			const result = await piSpawnModule.runPi([process.execPath, "-e", script], cwd, undefined, "ladder-real", 400);
			const elapsed = Date.now() - started;
			expect(result.text).toBe("partial output before kill");
			expect(result.error).toContain("timed out");
			// The SIGTERM grace actually elapsed before the SIGKILL escalation…
			expect(elapsed).toBeGreaterThanOrEqual(10_000);
			// …and the child was KILLED by the ladder, not by its own 13s timer.
			expect(existsSync(marker)).toBe(false);
			// …and the promise settled well within SIGTERM + SIGKILL + settle bounds.
			expect(elapsed).toBeLessThan(10_000 + 5_000 + 5_000);
		});
	}, 30_000);
});

// ─── T7.1 / SD-04 (NFR-6 pinning): abort-listener registration guard ───────
//
// A listener attached to an AbortSignal AFTER it aborted NEVER fires (WHATWG /
// Node EventTarget semantics). Without a synchronous `signal?.aborted` check
// around the registration, a signal that aborts between the caller's last
// check and runPi's spawn leaves the child running to its own hard timeout
// (up to 1200s for code-writing agents) before the run unwinds.
describe("SD-04: runPi guards abort-listener registration with synchronous aborted checks", () => {
	beforeEach(() => { spawnHarness.mode = "fake"; });
	afterEach(() => { spawnHarness.mode = "real"; });

	it("a signal aborted BEFORE runPi never spawns a child — resolves error=aborted immediately", async () => {
		await withTempCwd(async (cwd) => {
			spawnHarness.last = null;
			const controller = new AbortController();
			controller.abort(); // pre-aborted: the listener below would never fire
			const p = piSpawnModule.runPi(["fake"], cwd, controller.signal, "pre-aborted", 60_000);
			const raced = await Promise.race([
				p.then((r) => r, () => "rejected" as const),
				new Promise((resolve) => setTimeout(() => resolve("TIMED_OUT" as const), 2_000)),
			]);
			// cleanup: deterministically settle the dangling RED-path child so no
			// timers/streams survive the failing assertion.
			const child = spawnHarness.last as ScriptedChild | null;
			if (child) { child.stdout.end(); child.emit("close", 0); }
			await p.catch(() => undefined);
			expect(raced).toEqual({ text: "", control: null, error: "aborted" });
			// the guard fires BEFORE spawn: no child is spawned into a dead run
			expect(spawnHarness.last).toBeNull();
		});
	});

	it("a signal aborted BEFORE runPi leaves no abort listener behind (no leak, no kill ladder armed)", async () => {
		await withTempCwd(async (cwd) => {
			spawnHarness.last = null;
			const controller = new AbortController();
			const baseline = getEventListeners(controller.signal, "abort").length;
			controller.abort();
			const p = piSpawnModule.runPi(["fake"], cwd, controller.signal, "pre-aborted-leak", 60_000);
			const raced = await Promise.race([
				p.then((r) => r, () => "rejected" as const),
				new Promise((resolve) => setTimeout(() => resolve("TIMED_OUT" as const), 2_000)),
			]);
			const child = spawnHarness.last as ScriptedChild | null;
			if (child) { child.stdout.end(); child.emit("close", 0); }
			await p.catch(() => undefined);
			expect(raced).toEqual({ text: "", control: null, error: "aborted" });
			expect(getEventListeners(controller.signal, "abort").length).toBe(baseline);
		});
	});
});
