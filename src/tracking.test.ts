/**
 * Phase 1 — `rollbackWorktreeTo` spawn-argv contract (spec-18 / SCENARIO-010, SCENARIO-012).
 *
 * Co-located beside the source it exercises (`src/tracking.ts`), mirroring the
 * `src/build-runner.test.ts` precedent. The BEHAVIOR of `rollbackWorktreeTo`
 * (real `git reset --hard` + `git clean -fd`) is proven end-to-end against a
 * real git binary in `tests/tracking-rollback.test.ts`. Here we assert the
 * exact spawn-argv CONTRACT that lets rollback sidestep the `src/safety.ts`
 * denylist: discrete argv elements, NEVER `shell:true`.
 *
 * Coverage matrix:
 *   - AC-05 / SCENARIO-010 — success path issues exactly two `git` invocations
 *     (`reset --hard <ref>` then `clean -fd`) scoped to `-C <worktreePath>`.
 *   - default `commit='HEAD'` — the reset argv lands at HEAD when omitted.
 *   - explicit commit ref — threaded as a discrete argv element (no shell).
 *   - never `shell:true` — the safety.ts denylist matches shell command strings
 *     only, so discrete argv can never be confused for a shell command.
 *   - SCENARIO-012 / AC-10 — never throws: non-zero exit → `{ok:false}`, and an
 *     undefined worktreePath returns early WITHOUT spawning git.
 *
 * Hermetic: `node:child_process.spawnSync` is mocked so NO real `git` runs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the ONLY side-effect rollback performs: spawnSync. Real git never runs.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { rollbackWorktreeTo } from "./tracking.ts";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;
const WORKTREE = "/fake/worktree";

beforeEach(() => {
	spawn.mockReset();
});

describe("rollbackWorktreeTo — discrete-argv spawnSync (no shell:true) (SCENARIO-010)", () => {
	it("issues exactly two git invocations — reset then clean — scoped to the worktree", () => {
		spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));

		const result = rollbackWorktreeTo(WORKTREE);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		const calls = spawn.mock.calls as unknown as Array<[string, string[], unknown]>;
		expect(calls).toHaveLength(2);
		expect(calls[0][0]).toBe("git");
		expect(calls[0][1]).toEqual(["-C", WORKTREE, "reset", "--hard", "HEAD"]);
		expect(calls[1][0]).toBe("git");
		expect(calls[1][1]).toEqual(["-C", WORKTREE, "clean", "-fd"]);
	});

	it("defaults the commit ref to HEAD", () => {
		spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
		rollbackWorktreeTo(WORKTREE);
		const calls = spawn.mock.calls as unknown as Array<[string, string[]]>;
		expect(calls[0][1]).toEqual(["-C", WORKTREE, "reset", "--hard", "HEAD"]);
	});

	it("threads an explicit commit ref through as a discrete argv element", () => {
		spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
		rollbackWorktreeTo(WORKTREE, "abc123");
		const calls = spawn.mock.calls as unknown as Array<[string, string[]]>;
		expect(calls[0][1]).toEqual(["-C", WORKTREE, "reset", "--hard", "abc123"]);
	});

	it("never opts into shell:true on either invocation (safety.ts denylist bypass)", () => {
		spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
		rollbackWorktreeTo(WORKTREE, "main");
		const calls = spawn.mock.calls as unknown as Array<[string, string[], unknown]>;
		for (const call of calls) {
			const opts = (call[2] ?? {}) as Record<string, unknown>;
			expect(opts.shell).toBeFalsy();
		}
	});
});

describe("rollbackWorktreeTo — never throws / degrades (SCENARIO-012 / AC-10)", () => {
	it("returns {ok:false} without throwing when git reset exits non-zero", () => {
		spawn.mockImplementation((_cmd: string, args: string[]) => {
			if (args.includes("reset")) return { status: 128, stdout: "", stderr: "fatal: bad ref" };
			return { status: 0, stdout: "", stderr: "" };
		});
		let result: ReturnType<typeof rollbackWorktreeTo> | undefined;
		expect(() => {
			result = rollbackWorktreeTo(WORKTREE, "deadbeef");
		}).not.toThrow();
		expect(result?.ok).toBe(false);
		expect(typeof result?.error).toBe("string");
	});

	it("returns {ok:false} without throwing when git clean exits non-zero", () => {
		spawn.mockImplementation((_cmd: string, args: string[]) => {
			if (args.includes("clean")) return { status: 1, stdout: "", stderr: "clean failed" };
			return { status: 0, stdout: "", stderr: "" };
		});
		const result = rollbackWorktreeTo(WORKTREE);
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
	});

	it("returns {ok:false, error:'no worktreePath'} for an undefined path and never spawns git", () => {
		spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
		const result = rollbackWorktreeTo(undefined);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("no worktreePath");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("returns {ok:false} without throwing when spawnSync itself errors", () => {
		spawn.mockImplementation(() => ({ error: new Error("ENOENT") }));
		const result = rollbackWorktreeTo(WORKTREE);
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
	});
});
