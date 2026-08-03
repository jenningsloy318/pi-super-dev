import { describe, expect, it } from "vitest";
import {
	SUPER_DEV_EXTENSION_VERSION,
	SUPER_DEV_VERSION_METADATA,
	superDevRunMetadataLine,
	superDevVersionLabel,
} from "../src/version.ts";

describe("super-dev extension version metadata", () => {
	it("sets the runtime-visible extension version to 0.01.01", () => {
		expect(SUPER_DEV_EXTENSION_VERSION).toBe("0.01.01");
		expect(SUPER_DEV_VERSION_METADATA).toMatchObject({
			name: "super-dev",
			version: "0.01.01",
		});
		expect(superDevVersionLabel()).toBe("super-dev v0.01.01");
	});

	it("exposes the commit-based patch/minor rollover rule for logs and docs", () => {
		const line = superDevRunMetadataLine();
		expect(line).toContain("super-dev v0.01.01");
		expect(line).toContain("increment patch every commit");
		expect(line).toContain("patch 01-99");
		expect(line).toContain("minor 01-99");
	});
});
