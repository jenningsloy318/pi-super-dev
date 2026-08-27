/**
 * Judge wall-clock budget (run 2026-08-27T12-33-43-088Z).
 *
 * 4/4 judge calls on the overnight phase-03 stall timed out at EXACTLY the
 * 240s cap (240161/240193/240244/240237ms) — glm-5.2 @ thinking=high
 * exploring a worktree systematically overruns 240s. Default doubles to 480s;
 * SUPER_DEV_JUDGE_TIMEOUT_MS still overrides.
 */
import { describe, it, expect, afterEach } from "vitest";
import { judgeTimeoutMs } from "../src/stages/judge.ts";

describe("judgeTimeoutMs", () => {
	afterEach(() => { delete process.env.SUPER_DEV_JUDGE_TIMEOUT_MS; });
	it("defaults to 480s (was 240s — 4/4 observed timeouts at the cap)", () => {
		expect(judgeTimeoutMs()).toBe(480_000);
	});
	it("respects SUPER_DEV_JUDGE_TIMEOUT_MS override", () => {
		process.env.SUPER_DEV_JUDGE_TIMEOUT_MS = "90000";
		expect(judgeTimeoutMs()).toBe(90_000);
	});
});
