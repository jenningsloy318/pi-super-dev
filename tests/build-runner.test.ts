/**
 * Unit tests for the deterministic build/test/typecheck gate (build-runner.ts).
 * No LLM. detectProjectCommands is pure; runBuildGate spawns real processes in
 * tmpdirs, so the cases use self-contained scripts that need no dependencies.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectCommands, runBuildGate } from "../src/build-runner.ts";

function tmpProj(setup: (dir: string) => void): string {
	const dir = mkdtempSync(join(tmpdir(), "sd-build-"));
	setup(dir);
	return dir;
}

describe("detectProjectCommands", () => {
	it("detects rust from Cargo.toml", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "Cargo.toml"), ""));
		try {
			const c = detectProjectCommands(d);
			expect(c.language).toBe("rust");
			expect(c.build?.[0]).toBe("cargo");
			expect(c.test).toEqual(["cargo", "test", "--quiet"]);
			expect(c.typecheck?.[0]).toBe("cargo");
			expect(c.ran).toHaveLength(3);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("detects go from go.mod", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "go.mod"), "module x\n"));
		try {
			const c = detectProjectCommands(d);
			expect(c.language).toBe("go");
			expect(c.test).toEqual(["go", "test", "./..."]);
			expect(c.ran).toContain("go test ./...");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("detects node scripts + tsconfig fallback typecheck, defaulting to npm", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "node -e 0" } }));
			writeFileSync(join(dir, "tsconfig.json"), "{}");
		});
		try {
			const c = detectProjectCommands(d);
			expect(c.pm).toBe("npm");
			expect(c.build).toEqual(["npm", "run", "build"]);
			expect(c.test).toEqual(["npm", "run", "test"]);
			// no `typecheck` script → tsconfig fallback to local tsc
			expect(c.typecheck?.[0]).toBe("npx");
			expect(c.typecheck).toContain("--noEmit");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("detects packageManager field (bun)", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "bun@1.2.3", scripts: { test: "bun test" } })));
		try {
			const c = detectProjectCommands(d);
			expect(c.pm).toBe("bun");
			expect(c.test).toEqual(["bun", "run", "test"]);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("detects python pytest from pyproject.toml", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n"));
		try {
			const c = detectProjectCommands(d);
			expect(c.language).toBe("python");
			expect(c.test).toEqual(["pytest", "-q"]);
			expect(c.build).toBeUndefined();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("returns empty ran for greenfield (no manifest)", () => {
		const d = tmpProj(() => {});
		try {
			const c = detectProjectCommands(d);
			expect(c.language).toBe("mixed");
			expect(c.ran).toEqual([]);
			expect(c.build).toBeUndefined();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("runBuildGate", () => {
	it("passes for greenfield (no commands → non-fatal)", () => {
		const d = tmpProj(() => {});
		try {
			const r = runBuildGate(d);
			expect(r.pass).toBe(true);
			expect(r.ran).toEqual([]);
			expect(r.errors).toEqual([]);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("passes when the test script exits 0", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } })));
		try {
			const r = runBuildGate(d);
			expect(r.pass).toBe(true);
			expect(r.allTestsPass).toBe(true);
			expect(r.ran).toContain("npm run test");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("fails and reports a tail when the test script exits 1", () => {
		const d = tmpProj((dir) => writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.error('boom'); process.exit(1)\"" } })));
		try {
			const r = runBuildGate(d);
			expect(r.pass).toBe(false);
			expect(r.allTestsPass).toBe(false);
			expect(r.errors.some((e) => e.includes("FAILED"))).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
