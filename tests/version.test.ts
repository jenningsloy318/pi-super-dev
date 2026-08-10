import { describe, expect, it } from "vitest";
import {
	SUPER_DEV_EXTENSION_VERSION,
	SUPER_DEV_VERSION_POLICY,
	SUPER_DEV_VERSION_METADATA,
	superDevRunMetadataLine,
	superDevVersionLabel,
} from "../src/version.ts";

describe("super-dev extension version metadata", () => {
	it("sets the runtime-visible extension version to 0.01.20", () => {
		expect(SUPER_DEV_EXTENSION_VERSION).toBe("0.01.20");
		expect(SUPER_DEV_VERSION_METADATA).toMatchObject({
			name: "super-dev",
			version: "0.01.20",
		});
		expect(superDevVersionLabel()).toBe("super-dev v0.01.20");
	});

	it("keeps the TUI/run metadata line short", () => {
		const line = superDevRunMetadataLine();
		expect(line).toBe("super-dev v0.01.20");
		expect(line).not.toContain("version policy");
		expect(line).not.toContain("increment patch every commit");
	});

	it("exposes the commit-based patch/minor rollover rule as metadata", () => {
		expect(SUPER_DEV_VERSION_METADATA.policy).toBe(SUPER_DEV_VERSION_POLICY);
		expect(SUPER_DEV_VERSION_METADATA.policy).toContain("increment patch every commit");
		expect(SUPER_DEV_VERSION_METADATA.policy).toContain("patch 01-99");
		expect(SUPER_DEV_VERSION_METADATA.policy).toContain("minor 01-99");
	});
});
