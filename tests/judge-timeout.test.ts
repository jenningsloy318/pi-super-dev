/**
 * Judge wall-clock budget (run 2026-08-27T12-33-43-088Z).
 *
 * 4/4 judge calls on the overnight phase-03 stall timed out at EXACTLY the
 * 240s cap (240161/240193/240244/240237ms) — glm-5.2 @ thinking=high
 * exploring a worktree systematically overruns 240s. Default doubled to 480s
 * (v0.2.6), then raised to a dedicated 20-min tier (v0.3.85 decision 6:
 * 480s still clipped phase-5 diagnoses twice on run 2026-09-09; the judge is
 * a routing decision, not a deep review — 30min too loose, 20min the mean).
 * SUPER_DEV_JUDGE_TIMEOUT_MS still overrides.
 */
import { describe, it, expect, afterEach } from "vitest";
import { judgeTimeoutMs } from "../src/stages/judge.ts";

describe("judgeTimeoutMs", () => {
	afterEach(() => { delete process.env.SUPER_DEV_JUDGE_TIMEOUT_MS; });
	it("defaults to 20min (v0.3.85 decision 6: 480s observed too tight twice on run 2026-09-09 phase 5)", () => {
		expect(judgeTimeoutMs()).toBe(1_200_000);
	});
	it("respects SUPER_DEV_JUDGE_TIMEOUT_MS override", () => {
		process.env.SUPER_DEV_JUDGE_TIMEOUT_MS = "90000";
		expect(judgeTimeoutMs()).toBe(90_000);
	});
});
