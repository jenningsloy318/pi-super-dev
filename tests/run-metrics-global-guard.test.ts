import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.3.73 M5 — the GLOBAL run-metrics ledger write must be env-guarded so test
 * suites that drive runWorkflow to close-out (without mocking getSuperDevDir)
 * stop polluting ~/.super-dev/run-metrics.jsonl (481 junk rows → fake 3σ bands
 * on every real run; run 2026-09-05T23-09-55-596Z close-out fired 5 bands with
 * median=0/MAD=0 baselines).
 */

let dir: string;
let globalDir: string;

vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return {
		...orig,
		getSuperDevDir: () => globalDir,
	};
});

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "metrics-guard-"));
	globalDir = mkdtempSync(join(tmpdir(), "metrics-global-"));
	// Tests that exercise the global write opt back IN explicitly.
	delete process.env.SUPER_DEV_NO_GLOBAL_METRICS;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(globalDir, { recursive: true, force: true });
});

describe("v0.3.73 M5 — global ledger env guard", () => {
	it("SUPER_DEV_NO_GLOBAL_METRICS=1 skips the global append (specDir row still written)", async () => {
		const { appendRunMetrics } = await import("../src/evolution/sigma-bands.ts");
		process.env.SUPER_DEV_NO_GLOBAL_METRICS = "1";
		appendRunMetrics(dir, { specId: "s", status: "success", wallMs: 1, costUsd: 0, tokens: 0, agentsSpawned: 0, agentErrorRounds: 0, fatalAborts: 0 } as never);
		expect(existsSync(join(dir, "run-metrics.jsonl"))).toBe(true);
		expect(existsSync(join(globalDir, "run-metrics.jsonl"))).toBe(false);
	});

	it("default (env unset) still appends globally", async () => {
		const { appendRunMetrics } = await import("../src/evolution/sigma-bands.ts");
		appendRunMetrics(dir, { specId: "s", status: "success", wallMs: 1, costUsd: 0, tokens: 0, agentsSpawned: 0, agentErrorRounds: 0, fatalAborts: 0 } as never);
		expect(existsSync(join(globalDir, "run-metrics.jsonl"))).toBe(true);
	});
});

describe("v0.3.73 dual review AR-73-04 — the guard resolves through the superDevEnv seam", () => {
	it("sigma-bands uses superDevEnv, not a raw process.env read (source contract)", () => {
		const src = readFileSync(join(import.meta.dirname, "../src/evolution/sigma-bands.ts"), "utf8");
		expect(src).toContain('superDevEnv("SUPER_DEV_NO_GLOBAL_METRICS")');
		expect(src).not.toContain("process.env.SUPER_DEV_NO_GLOBAL_METRICS");
	});

	it("a set guard outside vitest would WARN once (source contract)", () => {
		const src = readFileSync(join(import.meta.dirname, "../src/evolution/sigma-bands.ts"), "utf8");
		expect(src).toContain("warnedGlobalMetricsOff");
		expect(src).toMatch(/console\.warn\(.*SUPER_DEV_NO_GLOBAL_METRICS/);
	});
});

describe("v0.3.73 M5 — vitest hermeticity setup sets the guard for the whole suite", () => {
	it("config-env-hermeticity sets SUPER_DEV_NO_GLOBAL_METRICS=1 (source contract)", async () => {
		const src = readFileSync(join(import.meta.dirname, "setup/config-env-hermeticity.ts"), "utf8");
		expect(src).toContain("SUPER_DEV_NO_GLOBAL_METRICS");
	});
});
