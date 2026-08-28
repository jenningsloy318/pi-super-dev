import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.3.25 L1 — FleetView visibility via pi-subagents' external-runs registry.
 *
 * super-dev agent calls (and later stages) publish display-only ExternalRun
 * records so the whole pipeline is visible in pi's Fleet UI — with live
 * currentAction updates, terminal states, and preview text. Everything is
 * best-effort: a missing pi-subagents install, a failed import, or a registry
 * error must NEVER affect the pipeline (silent no-op).
 */

import {
	type ExternalRunsModule,
	fleetBegin,
	fleetUpdate,
	fleetFinish,
	resolveExternalRunsModule,
	resolvePiSessionIdentity,
} from "../src/agents/fleet-visibility.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-fleet-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("resolveExternalRunsModule", () => {
	it("returns null when pi-subagents is not resolvable (standalone/CLI) — never throws", async () => {
		// Isolate from THIS machine's real pi install (the developer runs
		// pi-subagents): bogus HOME + no extra candidates → every path fails.
		const savedHome = process.env.HOME;
		const savedRoot = process.env.PI_SUBAGENTS_ROOT;
		delete process.env.PI_SUBAGENTS_ROOT;
		process.env.HOME = "/nonexistent-home-super-dev-test";
		try {
			const mod = await resolveExternalRunsModule(["/nonexistent/super-dev-test-path"], true);
			expect(mod).toBeNull();
		} finally {
			process.env.HOME = savedHome;
			if (savedRoot !== undefined) process.env.PI_SUBAGENTS_ROOT = savedRoot;
		}
	});
});

function fakeModule(): { mod: ExternalRunsModule; calls: any[] } {
	const calls: any[] = [];
	const mod: ExternalRunsModule = {
		registerExternalRun: (input: any) => { calls.push(["register", input]); return input; },
		updateExternalRun: (sessionId: string, id: string, update: any) => { calls.push(["update", sessionId, id, update]); return update; },
		unregisterExternalRun: (sessionId: string, id: string) => { calls.push(["unregister", sessionId, id]); return true; },
	};
	return { mod, calls };
}

describe("resolvePiSessionIdentity (v0.3.27 — run 2026-08-28T16-09-12 fleet invisibility)", () => {
	it("prefers the session FILE path over the session id, mirroring pi-subagents' resolveCurrentSessionId", () => {
		// E7 production probe (pi 0.84.3): getSessionId() returns a uuid while
		// pi-subagents' fleet filter passes resolveCurrentSessionId() =
		// getSessionFile() ?? getSessionId(). Registering with the uuid made
		// snapshotExternalRuns(sessionFile) return 0 rows — external runs never
		// appeared in any Fleet view.
		const sm = {
			getSessionId: () => "01a04932-ccb3-73b3-bf64-53cb83e66d69",
			getSessionFile: () => "/home/jenningsl/.pi/agent/sessions/--tmp--/2026-08-28T16-27-41-107Z_01a04932.jsonl",
		};
		expect(resolvePiSessionIdentity(sm)).toBe(sm.getSessionFile());
	});

	it("falls back to the session id when no session file exists, and to undefined when neither is available", () => {
		expect(resolvePiSessionIdentity({ getSessionId: () => "uuid-only" })).toBe("uuid-only");
		expect(resolvePiSessionIdentity({ getSessionFile: () => null })).toBeUndefined();
		expect(resolvePiSessionIdentity({})).toBeUndefined();
	});
});

describe("fleet visibility wrappers", () => {
	it("fleetBegin registers a running external run; fleetFinish writes the terminal state and unregisters", () => {
		const { mod, calls } = fakeModule();
		const stop = fleetBegin(mod, { sessionId: "sess-1", id: "pipeline.judge.a1", label: "judge", source: "super-dev" });
		expect(calls[0][0]).toBe("register");
		expect(calls[0][1].id).toBe("pipeline.judge.a1");
		expect(calls[0][1].sessionId).toBe("sess-1");
		expect(calls[0][1].source).toBe("super-dev");
		expect(calls[0][1].state).toBe("running");
		expect(calls[0][1].label).toBe("judge");

		fleetFinish(mod, "sess-1", "pipeline.judge.a1", { state: "completed", preview: "verdict: routed" });
		const terminal = calls.find((c) => c[0] === "update");
		expect(terminal[3].state).toBe("completed");
		expect(terminal[3].preview).toContain("verdict");
		expect(calls.some((c) => c[0] === "unregister")).toBe(true);
		expect(typeof stop).toBe("function");
	});

	it("fleetUpdate sets currentAction with throttling (at most one update per second by default)", () => {
		const { mod, calls } = fakeModule();
		fleetBegin(mod, { sessionId: "sess-1", id: "call-1", label: "x", source: "super-dev" });
		fleetUpdate(mod, "sess-1", "call-1", "reading file A");
		fleetUpdate(mod, "sess-1", "call-1", "running tests B"); // same window → suppressed
		const updates = calls.filter((c) => c[0] === "update" && c[3]?.currentAction);
		expect(updates.length).toBe(1);
		expect(updates[0][3].currentAction).toBe("reading file A");
	});

	it("every wrapper is a silent no-op with a null module or a throwing registry", () => {
		expect(() => fleetBegin(null, { sessionId: "s", id: "i", label: "l", source: "super-dev" })).not.toThrow();
		expect(() => fleetUpdate(null, "s", "i", "action")).not.toThrow();
		expect(() => fleetFinish(null, "s", "i", { state: "completed" })).not.toThrow();
		const throwing: ExternalRunsModule = {
			registerExternalRun: () => { throw new Error("registry full"); },
			updateExternalRun: () => { throw new Error("boom"); },
			unregisterExternalRun: () => { throw new Error("boom"); },
		};
		expect(() => fleetBegin(throwing, { sessionId: "s", id: "i", label: "l", source: "super-dev" })).not.toThrow();
		expect(() => fleetUpdate(throwing, "s", "i", "a")).not.toThrow();
		expect(() => fleetFinish(throwing, "s", "i", { state: "failed" })).not.toThrow();
	});
});
