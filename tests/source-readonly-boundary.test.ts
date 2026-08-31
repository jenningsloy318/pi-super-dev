import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backend = vi.hoisted(() => ({
	run: async (_opts: { cwd: string; prompt?: string; accessMode?: string }) => ({ text: "", control: { ok: true } }),
}));

vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn((opts) => backend.run(opts as { cwd: string; prompt?: string; accessMode?: string })),
	summarizeSlug: vi.fn(async () => "x"),
}));

vi.mock("../src/pi-spawn.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/pi-spawn.ts")>(),
	spawnAgent: vi.fn((opts) => backend.run(opts as { cwd: string; prompt?: string; accessMode?: string })),
	isBrowserAgent: vi.fn(() => false),
	needsWebResearch: vi.fn(() => false),
}));

import { makeContext } from "../src/workflow.ts";
import { debugWriter, docsWriter } from "../src/stages/writers.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

let tempDirs: string[] = [];

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): { cwd: string; specDir: string } {
	const cwd = mkdtempSync(join(tmpdir(), "super-dev-ro-"));
	tempDirs.push(cwd);
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	git(cwd, ["config", "user.name", "Test User"]);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src/app.ts"), "export const value = 1;\n");
	git(cwd, ["add", "src/app.ts"]);
	git(cwd, ["commit", "-m", "init"]);
	const specDir = join(cwd, "docs/specifications/feature");
	mkdirSync(specDir, { recursive: true });
	return { cwd, specDir };
}

function ctxFor(cwd: string, specDir: string, logs: string[] = []): StageContext {
	const state = { setup: { worktreePath: cwd, specDirectory: specDir } } as unknown as PipelineState;
	return makeContext(state, "task", {}, (m) => logs.push(m));
}

afterEach(() => {
	backend.run = async () => ({ text: "", control: { ok: true } });
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("source-read-only agent boundary", () => {
	it("fails and restores a clean tracked source file changed by a read-only agent", async () => {
		const { cwd, specDir } = makeRepo();
		const logs: string[] = [];
		backend.run = async (opts) => {
			expect(opts.accessMode).toBe("source-read-only");
			expect(opts.prompt).toContain("Source mutation boundary");
			writeFileSync(join(opts.cwd, "src/app.ts"), "export const value = 2;\n");
			return { text: "", control: { ok: true } };
		};

		await expect(ctxFor(cwd, specDir, logs).agent({ id: "pipeline.debug", agent: "debug-analyzer", accessMode: "source-read-only", prompt: "inspect" }))
			.rejects.toThrow(/source-read-only boundary violation/);

		expect(readFileSync(join(cwd, "src/app.ts"), "utf8")).toBe("export const value = 1;\n");
		expect(logs.join("\n")).toMatch(/source-read-only boundary violation paths=src\/app\.ts/);
		expect(logs.join("\n")).toMatch(/agent pipeline\.debug: threw/);
	});

	it("removes a new untracked source file created by a read-only agent", async () => {
		const { cwd, specDir } = makeRepo();
		backend.run = async (opts) => {
			writeFileSync(join(opts.cwd, "src/generated.ts"), "export const generated = true;\n");
			return { text: "", control: { ok: true } };
		};

		await expect(ctxFor(cwd, specDir).agent({ id: "pipeline.assessment", agent: "code-assessor", accessMode: "source-read-only", prompt: "inspect" }))
			.rejects.toThrow(/source-read-only boundary violation/);

		expect(existsSync(join(cwd, "src/generated.ts"))).toBe(false);
	});

	it("allows report artifacts under the active spec directory", async () => {
		const { cwd, specDir } = makeRepo();
		backend.run = async (opts) => {
			writeFileSync(join(opts.cwd, "docs/specifications/feature/04-debug-analysis.md"), "# Debug\n");
			return { text: "", control: { ok: true } };
		};

		const result = await ctxFor(cwd, specDir).agent({ id: "pipeline.debug", agent: "debug-analyzer", accessMode: "source-read-only", prompt: "inspect" });

		expect(result.control).toEqual({ ok: true });
		expect(readFileSync(join(specDir, "04-debug-analysis.md"), "utf8")).toBe("# Debug\n");
	});

	it("wires debug analysis through source-read-only access mode", async () => {
		let captured: string | undefined;
		const ctx = {
			budget: { check: () => true },
			agent: vi.fn(async (call) => {
				captured = call.accessMode;
				return { text: "", control: null };
			}),
			log: vi.fn(),
			task: "debug task",
		} as unknown as StageContext;

		await debugWriter.run({ setup: { worktreePath: "/tmp/project", specDirectory: "/tmp/project/docs/specifications/x" } } as unknown as PipelineState, ctx);

		expect(captured).toBe("source-read-only");
	});

	it("wires documentation through source-read-only access mode", async () => {
		let captured: string | undefined;
		const ctx = {
			budget: { check: () => true },
			agent: vi.fn(async (call) => {
				captured = call.accessMode;
				return { text: "", control: null };
			}),
			log: vi.fn(),
			task: "docs task",
		} as unknown as StageContext;

		await docsWriter.run({ setup: { worktreePath: "/tmp/project", specDirectory: "/tmp/project/docs/specifications/x" } } as unknown as PipelineState, ctx);

		expect(captured).toBe("source-read-only");
	});
});
