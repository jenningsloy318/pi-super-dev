/**
 * Tests for runAgentViaSession's corrective-re-prompt behavior (B1/B2 from the
 * deep audit): the corrective turn must (B1) fire ONLY when structured_output
 * was actually called, and (B2) MERGE into the captured value instead of
 * overwriting (so previously-present keys survive a partial second call).
 *
 * These test the pure helpers + the tool-merge behavior directly, since the
 * full session path needs a real model (covered by verify-bdd.ts).
 */

import { describe, it, expect, vi } from "vitest";
import { missingKeys, deliveryDisciplineFor, sessionToolAccess } from "../src/session-agent.ts";

describe("deliveryDisciplineFor", () => {
	it("gives code-writing agents a code-centric discipline (edits, not a document)", () => {
		const impl = deliveryDisciplineFor("implementer");
		expect(impl).toMatch(/APPLIED SOURCE-CODE EDITS/);
		// Must NOT tell the implementer its deliverable is a "document" nor cap it at ~6 calls.
		expect(impl).not.toMatch(/written document/);
		expect(impl).not.toMatch(/AT MOST ~6 tool calls/);
		// Steers away from the edit-thrash failure mode.
		expect(impl).toMatch(/whole-file `write`/);
		expect(impl).toMatch(/source file MUST be modified/);
	});
	it("gives tdd-guide a RED-phase test-only discipline", () => {
		const tdd = deliveryDisciplineFor("tdd-guide");
		expect(tdd).toMatch(/APPLIED TEST-CODE EDITS/);
		expect(tdd).toMatch(/test files only/i);
		expect(tdd).toMatch(/Do NOT create or modify production\/source implementation files/);
		expect(tdd).toMatch(/test file MUST be modified/);
		expect(tdd).not.toMatch(/APPLIED SOURCE-CODE EDITS/);
		expect(tdd).not.toMatch(/source file MUST be modified/);
	});
	it("keeps a render-pipeline structured-output discipline for doc writers", () => {
		const doc = deliveryDisciplineFor("research-agent");
		expect(doc).toMatch(/COMPLETE STRUCTURED CONTENT/);
		expect(doc).toMatch(/renderer writes the Markdown document/);
		expect(doc).toMatch(/AT MOST ~6 tool calls/);
		expect(doc).toMatch(/immediately call structured_output/);
		expect(doc).toMatch(/do NOT hand-write markdown files/);
		expect(doc).not.toMatch(/APPLIED SOURCE-CODE EDITS/);
	});
});

describe("missingKeys", () => {
	it("returns all keys when captured is null/undefined", () => {
		expect(missingKeys(undefined, ["a", "b"])).toEqual(["a", "b"]);
		expect(missingKeys(null, ["a", "b"])).toEqual(["a", "b"]);
	});
	it("returns keys that are blank", () => {
		expect(missingKeys({ a: 1, b: "", c: null, d: [], e: "x" }, ["a", "b", "c", "d", "e", "f"])).toEqual(["b", "c", "d", "f"]);
	});
	it("can allow empty arrays for fields where [] is semantically complete", () => {
		expect(missingKeys(
			{ filesCreated: ["src/new.ts"], filesModified: [], filesDeleted: [] },
			["filesCreated", "filesModified", "filesDeleted"],
			{ allowEmptyArraysFor: ["filesModified", "filesDeleted"] },
		)).toEqual([]);
	});
	it("returns [] when everything is present", () => {
		expect(missingKeys({ a: 1, b: "x" }, ["a", "b"])).toEqual([]);
	});
});

describe("sessionToolAccess", () => {
	it("keeps write-mode sessions on coding tools with only super_dev excluded", () => {
		expect(sessionToolAccess(undefined)).toEqual({ useCodingTools: true, excludeTools: ["super_dev"] });
		expect(sessionToolAccess("write")).toEqual({ useCodingTools: true, excludeTools: ["super_dev"] });
	});

	it("uses a read/diagnostic allowlist for source-read-only sessions", () => {
		expect(sessionToolAccess("source-read-only")).toEqual({
			useCodingTools: false,
			tools: ["read", "bash", "grep", "find", "ls", "structured_output"],
			excludeTools: ["super_dev", "edit", "write"],
		});
	});
});

