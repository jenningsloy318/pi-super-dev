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
// v0.3.84: the REAL superDevEnv must refuse its config fallback under the
// suite too — local vi.mock(...super-dev-dir...) factories in ~10 files
// spread `...actual`, silently restoring the real accessor (and its
// intra-module getConfig binding, which a namespace mock cannot intercept).
// Observed live: a developer config.env SUPER_DEV_DEFAULT_TIMEOUT_MS broke
// tests/agent-runtime.test.ts tier assertions mid-session.
process.env.SUPER_DEV_NO_CONFIG_ENV = "1";
process.env.SUPER_DEV_NO_GLOBAL_METRICS = "1";
// P2 (v0.3.90, F-07): the close-out eval stage's OWN kill switch — same
// hermeticity class as SUPER_DEV_NO_GLOBAL_METRICS above, deliberately a
// SEPARATE key (decoupled: metrics ledger and eval surface can be disabled
// independently; the stage is ON by default in production). Suites that
// drive runWorkflow to close-out would otherwise dispatch eval-scorer,
// append dataset rows to the real ~/.super-dev/evals/runs/, and write extra
// events/reports — the tests/eval-stage.test.ts wiring test deletes this var
// locally (with getSuperDevDir mocked to a tmp dir) to exercise the wiring.
// P3 (D4): the flywheel rides the SAME switch (state.json / proposals under
// the default home would otherwise be written at every close-out); the D6
// reread check deliberately does NOT (always on — read-only + event-on-
// findings only, zero writes when no findings).
process.env.SUPER_DEV_NO_EVAL_STAGE = "1";
// v0.3.81 adv-F1: activation's fire-and-forget git fetch must never do real
// network I/O (or mutate remote-tracking refs) from inside the unit suite.
process.env.SUPER_DEV_NO_FRESHNESS_CHECK = "1";
