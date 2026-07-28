/**
 * Phase 4 — Build-run PI session/model correlation tagging (RED phase).
 *
 * Targets AC-10 → SCENARIO-016 (env vars present → metadata records them) and
 * SCENARIO-017 (env vars absent → byte-identical to today). The contract is an
 * additive, optional `correlation?: { sessionId?: string; model?: string }`
 * field on `BuildGateResult`, populated defensively from
 * `process.env.PI_SESSION_ID` / `process.env.PI_MODEL`. It MUST NOT change
 * gate pass/fail logic, command construction, or emit control characters.
 *
 * Hermetic: each env-touching test saves/restores `process.env.PI_*` so tests
 * stay independent (no shared state). `runBuildGate` spawns real processes in
 * tmpdirs using self-contained scripts needing no dependencies.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuildGate, buildGateCorrelationLine, type BuildGateResult } from "../src/build-runner.ts";

function tmpProj(setup: (dir: string) => void): string {
	const dir = mkdtempSync(join(tmpdir(), "sd-build-corr-"));
	setup(dir);
	return dir;
}

/** The exact set of result keys BEFORE this change (byte-identical baseline). */
const BASELINE_KEYS = [
	"pass",
	"buildSuccess",
	"allTestsPass",
	"typecheckSuccess",
	"ran",
	"errors",
	"outOfScopeErrors",
	"inScopePass",
].sort();

const ENV_KEYS = ["PI_SESSION_ID", "PI_MODEL"] as const;

describe("runBuildGate — PI session/model correlation tagging (AC-10, SCENARIO-016/017)", () => {
	let saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("records sessionId and model on result.correlation when both env vars are present (SCENARIO-016)", () => {
		process.env.PI_SESSION_ID = "abc-123";
		process.env.PI_MODEL = "claude-sonnet-4-5";
		const d = tmpProj(() => {});
		try {
			const r = runBuildGate(d);
			expect(r.correlation).toBeDefined();
			expect(r.correlation?.sessionId).toBe("abc-123");
			expect(r.correlation?.model).toBe("claude-sonnet-4-5");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("correlation values are plain ASCII with no control characters (SCENARIO-016)", () => {
		process.env.PI_SESSION_ID = "sess-plain";
		process.env.PI_MODEL = "model-plain";
		const d = tmpProj(() => {});
		try {
			const r = runBuildGate(d);
			const blob = JSON.stringify(r.correlation);
			// No ANSI / ESC / newline / other control characters in machine-readable output.
			expect(/[\x00-\x1f\x7f]/.test(blob)).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("records only sessionId when only PI_SESSION_ID is present", () => {
		process.env.PI_SESSION_ID = "only-sess";
		const d = tmpProj(() => {});
		try {
			const r = runBuildGate(d);
			expect(r.correlation).toBeDefined();
			expect(r.correlation?.sessionId).toBe("only-sess");
			expect("model" in (r.correlation ?? {})).toBe(false);
			expect(r.correlation?.model).toBeUndefined();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("records only model when only PI_MODEL is present", () => {
		process.env.PI_MODEL = "only-model";
		const d = tmpProj(() => {});
		try {
			const r = runBuildGate(d);
			expect(r.correlation).toBeDefined();
			expect(r.correlation?.model).toBe("only-model");
			expect("sessionId" in (r.correlation ?? {})).toBe(false);
			expect(r.correlation?.sessionId).toBeUndefined();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("leaves the result byte-identical when both env vars are absent (SCENARIO-017)", () => {
		const d = tmpProj(() => {});
		try {
			const r = runBuildGate(d);
			expect(r.correlation).toBeUndefined();
			// No `correlation` key at all when env vars are absent.
			expect(Object.keys(r).sort()).toEqual(BASELINE_KEYS);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("does not change gate pass/fail logic — a green gate stays green with correlation present", () => {
		process.env.PI_SESSION_ID = "sess-green";
		process.env.PI_MODEL = "model-green";
		const d = tmpProj((dir) =>
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } })),
		);
		try {
			const r = runBuildGate(d);
			expect(r.pass).toBe(true);
			expect(r.allTestsPass).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("does not change gate pass/fail logic — a red gate stays red with correlation present", () => {
		process.env.PI_SESSION_ID = "sess-red";
		process.env.PI_MODEL = "model-red";
		const d = tmpProj((dir) =>
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } })),
		);
		try {
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.allTestsPass).toBe(false);
			expect(r.errors.some((e) => e.includes("FAILED"))).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("does not alter constructed commands (ran labels unchanged) when correlation is present", () => {
		process.env.PI_SESSION_ID = "sess-cmd";
		process.env.PI_MODEL = "model-cmd";
		const d = tmpProj((dir) =>
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } })),
		);
		try {
			const r = runBuildGate(d);
			// The argv label is byte-identical to today (no env-tagging of the command).
			expect(r.ran).toEqual(["npm run test"]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("populates correlation even on an erroring/aborted gate (defensive, no-throw)", () => {
		process.env.PI_SESSION_ID = "sess-def";
		process.env.PI_MODEL = "model-def";
		// Greenfield → gate passes with no commands; correlation must still attach.
		const d = tmpProj(() => {});
		try {
			const r: BuildGateResult = runBuildGate(d);
			expect(r.pass).toBe(true);
			expect(r.correlation).toBeDefined();
			expect(r.correlation?.sessionId).toBe("sess-def");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("buildGateCorrelationLine (AR-02: makes the tag observable)", () => {
	it("returns null when the result carries no correlation", () => {
		const r: BuildGateResult = { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, ran: [], errors: [], outOfScopeErrors: [], inScopePass: true };
		expect(buildGateCorrelationLine(r)).toBeNull();
	});

	it("formats a plain-ASCII `# pi-session=<id> model=<model>` line when both are present", () => {
		const r: BuildGateResult = { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, ran: [], errors: [], outOfScopeErrors: [], inScopePass: true, correlation: { sessionId: "s-1", model: "openai/gpt-4o" } };
		expect(buildGateCorrelationLine(r)).toBe("# pi-session=s-1 model=openai/gpt-4o");
	});

	it("emits only the present key when just the session id is set", () => {
		const r: BuildGateResult = { pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, ran: [], errors: [], outOfScopeErrors: [], inScopePass: true, correlation: { sessionId: "s-2" } };
		expect(buildGateCorrelationLine(r)).toBe("# pi-session=s-2");
	});
});
