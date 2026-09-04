/**
 * (v0.3.64: the R5 subprocess-timeout-checkpoint source contract was deleted
 *  with the subprocess backend — pi-spawn.ts is gone.)
 * v0.3.60 pi-canon alignment tests (researchPi R1/R2/R3/R7/R8/R9 + the
 * r59-P2-doc reword). Each test pins one canon adoption at its class level:
 *
 *   R1  typed `pi.on("input")` subscription (was raw `pi.events.on` bus)
 *   R2  StringEnum for the `backend` param (Google-model schema compatibility)
 *   R3  idempotent `session_shutdown` + cross-instance run guard (globalThis)
 *   R7  `parent:` mid-run escape hatch (transform, prefix stripped)
 *   R8  canonical tool-output truncation bounds + notice (content path)
 *   R9  in-flight reflection tracked + NAMED when a teardown drops it (P10)
 *
 * The R5 rpc-driver halves live in rpc-driver.test.ts (sendControl) and the
 * source-contract test below (pi-spawn wiring).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as ext from "../src/extension.ts";

const activate = (ext as any).default as (pi: any) => void;
const setActiveRun = (run: unknown): void => (ext as any).setRunGuard === undefined && (ext as any).setActiveRun(run);
const setInFlight = (v: boolean): void => (ext as any).setInFlight(v);
const setRunGuard = (g: unknown): void => (ext as any).setRunGuard(g);
const runGuardRefusal = (): string | null => (ext as any).runGuardRefusal();
const createActiveRun = (ctx?: unknown): any => (ext as any).createActiveRun(ctx);
const canonTruncate = (text: string, logPath?: string): string => (ext as any).canonTruncate(text, logPath);

/** Full mock pi: typed `on` channel (R1) + every API activate() touches. */
function makeMockPi() {
	const handlers: Record<string, Array<(e: any) => any>> = {};
	const events = {
		on: vi.fn((type: string, h: (e: any) => any) => {
			(handlers[type] ??= []).push(h);
		}),
		emit(type: string, e: any) {
			let last: unknown;
			for (const h of handlers[type] ?? []) last = h(e);
			return last;
		},
	};
	const entries: Array<{ type: string; data: any }> = [];
	const on = vi.fn((type: string, h: (e: any) => any) => {
		(handlers[type] ??= []).push(h);
	});
	const pi = {
		events,
		on,
		appendEntry: vi.fn((type: string, data: any) => { entries.push({ type, data }); }),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerEntryRenderer: vi.fn(),
		registerShortcut: vi.fn(),
		setSessionName: vi.fn(),
		getSessionName: vi.fn(() => ""),
		sendUserMessage: vi.fn(),
		handlers,
		entries,
		fire(type: string, e: any) {
			let last: unknown;
			for (const h of handlers[type] ?? []) last = h(e);
			return last;
		},
	};
	return pi;
}

const registeredTool = (pi: ReturnType<typeof makeMockPi>): any => {
	const calls = (pi.registerTool as any).mock.calls as any[][];
	return calls.length ? calls[calls.length - 1][0] : undefined;
};
const ev = (text: string, source = "interactive") => ({ type: "input", text, source });

beforeEach(() => {
	delete process.env.SUPER_DEV_ALLOW_OVERLAP;
	setRunGuard(undefined);
});
afterEach(async () => {
	setInFlight(false);
	(ext as any).setActiveRun(null);
	setRunGuard(undefined);
	// Clear R9 reflection tracking (synchronous clear; the previous test's
	// already-settled promise must not leak into the next quiet-shutdown case).
	(ext as any).noteInFlightReflection(undefined, undefined);
	await Promise.resolve(); // drain the microtask queue (settle hooks)
	vi.restoreAllMocks();
});

