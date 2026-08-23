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
