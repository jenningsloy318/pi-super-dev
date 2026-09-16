/**
 * v0.4.9 — the python bootstrap arm (live-run prototype-timeout class:
 * dependency cold-start inside a bounded 20-min agent slot burned a full
 * delegation round in 3 of the last ~10 runs; attempt 2 inherited the warm
 * wheel cache and passed in 3 minutes). Contract mirrors the node arm:
 * best-effort, never fatal, every skip LOUD.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
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
		// Adversarial F4 fold: red-without-uv guard + hermetic caches.
		let uvOk = false;
		try { execFileSync("uv", ["--version"], { stdio: "ignore" }); uvOk = true; } catch { uvOk = false; }
		if (!uvOk) {
			const wt = join(home, "wt3-noenv");
			mkdirSync(join(wt, "python"), { recursive: true });
			writeFileSync(join(wt, "python", "pyproject.toml"), "[project]\n");
			writeFileSync(join(wt, "python", "uv.lock"), "version = 1\n");
			const { bootstrapDependenciesForTests } = await import("../src/setup.ts");
			bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
			expect(log.some((l) => l.includes("uv is not on PATH"))).toBe(true);
			return;
		}
		const realCache = process.env.UV_CACHE_DIR;
		process.env.UV_CACHE_DIR = join(home, "uv-cache");
		try {
			const wt = join(home, "wt3");
			mkdirSync(join(wt, "node_modules"), { recursive: true });
			mkdirSync(join(wt, "python"), { recursive: true });
			writeFileSync(join(wt, "python", "pyproject.toml"), `[project]\nname = "sd-pyboot-test"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n`);
			writeFileSync(join(wt, "python", "uv.lock"), "version = 1\nrequires-dist = []\n");
			const { bootstrapDependenciesForTests } = await import("../src/setup.ts");
			bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
			const py = log.filter((l) => l.includes("python bootstrap"));
			expect(py.length).toBeGreaterThanOrEqual(1);
			if (existsSync(join(wt, "python", ".venv"))) {
				// uv may create .venv BEFORE failing on a bad lock — either outcome
				// is contract-valid as long as it is LOUD (P10).
				expect(py.some((l) => l.includes("finished") || l.includes("FAILED"))).toBe(true);
				log.length = 0;
				bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
				expect(log.some((l) => l.includes(".venv already exists"))).toBe(true);
			} else {
				expect(py.some((l) => l.includes("FAILED"))).toBe(true);
			}
		} finally {
			if (realCache !== undefined) process.env.UV_CACHE_DIR = realCache; else delete process.env.UV_CACHE_DIR;
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

describe("v0.4.9 arm independence (code-gate MED-2)", () => {
	it("no node_modules + no node lockfile + a python/ uv project → node skip AND python-arm lines in ONE call", async () => {
		const wt = join(home, "wt-mixed");
		mkdirSync(join(wt, "python"), { recursive: true });
		writeFileSync(join(wt, "python", "pyproject.toml"), "[project]\n");
		writeFileSync(join(wt, "python", "uv.lock"), "version = 1\n");
		const { bootstrapDependenciesForTests } = await import("../src/setup.ts");
		bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
		expect(log.some((l) => l.includes("Setup node bootstrap skipped (no node lockfile"))).toBe(true);
		expect(log.some((l) => l.includes("python bootstrap"))).toBe(true);
	});

	it("F1 — a FAILED sync REMOVES the partial .venv (no poisoned reuse)", async () => {
		const wt = join(home, "wt-f1");
		mkdirSync(join(wt, "python"), { recursive: true });
		// pyproject WITHOUT uv.lock would skip; with a BAD lock the sync fails
		writeFileSync(join(wt, "python", "pyproject.toml"), "[project]\n");
		writeFileSync(join(wt, "python", "uv.lock"), "NOT VALID TOML [[[\n");
		const realCache = process.env.UV_CACHE_DIR;
		process.env.UV_CACHE_DIR = join(home, "uv-cache-f1");
		try {
			const { bootstrapDependenciesForTests } = await import("../src/setup.ts");
			bootstrapDependenciesForTests(home, wt, true, (m) => log.push(m));
			expect(log.some((l) => l.includes("FAILED") && l.includes("REMOVED"))).toBe(true);
			expect(existsSync(join(wt, "python", ".venv"))).toBe(false); // the partial venv is gone
		} finally {
			if (realCache !== undefined) process.env.UV_CACHE_DIR = realCache; else delete process.env.UV_CACHE_DIR;
		}
	});
});

describe("v0.4.9 python-env prompt pins", () => {
	it("prototype AND implementation prompts carry the PYTHON ENV lesson IN THE JOINED OUTPUT (code-gate MED-1)", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync("src/prompts.ts", "utf8");
		expect(src.match(/PYTHON ENV \(v0\.4\.9/g)?.length).toBe(2); // secondary: both builders own it
		const { buildPrototypePrompt, buildImplementPrompt } = await import("../src/prompts.ts");
		const stub = { specDirectory: "/tmp/s", defaultBranch: "main", language: "python", isWebUi: false, specIdentifier: "x", worktreePath: "/tmp/w", worktreeCreated: true, initializedRepo: false, copiedEnvFiles: [] } as never;
		const proto = buildPrototypePrompt(stub, null, "do it", { docPath: "/tmp/d", docs: [] } as never, ["c"], 1, null);
		expect(proto).toContain("PYTHON ENV (v0.4.9");
		expect(proto).toContain("dependency cold-start inside a bounded agent slot is the #1 delegation-timeout cause");
		const impl = buildImplementPrompt(stub, null, { name: "p1" }, { languageInstructions: "" } as never, { specificationPath: "/tmp/sp" } as never);
		expect(impl).toContain("PYTHON ENV (v0.4.9");
	});
});

describe("v0.4.10 realized scenario-space injection (live spec trace-gate burn)", () => {
	it("extracts the id list from the BDD doc and names the trace-gate contract", async () => {
		const { writeFileSync: wf, mkdirSync: md } = await import("node:fs");
		const doc = join(home, "03-bdd-scenarios.md");
		md(home, { recursive: true });
		wf(doc, "# BDD\n\n## SCENARIO-050 first\n## SCENARIO-051 second\n## SCENARIO-069 last\n");
		const { realizedScenarioSpaceBlock } = await import("../src/stages/writers.ts");
		const block = realizedScenarioSpaceBlock({ docPath: doc });
		expect(block).toContain("exactly 3 scenario id(s): SCENARIO-050, SCENARIO-051, SCENARIO-069");
		expect(block).toContain("Cite ONLY ids from this list");
	});

	it("absent or unreadable BDD doc ⇒ empty block (trace gate still backstops)", async () => {
		const { realizedScenarioSpaceBlock } = await import("../src/stages/writers.ts");
		expect(realizedScenarioSpaceBlock(null)).toBe("");
		expect(realizedScenarioSpaceBlock({ docPath: "/nonexistent/bdd.md" })).toBe("");
	});
});

describe("v0.4.14 reading discipline (owner directive — read by segments, not grep)", () => {
	it("every ctxBlock-carrying builder ships the READING DISCIPLINE in its JOINED output", async () => {
		const { buildRequirementsPrompt, buildDesignPrompt, buildSpecPrompt, buildImplementPrompt, buildPrototypePrompt } = await import("../src/prompts.ts");
		const stub = { worktreePath: "/tmp/w", specDirectory: "/tmp/s", language: "python", isWebUi: false, specIdentifier: "x", defaultBranch: "main" } as never;
		const c = { language: "python", taskType: "feature", uiScope: "none" } as never;
		for (const [name, text] of [
			["requirements", buildRequirementsPrompt(stub, c, "t", "")],
			["design", buildDesignPrompt(stub, c, "t", null, null, null, "architecture-designer", "")],
			["spec", buildSpecPrompt(stub, c, "t", null, null, null, null, null)],
			["implement", buildImplementPrompt(stub, c, { name: "p" }, { languageInstructions: "" } as never, { specificationPath: "/tmp/sp" } as never)],
			["prototype", buildPrototypePrompt(stub, c, "t", { docPath: "/tmp/d" } as never, [], 1, null)],
		] as Array<[string, string]>) {
			expect(text, name).toContain("READING DISCIPLINE");
			expect(text, name).toContain("offset/limit in SEGMENTS");
			expect(text, name).toContain("grep finds MATCHING LINES, not understanding");
		}
	});
});