describe("R1: typed pi.on(\"input\") subscription", () => {
	it("registers the input handler via the typed pi.on channel, NOT the raw events bus", () => {
		const pi = makeMockPi();
		activate(pi);
		const typedCalls = (pi.on as any).mock.calls.filter((c: any[]) => c[0] === "input");
		expect(typedCalls).toHaveLength(1);
		expect(typeof typedCalls[0][1]).toBe("function");
		// The raw bus channel must stay silent — the migration is 1:1, not additive.
		const busCalls = (pi.events.on as any).mock.calls.filter((c: any[]) => c[0] === "input");
		expect(busCalls).toHaveLength(0);
	});

	it("also registers an idempotent session_shutdown handler (R3)", () => {
		const pi = makeMockPi();
		activate(pi);
		const calls = (pi.on as any).mock.calls.filter((c: any[]) => c[0] === "session_shutdown");
		expect(calls).toHaveLength(1);
	});
});

describe("R2: backend param is a plain deprecated string (v0.3.64: no enum — value ignored)", () => {
	it("backend serializes as {type:string} with no enum/union and stays optional", () => {
		const pi = makeMockPi();
		activate(pi);
		const tool = registeredTool(pi);
		expect(tool).toBeDefined();
		const backend = tool.parameters.properties.backend;
		expect(backend.type).toBe("string");
		expect(backend.enum).toBeUndefined();
		expect(backend.anyOf).toBeUndefined();
		expect(backend.oneOf).toBeUndefined();
		// Still optional — absent from required.
		expect(tool.parameters.required ?? []).not.toContain("backend");
	});
});

describe("R7: `parent:` mid-run escape hatch", () => {
	const capture = (pi: ReturnType<typeof makeMockPi>, text: string) => pi.fire("input", ev(text));

	it("transforms `parent: <text>` to the parent agent with the prefix stripped", () => {
		const pi = makeMockPi();
		activate(pi);
		(ext as any).setActiveRun(createActiveRun());
		const result = capture(pi, "parent: check the CI logs") as { action: string; text?: string };
		expect(result).toEqual({ action: "transform", text: "check the CI logs" });
	});

	it("strips surrounding whitespace around the payload", () => {
		const pi = makeMockPi();
		activate(pi);
		(ext as any).setActiveRun(createActiveRun());
		const result = capture(pi, "  parent:   status?  ") as { action: string; text?: string };
		expect(result).toEqual({ action: "transform", text: "status?" });
	});

	it("bare `parent:` with no payload continues (nothing to deliver)", () => {
		const pi = makeMockPi();
		activate(pi);
		(ext as any).setActiveRun(createActiveRun());
		expect(capture(pi, "parent:")).toEqual({ action: "continue" });
		expect(capture(pi, "parent:   ")).toEqual({ action: "continue" });
	});

	it("ordinary non-slash input is still captured (default semantics unchanged)", () => {
		const pi = makeMockPi();
		activate(pi);
		const run = createActiveRun();
		(ext as any).setActiveRun(run);
		expect(capture(pi, "pivot to auth")).toEqual({ action: "handled" });
		expect(run.drain()).toEqual(["pivot to auth"]);
	});
});

describe("R3: cross-instance run guard (globalThis) + honest refusal", () => {
	it("runGuardRefusal is null when no guard is held", () => {
		expect(runGuardRefusal()).toBeNull();
	});

	it("refuses with the run dir and the escape hatch when the guard is held", () => {
		setRunGuard({ startedAt: "2026-09-02T12:00:00", runDir: "/tmp/.super-dev/runs/2026-09-02T00-00-00-000Z" });
		const refusal = runGuardRefusal();
		expect(refusal).toContain("still active");
		expect(refusal).toContain("/tmp/.super-dev/runs/2026-09-02T00-00-00-000Z");
		expect(refusal).toContain("SUPER_DEV_ALLOW_OVERLAP=1");
	});

	it("SUPER_DEV_ALLOW_OVERLAP=1 is the mechanical escape hatch", () => {
		setRunGuard({ startedAt: "2026-09-02T12:00:00", runDir: "/tmp/x" });
		process.env.SUPER_DEV_ALLOW_OVERLAP = "1";
		expect(runGuardRefusal()).toBeNull();
	});

	it("clearing the guard re-opens the gate", () => {
		setRunGuard({ startedAt: "t", runDir: "/tmp/x" });
		setRunGuard(undefined);
		expect(runGuardRefusal()).toBeNull();
	});
});

