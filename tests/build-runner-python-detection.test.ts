import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { detectProjectCommands } from "../src/build-runner/detect.ts";
import { runBuildGate } from "../src/build-runner/gates.ts";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

/** Make a fresh empty temp dir. */
function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "sd-pydet-"));
}

beforeEach(() => {
	spawn.mockReset();
	spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
	delete process.env.SUPER_DEV_BUILD_TEST_PACKAGES;
	delete process.env.SUPER_DEV_GATE_BASE_REF;
	process.env.SUPER_DEV_SKIP_DEP_BOOTSTRAP = "1";
});

// NOTE: SUPER_DEV_SKIP_DEP_BOOTSTRAP is restored per-test below; the uv test
// clears it explicitly.
afterEach(() => {
	delete process.env.SUPER_DEV_SKIP_DEP_BOOTSTRAP;
});

describe("GAP-E: python test-runner detection (Fix 6b)", () => {
	it("requirements.txt listing pytest (no pytest config anywhere) → test command resolves", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "requirements.txt"), "pytest>=8.0\nhttpx\n");
		const cmds = detectProjectCommands(dir);
		expect(cmds.language).toBe("python");
		expect(cmds.test).toEqual(["pytest", "-q"]);
		expect(cmds.ran).toContain("pytest");
	});

	it("pyproject dependency array listing pytest → test command resolves", () => {
		const dir = tmpDir();
		writeFileSync(
			join(dir, "pyproject.toml"),
			'[project]\nname = "p"\nversion = "0.1.0"\ndependencies = ["pytest>=8", "httpx"]\n',
		);
		const cmds = detectProjectCommands(dir);
		expect(cmds.language).toBe("python");
		expect(cmds.test).toEqual(["pytest", "-q"]);
	});

	it("tests/conftest.py present (no config, no dependency entry) → test command resolves", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "requirements.txt"), "httpx\n");
		mkdirSync(join(dir, "tests"));
		writeFileSync(join(dir, "tests", "conftest.py"), "");
		const cmds = detectProjectCommands(dir);
		expect(cmds.test).toEqual(["pytest", "-q"]);
	});

	it("bare python repo with NO pytest signal anywhere → defaults to zero-config pytest instead of undefined", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "requirements.txt"), "httpx\n");
		const cmds = detectProjectCommands(dir);
		// Pre-fix behavior: cmds.test === undefined → RED oracle `unknown`
		// forever → every attempt failed as unverified (stagnation with no code
		// cause). Post-fix: zero-config pytest default (honest ENOENT if absent).
		expect(cmds.test).toEqual(["pytest", "-q"]);
		expect(cmds.ran).toContain("pytest (default)");
	});

	it("commented-out pytest in requirements.txt does NOT count as a config-based detection", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "requirements.txt"), "# pytest>=8\nhttpx\n");
		const cmds = detectProjectCommands(dir);
		// Falls through to the zero-config default (still runs pytest, but the
		// label proves the dependency regex did not false-positive).
		expect(cmds.ran).toContain("pytest (default)");
		expect(cmds.ran).not.toContain("pytest");
	});

	it("pytest-cov alone is NOT a bare pytest dependency entry", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "requirements.txt"), "pytest-cov>=5\n");
		const cmds = detectProjectCommands(dir);
		expect(cmds.ran).toContain("pytest (default)");
		expect(cmds.ran).not.toContain("pytest");
	});

	it("pytest config file still wins (label without default marker)", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "requirements.txt"), "httpx\n");
		writeFileSync(join(dir, "pytest.ini"), "[pytest]\n");
		const cmds = detectProjectCommands(dir);
		expect(cmds.test).toEqual(["pytest", "-q"]);
		expect(cmds.ran).toContain("pytest");
		expect(cmds.ran).not.toContain("pytest (default)");
	});

	it("non-python repos unaffected: rust and go detection unchanged", () => {
		const rustDir = tmpDir();
		writeFileSync(join(rustDir, "Cargo.toml"), '[package]\nname = "p"\n');
		const rust = detectProjectCommands(rustDir);
		expect(rust.language).toBe("rust");
		expect(rust.test).toEqual(["cargo", "test", "--quiet"]);

		const goDir = tmpDir();
		writeFileSync(join(goDir, "go.mod"), "module example.com/p\n\ngo 1.26\n");
		const go = detectProjectCommands(goDir);
		expect(go.language).toBe("go");
		expect(go.test).toEqual(["go", "test", "./..."]);
	});
});

describe("GAP-F: uv.lock dependency bootstrap (Fix 8)", () => {
	it("uv.lock without .venv → `uv sync` is spawned before gate commands", () => {
		process.env.SUPER_DEV_SKIP_DEP_BOOTSTRAP = undefined as unknown as string;
		delete process.env.SUPER_DEV_SKIP_DEP_BOOTSTRAP;
		const dir = tmpDir();
		writeFileSync(
			join(dir, "pyproject.toml"),
			'[project]\nname = "p"\nversion = "0.1.0"\ndependencies = ["httpx"]\n',
		);
		writeFileSync(join(dir, "uv.lock"), "version = 1\n");
		const calls: string[][] = [];
		spawn.mockImplementation((cmd: string, args: string[]) => {
			calls.push([cmd, ...(args ?? [])]);
			return { status: 0, stdout: "", stderr: "" };
		});
		runBuildGate(dir);
		const uvSync = calls.find((a) => a[0] === "uv" && a[1] === "sync");
		expect(uvSync).toBeDefined();
	});

	it("uv.lock with an existing .venv → `uv sync` is skipped (idempotent)", () => {
		process.env.SUPER_DEV_SKIP_DEP_BOOTSTRAP = undefined as unknown as string;
		delete process.env.SUPER_DEV_SKIP_DEP_BOOTSTRAP;
		const dir = tmpDir();
		writeFileSync(
			join(dir, "pyproject.toml"),
			'[project]\nname = "p"\nversion = "0.1.0"\ndependencies = ["httpx"]\n',
		);
		writeFileSync(join(dir, "uv.lock"), "version = 1\n");
		mkdirSync(join(dir, ".venv"));
		const calls: string[][] = [];
		spawn.mockImplementation((cmd: string, args: string[]) => {
			calls.push([cmd, ...(args ?? [])]);
			return { status: 0, stdout: "", stderr: "" };
		});
		runBuildGate(dir);
		const uvSync = calls.find((a) => a[0] === "uv" && a[1] === "sync");
		expect(uvSync).toBeUndefined();
	});
});
