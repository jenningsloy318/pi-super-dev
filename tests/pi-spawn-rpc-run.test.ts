/**
 * v0.2.10 W1 review remediation (code-reviewer F-4/F-1/F-6): unit coverage for
 * `runPiRpc` — the ~140-line orchestration layer around RpcDriver that had
 * zero unit tests (only SUPER_DEV_SPAWN_E2E-gated coverage).
 *
 * The child `pi` process is faked with PassThrough streams + a scripted NDJSON
 * responder, so every behavior is deterministic and hermetic:
 *   1. turn-1 no-control → exactly ONE corrective prompt event on stdin →
 *      turn-2 <control> text recovery — and a PARTIAL turn-1 capture file must
 *      NOT mask it (F-1: the capture is unlinked before the corrective turn).
 *   2. remaining budget ≤ 15s after turn 1 → corrective skipped.
 *   3. turn-1 timeout (error result) → corrective skipped (correctiveFor is
 *      never consulted for errored first turns).
 *   4. abort mid-turn → rpc abort event on stdin, SIGTERM ladder, "aborted".
 *   5. old-pi quick exit: close before any event → honest error + the F-6
 *      SUPER_DEV_NO_RPC_SPAWN=1 hint (host pi may lack --mode rpc).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FakePromptEvent = { id: string; type: string; message: string };

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kills: string[] = [];
	readonly prompts: FakePromptEvent[] = [];
	abortEvents = 0;
	closed = false;
	/** Scripted responder per prompt event index (0-based). */
	script: (child: FakeChild, ev: FakePromptEvent, index: number) => void = () => {};

	constructor() {
		super();
		let buf = "";
		this.stdin.setEncoding("utf8");
		this.stdin.on("data", (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const raw = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const line = raw.trim();
				if (!line) continue;
				let ev: { type?: string; [k: string]: unknown };
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				if (ev.type === "clear_queue" || ev.type === "abort") {
					// v0.3.60 R5 fidelity: real RPC-mode pi ACKs control commands and
					// KEEPS RUNNING — abort checkpoints the running turn; termination
					// stays the caller's move (terminateChild SIGTERM ladder). The old
					// kill-on-abort fake pre-dates the mid-checkpoint abort sender.
					if (typeof ev.id === "string") {
						this.stdout.write(`${JSON.stringify({ id: ev.id, type: "response", command: ev.type, success: true })}\n`);
					}
					if (ev.type === "abort") this.abortEvents++;
				} else if (ev.type === "prompt" || ev.type === "follow_up") {
					const pev = ev as unknown as FakePromptEvent;
					this.prompts.push(pev);
					this.script(this, pev, this.prompts.length - 1);
				}
			}
		});
	}

	kill(sig = "SIGTERM"): boolean {
		this.kills.push(sig);
		if (!this.closed) {
			this.closed = true;
			// mirror a real child: close after the signal
			queueMicrotask(() => this.emit("close", sig === "SIGKILL" ? null : 1));
		}
		return true;
	}
}

/** Script one turn: response ack → assistant message_end(text) → agent_settled. */
function turnScript(text: string, opts: { delayMs?: number; beforeSettle?: (child: FakeChild) => void } = {}) {
	return (child: FakeChild, ev: FakePromptEvent, _index?: number) => {
		const respond = () => {
			child.stdout.write(`${JSON.stringify({ type: "response", id: ev.id, success: true })}\n`);
			child.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fake-model", content: [{ type: "text", text }] } })}\n`);
			opts.beforeSettle?.(child);
			child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
		};
		if (opts.delayMs) setTimeout(respond, opts.delayMs);
		else respond();
	};
}

const cpState = vi.hoisted(() => ({
	stubber: null as null | (() => FakeChild | undefined),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (cmd: string, args: string[], opts: unknown) => {
			const fake = cpState.stubber?.();
			if (fake) return fake as never;
			return actual.spawn(cmd, args, opts as never);
		},
	};
});

import { runPiRpc } from "../src/pi-spawn.ts";
import type { SpawnResult } from "../src/types.ts";

function mkOpts(child: FakeChild, over: Partial<Parameters<typeof runPiRpc>[0]> = {}) {
	const events: string[] = [];
	return {
		options: {
			args: ["pi", "--mode", "rpc"],
			cwd: process.cwd(),
			label: "test-agent",
			timeoutMs: 30_000,
			task: "Task: do the thing",
			correctiveFor: (first: SpawnResult) => (first.control ? null : "CORRECTIVE: call structured_output now"),
			...over,
		} as Parameters<typeof runPiRpc>[0],
		events,
	};
}