describe("R3+R9: idempotent session_shutdown — honest lines, named drops", () => {
	it("names the in-flight run dir and the dropped reflection; second fire is a no-op", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const pi = makeMockPi();
		activate(pi);
		(ext as any).setActiveRun(createActiveRun());
		setInFlight(true);
		setRunGuard({ startedAt: "2026-09-02T12:00:00", runDir: "/tmp/.super-dev/runs/A" });
		(ext as any).noteInFlightReflection("/tmp/.super-dev/runs/A", Promise.resolve());

		pi.fire("session_shutdown", { type: "session_shutdown", reason: "reload" });

		const lines = pi.entries.filter((e: any) => e.type === "super-dev-shutdown").map((e: any) => e.data.line as string);
		expect(lines.some((l: string) => l.includes("STILL IN FLIGHT") && l.includes("/tmp/.super-dev/runs/A"))).toBe(true);
		expect(lines.some((l: string) => l.includes("reflection") && l.includes("/tmp/.super-dev/runs/A") && l.includes("DROPPED"))).toBe(true);
		expect(consoleError).toHaveBeenCalled();

		const countAfterFirst = pi.entries.filter((e: any) => e.type === "super-dev-shutdown").length;
		pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		const countAfterSecond = pi.entries.filter((e: any) => e.type === "super-dev-shutdown").length;
		expect(countAfterSecond).toBe(countAfterFirst); // idempotent
	});

	it("quiet shutdown (no run, no reflection) stays silent", () => {
		const pi = makeMockPi();
		activate(pi);
		pi.fire("session_shutdown", { type: "session_shutdown", reason: "new" });
		expect(pi.entries.filter((e: any) => e.type === "super-dev-shutdown")).toHaveLength(0);
	});
});

