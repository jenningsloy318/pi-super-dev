import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const msg = (text: string) => `${JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }] },
})}\n`;

const harness = vi.hoisted(() => {
	const state = {
		outputs: [] as string[],
		/** Optional hook invoked with the FIRST spawn's env before its output
		 * plays — used to simulate the child tool writing a capture file. */
		firstSpawnHook: null as null | ((env: Record<string, string | undefined>) => void),
		calls: [] as Array<{ command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> }>,
	};
	return {
		state,
		reset(outputs: string[]) {
			state.outputs = [...outputs];
			state.calls = [];
			state.firstSpawnHook = null;
		},
	};
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn((command: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
		harness.state.calls.push({ command, args, cwd: opts.cwd, env: opts.env as Record<string, string | undefined> | undefined });
		if (harness.state.calls.length === 1 && harness.state.firstSpawnHook && opts.env) {
			harness.state.firstSpawnHook(opts.env as Record<string, string | undefined>);
		}
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

// The whole file pins the JSON one-shot fallback path (the corrective
// RESPAWN semantics). The v0.2.10 RPC default is covered separately in
// tests/pi-spawn-v0210.test.ts — the fake child here has no stdin and never
// acks rpc turns, so force the fallback for every test in this file.
beforeEach(() => {
	vi.stubEnv("SUPER_DEV_NO_RPC_SPAWN", "1");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

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

describe("spawnAgent json-path stale-capture regression (v0.2.10 review F-1)", () => {
	beforeEach(() => {
		vi.stubEnv("SUPER_DEV_NO_RPC_SPAWN", "1");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("a PARTIAL first-run capture does not mask the corrective retry's text-channel recovery", async () => {
		harness.reset([
			msg("I read the sources and wrote the doc body, but no control block."),
			msg('Done.\n<control>{"docPath":"docs/01-requirements.md","summary":"recovered"}</control>'),
		]);
		// The FIRST fake child run simulates the tool having captured a PARTIAL
		// object (docPath only): the child tool cannot reject it (keys are
		// declared permissively, nothing required), so the capture file exists
		// when run 1 ends with text lacking any control block.
		harness.state.firstSpawnHook = (env) => {
			const capture = env.SUPER_DEV_SO_CAPTURE;
			if (capture) writeFileSync(capture, JSON.stringify({ docPath: "docs/01-requirements.md" }), { mode: 0o600 });
		};

		const result = await spawnAgent({
			agent: "requirements-clarifier",
			id: "pipeline.requirements",
			prompt: "write requirements",
			cwd: "/tmp/project",
			controlKeys: ["docPath", "summary"],
			timeoutMs: 5000,
		});

		// Pre-fix (stale capture): applyCapture overwrote the retry's good text
		// control with the partial {docPath} -> missing summary -> deterministic
		// failure of exactly the recovery the corrective retry exists for.
		expect(result.control).toEqual({ docPath: "docs/01-requirements.md", summary: "recovered" });
		expect(result.error).toBeUndefined();
		// two spawns = the corrective respawn actually ran
		expect(harness.state.calls).toHaveLength(2);
	});
});