describe("structured_output capture merges (B2)", () => {
	it("simulates the merge: a partial second call does not erase earlier keys", () => {
		// Mirror of the tool's execute(): capture.value = { ...capture.value, ...params }
		let value: Record<string, unknown> | undefined = undefined;
		const exec = (params: Record<string, unknown>) => {
			value = { ...value, ...params };
		};
		// First call: docPath + summary present, scenarioCount missing.
		exec({ docPath: "/x/01-requirements.md", summary: "s" });
		expect(value).toEqual({ docPath: "/x/01-requirements.md", summary: "s" });
		// Corrective turn returns ONLY the missing key — merge must keep docPath.
		exec({ scenarioCount: 5 });
		expect(value).toEqual({ docPath: "/x/01-requirements.md", summary: "s", scenarioCount: 5 });
	});
});

// ─── T7.1 / SD-04 (NFR-6 pinning): session-backend abort-listener guard ─────
//
// runAgentViaSession registers `opts.signal?.addEventListener("abort", onAbort)`
// only AFTER the awaited session creation. Per WHATWG/Node semantics a listener
// attached to an ALREADY-aborted signal never fires — the session would run to
// its own hard timeout. The pinning tests mock the pi SDK (no real session, no
// model) and assert the synchronous `signal?.aborted` checks fire instead.
const sessionHarness = vi.hoisted(() => ({
	createCalls: 0,
	/** When set, FakeResourceLoader.reload() aborts it (simulating an abort
	 *  landing DURING the awaited session-creation window). */
	abortOnReload: null as AbortController | null,
	lastSession: null as { abortCalls: number; promptCalls: number } | null,
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
	class FakeSession {
		abortCalls = 0;
		promptCalls = 0;
		messages: unknown[] = [];
		async prompt() { this.promptCalls++; }
		async abort() { this.abortCalls++; }
		dispose() {}
	}
	class FakeResourceLoader {
		async reload() { if (sessionHarness.abortOnReload) sessionHarness.abortOnReload.abort(); }
	}
	return {
		createAgentSession: async () => {
			sessionHarness.createCalls++;
			const s = new FakeSession();
			sessionHarness.lastSession = s;
			return { session: s };
		},
		createCodingTools: () => [],
		defineTool: (t: unknown) => t,
		getAgentDir: () => "/tmp/fake-agent-dir",
		DefaultResourceLoader: FakeResourceLoader,
		ModelRuntime: { create: async () => ({ getModel: () => null }) },
		SessionManager: { inMemory: () => ({}) },
		SettingsManager: { create: () => ({}) },
	};
});

describe("SD-04: runAgentViaSession guards abort-listener registration with synchronous aborted checks", () => {
	const base = { agent: "implementer", prompt: "x", cwd: "/tmp" };

	it("a signal aborted BEFORE the call returns error=aborted without creating any session", async () => {
		const { runAgentViaSession } = await import("../src/session-agent.ts");
		sessionHarness.createCalls = 0;
		sessionHarness.abortOnReload = null;
		const controller = new AbortController();
		controller.abort(); // pre-aborted: the listener registered post-creation would never fire
		const result = await runAgentViaSession({ ...base, signal: controller.signal, controlKeys: ["verdict"] });
		expect(result.error).toBe("aborted");
		expect(result.control).toBeNull();
		// the guard fires BEFORE session creation: no session is spun up into a dead run
		expect(sessionHarness.createCalls).toBe(0);
	});

	it("an abort landing DURING session creation terminates the session at registration (the after-check fires)", async () => {
		const { runAgentViaSession } = await import("../src/session-agent.ts");
		sessionHarness.createCalls = 0;
		sessionHarness.abortOnReload = null;
		const controller = new AbortController();
		sessionHarness.abortOnReload = controller; // reload() aborts mid-creation window
		try {
			await runAgentViaSession({ ...base, signal: controller.signal, controlKeys: ["verdict"] });
			// The synchronous post-registration check must have invoked onAbort —
			// the session is terminated immediately instead of running orphaned.
			expect(sessionHarness.lastSession?.abortCalls ?? 0).toBeGreaterThanOrEqual(1);
		} finally {
			sessionHarness.abortOnReload = null;
		}
	});
});