describe("R8: canonical tool-output truncation (content path)", () => {
	it("byte-identical below both canon bounds", () => {
		const text = "line1\nline2\nline3";
		expect(canonTruncate(text, "/tmp/log")).toBe(text);
	});

	it("cuts at 2000 lines and appends the canonical notice with counts + logPath", () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line-${i}`);
		const out = canonTruncate(lines.join("\n"), "/tmp/runs/x/run.log");
		const outLines = out.split("\n");
		expect(outLines).toHaveLength(2001); // 2000 kept + notice
		expect(outLines[0]).toBe("line-0");
		expect(outLines[1999]).toBe("line-1999");
		expect(outLines[2000]).toBe("[Output truncated: showing 2000 of 2500 lines — full output saved to: /tmp/runs/x/run.log]");
	});

	it("cuts at 50000 chars when the text is one huge line", () => {
		const text = "x".repeat(60_000);
		const out = canonTruncate(text);
		expect(out.startsWith("x".repeat(50_000))).toBe(true);
		expect(out).toContain("[Output truncated:");
		expect(out.endsWith("full output saved to: the run log]")).toBe(true);
	});
});


describe("v0.3.61 review fixes (r60 lanes)", () => {
	const fs = require("node:fs");
	const extSrc = fs.readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
	const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

	it("P1: runGuardRefusal reads the hatch through superDevEnv (config.json channel), never raw process.env", () => {
		expect(extSrc).toContain('superDevEnv("SUPER_DEV_ALLOW_OVERLAP")');
		expect(extSrc).not.toContain("process.env.SUPER_DEV_ALLOW_OVERLAP");
	});

	it("P2: releaseRunGuard only releases a guard the run OWNS (token match)", () => {
		const releaseRunGuard = (t: string): void => (ext as any).releaseRunGuard(t);
		setRunGuard({ startedAt: "t", runDir: "/tmp/x", token: "run-a" });
		releaseRunGuard("run-b"); // an overlapping later run must NOT clear it
		expect(runGuardRefusal()).not.toBeNull();
		releaseRunGuard("run-a"); // the owner clears it
		expect(runGuardRefusal()).toBeNull();
		// legacy tokenless fixtures stay releasable by anyone
		setRunGuard({ startedAt: "t", runDir: "/tmp/x" });
		releaseRunGuard("whoever");
		expect(runGuardRefusal()).toBeNull();
	});

	it("R9: MULTIPLE pending reflections are all named; a settled one stops being reported", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const note = (d: string, p: Promise<unknown>): void => (ext as any).noteInFlightReflection(d, p);
		let resolveA!: () => void;
		const a = new Promise<void>((r) => { resolveA = r; });
		const b = new Promise<void>(() => { /* never settles */ });
		note("/tmp/.super-dev/runs/A", a);
		note("/tmp/.super-dev/runs/B", b);
		resolveA();
		await flush(); // let A's finally self-clear microtask run

		const pi = makeMockPi();
		activate(pi);
		pi.fire("session_shutdown", { type: "session_shutdown", reason: "reload" });
		const lines = pi.entries.filter((e: any) => e.type === "super-dev-shutdown").map((e: any) => e.data.line as string);
		expect(lines.some((l: string) => l.includes("/runs/A") && l.includes("DROPPED"))).toBe(false);
		expect(lines.some((l: string) => l.includes("/runs/B") && l.includes("DROPPED"))).toBe(true);
		expect(consoleError).toHaveBeenCalled();
	});

	it("R9: a settled reflection never false-alarms (self-clear, P10)", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		(ext as any).noteInFlightReflection("/tmp/.super-dev/runs/A", Promise.resolve());
		await flush();
		const pi = makeMockPi();
		activate(pi);
		pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		const lines = pi.entries.filter((e: any) => e.type === "super-dev-shutdown").map((e: any) => e.data.line as string);
		expect(lines.some((l: string) => l.includes("DROPPED"))).toBe(false);
	});

	it("R8: the 50KB bound is UTF-8 BYTES — CJK content no longer slips through at ~3x the cap", () => {
		const text = "汉".repeat(30_000); // 90,000 bytes, 30,000 chars — passed the old char bound
		const out = canonTruncate(text, "/tmp/log");
		const kept = out.slice(0, out.lastIndexOf("\n"));
		expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(50_000);
		expect(Buffer.byteLength(kept, "utf8")).toBeGreaterThan(49_000); // cut is at the byte cap
		expect(out).toContain("[Output truncated: kept first 50000 bytes (1 lines)");
		expect(kept).not.toContain("\uFFFD"); // no replacement chars from a mid-codepoint cut
	});

	it("R8: the byte cut never splits a surrogate pair (astral-plane content)", () => {
		const text = "x".repeat(24_999) + "𝄞".repeat(12_500); // 24,999 + 50,000 bytes
		const out = canonTruncate(text);
		const kept = out.slice(0, out.lastIndexOf("\n"));
		expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(50_000);
		// no lone surrogates anywhere in the kept text
		for (const ch of kept) {
			const cp = ch.codePointAt(0)!;
			expect(cp >= 0x10000 || cp < 0xD800 || cp > 0xDFFF).toBe(true);
		}
	});

	it("R8: the line-cap notice is unchanged (byte-identical below both bounds)", () => {
		const text = "line1\nline2\nline3";
		expect(canonTruncate(text, "/tmp/log")).toBe(text);
		const lines = Array.from({ length: 2500 }, (_, i) => `line-${i}`);
		const out = canonTruncate(lines.join("\n"), "/tmp/runs/x/run.log");
		expect(out.split("\n")).toHaveLength(2001);
		expect(out.split("\n")[2000]).toBe("[Output truncated: showing 2000 of 2500 lines — full output saved to: /tmp/runs/x/run.log]");
	});
});