describe("runPiRpc [hermetic fake child]", () => {
	let tempDir: string;
	let stub: FakeChild | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "sd-rpc-run-"));
		stub = undefined;
		cpState.stubber = () => {
			stub = stub ?? new FakeChild();
			return stub;
		};
	});

	afterEach(() => {
		cpState.stubber = null;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("F-1: turn-1 partial capture does NOT mask the corrective turn's text-channel recovery", async () => {
		const capturePath = join(tempDir, "control-output.json");
		const child = new FakeChild();
		cpState.stubber = () => child;
		// turn 1: the tool wrote a PARTIAL capture (missing `beta`), text has no control
		child.script = (c, ev, i) => {
			if (i === 0) turnScript("I have read everything needed.", { beforeSettle: () => writeFileSync(capturePath, JSON.stringify({ alpha: 1 }), { mode: 0o600 }) })(c, ev, i);
			else turnScript(`done\n<control>{"alpha": 1, "beta": 2}</control>`)(c, ev, i);
		};
		const result = await runPiRpc({
			args: ["pi"], cwd: process.cwd(), label: "t", timeoutMs: 30_000,
			task: "Task: x", capturePath,
			// mirrors spawnAgent's real correctiveFor: completeness against required
			// keys (the partial capture {alpha:1} is missing `beta` → corrective).
			correctiveFor: (first) => (first.control && first.control.beta !== undefined ? null : "CORRECTIVE: beta is missing"),
		});
		// exactly one corrective, in the SAME process, as a prompt event
		expect(child.prompts).toHaveLength(2);
		expect(child.prompts[0].type).toBe("prompt");
		expect(child.prompts[1].type).toBe("prompt");
		expect(child.prompts[1].message).toContain("CORRECTIVE");
		// the text-channel object won — NOT the stale partial {alpha:1}
		expect(result.control).toEqual({ alpha: 1, beta: 2 });
		expect(result.error).toBeUndefined();
	});

	it("remaining budget ≤ 15s after turn 1 skips the corrective turn", async () => {
		const child = new FakeChild();
		cpState.stubber = () => child;
		// 400ms delay with a 15_400ms budget → remaining < 15s after turn 1
		child.script = (c, ev, i) => turnScript(`<control>{"ok": true}</control>`, { delayMs: 400 })(c, ev, i);
		const result = await runPiRpc({
			args: ["pi"], cwd: process.cwd(), label: "t", timeoutMs: 15_400,
			task: "Task: x",
			correctiveFor: () => "CORRECTIVE",
		});
		expect(child.prompts).toHaveLength(1);
		expect(result.control).toEqual({ ok: true });
	});

	it("turn-1 timeout (error result) never consults correctiveFor", async () => {
		const child = new FakeChild();
		cpState.stubber = () => child;
		child.script = () => { /* never responds */ };
		let correctiveConsulted = false;
		const result = await runPiRpc({
			args: ["pi"], cwd: process.cwd(), label: "t", timeoutMs: 150,
			task: "Task: x",
			correctiveFor: () => { correctiveConsulted = true; return "CORRECTIVE"; },
		});
		expect(result.error).toContain("timed out");
		expect(correctiveConsulted).toBe(false);
		expect(child.prompts).toHaveLength(1);
	});

	it("abort mid-turn: rpc abort on stdin, SIGTERM ladder, error=aborted", async () => {
		const child = new FakeChild();
		cpState.stubber = () => child;
		child.script = () => { /* in-flight turn: no response */ };
		const controller = new AbortController();
		const pending = runPiRpc({
			args: ["pi"], cwd: process.cwd(), label: "t", timeoutMs: 30_000,
			signal: controller.signal,
			task: "Task: x",
			correctiveFor: () => "CORRECTIVE",
		});
		// wait until the prompt reached the child, then abort
		await vi.waitFor(() => expect(child.prompts).toHaveLength(1));
		controller.abort();
		const result = await pending;
		expect(result.error).toBe("aborted");
		expect(child.abortEvents).toBe(1);
		expect(child.kills).toContain("SIGTERM");
	});

	it("F-6: old-pi quick exit (close before any event) → honest error + NO_RPC hint", async () => {
		const child = new FakeChild();
		cpState.stubber = () => child;
		const events: string[] = [];
		const pending = runPiRpc({
			args: ["pi"], cwd: process.cwd(), label: "t", timeoutMs: 30_000,
			task: "Task: x",
			onProgress: { event: (line: string) => events.push(line), text: () => {} } as never,
			correctiveFor: () => "CORRECTIVE",
		});
		// the child exits instantly (unsupported --mode rpc), zero protocol events
		await vi.waitFor(() => expect(child.prompts).toHaveLength(1));
		child.stderr.write("unknown mode: rpc\n");
		child.emit("close", 1);
		const result = await pending;
		expect(result.error).toBe("process exited before turn completion (exit 1)");
		const hint = events.find((e) => e.includes("SUPER_DEV_NO_RPC_SPAWN=1"));
		expect(hint).toBeDefined();
		expect(hint).toContain("pi@0.82.1");
	});

	it("v0.3.1 F5: exit with NO close event (descendant holds the pipe) still settles after the grace — cumora lesson", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChild();
			// never respond, and emit exit WITHOUT the close the ladder normally queues
			child.kill = () => { child.kills.push("SIGTERM"); return true; };
			cpState.stubber = () => child;
			const events: string[] = [];
			const pending = runPiRpc({
				args: ["pi"], cwd: process.cwd(), label: "t", timeoutMs: 60_000,
				task: "Task: x",
				onProgress: { event: (line: string) => events.push(line), text: () => {} } as never,
				correctiveFor: () => "CORRECTIVE",
			});
			await vi.advanceTimersByTimeAsync(50); // let the prompt flush
			expect(child.prompts).toHaveLength(1);
			// sd31-SD31-4/F-06: a final newline-less assistant message_end must ride the
			// exit-settle's residual-buffer flush, not be dropped with the missing close.
			child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "m", content: [{ type: "text", text: "residual final text" }] } }));
			child.emit("exit", 1); // child died; a descendant holds stdout so `close` never fires
			await vi.advanceTimersByTimeAsync(5_000); // SETTLE_GRACE_MS
			const result = await pending;
			expect(result.error).toContain("no close event");
			expect(result.text).toContain("residual final text");
			expect(events.some((e) => e.includes("no close event"))).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("v0.3.1 F5 control: close within the grace cancels the exit-settle (close path wins, no double settle)", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChild();
			cpState.stubber = () => child;
			const events: string[] = [];
			const pending = runPiRpc({
				args: ["pi"], cwd: process.cwd(), label: "t", timeoutMs: 60_000,
				task: "Task: x",
				onProgress: { event: (line: string) => events.push(line), text: () => {} } as never,
				correctiveFor: () => "CORRECTIVE",
			});
			await vi.advanceTimersByTimeAsync(50);
			child.emit("exit", 1);
			await vi.advanceTimersByTimeAsync(2_000); // within grace
			child.emit("close", 1); // the pipe released — the normal path settles first
			const result = await pending;
			expect(result.error).toBe("process exited before turn completion (exit 1)");
			expect(result.error).not.toContain("no close event");
			// sd31-SD31-8: the stale exit-settle timer must be cleared — advancing past
			// the grace must NOT produce a second settle event.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(events.filter((e) => e.includes("settling"))).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── v0.3.28 full-field progress parity (user request: 全量一致) ───────────────
// The delegation backend now logs tool+args, narration (⇢), and a terminal
// usage summary. The subprocess backend already had tool lines + narration but
// logged narration UNPREFIXED and no terminal usage — while the child's
// message_end carries full usage {input, output, cacheRead, cacheWrite, cost}.
// These tests pin the parity: same ⇢ narration format, same terminal segments.
describe("v0.3.28: terminal usage summary + narration parity (subprocess backend)", () => {
	it("emits `subprocess <label>: completed` with model/turns/tools/tokens/cache/cost/duration and ⇢ narration lines", async () => {
		const child = new FakeChild();
		cpState.stubber = () => child;
		const events: string[] = [];
		child.script = (c, ev, _i) => {
			c.stdout.write(`${JSON.stringify({ type: "response", id: ev.id, success: true })}\n`);
			c.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
			c.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/PopupActivity.kt" } })}\n`);
			c.stdout.write(`${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Inspecting the export path." }] } })}\n`);
			c.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fake-model", content: [{ type: "text", text: "<control>{\"ok\": true}</control>" }], usage: { input: 100, output: 40, cacheRead: 12, cacheWrite: 0, cost: { total: 0.0123 } } } })}\n`);
			c.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
		};
		const result = await runPiRpc({
			args: ["pi"], cwd: process.cwd(), label: "t", timeoutMs: 30_000,
			task: "Task: x",
			onProgress: { event: (line: string) => events.push(line), text: () => {} } as never,
			correctiveFor: () => null,
		});
		expect(result.control).toEqual({ ok: true });
		const done = events.find((e) => e.startsWith("subprocess t: completed"));
		expect(done).toBeTruthy();
		expect(done).toContain("model=fake-model");
		expect(done).toContain("turns=1");
		expect(done).toContain("tools=1");
		expect(done).toContain("tokens=100/40");
		expect(done).toContain("cache=12/0");
		expect(done).toContain("$0.0123");
		expect(done).toContain("duration=");
		// Narration now lands in run.log with the same ⇢ prefix as the delegation
		// backend (was: bare unprefixed lines).
		expect(events).toContain("t: ⇢ Inspecting the export path.");
	});
});
