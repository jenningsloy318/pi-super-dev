import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPER_DEV_EXTENSION_VERSION } from "../src/version.ts";

/**
 * Lockfile integrity (v0.4.25) — the v0.4.16 stamping-corruption class.
 *
 * From v0.4.16 through v0.4.24 the per-commit version bump overwrote EVERY
 * `version` field in package-lock.json with the project version, not just the
 * two root fields. 404 dependency entries claimed "0.4.24" (typescript, vitest,
 * vite, …) and 52 of them carried no `resolved`, so a fresh `npm ci` could not
 * resolve them at all. The defect went undetected for nine releases because the
 * already-installed node_modules kept the suite green and every comparison was
 * between two identically-corrupted lockfiles.
 *
 * This test pins the invariant mechanically: the corruption signature is a
 * dependency entry whose `version` equals the project version. It also guards
 * resolution completeness and root-field alignment, so the next bump that
 * reaches for a global string replace fails here, in CI, before it ships.
 */
describe("package-lock.json integrity (the v0.4.16 stamping-corruption class)", () => {
	const lockPath = join(process.cwd(), "package-lock.json");
	const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
		version: string;
		lockfileVersion: number;
		packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
	};

	it("no dependency entry carries the project version (the corruption signature)", () => {
		const corrupted = Object.entries(lock.packages)
			.filter(([key, entry]) => key !== "" && entry.version === lock.version)
			.map(([key]) => key);
		expect(corrupted).toEqual([]);
	});

	it("every dependency entry is resolvable (resolved or integrity present)", () => {
		const unresolved = Object.entries(lock.packages)
			.filter(([key, entry]) => key !== "" && !entry.resolved && !entry.integrity)
			.map(([key]) => key);
		expect(unresolved).toEqual([]);
	});

	it("the two root version fields match the extension version", () => {
		expect(lock.version).toBe(SUPER_DEV_EXTENSION_VERSION);
		expect(lock.packages[""]?.version).toBe(SUPER_DEV_EXTENSION_VERSION);
	});

	it("the lockfile format is lockfileVersion 3 (the shape the repair assumed)", () => {
		expect(lock.lockfileVersion).toBe(3);
	});
});
