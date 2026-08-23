import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
		setupFiles: ["tests/setup/config-env-hermeticity.ts"],
	},
});
