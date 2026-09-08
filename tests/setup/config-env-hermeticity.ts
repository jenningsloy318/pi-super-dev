/**
 * Global test hermeticity for the config.json env channel (v0.3.15).
 *
 * superDevEnv() falls back to the developer's REAL ~/.super-dev/config.json
 * when process.env is unset — exactly what production wants and exactly what
 * breaks test hermeticity: ~20 test files delete SUPER_DEV_* env vars and
 * assert defaults, so a developer who populates config.env (the feature's
 * own target user) would fail the suite deterministically.
 *
 * Stubbing getConfig alone is NOT sufficient: superDevEnv's internal call to
 * getConfig bypasses the mocked namespace binding. So superDevEnv itself is
 * stubbed to an env-vars-only passthrough (the pre-v0.3.15 behavior every
 * default-asserting test expects). The REAL implementation is pinned by the
 * source-contract test in tests/config-env.test.ts (the internal config path
 * cannot be exercised in-process under this mock).
 */
import { vi } from "vitest";

vi.mock("../../src/render/super-dev-dir.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/render/super-dev-dir.ts")>();
	return {
		...actual,
		superDevEnv: vi.fn((key: string) => {
			const v = process.env[key];
			return v !== undefined && v !== "" ? v : undefined;
		}),
	};
});

// v0.3.73 M5: global metrics-ledger hermeticity. Suites that drive runWorkflow
// to close-out (workflow.test, runlog-*, team-raci, cleanup-sensitive-scan)
// append a run-metrics row to the REAL ~/.super-dev/run-metrics.jsonl unless
// the global write is guarded — the σ-band baselines then accumulate 0-cost
// test rows and every real run trips fake 3σ bands. Metrics-asserting suites
// (run-metrics.test, sigma-bands.test) delete this var locally; they mock
// getSuperDevDir so their writes stay in tmp dirs either way.
process.env.SUPER_DEV_NO_GLOBAL_METRICS = "1";
// v0.3.81 adv-F1: activation's fire-and-forget git fetch must never do real
// network I/O (or mutate remote-tracking refs) from inside the unit suite.
process.env.SUPER_DEV_NO_FRESHNESS_CHECK = "1";
