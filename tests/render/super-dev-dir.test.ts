import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	getConfigPath,
	getLearnedPath,
	getRunsDir,
	getSuperDevDir,
	getTracesDir,
} from "../../src/render/super-dev-dir.ts";

describe("super-dev runtime directory", () => {
	it("stores config and runtime data under ~/.super-dev", () => {
		const root = join(homedir(), ".super-dev");
		expect(getSuperDevDir()).toBe(root);
		expect(getConfigPath()).toBe(join(root, "config.json"));
		expect(getLearnedPath()).toBe(join(root, "learned.md"));
		expect(getRunsDir()).toBe(join(root, "runs"));
		expect(getTracesDir()).toBe(join(root, "traces"));
	});
});
