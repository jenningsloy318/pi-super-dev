/**
 * v0.4.9 — the python bootstrap arm (live-run prototype-timeout class:
 * dependency cold-start inside a bounded 20-min agent slot burned a full
 * delegation round in 3 of the last ~10 runs; attempt 2 inherited the warm
 * wheel cache and passed in 3 minutes). Contract mirrors the node arm:
 * best-effort, never fatal, every skip LOUD.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const log: string[] = [];
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return { ...actual, superDevEnv: vi.fn((key: string) => process.env[key]) };
});

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sd-pyboot-"));
	log.length = 0;
});
afterEach(() => {
	try { rmSync(home, { recursive: true, force: true }); } catch { /* tmp */ }
});

// The arm is exercised through bootstrapDependencies; we drive it by faking a
// node_modules (so the node arm is inert) and a python/ uv project.
describe("v0.4.9 python bootstrap arm", () => {
	it("skips loudly when uv is not on PATH (uv-locked project present)", async () => {
		const realPath = process.env.PATH;
		process.env.PATH = "/nonexistent-sd-pyboot"; // uv probe fails → the named skip
		try {
		const wt = join(home, "wt");
		mkdirSync(join(wt, "node_modules"), { recursive: true }); // node arm inert
		mkdirSync(join(wt, "python"), { recursive: true });
		writeFileSync(join(wt, "python", "pyproject.toml"), "[project]\nname = \"x\"\n");
		writeFileSync(join(wt, "python", "uv.lock"), "version = 1\n");
		const { bootstrapDependenciesForTests } = await import("../src/setup.ts");
		bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
		expect(log.some((l) => l.includes("python bootstrap skipped") && l.includes("uv is not on PATH"))).toBe(true);
		expect(existsSync(join(wt, "python", ".venv"))).toBe(false);
		} finally { process.env.PATH = realPath; }
	});

	it("skips loudly when pyproject.toml has no uv.lock", async () => {
		const wt = join(home, "wt2");
		mkdirSync(join(wt, "node_modules"), { recursive: true });
		mkdirSync(join(wt, "python"), { recursive: true });
		writeFileSync(join(wt, "python", "pyproject.toml"), "[project]\n");
		const { bootstrapDependenciesForTests } = await import("../src/setup.ts");
		bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
		expect(log.some((l) => l.includes("python bootstrap skipped") && l.includes("without uv.lock"))).toBe(true);
	});

	it("runs uv sync --frozen for a locked project and reuses an existing .venv loudly", async () => {
		const wt = join(home, "wt3");
		mkdirSync(join(wt, "node_modules"), { recursive: true });
		mkdirSync(join(wt, "python"), { recursive: true });
		writeFileSync(join(wt, "python", "pyproject.toml"), `[project]\nname = "sd-pyboot-test"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n`);
		writeFileSync(join(wt, "python", "uv.lock"), "version = 1\nrequires-dist = []\n");
		const { bootstrapDependenciesForTests } = await import("../src/setup.ts");
		bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
		// uv present in this environment → the sync either finished or failed
		// LOUDLY; both are contract-valid, silent is not.
		const py = log.filter((l) => l.includes("python bootstrap"));
		expect(py.length).toBeGreaterThanOrEqual(1);
		if (existsSync(join(wt, "python", ".venv"))) {
			// uv may create .venv BEFORE failing on a bad lock — either outcome
			// is contract-valid as long as it is LOUD (P10).
			expect(py.some((l) => l.includes("finished") || l.includes("FAILED"))).toBe(true);
			// second call: reuse path is loud
			log.length = 0;
			bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
			expect(log.some((l) => l.includes(".venv already exists"))).toBe(true);
		} else {
			expect(py.some((l) => l.includes("FAILED"))).toBe(true);
		}
	});

	it("node-only repos are untouched by the python arm (no pyproject → no python lines)", async () => {
		const wt = join(home, "wt4");
		mkdirSync(join(wt, "node_modules"), { recursive: true });
		const { bootstrapDependenciesForTests } = await import("../src/setup.ts");
		bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
		expect(log.some((l) => l.includes("python bootstrap"))).toBe(false);
	});
});

describe("v0.4.9 python-env prompt pins", () => {
	it("prototype AND implementation prompts carry the PYTHON ENV lesson", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync("src/prompts.ts", "utf8");
		expect(src.match(/PYTHON ENV \(v0\.4\.9/g)?.length).toBe(2);
		expect(src).toContain("dependency cold-start inside a bounded agent slot is the #1 delegation-timeout cause");
	});
});
