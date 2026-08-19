import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
	SUPER_DEV_EXTENSION_VERSION,
	SUPER_DEV_VERSION_POLICY,
	SUPER_DEV_VERSION_METADATA,
	superDevRunMetadataLine,
	superDevVersionLabel,
} from "../src/version.ts";

describe("super-dev extension version metadata", () => {
	it("sets the runtime-visible extension version to SUPER_DEV_EXTENSION_VERSION", () => {
		expect(SUPER_DEV_EXTENSION_VERSION).toBe("0.2.4");
		expect(SUPER_DEV_VERSION_METADATA).toMatchObject({
			name: "super-dev",
			version: "0.2.4",
		});
		expect(superDevVersionLabel()).toBe("super-dev v0.2.4");
	});

	it("keeps the TUI/run metadata line short", () => {
		const line = superDevRunMetadataLine();
		expect(line).toBe("super-dev v0.2.4");
		expect(line).not.toContain("version policy");
		expect(line).not.toContain("increment patch every commit");
	});

	it("keeps package metadata aligned with the runtime version", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
		const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { version?: string; packages?: Record<string, { version?: string }> };
		expect(pkg.version).toBe(SUPER_DEV_EXTENSION_VERSION);
		expect(lock.version).toBe(SUPER_DEV_EXTENSION_VERSION);
		expect(lock.packages?.[""]?.version).toBe(SUPER_DEV_EXTENSION_VERSION);
	});

	it("exposes the commit-based patch/minor rollover rule as metadata", () => {
		expect(SUPER_DEV_VERSION_METADATA.policy).toBe(SUPER_DEV_VERSION_POLICY);
		expect(SUPER_DEV_VERSION_METADATA.policy).toContain("increment patch every commit");
		expect(SUPER_DEV_VERSION_METADATA.policy).toContain("patch 1-99");
		expect(SUPER_DEV_VERSION_METADATA.policy).toContain("minor 1-99");
	});
});
