/**
 * Structural tests: the package is a clean, self-contained pi-package with no
 * dependency on @agwab/pi-workflow.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as Record<string, unknown>;

describe("package.json", () => {
	it("has pi.extensions pointing to ./src/extension.ts", () => {
		const pkg = readJson("package.json");
		expect((pkg.pi as Record<string, unknown>).extensions).toContain("./src/extension.ts");
	});
	it("has the pi-package keyword", () => {
		expect((readJson("package.json").keywords as string[])).toContain("pi-package");
	});
	it("declares NO bundled runtime dependencies", () => {
		const pkg = readJson("package.json");
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.bundledDependencies).toBeUndefined();
	});
	it("does NOT depend on @agwab/pi-workflow", () => {
		const pkg = readJson("package.json");
		const all = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.peerDependencies as Record<string, string> | undefined) };
		expect(all["@agwab/pi-workflow"]).toBeUndefined();
	});
});

describe("self-contained engine structure", () => {
	it("has the control-flow node algebra", () => {
		expect(existsSync(join(ROOT, "src", "nodes.ts"))).toBe(true);
	});
	it("has the runner and pipeline composition", () => {
		expect(existsSync(join(ROOT, "src", "workflow.ts"))).toBe(true);
		expect(existsSync(join(ROOT, "src", "stages", "index.ts"))).toBe(true);
	});
	it("spawns pi directly (the pi-workflow replacement)", () => {
		const src = readFileSync(join(ROOT, "src", "pi-spawn.ts"), "utf8");
		expect(src).toContain('"--mode"');
		expect(src).toContain('"-p"');
		expect(src).toContain("spawn");
	});
	it("has NO pi-workflow workflows directory", () => {
		expect(existsSync(join(ROOT, "workflows"))).toBe(false);
	});
	it("registers the super_dev tool and /super-dev command", () => {
		const ext = readFileSync(join(ROOT, "src", "extension.ts"), "utf8");
		expect(ext).toMatch(/registerTool/);
		expect(ext).toContain('"super_dev"');
		expect(ext).toMatch(/registerCommand/);
	});
	it("ships the 21 specialist agent definitions", () => {
		const agents = readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md"));
		expect(agents.length).toBe(21);
	});
});

describe("node algebra exports", () => {
	it("exports all control-flow nodes", () => {
		const src = readFileSync(join(ROOT, "src", "nodes.ts"), "utf8");
		for (const name of ["task", "sequence", "branch", "choose", "parallel", "loop", "retry", "gate", "map", "wait", "waitForEvent", "tryCatch", "noop"]) {
			expect(src).toContain(`export function ${name}`);
		}
	});
});

describe("agent prompts: no dead references (templates/Q1-Q10 self-audit)", () => {
	const AGENTS = join(ROOT, "agents");
	it("NO agent prompt tells the agent to read a format template we don't ship, or to 'follow the template structure'", () => {
		// Checks EVERY agent file (a previous guard only covered 6 named writers, which
		// let 9 other agents keep dead template refs — leftover from the original plugin).
		const files = readdirSync(AGENTS).filter((f) => f.endsWith(".md"));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const md = readFileSync(join(AGENTS, f), "utf8");
			expect(md, `${f} references a non-existent template`).not.toMatch(/read\s+(?:the\s+)?format\s+template/i);
			expect(md, `${f} still references the old template structure`).not.toMatch(/following the template structure/i);
		}
	});
	it("bdd prompt no longer demands the vestigial Q1-Q10/D1-D8 self-audit or mandatory-revision loop", () => {
		const md = readFileSync(join(AGENTS, "bdd-scenario-writer.md"), "utf8");
		expect(md).not.toMatch(/Q1-Q10|D1-D8|triggers mandatory revision|self-score/i);
	});
});
