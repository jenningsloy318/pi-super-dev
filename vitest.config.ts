import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
		setupFiles: ["tests/setup/config-env-hermeticity.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// Entry shells: extension.ts is the host-process bootstrap (RPC bus
			// wiring exercised only by live runs); rpc-driver.ts is the standalone
			// CLI harness; bench/ is an offline benchmark harness. All MEASURED
			// source must hold the hard thresholds.
			exclude: ["src/extension.ts", "src/rpc-driver.ts", "src/bench/**", "src/version.ts"],
			reporter: ["text", "text-summary", "json-summary"],
			// v0.3.47: HARD GATE (user mandate 2026-08-31) — passing tests alone
			// are no longer sufficient; 85% is the floor for every measured
			// dimension. A run below any threshold exits non-zero and the change
			// may NOT be committed (release checklist, docs/testing-strategy.md).
			thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 },
		},
	},
});
