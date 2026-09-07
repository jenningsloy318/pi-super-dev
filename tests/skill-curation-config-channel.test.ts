import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * v0.3.76 dual-review R3/AR-1: `SUPER_DEV_SKILLS=ambient` must resolve via
 * superDevEnv (process.env > config.json env map) — the config channel is the
 * ONLY one GUI-launched pi sessions have. Before the fix, ambientSkillsForced
 * read raw process.env, so a config-map-only value silently did nothing.
 * Isolated file because mocking superDevEnv module-wide would poison the
 * ambient tests in skill-curation.test.ts (which exercise the real channel).
 */

vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	const superDevEnv = vi.fn((key: string) =>
		key === "SUPER_DEV_SKILLS" ? "ambient" : (real.superDevEnv as (k: string) => string | undefined)(key),
	);
	return { ...real, superDevEnv };
});

import { ambientSkillsForced, resetAmbientSkillsForcedForTests } from "../src/agents/agent-runtime.ts";

describe("v0.3.76 R3/AR-1 — SUPER_DEV_SKILLS resolves via the superDevEnv channel (config env map, GUI sessions)", () => {
	beforeEach(() => { resetAmbientSkillsForcedForTests(); delete process.env.SUPER_DEV_SKILLS; });
	afterEach(() => { resetAmbientSkillsForcedForTests(); });

	it("a config-env-map-only value (no shell env) still forces ambient", () => {
		// superDevEnv is mocked to the config-map outcome (real precedence would
		// return "ambient" from the map because process.env is unset)
		expect(ambientSkillsForced()).toBe(true);
	});

	it("the channel is consulted exactly once per session — the decision is memoized, keeping registration (activate-time) and skillsForCall (per-call) on one value", async () => {
		const mocked = (await import("../src/render/super-dev-dir.ts")) as unknown as { superDevEnv: ReturnType<typeof vi.fn> };
		const callsBefore = mocked.superDevEnv.mock.calls.length;
		expect(ambientSkillsForced()).toBe(true);
		expect(ambientSkillsForced()).toBe(true); // memo hit — no new channel read
		expect(mocked.superDevEnv.mock.calls.length - callsBefore).toBe(1);
		resetAmbientSkillsForcedForTests();
		expect(ambientSkillsForced()).toBe(true);
		expect(mocked.superDevEnv.mock.calls.length - callsBefore).toBe(2); // fresh session re-resolves once
	});
});
